# M3: Frontier Engines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine can run frontier orchestration sessions — Claude Code embedded via the Agent SDK, wiki MCP auto-attached, streamed to the client as JSON-RPC notifications — with session lifecycle (start/prompt/stop/list), subprocess hygiene, and cost accounting folded into the meter. Exit: a frontier session answers questions about a repo using `wiki_query`/`wiki_map` tools (manual smoke; CI runs against a fake adapter). Plus the M2 inherits: `timeoutMs` on model calls, providerMetadata passthrough, and the concurrency-ownership decision in writing.

**Architecture:** `src/engines/` mirrors the sibling-service pattern: `types.ts` (ACP-shaped `FrontierAdapter`/`FrontierSession`/`FrontierEvent` — interface stays protocol-agnostic so an ACP or Codex adapter can slot in later), `claude.ts` (Agent SDK adapter; SDK spawns the `claude` CLI subprocess), `methods.ts` (`FrontierService` on Engine + `engine.frontier.*` RPCs). Streaming uses server→client JSON-RPC notifications (`frontier.event`), which requires giving Engine a `notify` sink wired to stdout in main.ts. CI never runs the real CLI: the adapter is constructor-injected (`queryFn`) and tests use fakes; a manual smoke script gated by `OPENFUSION_CLAUDE_SMOKE=1` covers the real path.

**Auth posture (from docs/research/2026-07-03-m3-api-verification.md — binding):** the engine NEVER handles, prompts for, stores, or routes frontier credentials. The Agent SDK inherits whatever auth the operator configured in the official CLI themselves. No login flows, no token params in any RPC schema.

**Tech Stack (verified 2026-07-03):** `@anthropic-ai/claude-agent-sdk@^0.3` (subprocess architecture; `mcpServers: { type: "http" }`; `canUseTool`; `permissionMode`), MCP SDK stays 1.29 (v2 not GA). Codex + ACP adapters deferred (research verdicts recorded).

## Global Constraints

- Everything standing: Node ≥22, strict TS NodeNext `.js` imports, tsconfig.test.json coverage, stdout = JSON-RPC only (responses AND notifications — both single-line ndjson), tmp fixtures, conventional commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, nothing under `.superpowers/`/`.claude/`, no live keys/logins in CI.
- **Auth-agnostic rule:** no RPC schema in this milestone may accept credentials or tokens; no code may read `ANTHROPIC_*`/`CLAUDE_*` env vars; the SDK's ambient auth is the only path.
- **Concurrency ownership (M2 final review, Important #4 — DECIDED):** the client (shell/orchestrator) bounds in-flight `engine.models.complete` and `engine.frontier.prompt` calls; StdioPipeline stays uncapped. Record as a comment atop `StdioPipeline` and in README's protocol notes (Task 5).
- Frontier prompts/responses are never logged; `engine.log` gets lifecycle lines only (`frontier.start <sessionId>`, `frontier.prompt <sessionId> done|error|timeout`, `frontier.stop <sessionId>`).
- CI must pass with no `claude` binary installed: anything touching the real SDK adapter path is either fake-injected or gated behind `OPENFUSION_CLAUDE_SMOKE=1` (test skipped when unset).

---

### Task 1: Model-call hardening — timeoutMs, providerMetadata, NaN guard

**Files:**
- Modify: `packages/engine/src/models/methods.ts`, `packages/engine/src/models/pricing.ts`
- Test: extend `packages/engine/test/models-complete.test.ts`, `models-pricing.test.ts`

**Interfaces:**
- `engine.models.complete` params gain `timeoutMs?: int 1000..600000` (per-ATTEMPT deadline). Implementation: `generateText({ ..., abortSignal: AbortSignal.timeout(timeoutMs) })` when set. A timed-out attempt counts as RETRYABLE (a hung provider is exactly what failover exists for): extend `isRetryableModelError` — abort/timeout errors (`err.name === "AbortError" || err.name === "TimeoutError"`, and `APICallError.isInstance(err) && err.cause` matching those) return true. Attempt error strings for timeouts must contain `"timed out"` (normalize the message).
- `engine.models.complete` result gains `providerMetadata?: unknown` — the raw `result.providerMetadata` from the SDK when present (needed for the pre-savings live-metering smoke: Moonshot/GLM cache-field discovery). Never logged.
- `normalizeUsage` NaN guard: any non-finite number → 0 (`Number.isFinite(v) ? v : 0` on all three fields).

- [ ] **Step 1: Failing tests**
  - Timeout: configure an openai-compatible provider whose injected fetch returns `new Promise(() => {})` (never settles); call complete with `timeoutMs: 500`, NO fallbacks → RPC error SERVER_ERROR, `data.attempts[0].error` contains "timed out"; the call resolves in < 5s (assert elapsed).
  - Timeout failover: same hung primary + fixture-backed fallback, `timeoutMs: 500` → succeeds via fallback, attempts length 2.
  - providerMetadata: the existing fixture test additionally asserts `result.providerMetadata` is defined (openai-compatible providers return at least an empty object — if the SDK omits it for this adapter, assert the field is absent WITHOUT error and note it; do not fabricate).
  - NaN guard: `normalizeUsage({ inputTokens: NaN, outputTokens: 5 })` → `{0, 5, 0}`.
- [ ] **Step 2: RED run.**
- [ ] **Step 3: Implement** (schema, abortSignal wiring, classifier branches, metadata passthrough, guard).
- [ ] **Step 4: GREEN** — full suite, exact totals (~127).
- [ ] **Step 5: Commit** — `feat(engine): per-attempt timeoutMs with retryable timeouts, providerMetadata passthrough, NaN-safe usage`

---

### Task 2: Frontier scaffolding — types, service, RPC, notifications

**Files:**
- Create: `packages/engine/src/engines/types.ts`, `packages/engine/src/engines/methods.ts`
- Modify: `packages/engine/src/engine.ts` (notify sink + FrontierService + re-exports), `packages/engine/src/main.ts` (wire notify to stdout), `packages/engine/src/rpc/stdio.ts` (expose a `writeNotification` helper OR reuse the write callback — see Step 3)
- Test: `packages/engine/test/frontier-methods.test.ts`

**Interfaces:**
- `types.ts`:
  ```ts
  export type FrontierEvent =
    | { type: "text"; text: string }
    | { type: "tool_use"; name: string; summary: string }
    | { type: "result"; resultText: string; costUsd: number | null;
        usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
        numTurns: number; durationMs: number; engineSessionId: string | null }
    | { type: "error"; message: string };
  export interface FrontierPromptHandle {
    events: AsyncIterable<FrontierEvent>;
    abort(): void;
  }
  export interface FrontierSession {
    readonly id: string;               // OUR session id (uuid)
    readonly projectDir: string;
    prompt(text: string, opts?: { timeoutMs?: number }): FrontierPromptHandle;
    close(): Promise<void>;            // must kill any subprocess
  }
  export interface FrontierAdapter {
    readonly kind: string;             // "claude-code" | future: "codex" | "acp:*"
    createSession(opts: {
      projectDir: string;
      wikiMcpUrl: string | null;
      log: (line: string) => void;
    }): Promise<FrontierSession>;
  }
  ```
- Engine gains `notify: (method: string, params: unknown) => void` (constructor option, default no-op; main.ts wires it to `process.stdout.write(encodeNdjson({ jsonrpc: "2.0", method, params }))`).
- `FrontierService`: `registerAdapter(adapter)`, sessions `Map<sessionId, {session, adapter}>`, `close()` closes all sessions. Default registration of the Claude adapter happens in Task 3 (this task registers none; tests inject fakes).
- RPC (all zod-validated): `engine.frontier.start { projectDir, engine?: string ("claude-code" default), attachWiki?: boolean (default true) }` → `{ sessionId, engine, wikiAttached: boolean }` — requires git repo (SERVER_ERROR otherwise); when attachWiki and the wiki is built, ensures `engine.mcp` server for the project (reuse WikiService's startMcpServer path) and passes its URL; when wiki not built, `wikiAttached: false` (no error). Unknown adapter kind → SERVER_ERROR. `engine.frontier.prompt { sessionId, text, timeoutMs? }` → streams `frontier.event { sessionId, seq, event }` notifications for each FrontierEvent, then RESPONDS with the final `{ result: <the result event fields>, events: <count> }`; unknown sessionId → SERVER_ERROR; concurrent prompt on the same session → SERVER_ERROR "prompt already in flight". `engine.frontier.stop { sessionId }` → `{ stopped: boolean }`. `engine.frontier.list {}` → `{ sessions: [{ sessionId, engine, projectDir }] }`.
- [ ] **Step 1: Failing tests** — all with a FAKE adapter (helper in the test file): fake `createSession` returns a session whose `prompt` yields `[{text}, {tool_use}, {result ...}]` from an async generator. Tests: start→prompt round-trip (collect notifications via an Engine constructed with a capturing `notify`; assert seq ordering 0,1,2, final response result matches the result event, meter-independence); start on non-git dir → SERVER_ERROR; unknown session prompt → SERVER_ERROR; concurrent prompt rejection; stop → `{stopped: true}` and session's close() called (spy flag); list reflects state; attachWiki=false path (wikiAttached false, no MCP started); Engine.close closes sessions (spy).
- [ ] **Step 2: RED run.**
- [ ] **Step 3: Implement.** Keep notification writing on the SAME write path as responses (single-line ndjson via the pipeline's write callback — pass `engine.notify` the same writer main.ts gives StdioPipeline; both funnel through one function so interleaving stays line-atomic).
- [ ] **Step 4: GREEN** — full suite, exact totals (~135+).
- [ ] **Step 5: Commit** — `feat(engine): frontier session service with ACP-shaped adapter interface and event notifications`

---

### Task 3: Claude Code adapter (Agent SDK)

**Files:**
- Modify: `packages/engine/package.json` (add `@anthropic-ai/claude-agent-sdk`)
- Create: `packages/engine/src/engines/claude.ts`
- Modify: `packages/engine/src/engines/methods.ts` or `engine.ts` (register default adapter), re-exports
- Test: `packages/engine/test/frontier-claude.test.ts` (fake queryFn), `packages/engine/test/frontier-claude-smoke.test.ts` (env-gated real smoke)

**Interfaces:**
- `createClaudeAdapter(options?: { queryFn?: typeof query }): FrontierAdapter` — kind `"claude-code"`. Session `prompt(text)`:
  - calls `queryFn({ prompt: text, options: { cwd: projectDir, resume: engineSessionId ?? undefined, mcpServers: wikiMcpUrl ? { wiki: { type: "http", url: wikiMcpUrl } } : undefined, allowedTools: ["Read", "Grep", "Glob", "Bash(git log*)", "mcp__wiki__wiki_query", "mcp__wiki__wiki_map"], permissionMode: "default", canUseTool: async () => ({ behavior: "deny", message: "openfusion v1: read-only orchestration" }) } })` — v1 is READ-ONLY orchestration (answers/plans; no edits) per the milestone exit criterion; write-tools arrive with M5's worker/review loop. (Verify exact option/type names against the installed SDK's sdk.d.ts; adapt minimally and report — the research doc is 0.3.199-accurate.)
  - maps SDK messages → FrontierEvents: assistant text blocks → `text`; assistant tool_use blocks → `tool_use {name, summary: JSON.stringify(input).slice(0,200)}`; `result` message → `result` event (map `total_cost_usd` → costUsd, usage via the same normalize shape, `session_id` → engineSessionId, store it for resume on next prompt).
  - abort(): AbortController passed to queryFn if supported (check sdk.d.ts for abort/signal option; else close the Query iterator via `.close()`/returning early — document which).
  - session.close(): terminate any in-flight query (Query.close() kills the CLI subprocess per SDK docs) and drop resume state.
- Cost accounting: on each `result` event the adapter calls a provided `onResult` hook; `FrontierService` records to `engine.models`' CostMeter as kind `"frontier-claude"`, model from `modelUsage`'s dominant key or `"claude-code"`, costUsd from the SDK figure (estimate — flagged as such), usage normalized. (Meter gains nothing new; UsageRecord already fits.)
- [ ] **Step 1: Install + probe** — `pnpm add @anthropic-ai/claude-agent-sdk --filter @openfusion/engine`; probe `node -e "import('@anthropic-ai/claude-agent-sdk').then(m => console.log('sdk-ok', typeof m.query))"` → `sdk-ok function`. STOP → NEEDS_CONTEXT on failure.
- [ ] **Step 2: Failing tests (fake queryFn)** — fake yields: system msg (ignored), assistant msg with one text block + one tool_use block, result msg with `total_cost_usd: 0.12`, usage `{input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 300}`, `session_id: "sess-abc"`, `num_turns: 3`. Assert: events sequence `text`, `tool_use`, `result`; result fields mapped (costUsd 0.12, usage {1000,200,300}, engineSessionId "sess-abc"); SECOND prompt passes `resume: "sess-abc"` to queryFn (capture options); meter gained one record kind "frontier-claude"; mcpServers present when wikiMcpUrl set, absent when null; canUseTool denies (call the captured option fn, assert behavior deny).
- [ ] **Step 3: RED, implement, GREEN** — full suite, exact totals. The env-gated smoke test: `it.skipIf(!process.env.OPENFUSION_CLAUDE_SMOKE)("answers a repo question using the wiki", ...)` — real adapter, this repo cloned to tmp, wiki built, MCP attached, prompt "Using the wiki_query tool, in which file is createEngine defined? Answer with just the path."; assert response text contains `packages/engine/src/engine.ts`; 120s timeout. CI skips it (no env var).
- [ ] **Step 4: Commit** — `feat(engine): Claude Code frontier adapter via Agent SDK with wiki MCP attach and read-only permissions`

---

### Task 4: Lifecycle robustness

**Files:**
- Modify: `packages/engine/src/engines/methods.ts`, `packages/engine/src/engines/claude.ts` (as needed)
- Test: extend `packages/engine/test/frontier-methods.test.ts`

**Interfaces / behaviors:**
- Prompt timeout: `engine.frontier.prompt`'s `timeoutMs` (default 600000, max 3600000) arms a timer that calls `handle.abort()`; the RPC then errors SERVER_ERROR "frontier prompt timed out" AFTER emitting a final `frontier.event` error notification; session remains usable for the next prompt.
- Double-stop is idempotent (`{stopped: false}` second time); stop during in-flight prompt aborts it first (prompt RPC errors, no hang); `Engine.close()` with an in-flight prompt resolves within a bounded time (abort-then-close, tested with a fake session whose events iterator blocks until abort).
- Fake-adapter tests for all of the above (abort plumbed through the fake's generator via AbortSignal-style flag).
- [ ] **Step 1: Failing tests → Step 2: RED → Step 3: implement → Step 4: GREEN (exact totals) → Step 5: Commit** — `feat(engine): frontier prompt timeouts and abort-safe session lifecycle`

---

### Task 5: Protocol docs + README + ledger-carried notes

**Files:**
- Modify: `README.md`, `packages/engine/src/rpc/stdio.ts` (concurrency-ownership comment), `docs/superpowers/specs/2026-07-03-harness-fusion-app-design.md` (§12 risk note)
- Test: none (docs) — full suite must stay green

**Content:**
- README: status paragraph (frontier sessions; auth-agnostic posture sentence: "OpenFusion never handles frontier credentials — the embedded official CLI uses whatever login you have configured; review your provider's terms for subscription use"), plus a short "Engine protocol" section: ndjson JSON-RPC, responses in completion order, `frontier.event` notifications, client owns in-flight bounding.
- stdio.ts comment atop StdioPipeline recording the concurrency-ownership decision.
- Spec §12: append risk 5 — "Subscription-auth ToS: engine is auth-agnostic by design (M3); distributing any claude.ai login flow is prohibited by provider terms; revisit before public DMG release (M8)."
- [ ] Implement, `pnpm build && pnpm typecheck && pnpm test` green, commit — `docs: frontier protocol notes, auth posture, concurrency ownership`

---

## Milestone exit checklist

- [ ] Full suite green from clean checkout, no `claude` binary required
- [ ] Manual (operator machine with claude logged in): `OPENFUSION_CLAUDE_SMOKE=1 pnpm --filter @openfusion/engine test -- frontier-claude-smoke` passes — frontier session answers the createEngine question via wiki tools
- [ ] `engine.models.usage` shows the frontier session's cost record alongside worker records
- [ ] Next per roadmap: M4 (harnessgen) — the understanding phase; plan-time verify: prompt design for wiki prose generation + .openfusion artifact schemas (spec §4.3); revisit MCP SDK v2 (post-07-28)
