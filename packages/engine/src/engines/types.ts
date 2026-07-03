// ACP-shaped adapter surface for frontier coding engines (Claude Code today;
// Codex / other ACP-speaking agents later — see FrontierAdapter.kind). These
// types are the load-bearing contract between engine.frontier.* RPCs
// (methods.ts) and per-engine adapters (Task 3's Claude adapter is the
// first implementation): transcribed verbatim from the M3 task-2 brief so
// downstream tasks can depend on these exact names.
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
    }
  | { type: "error"; message: string }
  | { type: "notice"; kind: "rate_limit" | "overloaded" | "api_error"; message: string };

export interface FrontierPromptHandle {
  events: AsyncIterable<FrontierEvent>;
  abort(): void;
}

export interface FrontierSession {
  readonly id: string; // OUR session id (uuid)
  readonly projectDir: string;
  prompt(text: string, opts?: { timeoutMs?: number }): FrontierPromptHandle;
  close(): Promise<void>; // must kill any subprocess
}

export interface FrontierAdapter {
  readonly kind: string; // "claude-code" | future: "codex" | "acp:*"
  createSession(opts: {
    projectDir: string;
    wikiMcpUrl: string | null;
    log: (line: string) => void;
    // Absent (or writeScope absent/empty) => today's read-only posture:
    // canUseTool denies every write tool, unconditionally. When writeScope
    // is a non-empty list, the adapter's canUseTool allows Write / Edit /
    // MultiEdit / NotebookEdit calls whose resolved target path lands
    // inside one of these directories, and keeps denying everything else.
    // Entries are expected to already be absolute, resolved paths — the RPC
    // layer (methods.ts) resolves relative writeScope entries against
    // projectDir before calling createSession.
    toolPolicy?: { writeScope?: string[] };
  }): Promise<FrontierSession>;
}
