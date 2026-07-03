# M5b: Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `engine.orchestrate {projectDir, task}` runs the full harness-fusion loop: classify the task → route it to the cheapest adequate open-model worker via the generated `routing.yaml`/agents → run the worker in an isolated worktree → have the frontier review the worker's diff → retry once, then escalate the task to the frontier itself. It returns a structured, reviewed outcome (the proposed diff, the verdict, which agent/model ran, whether it escalated, and the metered cost split by surface). This is the M5 exit criterion — the cost-savings thesis running end to end.

**Architecture:** Builds entirely on merged pieces. Task 0 gives `engine.worker.run` a deadline (unblocks escalation). Task 1 lands the small schema/infra prerequisites (agent `providerId`, per-surface meter tagging, a shared `rpc/guards.ts`). Task 2 is `src/orchestrate/routing.ts` (load harness routing+agents, classify a task to an agent, resolve its model). Task 3 is `src/orchestrate/review.ts` (frontier reviews a diff → structured verdict, via the M4 `promptForJson` driver). Task 4 is `src/orchestrate/orchestrate.ts` + `methods.ts` (`engine.orchestrate` ties classify→route→worker→review→escalate; `engine.orchestrate.apply` lands an approved diff). Task 5 is worktree lifecycle policy + docs.

## Global Constraints

- Everything standing: Node ≥22, strict TS NodeNext `.js` imports, tsconfig.test coverage, stdout protocol purity, tmp git-repo fixtures, conventional commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, nothing under `.superpowers/`/`.claude/` of THIS repo, auth-agnostic, prompts/model-output/file-content never logged (progress carries structured metadata only).
- **Diff integrity contract (from M5a final review — hard rule):** the orchestrator reviews and APPLIES the worker's base-SHA-anchored diff to the base working tree via `git apply`; it NEVER merges the worker branch. Application is an explicit step (`engine.orchestrate.apply`), gated on an approved verdict — nothing lands silently (spec §5.5 approval gate; M5b produces the reviewed diff, application is explicit).
- **No live keys / no claude binary in CI:** worker models via `MockLanguageModelV4` (ProviderRegistry.setTestModel); frontier review + escalation via a fake `FrontierAdapter` (registerAdapter). Real end-to-end is an env-gated smoke.
- **Estimate-class accounting:** all `costUsd` (worker and frontier) are estimates; `engine.orchestrate` reports a cost split with that caveat.
- **Concurrency:** the orchestrator bounds its own worker fan-out (M5b owns this — the engine stays uncapped per the M2 client-owns-bounding decision, but the orchestrator IS a client). v1 orchestrate runs ONE worker per task (no parallel decomposition yet — that is post-v1); the fan-out cap matters once Task 4's design admits parallel subtasks, which v1 defers. Document that v1 is single-worker-per-task.

---

### Task 0: worker deadlines + abort-on-close (M5a final-review Task 0)

**Files:**
- Modify: `packages/engine/src/worker/loop.ts` (abortSignal), `packages/engine/src/worker/methods.ts` (timeoutMs param, WorkerService tracks in-flight runs, close aborts)
- Test: extend `packages/engine/test/worker-methods.test.ts`, `worker-loop.test.ts`

**Interfaces:**
- `runWorkerLoop` input gains `abortSignal?: AbortSignal` → passed to `generateText({ abortSignal })`.
- `engine.worker.run` params gain `timeoutMs?: int 1000..1800000` (default 600000). Implementation: `const ac = AbortSignal.timeout(timeoutMs); runWorkerLoop({ ..., abortSignal: ac })`. A timeout/abort → the existing failure path (SERVER_ERROR + worktree breadcrumb, no auto-remove); the error message contains `"timed out"` when the signal was a timeout.
- `WorkerService` tracks in-flight runs in a `Set<AbortController>` (or a Map keyed by taskId); `close()` aborts them all before returning (engine.close no longer risks hanging behind a wedged worker). Add an internal `AbortController` per run (combined with the timeout signal via `AbortSignal.any([timeoutSignal, controller.signal])` — verify `AbortSignal.any` availability on Node 22, it's stable since 20; else fall back to a manual combined controller).

- [ ] **Step 1: Failing tests** — a mock model whose `doGenerate` returns a never-resolving promise → `engine.worker.run` with `timeoutMs: 500` rejects as SERVER_ERROR containing "timed out" within a few seconds (not a hang), worktree left in place; `engine.close()` while a run is in-flight (blocking mock) resolves within a bound (abort fires). Assert elapsed bounds.
- [ ] **Step 2: RED → implement → GREEN** (exact totals) → Commit `feat(engine): worker.run timeoutMs and abort-in-flight-on-close`

---

### Task 1: schema + meter tagging + shared guards

**Files:**
- Modify: `packages/engine/src/harness/schema.ts` (AgentModelSchema providerId), `packages/engine/src/models/meter.ts` (source tag), `packages/engine/src/models/methods.ts` + `worker/methods.ts` + `harness/generate.ts` (pass source; use shared guards)
- Create: `packages/engine/src/rpc/guards.ts`
- Test: extend `harness-schema.test.ts`, `models-*.test.ts`, add `rpc-guards.test.ts`

**Interfaces:**
- `AgentDefSchema.model`: currently `{ kind, model } | "frontier"`. Add an OPTIONAL `providerId?: string` to the object form: `{ kind: string, model: string, providerId?: string } | "frontier"`. Backward-compatible (existing agents without it still parse). The generation prompt (harness/generate.ts) SHOULD now capture providerId — update the agents-routing prompt to include providerId in its model menu and the schema it asks for; but a missing providerId is tolerated (routing resolves it — Task 2).
- `UsageRecord` gains `source: "complete" | "worker" | "frontier-review" | "frontier-escalate"` (required; existing callers pass "complete"). `CostMeter.totals()` gains `bySource: Record<string, { calls: number; costUsd: number; inputTokens: number; outputTokens: number }>`. `engine.models.usage` result carries bySource. Update the 3 existing `record()` call sites (models.complete → "complete", worker.run → "worker", and the frontier-claude adapter's onResult path → "frontier-review" for now, refined in Task 4).
- `rpc/guards.ts`: export `requireGitRepo(projectDir): string` (the getHeadSha/requireHeadSha logic, throws RpcMethodError SERVER_ERROR "not a git repository" — lift from wiki/harness/worker methods, replace the ≥3 copies), `providerKindOf(registry, providerId): string` (the kindOf duplicate), and `resolveProjectKey(projectDir): string` (the realpath keyFor duplicate). Refactor the call sites to use them; behavior identical (existing tests green).

- [ ] **Step 1: Failing tests** — AgentDefSchema accepts model with providerId and without; UsageRecord requires source, totals().bySource splits correctly across mixed-source records; engine.models.usage exposes bySource; rpc-guards unit tests (requireGitRepo throws on non-git, returns sha on git; providerKindOf; resolveProjectKey realpaths). Existing tests must stay green after the guard refactor.
- [ ] **Step 2: RED → implement → GREEN** (exact totals) → Commit `feat(engine): agent providerId, per-surface meter tagging, shared rpc guards`

---

### Task 2: routing — classify + resolve

**Files:**
- Create: `packages/engine/src/orchestrate/routing.ts`
- Test: `packages/engine/test/orchestrate-routing.test.ts`

**Interfaces:**
- `interface RoutedAgent { agent: AgentDef; taskClass: string; resolution: { providerId: string; model: string } | "frontier" }`
- `classifyTask(task: string, routing: Routing): string` — v1 keyword/heuristic classifier: map the task to one of routing's task classes by simple keyword match (task mentions "test" → tests class if present; "doc"/"readme" → docs; "fix"/"bug" → the class routing has for it; default → routing.defaults maps to an agent, so classify returns a sentinel `"__default__"` when nothing matches and the router uses defaults.agent). Keep it deterministic and documented as a v1 heuristic (M6/later may use a frontier classifier). Unknown/unmatched → `"__default__"`.
- `routeTask(task: string, harness: HarnessBundle, registry: ProviderRegistry): RoutedAgent` — classify → look up the agent for that class in routing.taskClasses (or defaults.agent for `__default__` / unknown class) → find the AgentDef by name → resolve its model: if `model === "frontier"` → resolution "frontier"; else if `model.providerId` present → `{ providerId, model }`; else DETERMINISTIC fallback: find configured providers of `model.kind` via registry.list() — exactly one → use it; zero → throw RpcMethodError SERVER_ERROR "no configured provider of kind <kind> for agent <name>"; more than one → throw SERVER_ERROR "ambiguous provider kind <kind>; agent must specify providerId". Router unknown-class → defaults.agent (never throws for classification; throws only on unresolvable model).
- Escalation-knob reconciliation (documented): the ORCHESTRATOR uses `routing.escalation.failuresBeforeFrontier` as the authority for "how many worker attempts before escalating" (default 2 per the harness). `agent.escalation.maxAttempts` is the per-agent CAP on retries WITHIN a single worker task before that attempt is considered failed (v1: treat one worker.run as one attempt; maxAttempts reserved for future in-worker retry — document that v1 does not sub-retry within a worker, so agent.escalation.maxAttempts is currently informational and routing.escalation.failuresBeforeFrontier drives escalation). State this explicitly in a comment.

- [ ] **Step 1: Failing tests** — classifyTask maps representative tasks to classes + `__default__` fallback; routeTask returns the right agent+resolution for a class; providerId-present resolves directly; kind-with-one-configured-provider resolves; kind-with-zero → SERVER_ERROR; kind-with-two → ambiguous SERVER_ERROR; unknown class → defaults.agent; frontier agent → "frontier" resolution. Build fixture HarnessBundles via the schema.
- [ ] **Step 2: RED → implement → GREEN** (exact totals) → Commit `feat(engine): task classification and routing to worker models`

---

### Task 3: the frontier review gate

**Files:**
- Create: `packages/engine/src/orchestrate/review.ts`
- Test: `packages/engine/test/orchestrate-review.test.ts`

**Interfaces:**
- `ReviewVerdictSchema` (zod): `{ decision: "approve" | "request-changes"; reasons: string[]; severity: "none" | "minor" | "major" }`.
- `reviewDiff(session: FrontierSession, input: { task: string; diff: string; summary: string }): Promise<{ verdict: ReviewVerdict; costUsd: number | null }>` — uses `promptForJson` (from `src/harness/driver.ts`) against ReviewVerdictSchema with a review prompt: "You are reviewing a change a worker made for this task. Task: <task>. The worker's summary: <summary>. The diff: <diff>. Decide whether it correctly and safely accomplishes the task. Respond with the JSON verdict." READ-ONLY frontier session (the reviewer doesn't edit — no toolPolicy). Returns the parsed verdict + the driver's costUsd.
- Fully testable with a fake FrontierSession (scripted to emit a fenced-JSON verdict) — no real adapter in CI.
- Note: an empty diff (worker did nothing) should be handled by the CALLER (orchestrate) — reviewDiff on an empty diff is valid but orchestrate treats empty-diff as an automatic worker failure before even reviewing (don't spend a frontier call reviewing nothing). Document this; the check lives in Task 4.

- [ ] **Step 1: Failing tests** (fake FrontierSession): a scripted approve verdict → returns decision "approve"; a request-changes verdict with reasons → parsed correctly; the review prompt CONTAINS the task + summary + diff (capture the fake's received prompt); cost passed through; a malformed-then-corrected verdict exercises the driver's retry (already tested in M4 but assert it composes here).
- [ ] **Step 2: RED → implement → GREEN** (exact totals) → Commit `feat(engine): frontier review gate producing structured verdicts on worker diffs`

---

### Task 4: engine.orchestrate — the end-to-end loop

**Files:**
- Create: `packages/engine/src/orchestrate/orchestrate.ts`, `packages/engine/src/orchestrate/methods.ts`
- Modify: `packages/engine/src/engine.ts` (OrchestrateService + re-exports)
- Test: `packages/engine/test/orchestrate.test.ts`; env-gated `orchestrate-smoke.test.ts`

**Interfaces:**
- `OrchestrateService` on Engine (sibling pattern), composing WorkerService + FrontierService + WorktreeManager + HarnessService(load) + ModelsService.
- `engine.orchestrate` params (zod): `{ projectDir, task: string(min1), maxWorkerAttempts?: int 1..3 (default from routing.escalation.failuresBeforeFrontier, else 2), workerTimeoutMs?, reviewTimeoutMs? }` → result:
  ```
  { outcome: "worker-approved" | "escalated" | "failed",
    agent: string, resolution: {providerId, model} | "frontier",
    attempts: Array<{ n: number; kind: "worker"|"frontier"; summary: string; verdict?: ReviewVerdict; empty?: boolean }>,
    diff: string, diffStat: string, worktree: { path, branch } | null,
    cost: { workerUsd: number|null; frontierUsd: number|null; totalUsd: number|null, note: "estimate-class" } }
  ```
- Pipeline (emit `orchestrate.progress {stage, detail}` notifications: `load`, `route`, `worker:<n>`, `review:<n>`, `escalate`, `done`):
  1. `requireGitRepo`; `loadHarness(projectDir)` — null → SERVER_ERROR "no harness; run engine.harness.generate first"; validateHarness must pass.
  2. `routeTask` → RoutedAgent. If resolution is "frontier" (agent is a frontier agent), skip workers, go straight to a frontier task attempt (escalate path).
  3. Worker attempts loop (up to maxWorkerAttempts): `engine.worker.run` with the resolved provider/model, the task, and the agent's wiki digest context (pull the relevant wiki page digests via loadHarness — or pass the agent's own prompt; keep simple: pass task + agent.prompt as the worker task framing). Get the diff.
     - EMPTY diff → this attempt failed (no review call), record attempt {empty:true}, retry.
     - Non-empty → start a READ-ONLY frontier session (via FrontierService adapter) with wiki attached, `reviewDiff` → verdict.
     - "approve" → outcome "worker-approved", return with this attempt's worktree (LEFT IN PLACE for apply). Break.
     - "request-changes" → record, clean up THIS attempt's worktree (worker.cleanup — a rejected attempt's worktree is discarded; the NEXT attempt gets a fresh one), retry.
  4. After maxWorkerAttempts failures → ESCALATE: run the task on the FRONTIER directly in a fresh worktree WITH write policy (frontier session with `toolPolicy.writeScope` = the worktree root, so the frontier edits files itself via canUseTool — this is the first use of the M4 write-policy path in anger; the frontier session prompt: "Complete this task by editing files: <task>"; then diff the worktree). Frontier escalation produces a diff; outcome "escalated". (If even the frontier produces an empty diff or errors → outcome "failed".)
  5. Cost: sum worker attempts' costUsd (workerUsd) and review+escalate costUsd (frontierUsd); tag meter records with the right source.
- `engine.orchestrate.apply { projectDir, diff }` → `{ applied: boolean }`: `git -C <projectDir> apply --3way <diff>` (or `git apply` — apply the unified diff to the base working tree; --3way is more robust to drift). Returns applied true/false; on failure SERVER_ERROR with the git error. This is the explicit landing step (approval gate lives above it in M7). Does NOT commit — leaves changes in the base working tree for the user to review/commit. Never merges a branch.
- Failure semantics: any unrecoverable throw → SERVER_ERROR with as much structured data as available (the attempts so far, any worktree path); worktrees of failed/rejected attempts are cleaned EXCEPT the final surviving one (approved or escalated) which is left for apply.

- [ ] **Step 1: Failing tests** with a scripted fake worker model (setTestModel) + fake frontier adapter (registerAdapter):
  - Happy path: worker writes a file (non-empty diff), frontier approves → outcome "worker-approved", diff present, attempts length 1, cost split has workerUsd + frontierUsd, the surviving worktree exists. `engine.orchestrate.apply` with that diff → the file appears in the BASE repo working tree.
  - Retry then approve: worker attempt 1 produces a diff, frontier requests-changes; attempt 2 produces a diff, frontier approves → outcome "worker-approved", attempts length 2, attempt-1 worktree cleaned, attempt-2 worktree survives.
  - Escalation: both worker attempts get request-changes → frontier escalation (fake frontier adapter with a writeScope session that "edits" a file) produces a diff → outcome "escalated", attempts includes 2 worker + 1 frontier. (This test also exercises the M4 write-policy path via the fake adapter's canUseTool — assert the frontier session was started WITH a writeScope.)
  - Empty-diff worker → counts as failed attempt, no review call spent (assert the fake frontier's review was NOT invoked for the empty attempt).
  - No harness → SERVER_ERROR; non-git → SERVER_ERROR.
  - orchestrate.progress notifications emitted in order.
  - Env-gated `orchestrate-smoke.test.ts`: real routing + real open-model worker + real frontier review on a tmp clone of this repo with a trivial task; `it.skipIf(!process.env.OPENFUSION_ORCHESTRATE_SMOKE)`.
- [ ] **Step 2: RED → implement → GREEN** (exact totals) → Commit `feat(engine): engine.orchestrate — classify, route, worker, frontier review, escalate`

---

### Task 5: worktree lifecycle policy + docs

**Files:**
- Modify: `packages/engine/src/worker/methods.ts` or a new `orchestrate/methods.ts` surface (list/GC), `README.md`, spec §5/§12
- Test: `packages/engine/test/orchestrate-lifecycle.test.ts` (or extend worker-methods)

**Interfaces:**
- `engine.worker.list { projectDir }` → `{ worktrees: [{ path, branch }] }` (via WorktreeManager.list) — the GC surface so abandoned worktrees are discoverable.
- `engine.worker.gc { projectDir, keep?: string[] }` → `{ removed: string[] }`: remove all worker worktrees EXCEPT those whose path is in `keep` (and deleteBranch each removed). Lets the shell/user sweep abandoned worktrees after a session. Documents the policy: orchestrate cleans rejected-attempt worktrees itself; the surviving (approved/escalated) one is left for apply; anything abandoned by a crash is swept by gc. `git worktree prune` (already in WorktreeManager) sweeps admin entries on manager creation.
- README: status paragraph (orchestration exists — the full loop) + a "How the loop works" section (classify → route → worker → review → escalate → apply) with the estimate-class + unverified-harness caveats and the diff-apply-never-merge rule. Spec §5: note the realized flow; §12: add the risk that v1 orchestrate is single-worker-per-task (no parallel decomposition), and that the review gate quality bounds the cost-savings claim.

- [ ] **Step 1: Failing tests** — worker.list shows created worktrees; gc removes all but keep-listed, deletes their branches; gc on a clean project → removed empty. Real tmp git repos.
- [ ] **Step 2: RED → implement → GREEN** (exact totals) → Commit `feat(engine): worker worktree list/gc surface and orchestration docs`

---

## Milestone exit checklist

- [ ] Full suite green from clean checkout, no live keys / no claude binary
- [ ] `engine.orchestrate` on a fake-model + fake-frontier tmp repo drives classify→route→worker→review→(retry)→escalate; `engine.orchestrate.apply` lands the approved diff in the base tree; cost split reported by surface
- [ ] The M5 EXIT CRITERION met: one end-to-end task, open-model worker + frontier review + escalation path, all headless-testable
- [ ] Operator (keyed + authed machine): `OPENFUSION_ORCHESTRATE_SMOKE=1 pnpm --filter @openfusion/engine test -- orchestrate-smoke` — a real open model does a task, the real frontier reviews it
- [ ] Next per roadmap: M6 (evals) — repo-derived micro-evals, baseline-vs-harness report card; the pre-M6 pricing-confidence + endpoint-keyed-pricing gate lands here; then M7 shell
