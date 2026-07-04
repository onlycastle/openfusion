# M7b: Cockpit Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the proven shell backbone into a usable cockpit foundation: land the engine/bridge safety inherits that a real UI depends on (cancellable long runs, framing-safe writes under cancellation, run-scoped cost, robust transport), add macOS Keychain BYOK secret storage, migrate the frontend to a real framework with a typed engine client, and ship the FIRST cockpit workflow screen (open a project → build its wiki → manage models/keys). Orchestration and eval-report-card screens follow in M7c.

**Architecture:** Tasks 1-4 are framework-INDEPENDENT engine/Rust safety+capability work (fully headless-testable). Task 5 establishes the React+TS+Vite UI foundation + a typed `engineClient` (TS wrapper over the `engine_call` command + `engine_events` Channel, with single-subscription). Task 6 is the first real workflow screen. The engine's RPC surface is unchanged except where cancellation/run-scoping requires additive methods.

**Tech Stack (verified 2026-07-04, docs/research/2026-07-04-m7-tauri-verification.md):** Tauri 2.11, `tauri::ipc::Channel<T>` for progress streaming, `invoke` for RPC, the `keyring` Rust crate (direct, macOS Security framework) for Keychain. **Frontend framework: React 18 + TypeScript + Vite** — chosen for maximum OSS-contributor familiarity (Apache-2.0 project) and ecosystem depth for the cockpit's forms/tables/streaming-log needs; Vite is already the scaffold bundler. THIS IS A VETOABLE FOUNDATIONAL CHOICE (surfaced to the operator; Tasks 1-4 are framework-independent so a change here is contained to Tasks 5-6). Node 24 sidecar runtime.

## Global Constraints

- Everything standing: strict TS NodeNext `.js` imports (engine), conventional commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, nothing under `.superpowers/`/`.claude/` of THIS repo, auth-agnostic (Rust host + engine never handle frontier creds), **open-model API keys memory-only by DEFAULT** (Keychain persistence is explicit opt-in only), prompts/model-output/file-content NEVER logged (bridge/pump/UI included), the sidecar's stdout is JSON-RPC PROTOCOL ONLY.
- **Headless vs operator split (this milestone is partly operator-gated):** Tasks 1-4 are fully headless (cargo tests + engine vitest). Tasks 5-6 build+typecheck+component-test headlessly, but the actual RENDERED UI / click-through is an OPERATOR SMOKE — enumerate each; never claim an un-rendered screen "works".
- **No regression:** `pnpm --filter @openfusion/engine test` (520) + the Rust suite (33) + `pnpm --filter @openfusion/desktop build` stay green throughout. Rust: `cargo test` + `cargo clippy --all-targets -- -D warnings` clean. Cargo/engine tests need the sidecar staged (`pnpm --filter @openfusion/engine build:sidecar` + `node apps/desktop/scripts/stage-sidecar.mjs`).
- **DeepSeek alias retirement 2026-07-24** (inside this window): any model config/UI defaults must use `deepseek-v4-flash`/`-v4-pro` ids, never the retiring `deepseek-chat`/`deepseek-reasoner` aliases.

---

### Task 1: framing-safe writes under cancellation + per-call timeout (THE HARD GATE)

**Files:** Modify `apps/desktop/src-tauri/src/engine_bridge.rs`, `apps/desktop/src-tauri/src/commands.rs`; tests in `tests/engine_bridge.rs`.

**Why first:** M7a's final review established this as the hard gate before ANY per-call timeout/cancellation is introduced: a `call()` cancelled mid-`write_all` leaves a partial ndjson line on the engine's stdin → desyncs framing of the NEXT request → protocol corruption. The cockpit WILL add per-call timeouts/cancel (Task 2, the UI), so this must land first.

**Interfaces:**
- Make wire-writes ATOMIC w.r.t. caller cancellation: replace the "write inside `call()` before await" model with a dedicated WRITER TASK owning `ChildStdin`, fed by an `mpsc` channel. `call()` serializes its request, sends the bytes over the mpsc to the writer task (a send is not cancellation-sensitive mid-write — the writer task does the actual `write_all` and it runs to completion regardless of whether the caller's future is dropped), then awaits the oneshot response. A cancelled `call()` drops its future AFTER the request is already queued/sent — the writer still writes the WHOLE line (no partial), so framing stays intact. The PendingGuard still removes the pending entry on cancel (the response, if it comes, is dropped). Document the ordering invariant: a request is either fully written or (if the mpsc send itself is cancelled before enqueue) never written — never partial.
- Add per-call timeout support NOW that it's safe: `call()` (or a `call_with_timeout(method, params, timeout)`) that, on timeout, drops the response wait (PendingGuard cleans the entry) WITHOUT corrupting the stream (the request was already fully written by the writer task; a late response is dropped). engine_call command gains an optional `timeoutMs`. On timeout → an EngineCallError with a timeout code.
- Preserve all M7a bridge properties (correlation, no-cross-talk, no-hang-on-death, bounded shutdown, pump teardown) — don't regress the 16 bridge tests.

**Tests:** the load-bearing one — a `call()` cancelled MID-large-write (4MiB payload, via the writer-task model) → the engine still receives a COMPLETE well-formed request (no partial line), and a SUBSEQUENT call's framing is intact (the next request's response correlates correctly). Prove RED against the old inline-write model (partial line → next request mis-frames). Plus: per-call timeout fires → EngineCallError timeout code, stream still usable for the next call; writer-task survives child death; concurrent calls still no-cross-talk.

- [ ] **Step 1: RED** (mid-write-cancel framing test against a mock that echoes back the exact bytes it received per line, proving completeness) → **Step 2: implement writer-task + timeout → GREEN** (cargo test 3x, clippy -D warnings) → **Step 3: Commit** `fix(desktop): atomic wire-writes via writer task + safe per-call timeout`

---

### Task 2: engine-side cancellation of long runs (orchestrate/evals)

**Files:** Modify `packages/engine/src/orchestrate/orchestrate.ts` + `methods.ts`, `packages/engine/src/evals/run.ts` + `methods.ts`, `packages/engine/src/engine.ts` (a cancel registry); tests.

**Why:** the cockpit needs a CANCEL button for a long orchestrate/evals run. Today these are long RPC calls with no cancel (M6 inherit a). engine.close aborts everything; there's no per-run cancel.

**Interfaces:**
- A run gets an id: `engine.orchestrate`/`engine.evals.run` accept an optional `runId` (client-supplied uuid) OR return one at start via an early progress notification. Add `engine.cancel { runId }` → aborts THAT run: wire an AbortController per run into the orchestrate/evals flow (thread the signal into worker.run's timeout-abort machinery + reviewDiff's promptForJson + the escalation session; reuse the M5b abort plumbing). A cancelled run returns a SERVER_ERROR with a "cancelled" marker (distinct from a failure) + any partial worktree/attempts data.
- Wire the M7a-deferred `abortAll` → the `#tracked` frontier sessions so cancel/close reaches adapter-direct sessions (M6 inherit — the review flagged abortAll only reaches addressable handles).
- Cancellation must be CLEAN: a cancelled orchestrate leaves no orphaned worker worktree in an inconsistent state (cleanup rejected/partial per the existing discipline); a cancelled evals run cleans its tmp scratch dirs.

**Tests:** (engine vitest, fake models) an in-flight orchestrate with a scripted-slow fake worker + `engine.cancel(runId)` → the run aborts promptly (bounded), returns the cancelled marker, worktrees cleaned; same for evals.run mid-batch (cancels between/within tasks, scratch dirs removed); abortAll reaches a tracked frontier session (spy).

- [ ] **Step 1: RED** cancel tests → **Step 2: implement per-run AbortController + engine.cancel + abortAll→#tracked → GREEN** (exact totals) → **Step 3: Commit** `feat(engine): cancellable orchestrate/evals runs via engine.cancel`

---

### Task 3: transport aggregate hardening

**Files:** Modify `packages/engine/src/rpc/` (the ndjson stdio pipeline), tests.

**Why:** the Rust client now PIPELINES concurrent requests for real (M7a), raising the stakes on the engine's stdio transport (M6 inherit f). Harden before heavy notification streaming.

**Interfaces:**
- ndjson READER: a line-buffer CAP (reject/error a single line exceeding a sane bound rather than unbounded buffering — a giant param blob shouldn't OOM the engine); CRLF tolerance test (a `\r\n`-terminated line parses same as `\n`); a partial-line-across-chunks test (a request split across two stdin reads reassembles correctly).
- WRITER/backpressure: if the engine writes notifications faster than stdout drains (a slow Rust consumer), the engine must not unbounded-buffer or block the event loop pathologically — apply/ verify a drain strategy (the existing pipeline may already await writes; add a test that a slow reader applies backpressure without dropping protocol lines or corrupting framing).
- Fill the dispatcher test gaps the ledger names (concurrent dispatch, error-envelope edge cases) if cheap.

**Tests:** oversized-line cap; CRLF; split-across-chunks reassembly; concurrent-request ordering-independence; a slow-drain backpressure test (no dropped/corrupted lines). Engine 520+ stays green.

- [ ] **Step 1: RED** transport tests → **Step 2: implement caps/CRLF/backpressure → GREEN** → **Step 3: Commit** `feat(engine): harden ndjson transport (line cap, CRLF, backpressure) for pipelined client`

---

### Task 4: macOS Keychain BYOK secret storage

**Files:** Create `apps/desktop/src-tauri/src/secrets.rs` (+ lib.rs wiring, commands); Cargo.toml `keyring` dep; tests.

**Interfaces:**
- A `SecretStore` in Tauri managed state: a session `Mutex<HashMap<String, String>>` (memory-only, DEFAULT) + Keychain persistence via the `keyring` crate (macOS Security framework) under a stable service name (e.g. `net.originlayer.openfusion`), keyed by a provider/key id.
- Commands: `#[tauri::command] fn set_secret(state, id: String, value: String, persist: bool)` (store in memory; if persist, ALSO write to Keychain), `fn get_secret(state, id) -> Option<String>` (memory first, then Keychain if opted-in), `fn delete_secret(state, id)` (memory + Keychain), `fn list_secret_ids(state) -> Vec<String>` (ids only — NEVER values), `fn load_persisted_secrets(state)` (on startup, load opted-in Keychain entries into memory). NEVER log secret VALUES (ids/metadata only). NEVER return values in a list.
- The engine receives keys per-call over JSON-RPC (BYOK memory-only in the engine too — unchanged); the SHELL is where the user enters/persists them and forwards them into engine calls. Document the flow: keys live in the Rust SecretStore; the UI reads them (get_secret) to pass into `engine.models.configure`-style calls; they are memory-only unless the user opts to persist.

**Tests:** (cargo) set/get/delete round-trip in MEMORY (no Keychain — gate the actual Keychain write behind a `#[ignore]`/env-gated test since CI Keychain access is flaky/needs a login keychain; the memory path is the headless-testable core); list returns ids only never values; persist=false never touches Keychain (spy/inject a fake keyring backend if the crate allows, else test the memory path + document the Keychain path as operator-verified). No value logging (grep).

- [ ] **Step 1: RED** secret-store memory tests → **Step 2: implement SecretStore + commands + keyring → GREEN** (cargo, clippy) → **Step 3: Commit** `feat(desktop): Keychain BYOK secret store (memory-default, opt-in persist)`
- [ ] **OPERATOR SMOKE (document):** persist a key → quit → relaunch → the key is restored from Keychain (needs the login keychain + a real run).

---

### Task 5: React+TS+Vite UI foundation + typed engine client

**Files:** Migrate `apps/desktop/src/` to React+TS+Vite (add react/react-dom + @vitejs/plugin-react; index.html mounts a root); create `apps/desktop/src/engineClient.ts` (typed wrapper), an app shell + minimal routing, base styles; component tests (vitest + @testing-library/react or a headless render).

**Interfaces:**
- `engineClient.ts`: `call<T>(method: string, params: unknown, opts?: {timeoutMs?: number}): Promise<T>` over `invoke('engine_call', {method, params, timeoutMs})`; a SINGLE `engine_events` subscription per app (fix the M7a de-dup finding — one Channel, a typed emitter/observable the UI subscribes to, NOT a new engine_events invoke per component); typed error surface (EngineCallError → a thrown typed error). Typed method wrappers for the ones Task 6 needs (models.list, wiki.build, secrets via the Tauri secret commands). NO secret VALUES logged.
- App shell: a left-nav/workspace layout scaffold with routing (a couple of routes: Project, Keys — the orchestrate/eval routes are stubs for M7c). Loading/error boundary. Theme (light/dark) is nice-to-have, minimal.
- Keep it typed + testable. `pnpm --filter @openfusion/desktop build` + typecheck clean; a component test renders the shell + a mocked engineClient call.

**Tests (headless):** engineClient call success/error mapping (mock `invoke`); the single-subscription invariant (multiple UI subscribers → ONE engine_events invoke); the shell renders + routes (component test with a mocked client). Rendered look/interaction is an OPERATOR SMOKE.

- [ ] **Step 1: RED** engineClient + shell component tests → **Step 2: React migration + engineClient + shell → GREEN** (build, typecheck, component tests) → **Step 3: Commit** `feat(desktop): React+Vite UI foundation with typed single-subscription engine client`

---

### Task 6: first cockpit workflow screen — project + wiki + keys

**Files:** `apps/desktop/src/` — a Project screen + a Keys screen (React), using engineClient + the Tauri secret commands; component tests.

**Interfaces:**
- **Keys screen:** list configured providers (ids only), add/edit a BYOK key (set_secret with a persist toggle — default OFF/memory-only, clearly labeled), delete. Wire to Task 4's secret commands. NEVER render a stored value back (write-only field; show "configured" state). Choosing a provider uses the CORRECT model ids (deepseek-v4-flash/-pro, not the retiring aliases).
- **Project screen:** pick a project directory (Tauri dialog), show its git/status, a "Build wiki" action → `engine.wiki.build` with a live progress area (subscribe to engine_events wiki.build progress via engineClient), render the result (files indexed, symbols/refs). This proves the reactive-UI-over-bridge pattern with a REAL engine workflow end to end (a real long-ish call + streamed progress + a result).
- Errors surface cleanly (an unconfigured provider, a non-git dir → the engine's SERVER_ERROR rendered as a friendly message, not a stack trace).

**Tests (headless):** component tests with a mocked engineClient — the Keys screen calls set_secret with persist flag, never renders a value; the Project screen invokes wiki.build and renders streamed progress + result; error states render. The actual click-through in the running app is the OPERATOR SMOKE.

- [ ] **Step 1: RED** screen component tests → **Step 2: implement Keys + Project screens → GREEN** (build, typecheck, component tests) → **Step 3: Commit** `feat(desktop): project + keys cockpit screens (wiki build with live progress, BYOK management)`

---

## Milestone exit checklist

- [ ] Engine (520+) + Rust suite + desktop build all green; cargo clippy -D warnings clean; no engine/bridge regression
- [ ] Framing-safe writes under cancellation PROVEN (the mid-write-cancel test); per-call timeout safe; engine.cancel aborts a run cleanly; transport hardened; Keychain BYOK memory-default + opt-in persist; React foundation + typed single-subscription engineClient; Project+Keys screens component-tested
- [ ] No secret VALUES logged anywhere (bridge/pump/secrets/UI); nothing under `.superpowers/`/`.claude/`; no binary/target committed; DeepSeek v4 ids used (not retiring aliases)
- [ ] OPERATOR SMOKES (documented, need a display / login keychain): the app launches into the cockpit; add a BYOK key + persist → relaunch restores it; open a project → Build wiki → live progress + result render; cancel a (M7c) long run once it exists
- [ ] Next: M7c (orchestrate + eval-report-card cockpit screens — task→routed-model→worker-diff→review→apply flow with cancel; the eval report card with verdict/savings/confidence + clean-subset numbers), then M8 (sign + notarize + DMG)
