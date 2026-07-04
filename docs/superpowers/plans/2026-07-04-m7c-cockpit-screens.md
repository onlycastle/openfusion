# M7c: Cockpit Screens — Orchestration + Eval Report Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the harness-fusion thesis VISIBLE in the cockpit. Two screens: **Orchestrate** (enter a task → watch it route to a cheap open-model worker, see the worker's diff, the frontier's review verdict, escalation-if-needed, and apply the reviewed diff — with a working Cancel button) and **Eval Report Card** (run baseline-vs-harness evals → see the verdict [pass/fail/inconclusive], the ETH-hazard flag, the savings %, pricing confidence, and the per-task / clean-subset breakdown). Plus the small engine data-exposure the screens need and the CSP hardening that gates the DMG.

**Architecture:** Tasks 1-2 land the engine/client data + plumbing the screens consume (wiki.build progress notifications; structured report-card fields; a reusable `runWithCancel` client helper that mints a UUID runId, streams progress, and cancels via `engine.cancel`). Tasks 3-4 are the two React screens. Task 5 is CSP hardening + carried engine robustness (dup-runId reject, cancel-before-register retryable, evals RPC-layer cancel test). Task 6 is docs. Tasks 1/2/5 have engine/config work that is fully headless-testable; the screens (3/4) build+component-test headlessly but their RENDERED behavior is an operator smoke.

**Tech Stack (verified 2026-07-04):** Tauri 2.11, React 18, `tauri::ipc::Channel` progress streaming via the existing single-subscription `engineClient`, the existing `engine.orchestrate`/`engine.evals.run`/`engine.cancel` RPCs. No new external deps expected (confirm at Task time).

## Global Constraints

- Everything standing: strict TS NodeNext `.js` imports (engine), conventional commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, nothing under `.superpowers/`/`.claude/`, auth-agnostic, open-model keys memory-only unless opted-in, **prompts/model-output/file-content/secret-values NEVER logged or console.*'d** (the desktop dir-walking no-console test must stay green; the engine's no-content-logging discipline holds).
- **CANCEL SEMANTICS (hard rules — from M7b final review):** the screens mint a client-side UUID `runId` and pass it to `engine.orchestrate`/`engine.evals.run`; the Cancel button calls `engine.cancel {runId}` (the ONLY true stop). **NEVER pass `timeoutMs` on a long orchestrate/evals call** (a Rust-side per-call timeout abandons the response but the engine run keeps running). Treat `engine.cancel` returning `{cancelled:false}` on a still-running run as RETRYABLE (the cancel-before-register race).
- **Headless vs operator:** Tasks 1/2/5 engine+config → headless (vitest/cargo). Tasks 3/4 screens → build + component-test headless; rendered/click-through + a real orchestrate/eval run are OPERATOR SMOKES (enumerate).
- **No regression:** engine 552 + shared 10 + Rust cargo suite + desktop component tests stay green throughout. cargo/engine need the sidecar staged.
- **DeepSeek alias retirement 2026-07-24:** any model id shown/used = `deepseek-v4-flash`/`-v4-pro`, never the retiring aliases.

---

### Task 1: engine wiki.build progress notifications + structured report-card fields

**Files:** Modify `packages/engine/src/wiki/methods.ts` (emit progress), `packages/engine/src/evals/run.ts` (structured clean-subset fields on the report card), `packages/engine/src/wiki/indexer.ts` if the progress hook lives there; tests.

**Interfaces:**
- **wiki.build progress** (the M7b-flagged gap): `engine.wiki.build` currently emits NO progress. Emit `engine.notify`-style notifications with EXACTLY the contract the ProjectScreen filter already expects: method `"wiki.build.progress"`, params `{ projectDir: string, detail: string }` (a short human string like "indexed 42/120 files" or "parsing src/foo.ts"). Emit periodically during indexing (e.g. every N files or per-phase) — NOT per-file if that floods; bound the rate. Do NOT log file CONTENT (the detail is a path/count, never file contents). Add a SHARED type (in @openfusion/shared or an exported engine type) for the progress payload so engine + UI agree; a test asserts the notification shape.
- **Eval report-card structured fields**: the report card's clean-subset numbers currently drive the verdict + notes but aren't exposed as structured fields. Add to the report card result: `cleanTaskCount`, `cleanBaselinePassed`, `cleanHarnessPassed`, `cleanSavingsPct` (the values the verdict was actually computed from), and `measurementFailureCount`. So the eval screen can SHOW why a verdict is what it is (e.g. "verdict inconclusive: 3/8 tasks had measurement failures"). Additive, no verdict-logic change.

- [ ] **Step 1: Failing tests** — wiki.build emits `wiki.build.progress` notifications with {projectDir, detail} during a build (capture notifications, assert shape + that detail carries no file content); the report card carries the clean-subset structured fields matching the verdict computation. RED.
- [ ] **Step 2: implement → GREEN** (engine 552→ +N) → **Step 3: Commit** `feat(engine): wiki.build progress notifications and structured eval report-card fields`

---

### Task 2: reusable cancellable-run client helper (engineClient)

**Files:** Modify `apps/desktop/src/engineClient.ts`; tests.

**Interfaces:**
- A `runWithCancel` helper (or `startRun`) that both screens use: `runOrchestrate(params, onProgress): { promise: Promise<OrchestrateResult>, cancel: () => Promise<void>, runId: string }` and `runEvals(params, onProgress): { promise, cancel, runId }`. Each:
  - Mints a UUID `runId` (use `crypto.randomUUID()` — available in the webview) and passes it to `engine.orchestrate`/`engine.evals.run` (NO timeoutMs on these long calls — hard rule).
  - Subscribes to `onEngineEvent`, filters progress notifications to this run (by runId if the engine tags them, else by method + a heuristic — CHECK whether orchestrate.progress/evals.progress carry a runId; if not, note that a second concurrent run's progress could interleave, and either add runId to the engine notifications [small engine change — fold into Task 1 if needed] or document the single-run-at-a-time v1 assumption), invoking onProgress; unsubscribes when the promise settles.
  - `cancel()` calls `engine.cancel {runId}`; if it returns `{cancelled:false}` AND the run is still pending, it's RETRYABLE (retry a bounded couple of times with a short delay — the cancel-before-register race) before giving up; document.
  - The promise rejects with a typed CancelledError (distinct from a failure — detect `EngineError.data.cancelled === true`) so the UI shows "Cancelled" not "Failed".
- Typed method wrappers `orchestrate(params)`/`evalsRun(params)` if not present, returning the typed results (OrchestrateResult / report card — extend the hand-mirrored types with the Task-1 structured fields; note the drift caveat).

- [ ] **Step 1: Failing tests** (mock invoke/onEngineEvent): runOrchestrate mints a runId + passes it (NO timeoutMs — assert the invoke args have no timeoutMs); progress notifications for this runId reach onProgress; cancel() calls engine.cancel with the runId; a {cancelled:false} on a pending run retries then the CancelledError is distinguished from a failure; unsubscribe on settle. RED.
- [ ] **Step 2: implement → GREEN** (desktop tests) → **Step 3: Commit** `feat(desktop): cancellable-run engine client helper (UUID runId, engine.cancel, no timeoutMs)`

---

### Task 3: Orchestrate cockpit screen

**Files:** `apps/desktop/src/screens/OrchestrateScreen.tsx` (replace the stub) + test; wire the route in App.tsx.

**Interfaces:**
- Inputs: the project dir (reuse the Project selection / a picker or carry the selected project via app state), a task text area, a "Run" button. On run → `runOrchestrate({projectDir, task}, onProgress)` (Task 2 helper).
- Live view: a progress area streaming the orchestrate.progress stages (load → route → worker:n → review:n → escalate → done) as they arrive; SHOW the routed model/agent (from the result or an early progress event), the worker's DIFF (rendered readably — a diff view; a simple monospace + +/- coloring is fine, don't over-build), the review VERDICT (approve/request-changes + reasons + severity), escalation status, the final outcome (worker-approved/escalated/failed), and the cost split (worker vs review vs escalate, with the estimate-class + pricingConfidence caveat).
- A **Cancel button** (visible while running) → the helper's cancel(); shows "Cancelling…" then "Cancelled" (distinct from failed).
- An **Apply diff** action on a successful outcome → `engine.orchestrate.apply {projectDir, diff}` (git apply --3way to the project) → show applied/failed. Make clear the diff is applied to the working tree (not committed).
- Errors (no harness, non-git, unconfigured provider) → the engine's SERVER_ERROR rendered friendly.
- NEVER log/console the task, diff, model output, or params.

- [ ] **Step 1: Failing component tests** (mock the helper/engineClient): run invokes the helper with {projectDir, task}; streamed progress stages render; the routed model + diff + verdict + cost render from a mocked result; Cancel calls the helper cancel + shows Cancelled (not Failed); Apply calls engine.orchestrate.apply; an EngineError renders friendly; no task/diff logged. RED.
- [ ] **Step 2: implement → GREEN** (build, typecheck, component tests) → **Step 3: Commit** `feat(desktop): orchestrate cockpit screen (route → worker diff → review → escalate → apply, with cancel)`
- [ ] **OPERATOR SMOKE (document):** run a real orchestration on a project → watch the stages, the routed cheap model, the diff, the frontier review; cancel mid-run; apply an approved diff.

---

### Task 4: Eval report card cockpit screen

**Files:** `apps/desktop/src/screens/EvalsScreen.tsx` (replace the stub) + test; wire the route.

**Interfaces:**
- Inputs: project dir + a way to specify eval tasks (v1: the golden-commit descriptors the engine accepts — a list of {commitSha, testCommand} entries, or a simple "use recent commits" affordance; keep v1 minimal — a textarea/form for commit shas + a test command, matching what engine.evals.run accepts). A "Run evals" button → `runEvals({projectDir, tasks}, onProgress)`.
- Live view: evals.progress streaming (per-task baseline/harness). On completion, the REPORT CARD: the **verdict** prominently (pass = green, **fail = a clear ETH-HAZARD warning** "the harness produced WORSE quality than baseline — flagged, not shipped", inconclusive = amber with the reason from the structured fields); the **savings %** (with the estimate-class + pricingConfidence label — if confidence isn't "verified", show a caveat badge); baseline vs harness passed counts; the **per-task table** (id, baseline pass/fail, harness pass/fail, outcome, cost); the **clean-subset** numbers (cleanTaskCount/cleanBaseline/cleanHarness/cleanSavings + measurementFailureCount) explaining the verdict; the sample-size note (< threshold → "demo, not a claim").
- A **Cancel button** → the helper cancel(); shows Cancelled.
- Errors friendly; NEVER log task/diff/output.

- [ ] **Step 1: Failing component tests**: run invokes runEvals; progress renders; a mocked report card renders — verdict pass/fail/inconclusive each with the right treatment (assert the ETH-hazard FAIL shows the quality-degraded warning; assert an unverified pricingConfidence shows the caveat); per-task table + clean-subset numbers render; Cancel → Cancelled; friendly error. RED.
- [ ] **Step 2: implement → GREEN** → **Step 3: Commit** `feat(desktop): eval report card screen (verdict, ETH-hazard flag, savings, per-task, clean-subset)`
- [ ] **OPERATOR SMOKE (document):** run real evals (golden commits from a project) → see the verdict + a real savings number + the per-task breakdown.

---

### Task 5: CSP hardening + carried engine robustness

**Files:** Modify `apps/desktop/src-tauri/tauri.conf.json` (CSP); `packages/engine/src/rpc/cancel-registry.ts` (dup-runId reject); `packages/engine/test/evals-*.test.ts` (evals RPC-layer cancel test); `packages/engine/src/orchestrate/orchestrate.ts` + `evals/run.ts` (tag progress notifications with runId if Task 2 found they lack it); tests.

**Interfaces:**
- **CSP (pre-DMG gate):** replace `security.csp: null` in tauri.conf.json with a real, tight policy that still lets the React app + Tauri IPC/Channel work (Tauri injects its own IPC; a typical Tauri CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'` — adjust for what the app actually needs, e.g. if styles are inlined by Vite; NO remote origins — the app is fully local). VERIFY the app still builds AND (operator) runs under the CSP — a too-tight CSP silently breaks the webview. Document the policy + why each directive.
- **dup-runId reject (M7b Minor):** `CancelRegistry.register` currently clobbers on a duplicate runId. Reject a duplicate at register with a SERVER_ERROR (a run whose runId is already active can't start) so two runs can't share/steal a controller. Test.
- **evals RPC-layer cancel test (FIX BATCH T2.1):** add a test exercising cancellation through the actual `engine.evals.run` methods.ts handler wiring (register/deregister/cancel), mirroring the tested orchestrate path — closing the coverage gap the M7b review named.
- **runId on progress notifications (if needed):** if Task 2 found orchestrate.progress/evals.progress don't carry a runId (so the client can't reliably filter concurrent runs), add `runId` to those notification payloads. Test the shape.

- [ ] **Step 1: Failing tests** — dup-runId register → SERVER_ERROR; evals RPC-layer cancel aborts + deregisters; progress notifications carry runId (if added). CSP: build succeeds with the policy. RED where applicable.
- [ ] **Step 2: implement → GREEN** (engine + desktop build) → **Step 3: Commit** `feat: tighten CSP; reject duplicate runId; evals RPC cancel coverage; runId on progress`
- [ ] **OPERATOR SMOKE (document):** the app runs correctly under the tightened CSP (no webview breakage).

---

### Task 6: docs

**Files:** `apps/desktop/README.md`, root README, spec §5.

**Content:** README — the cockpit screens (Project/Keys/Orchestrate/Evals), the cancel semantics (UUID runId + engine.cancel, why not timeoutMs), the estimate-class/pricing-confidence caveats on displayed savings, the ETH-hazard flag meaning, the CSP, and the updated OPERATOR SMOKES list. Spec §5: the realized cockpit. Keep accurate.
- [ ] Implement, all suites green, commit `docs: cockpit orchestrate/evals screens, cancel semantics, savings caveats`

---

## Milestone exit checklist

- [ ] Engine (552+) + shared + Rust cargo + desktop component tests all green; clippy -D warnings clean; no regression
- [ ] wiki.build streams progress; orchestrate + eval screens render the full flow (route→worker→review→escalate→apply; verdict+savings+ETH-flag+clean-subset) with working Cancel (UUID runId → engine.cancel, no timeoutMs); CSP tightened + app builds under it; dup-runId rejected; evals RPC cancel covered
- [ ] No task/diff/model-output/secret-value logged or console.*'d; DeepSeek v4 ids only; nothing under `.superpowers/`/`.claude/`; no binary/target committed
- [ ] OPERATOR SMOKES (documented): run a real orchestration (watch route→cheap-worker→diff→review→escalate→apply, cancel mid-run); run real evals (verdict + real savings number + per-task); app runs under the tightened CSP
- [ ] Next: M8 (sign + notarize + DMG) — packaged-path dispatch, nested signing + Tauri #11992 pre-sign, notarize/staple, JIT-entitlement empirical check; CSP now resolved. THE .dmg SHIPS.
