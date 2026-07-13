// ACP-shaped adapter surface for frontier coding engines (Claude Code today;
// Codex / other ACP-speaking agents later — see FrontierAdapter.kind). These
// types are the load-bearing contract between engine.frontier.* RPCs
// (methods.ts) and per-engine adapters (Task 3's Claude adapter is the
// first implementation): transcribed verbatim from the M3 task-2 brief so
// downstream tasks can depend on these exact names.
import type { RuntimeCapabilities } from "@openfusion/shared";
export type FrontierEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; summary: string }
  | {
      type: "result";
      resultText: string;
      costUsd: number | null;
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
      numTurns: number;
      durationMs: number;
      engineSessionId: string | null;
      structuredOutput?: unknown;
    }
  | { type: "error"; message: string }
  | { type: "notice"; kind: "rate_limit" | "overloaded" | "api_error"; message: string };

export interface FrontierPromptHandle {
  events: AsyncIterable<FrontierEvent>;
  abort(): void;
}

export interface FrontierPromptOptions {
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
}

export interface FrontierSession {
  readonly id: string; // OUR session id (uuid)
  readonly projectDir: string;
  prompt(text: string, opts?: FrontierPromptOptions): FrontierPromptHandle;
  close(): Promise<void>; // must kill any subprocess
}

/** One model exposed by an authenticated frontier runtime. Model catalogs are
 * runtime-owned because subscription entitlements and rollouts can differ by
 * account; callers must not infer availability from the pricing table. */
export interface FrontierModel {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export interface FrontierAdapter {
  readonly kind: string; // "claude-code" | future: "codex" | "acp:*"
  /** Versioned capability probe. Security-relevant gaps are never emulated. */
  capabilities?(): RuntimeCapabilities | Promise<RuntimeCapabilities>;
  /** Discover models available to the currently authenticated account. */
  listModels?(): Promise<FrontierModel[]>;
  createSession(opts: {
    projectDir: string;
    wikiMcpUrl: string | null;
    /** Ephemeral loopback authorization; never persisted or logged. */
    wikiMcpBearerToken?: string;
    log: (line: string) => void;
    /** Omit to let the official runtime resolve its account/config default. */
    model?: string;
    // Absent (or writeScope absent/empty) => today's read-only posture:
    // canUseTool denies every write tool, unconditionally. When writeScope
    // is a non-empty list, the adapter's canUseTool allows Write / Edit /
    // MultiEdit / NotebookEdit calls whose resolved target path lands
    // inside one of these directories, and keeps denying everything else.
    // Entries are expected to already be absolute, resolved paths — the RPC
    // layer (methods.ts) resolves relative writeScope entries against
    // projectDir before calling createSession.
    toolPolicy?: { writeScope?: string[] };
    // Opaque label forwarded verbatim to the adapter's own onResult hook
    // (see claude.ts's CreateClaudeAdapterOptions) as a third argument
    // whenever a `result` event fires on a prompt made through THIS
    // session. The adapter itself has no notion of what a label MEANS —
    // kept meter-agnostic by design (see claude.ts's onResult doc comment)
    // — this exists purely so a caller that drives multiple purposes
    // through the SAME registered adapter (M5b Task 4's orchestrator: one
    // "claude-code" adapter serves both a read-only REVIEW session and a
    // write-scoped ESCALATION session) can tell its own onResult hook which
    // purpose produced a given result, without the adapter needing to know
    // "review" or "escalate" mean anything. Absent -> onResult's third
    // argument is undefined; registerFrontierMethods' default wiring
    // (engines/methods.ts) treats that the same as its pre-existing
    // "frontier-review" default.
    resultLabel?: string;
  }): Promise<FrontierSession>;
}
