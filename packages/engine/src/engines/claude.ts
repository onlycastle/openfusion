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
//
// M4 task-1 builds exactly that: `toolPolicy.writeScope` (see
// createSession's opts, ./types.ts) is a list of directories. When present
// and non-empty, `canUseTool` below allows Write / Edit / MultiEdit /
// NotebookEdit calls whose target path resolves inside one of them —
// `allowedTools` (READ_ONLY_ALLOWED_TOOLS) is untouched; write tools are
// NEVER added to it, for exactly the reason documented above.
//
// M4 task-1 review round 1 hardened that containment check twice: (Finding
// 1) the containment predicate is now the shared `isPathContained` in
// ./path-scope.ts, also used by methods.ts's RPC-layer writeScope
// validation, so a relative traversal entry can no longer establish
// out-of-project scope at one layer while the other layer disagrees; and
// (Finding 2) a target path is canonicalized (symlinks resolved) before the
// containment check, so a pre-existing symlink inside a scope dir pointing
// outside it can no longer be used to write out-of-scope.
//
// M4 task-1 re-review round 2 fixed a regression Finding 2's own realpath
// introduced: realpathing each writeScope dir (createSession, below) without
// re-checking the RESULT against projectDir meant a writeScope entry that
// was ITSELF a symlink out of the project — lexically inside projectDir, so
// it passed methods.ts's RPC-layer check untouched — got realpath'd into,
// and fully trusted as, its external target. Every realpath'd scope dir is
// now re-verified contained in the project root and dropped if it isn't.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelUsage, Query, SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";
import { canonicalizePath, isPathContained } from "./path-scope.js";
import type { FrontierAdapter, FrontierEvent, FrontierPromptHandle, FrontierSession } from "./types.js";

const CLAUDE_CODE_KIND = "claude-code";

// "Bash(git log*)" was dropped from this list (M3 final review, Important
// 3): `git log --output=/path` writes a file, and permission-scoping the
// tool name doesn't scope its flags — that residual write capability
// breaches the read-only v1 posture below just as surely as an unscoped
// Bash entry would.
const READ_ONLY_ALLOWED_TOOLS = ["Read", "Grep", "Glob", "mcp__wiki__wiki_query", "mcp__wiki__wiki_map"];

// The write-capable tools canUseTool may allow when writeScope is set.
// MultiEdit has no interface of its own in this SDK version's sdk-tools.d.ts
// (@anthropic-ai/claude-agent-sdk@0.3.198 defines FileEditInput for Edit,
// FileWriteInput for Write, and NotebookEditInput for NotebookEdit, but no
// MultiEdit type at all) — included here anyway, defensively, since Claude
// Code has historically shipped it with a `file_path` field matching Edit's;
// extractWriteTargetPath below handles it via the same `file_path` lookup.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

type FrontierResultEvent = Extract<FrontierEvent, { type: "result" }>;
type FrontierNoticeEvent = Extract<FrontierEvent, { type: "notice" }>;

// Write/Edit tool inputs (FileWriteInput/FileEditInput in sdk-tools.d.ts)
// name their target path `file_path`; NotebookEdit's (NotebookEditInput)
// names it `notebook_path`. Neither uses a bare `path` field — that spelling
// belongs to Glob/Grep's read-only "search root" input — but it's checked
// last anyway as a defensive fallback per the M4 task-1 brief, in case a
// future write tool (or SDK version) spells it differently.
function extractWriteTargetPath(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

// Containment check delegated to the shared ./path-scope.ts helper (M4
// task-1 review round 1, Finding 1) so this adapter's canUseTool policy and
// methods.ts's RPC-layer writeScope validation share one predicate and
// cannot drift apart. `canonicalTarget` is expected to already be
// symlink-resolved by the caller (see canonicalizePath below, Finding 2).
function isPathInScope(canonicalTarget: string, scopeDirs: string[]): boolean {
  return scopeDirs.some((scopeDir) => isPathContained(canonicalTarget, scopeDir));
}

// SDKAssistantMessage carries an optional top-level `error?:
// SDKAssistantMessageError` (sdk.d.ts) — a bare string enum with no
// accompanying message text, unlike a typical JS error. rate_limit and
// overloaded get their own FrontierEvent notice `kind`s (M3 inherit #2:
// rate-limit visibility); every other tag (authentication_failed,
// oauth_org_not_allowed, billing_error, invalid_request, model_not_found,
// server_error, unknown, max_output_tokens) folds into kind "api_error" with
// the raw tag interpolated into the message, since there's nothing more
// specific to say generically for any of them.
function mapAssistantError(error: SDKAssistantMessageError): FrontierNoticeEvent {
  switch (error) {
    case "rate_limit":
      // M4 task-1 review round 1, Finding 3 (Important): the previous copy
      // ("...the request will be retried automatically") asserted retry
      // semantics that were never verified against the SDK — that behavior,
      // if it exists, belongs to SDKAPIRetryMessage (system/api_retry), a
      // different message type this function doesn't map. Kept factual: no
      // remediation claim, just what was observed.
      return {
        type: "notice",
        kind: "rate_limit",
        message: "Claude API rate limit reported for this turn.",
      };
    case "overloaded":
      return {
        type: "notice",
        kind: "overloaded",
        message: "Claude API overloaded for this turn.",
      };
    default:
      return { type: "notice", kind: "api_error", message: `Claude API error: ${error}` };
  }
}

export interface CreateClaudeAdapterOptions {
  /** DI for tests; defaults to the real SDK's query(). */
  queryFn?: typeof query;
  /**
   * Invoked once per `result` message with the mapped FrontierEvent, the
   * "dominant" model from the SDK's per-model usage breakdown (see
   * dominantModel below), and the session's own `resultLabel` (opaque —
   * see createSession's opts in ./types.ts) if one was supplied when the
   * session was created. The adapter itself stays meter-agnostic —
   * registerFrontierMethods wires this to engine.models' CostMeter (kind
   * "frontier-claude") when it registers the default adapter, so this file
   * never imports the models layer; `resultLabel` is passed through
   * untouched purely so that wiring can distinguish which purpose (e.g.
   * M5b Task 4's review vs escalate) produced a given result.
   */
  onResult?: (result: FrontierResultEvent, model: string, resultLabel?: string) => void;
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

    async createSession({ projectDir, wikiMcpUrl, log, toolPolicy, resultLabel }): Promise<FrontierSession> {
      const id = randomUUID();
      let resumeSessionId: string | null = null;
      let activeQuery: Query | null = null;
      // Resolved once per session (writeScope doesn't vary per-prompt).
      // path.resolve(projectDir, dir) is a no-op past the base for an
      // already-absolute dir (the RPC layer always sends absolute,
      // projectDir-resolved entries — see types.ts's createSession opts doc)
      // and defensively anchors a hypothetically-relative one to projectDir
      // rather than process.cwd() for any other caller of this adapter.
      //
      // Also realpath'd here (M4 task-1 review round 1, Finding 2): scope
      // dirs generally exist by the time a session starts, so canonicalizing
      // them up front means every canUseTool call below compares a
      // canonicalized target against a canonicalized scope — not a
      // canonicalized target against a merely-lexical scope dir (which would
      // stay bypassable if the scope dir ITSELF were a symlink). A scope dir
      // that doesn't exist yet falls back to its resolved (non-canonical)
      // path — there's nothing to realpath.
      //
      // M4 task-1 re-review round 2 (Important regression): realpathing
      // alone re-opened the escape Finding 1 closed at the RPC layer.
      // methods.ts's engine.frontier.start validates only the LEXICAL
      // resolution of each writeScope entry against projectDir — it can't
      // see through a symlink from string paths alone. So a pre-existing
      // symlink named as a writeScope entry (lexically inside projectDir)
      // that actually points OUTSIDE projectDir sails through that RPC
      // check, then gets realpath'd above into the external target and
      // would be trusted outright as a scope dir — a deterministic full
      // containment escape, worse than the bug Finding 2 closed. Every
      // realpath'd scope dir is therefore re-verified contained in the
      // canonical project root below (same isPathContained predicate used
      // everywhere else in this file); one that fails is DROPPED rather
      // than thrown — the RPC layer already validated the lexical form, so
      // this is defense-in-depth at the trust boundary this adapter owns,
      // not the primary gate — and contributes nothing to writeScopeDirs,
      // so no write can ever land there.
      //
      // M5a task-1 (M4 T1 deferred, day-one critical for worker worktrees):
      // the fallback below for a scope dir that doesn't exist yet used to
      // be `resolved` itself — built off the RAW projectDir — compared
      // against `canonicalProjectDir`, which IS realpath'd. On a symlinked
      // project root (macOS os.tmpdir() -> /var/folders, really
      // /private/var/folders; worker worktrees live under os.tmpdir()) that
      // lexical-vs-canonical mismatch made the filter below drop every
      // legitimate not-yet-existing scope dir, denying all writes to it —
      // the exact scenario every worker worktree hits on session start,
      // before its scope dirs exist. Fixed by re-anchoring `resolved`'s
      // path relative to the raw project dir onto `canonicalProjectDir`
      // instead, so the filter always compares canonical-vs-canonical
      // regardless of whether realpath succeeded or a dir doesn't exist yet.
      let canonicalProjectDir: string;
      try {
        canonicalProjectDir = fs.realpathSync(projectDir);
      } catch {
        canonicalProjectDir = path.resolve(projectDir);
      }
      const projectDirResolved = path.resolve(projectDir);
      const writeScopeDirs = (toolPolicy?.writeScope ?? [])
        .map((dir) => {
          const resolved = path.resolve(projectDir, dir);
          try {
            return fs.realpathSync(resolved);
          } catch {
            return path.resolve(canonicalProjectDir, path.relative(projectDirResolved, resolved));
          }
        })
        .filter((realDir) => {
          if (isPathContained(realDir, canonicalProjectDir)) return true;
          log("writeScope entry dropped (resolves outside project after symlink resolution)");
          return false;
        });

      return {
        id,
        projectDir,

        // M6 Task 1 (eval-batch safety gate): `opts.timeoutMs` is enforced
        // again here. It was dropped in M3 final review (Minor 7) when the
        // RPC layer (methods.ts's engine.frontier.prompt) became the single
        // timeout authority — forwarding opts.timeoutMs from there too would
        // have raced two independent timers over the same deadline. That RPC
        // layer STILL deliberately never forwards its own timeoutMs
        // (methods.ts's "Deliberately NOT forwarding params.timeoutMs" —
        // unchanged), so this stays dormant for engine.frontier.prompt
        // callers specifically. But M5b threaded a PER-ATTEMPT timeoutMs
        // straight into THIS call from two paths that bypass the RPC prompt
        // handler entirely — harness/driver.ts's promptForJson (used by
        // harness/generate.ts and orchestrate/review.ts) and orchestrate.ts's
        // own escalation turn (runFrontierTurn) — and against the real
        // adapter it was a silent no-op: a wedged real review/escalate/
        // generate turn could hang an eval batch of N orchestrate loops
        // forever on one stuck prompt. `opts` is therefore back in this
        // method's signature.
        prompt(text, opts): FrontierPromptHandle {
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
              canUseTool: async (toolName, input) => {
                if (writeScopeDirs.length > 0 && WRITE_TOOLS.has(toolName)) {
                  const targetPath = extractWriteTargetPath(input);
                  if (targetPath !== null) {
                    const resolvedTarget = path.resolve(projectDir, targetPath);
                    // Canonicalize before the containment check (M4 task-1
                    // review round 1, Finding 2): a purely lexical check over
                    // resolvedTarget would treat `scope/link/file.txt` as
                    // in-scope even when `scope/link` is a pre-existing
                    // symlink pointing outside scope. canonicalizePath walks
                    // up to the deepest existing ancestor, realpaths it, and
                    // re-joins the (possibly not-yet-existing) tail — see
                    // ./path-scope.ts for the residual TOCTOU caveat this
                    // does NOT close.
                    const canonicalTarget = canonicalizePath(resolvedTarget);
                    if (isPathInScope(canonicalTarget, writeScopeDirs)) {
                      return { behavior: "allow" };
                    }
                  }
                }
                return {
                  behavior: "deny",
                  message: "openfusion v1: read-only orchestration",
                };
              },
            },
          });
          activeQuery = q;

          // Combined with the existing per-prompt abortController via
          // AbortSignal.any (mirrors worker/methods.ts's own combinator: a
          // timeoutSignal and a separately-triggerable controller/signal
          // merged into ONE thing the operation reacts to). Either source
          // firing runs the SAME teardown — abort the query's own
          // abortController (the existing graceful-cancellation mechanism,
          // same as `abort()` below) AND force-close the Query (kills the
          // CLI subprocess outright, per Query#close's own SDK doc comment —
          // see this session's close() method below), so a wedged real
          // process can't outlive its budget merely by ignoring the graceful
          // abort. `timedOut` (checked by mapEvents below) is set true only
          // when the TIMEOUT specifically fired — not a plain manual abort —
          // so a caller-initiated `abort()` keeps its existing, unlabeled
          // ending instead of being misreported as a timeout.
          let timedOut = false;
          // `timeoutRejection`, when armed, is raced against every
          // `q.next()` call below — NOT merely "wait for the query to
          // notice it was aborted and stop on its own". A truly wedged
          // subprocess might never react to abortController.abort() (that's
          // exactly the failure mode this task closes), so the race is what
          // actually bounds how long a caller can be kept waiting,
          // independent of the adapter's own cooperation.
          let timeoutRejection: Promise<never> | undefined;
          // Fix 2 (M6 Task 1 review round 1 — hygiene): set alongside
          // timeoutRejection when a deadline is armed; calling it tears the
          // combinedSignal "abort" listener down. Without this, a prompt
          // that finishes (or is manually aborted) BEFORE opts.timeoutMs
          // elapses left that listener registered — and the underlying
          // AbortSignal.timeout timer running — until the ORIGINAL deadline
          // eventually fired on a stale abortController/query this call no
          // longer owns. Harmless in practice today (the timer is unref'd;
          // q.close() is idempotent; the listener already has `{ once: true
          // }` so it can only ever fire once), but inconsistent with this
          // codebase's own pattern elsewhere of tearing a timeout down in a
          // `finally` (worker/methods.ts, models/methods.ts's
          // `clearTimeout(timer)`) — this closes the same gap here. Calling
          // it AFTER the listener already fired (the genuinely-wedged path)
          // is just a no-op removeEventListener, so this can never weaken
          // the wedged-query timeout guarantee itself.
          let removeTimeoutListener: (() => void) | undefined;
          if (opts?.timeoutMs !== undefined) {
            const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
            const combinedSignal = AbortSignal.any([timeoutSignal, abortController.signal]);
            timeoutRejection = new Promise<never>((_resolve, reject) => {
              const onTimeoutSignal = (): void => {
                timedOut = timeoutSignal.aborted;
                abortController.abort();
                q.close();
                if (timedOut) {
                  reject(new Error("prompt timed out"));
                }
                // A manual (non-timeout) abort while timeoutMs is set:
                // leave this promise permanently pending — the iteration
                // loop below ends on its own once the (now-aborted)
                // query's iterator stops, exactly as it did before this
                // task, and nothing re-checks this promise afterward.
              };
              combinedSignal.addEventListener("abort", onTimeoutSignal, { once: true });
              removeTimeoutListener = () => combinedSignal.removeEventListener("abort", onTimeoutSignal);
            });
          }

          async function* mapEvents(): AsyncGenerator<FrontierEvent> {
            // Prompt text and every streamed message body are user/model
            // content — never pass them to `log`. Only lifecycle facts
            // (nothing here) would be safe; this loop logs nothing.
            //
            // Fix 3 (M6 Task 1 review round 1 — comment): this manual
            // `while`/`q.next()` loop does NOT auto-propagate an early
            // consumer exit down to `q` the way a nested `for await...of q`
            // would have (that propagation is a language-level behavior of
            // `for await...of` calling the ITERATED object's own
            // `.return()` — a manually-driven `q.next()` loop has no such
            // hook). Every current consumer of `handle.events`
            // (harness/driver.ts, engines/methods.ts, orchestrate.ts) always
            // calls `handle.abort()` explicitly on early exit/catch, which is
            // what actually aborts `abortController` and closes `q` — so
            // this is inert today. A FUTURE consumer that merely `break`s
            // out of (or throws out of) its `for await (const event of
            // handle.events)` loop WITHOUT calling `handle.abort()` would
            // silently leak the underlying query/subprocess. Don't
            // reintroduce that leak — call `handle.abort()` on early exit.
            try {
              while (true) {
                const nextPromise = q.next();
                // Swallow a rejection this promise may settle with LATER, if
                // it loses the race below (the timeout won instead) —
                // without this, an eventual reject from an abandoned promise
                // with no attached handler would surface as an unhandled
                // rejection. Attaching .catch() here (even though its own
                // returned promise is discarded) is enough for Node to
                // consider the ORIGINAL promise handled; the race below
                // still resolves/rejects off that same original promise when
                // it settles first.
                nextPromise.catch(() => {});
                const result =
                  timeoutRejection !== undefined
                    ? await Promise.race([nextPromise, timeoutRejection])
                    : await nextPromise;
                if (result.done === true) return;
                const message = result.value;
                if (message.type === "assistant") {
                  // Rate-limit visibility (M3 inherit #2): an API-error tag
                  // on an assistant message is not terminal — it's a
                  // mid-turn notice, so mapping it here and letting the loop
                  // fall through to the message's (likely empty, but not
                  // assumed so) content blocks below is deliberate; the RPC
                  // layer streams `notice` like any other event, with no
                  // special handling (methods.ts's prompt loop is
                  // event-type-agnostic).
                  if (message.error !== undefined) {
                    yield mapAssistantError(message.error);
                  }
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
                  onResult?.(resultEvent, dominantModel(message.modelUsage), resultLabel);
                  yield resultEvent;
                }
              }
            } finally {
              // Fix 2: torn down on EVERY exit from this loop — normal
              // completion (the `return` above), an early consumer exit
              // (Fix 3's own doc comment — a `.return()`/`.throw()` on this
              // generator resumes here), or the timed-out rejection
              // propagating out of the `await` above. See
              // removeTimeoutListener's own doc comment for why this can
              // never weaken the wedged-query guarantee.
              removeTimeoutListener?.();
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
