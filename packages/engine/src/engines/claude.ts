// Claude Code frontier adapter: implements FrontierAdapter/FrontierSession
// (see ./types.ts) by driving `@anthropic-ai/claude-agent-sdk`'s query(),
// which spawns the `claude` CLI as a subprocess. AUTH-AGNOSTIC by design —
// this file never reads an env var or otherwise touches credentials; the
// SDK/CLI resolve auth themselves from whatever the operator configured
// (see docs/research/2026-07-03-m3-api-verification.md, "Auth posture").
//
// v1 is READ-ONLY orchestration (answers/plans; no edits) per the M3 exit
// criterion — write tools arrive with M5's worker/review loop.
//
// TOOL-POLICY RECORD (M3 final review, Important 2 — corrects an earlier,
// inverted version of this comment; M4 builds tool policy on this file, so
// get it right here): `allowedTools` and `canUseTool` are NOT two redundant
// guards over the same tools. They govern two DISJOINT sets, and
// `allowedTools` wins outright for the tools it lists. The SDK's own runtime
// warning (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`) says so directly: entries in
// `allowedTools` auto-approve the matching tool call BEFORE `canUseTool` is
// ever consulted — per the SDK's documented permission order (hooks → deny
// → ask → mode → allow → canUseTool), the `allow` step runs, and can
// short-circuit, ahead of `canUseTool`.
//
// So: `allowedTools` (READ_ONLY_ALLOWED_TOOLS below) is the SOLE authority
// for the tools it lists — `canUseTool` never even runs for them.
// `canUseTool` only governs tools NOT in `allowedTools` — here, that's
// "everything else", which is why it unconditionally denies.
//
// Consequence for future work: write-capability must ONLY ever be added via
// `canUseTool` policy (e.g. a path-scoped allow for a specific write tool),
// never by adding a tool to `allowedTools` — anything placed there bypasses
// `canUseTool`'s policy entirely, by design of the SDK itself.
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelUsage, Query } from "@anthropic-ai/claude-agent-sdk";
import type { FrontierAdapter, FrontierEvent, FrontierPromptHandle, FrontierSession } from "./types.js";

const CLAUDE_CODE_KIND = "claude-code";

// "Bash(git log*)" was dropped from this list (M3 final review, Important
// 3): `git log --output=/path` writes a file, and permission-scoping the
// tool name doesn't scope its flags — that residual write capability
// breaches the read-only v1 posture below just as surely as an unscoped
// Bash entry would.
const READ_ONLY_ALLOWED_TOOLS = ["Read", "Grep", "Glob", "mcp__wiki__wiki_query", "mcp__wiki__wiki_map"];

type FrontierResultEvent = Extract<FrontierEvent, { type: "result" }>;

export interface CreateClaudeAdapterOptions {
  /** DI for tests; defaults to the real SDK's query(). */
  queryFn?: typeof query;
  /**
   * Invoked once per `result` message with the mapped FrontierEvent and the
   * "dominant" model from the SDK's per-model usage breakdown (see
   * dominantModel below). The adapter itself stays meter-agnostic —
   * registerFrontierMethods wires this to engine.models' CostMeter (kind
   * "frontier-claude") when it registers the default adapter, so this file
   * never imports the models layer.
   */
  onResult?: (result: FrontierResultEvent, model: string) => void;
}

// modelUsage can hold more than one model when a fallback fires mid-turn,
// but CostMeter only takes one model string per record — the highest-cost
// entry stands in for "the model this turn mostly used". Empty modelUsage
// (never observed from the real CLI, but not contractually guaranteed
// non-empty) falls back to the adapter's own kind name.
function dominantModel(modelUsage: Record<string, ModelUsage>): string {
  let bestKey: string | undefined;
  let bestCost = -Infinity;
  for (const [key, usage] of Object.entries(modelUsage)) {
    if (usage.costUSD > bestCost) {
      bestKey = key;
      bestCost = usage.costUSD;
    }
  }
  return bestKey ?? CLAUDE_CODE_KIND;
}

export function createClaudeAdapter(options: CreateClaudeAdapterOptions = {}): FrontierAdapter {
  const queryFn = options.queryFn ?? query;
  const onResult = options.onResult;

  return {
    kind: CLAUDE_CODE_KIND,

    async createSession({ projectDir, wikiMcpUrl, log }): Promise<FrontierSession> {
      const id = randomUUID();
      let resumeSessionId: string | null = null;
      let activeQuery: Query | null = null;

      return {
        id,
        projectDir,

        // M3 final review, Minor 7: this used to also arm its own
        // `setTimeout(opts.timeoutMs)` here, racing a second independent
        // timer against engine.frontier.prompt's RPC-level one over the same
        // deadline (see methods.ts's timeoutPromise) — a review finding from
        // an earlier round (see docs/superpowers/sdd/m3-task-4-report.md,
        // "Fix 1 / Finding 1") already made the RPC layer the single
        // timeout authority and stopped forwarding `opts.timeoutMs` into
        // this call. That left this branch unreachable dead code; removed
        // outright rather than left dormant. `opts` (still part of the
        // FrontierSession contract in types.ts, for any other future caller)
        // is consequently unused here and dropped from this implementation —
        // TS structurally allows implementing a method with fewer parameters
        // than its interface declares.
        prompt(text): FrontierPromptHandle {
          const abortController = new AbortController();

          const q = queryFn({
            prompt: text,
            options: {
              cwd: projectDir,
              resume: resumeSessionId ?? undefined,
              mcpServers: wikiMcpUrl !== null ? { wiki: { type: "http", url: wikiMcpUrl } } : undefined,
              allowedTools: READ_ONLY_ALLOWED_TOOLS,
              permissionMode: "default",
              abortController,
              canUseTool: async () => ({
                behavior: "deny",
                message: "openfusion v1: read-only orchestration",
              }),
            },
          });
          activeQuery = q;

          async function* mapEvents(): AsyncGenerator<FrontierEvent> {
            // Prompt text and every streamed message body are user/model
            // content — never pass them to `log`. Only lifecycle facts
            // (nothing here) would be safe; this loop logs nothing.
            for await (const message of q) {
              if (message.type === "assistant") {
                for (const block of message.message.content) {
                  if (block.type === "text") {
                    yield { type: "text", text: block.text };
                  } else if (block.type === "tool_use") {
                    yield {
                      type: "tool_use",
                      name: block.name,
                      summary: JSON.stringify(block.input).slice(0, 200),
                    };
                  }
                }
              } else if (message.type === "result") {
                resumeSessionId = message.session_id;
                const usage = {
                  inputTokens: message.usage.input_tokens,
                  outputTokens: message.usage.output_tokens,
                  cacheReadTokens: message.usage.cache_read_input_tokens,
                };
                const resultEvent: FrontierResultEvent = {
                  type: "result",
                  resultText: message.subtype === "success" ? message.result : message.errors.join("; "),
                  costUsd: message.total_cost_usd,
                  usage,
                  numTurns: message.num_turns,
                  durationMs: message.duration_ms,
                  engineSessionId: message.session_id,
                };
                onResult?.(resultEvent, dominantModel(message.modelUsage));
                yield resultEvent;
              }
            }
          }

          return {
            events: mapEvents(),
            abort: () => abortController.abort(),
          };
        },

        async close(): Promise<void> {
          // Query.close() forcefully ends the query and kills the CLI
          // subprocess (SDK doc comment on Query#close) — the chosen abort
          // mechanism for session-level teardown. Per-prompt abort() above
          // instead aborts that prompt's AbortController, which the SDK
          // treats as cancellation for the same in-flight query.
          activeQuery?.close();
          activeQuery = null;
          resumeSessionId = null;
          log("claude-code: session closed");
        },
      };
    },
  };
}
