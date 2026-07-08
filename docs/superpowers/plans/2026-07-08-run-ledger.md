# Run Ledger v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a durable, metadata-plus-failure-causes record of every user-initiated orchestrate / eval / generation / card action to `<projectDir>/.openfusion/cache/runs.jsonl`, readable via `engine.runs.list` and surfaced as two compact history strips in the desktop.

**Architecture:** A self-contained `runs/ledger.ts` module (zod-validated JSONL append/read) + an awaited, never-rejecting `recordRun` wrapper. ALL write points live in the RPC handler layer (`orchestrate/methods.ts`, `evals/methods.ts`, `harness/methods.ts`) — pipelines stay untouched except two small additive plumbing changes (surface `contextBranch` on `OrchestrateResult`; surface `toolCallCounts` on the worker-run result). Recording at the RPC layer means eval-internal orchestrate runs (direct function calls from `evals/run.ts`) are naturally excluded — they're captured by the eval record instead.

**Tech Stack:** all in-codebase (zod v4, node:fs, existing RPC register pattern, React+RTL). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-08-run-ledger-design.md` (§-refs per task).

## Global Constraints

- Everything standing: Node ≥22, strict TS NodeNext `.js` imports, tsconfig.test coverage, stdout protocol purity, tmp git-repo fixtures, conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, nothing under `.superpowers/`/`.claude/` of THIS repo.
- **Content line (spec §1.2, structural):** records NEVER contain task text, diffs, prompts, or file content. Admitted deliberately: review-verdict `decision` + `reasons[]` text, eval report-card notes, cardStripped reasons. Attempt `summary` strings (worker/frontier prose) are EXCLUDED. A test pins the task-text exclusion.
- **Observer, never load-bearing (spec §2):** every append goes through `recordRun`, which try/catches and logs one metadata-only line on failure — a ledger failure must never fail or delay the run's own result. Pinned by a test.
- **Write points at the RPC handler layer only** — `runEvals`/`orchestrate`/`generateHarness` pipeline functions get no ledger calls (the two plumbing changes in T3 are result-shape additions, not ledger calls).
- Ledger reads tolerate corrupt/partial lines: skip + count, never throw (spec §3).
- Desktop house patterns: stale-response guards, optimistic-free read-only strips, RTL tests colocated.

---

### Task 1: the ledger module

**Files:**
- Create: `packages/engine/src/runs/ledger.ts`
- Test: `packages/engine/test/runs-ledger.test.ts`

**Interfaces (produces):**
```ts
// Discriminated union, zod-validated on READ (spec §3). Kinds + fields exactly:
export const RunRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    v: z.literal(1), kind: z.literal("orchestrate"), at: z.iso.datetime(),
    taskClass: z.string(), agent: z.string(), workerModel: z.string(), // model id or "frontier"
    attempts: z.number().int().min(0),
    outcome: z.enum(["worker-approved", "escalated", "failed", "error"]),
    escalated: z.boolean(),
    reviews: z.array(z.object({ decision: z.enum(["approve", "request-changes"]), reasons: z.array(z.string()) })),
    contextBranch: z.enum(["approved-card", "build-and-test-fallback", "none"]),
    toolCallCounts: z.record(z.string(), z.number().int()).optional(),
    cost: z.object({
      workerUsd: z.number().nullable(), reviewUsd: z.number().nullable(),
      escalateUsd: z.number().nullable(), totalUsd: z.number().nullable(),
    }),
    durationMs: z.number().int().min(0), runId: z.string().optional(),
    errorCategory: z.enum(["no-harness", "load-failed", "cancelled", "unknown"]).optional(), // set ONLY with outcome "error"
  }),
  z.object({
    v: z.literal(1), kind: z.literal("evals"), at: z.iso.datetime(),
    taskCount: z.number().int(), verdict: z.enum(["pass", "fail", "inconclusive"]),
    savingsPct: z.number().nullable(), cleanSavingsPct: z.number().nullable(),
    qualityHeld: z.boolean(), qualityGapWithinNoise: z.boolean(),
    pricingConfidence: z.string(), measurementFailureCount: z.number().int(),
    perTask: z.array(z.object({
      id: z.string(), baselinePassed: z.boolean(), harnessPassed: z.boolean(),
      harnessOutcome: z.string(), baselineOutcome: z.string(),
    })),
    note: z.string(), durationMs: z.number().int().min(0), runId: z.string().optional(),
  }),
  z.object({
    v: z.literal(1), kind: z.literal("generate"), at: z.iso.datetime(),
    pages: z.number().int(), agents: z.number().int(),
    estimatedCostUsd: z.number().nullable(), headSha: z.string(),
    cardStripped: z.array(z.object({ item: z.string(), reason: z.string() })),
    durationMs: z.number().int().min(0),
  }),
  z.object({
    v: z.literal(1), kind: z.literal("card"), at: z.iso.datetime(),
    action: z.enum(["update", "approve"]),
  }),
]);
export type RunRecord = z.infer<typeof RunRecordSchema>;

export function runsLedgerPath(projectDir: string): string;
  // path.join(path.resolve(projectDir), ".openfusion", "cache", "runs.jsonl") —
  // sibling of wikiDbPath (wiki/store.ts:205); same cache/ semantics (auto-gitignored
  // by writeHarness's ensureGitignoreGuard, never pruned).
export async function appendRun(projectDir: string, record: RunRecord): Promise<void>;
  // mkdir(dirname, {recursive:true}) then appendFile(path, JSON.stringify(record) + "\n").
  // Validates via RunRecordSchema.parse BEFORE writing (a malformed record is a caller
  // bug — throw to the recordRun wrapper, never write garbage).
export function readRuns(projectDir: string, opts?: { kind?: RunRecord["kind"]; limit?: number }):
  { records: RunRecord[]; skipped: number };
  // Sync. Absent file -> {records: [], skipped: 0}. Split on "\n", drop empty lines,
  // JSON.parse + RunRecordSchema.safeParse each — failures increment `skipped`, never
  // throw. Filter by kind when given. NEWEST-FIRST = reverse of file order. Default
  // limit 50, applied AFTER filtering and reversal.
export function recordRun(engine: Pick<Engine, "log">, projectDir: string, record: RunRecord): void;
  // Fire-and-forget: void appendRun(...).catch(() => engine.log(`run-ledger: append failed (${record.kind})`)).
  // NOTE the .catch also guards the sync RunRecordSchema.parse throw — wrap the whole
  // appendRun call in the promise chain (e.g. `void (async () => appendRun(...))().catch(...)`).
```

- [ ] **Step 1: Failing tests** (tmp dirs, no git needed): append→read roundtrip returns the record newest-first (append A then B → `records[0]` is B); `limit` truncates after reversal; `kind` filter (append one orchestrate + one card → `{kind:"card"}` returns only the card); a garbage line hand-appended between two valid lines → `{records: 2, skipped: 1}`; absent file → empty + 0; `runsLedgerPath` ends with `.openfusion/cache/runs.jsonl`; `appendRun` with an invalid record (e.g. missing `at`) rejects and writes NOTHING (file absent after); `recordRun` with an fs failure (point projectDir at a path whose `.openfusion` is an existing FILE so mkdir fails) does not throw and calls `log` with a string containing `run-ledger: append failed`.
- [ ] **Step 2: RED → implement → GREEN** (`pnpm --filter @openfusion/engine test -- test/runs-ledger.test.ts --run`, then full suite + typecheck) → Commit `feat(engine): run-ledger module — zod-validated JSONL append/read with corrupt-line tolerance`

---

### Task 2: `engine.runs.list` RPC

**Files:**
- Create: `packages/engine/src/runs/methods.ts`
- Modify: `packages/engine/src/engine.ts` (service field + register call, following the existing pattern at engine.ts:26-32 / 43-66)
- Test: `packages/engine/test/runs-methods.test.ts`

**Interfaces:**
- Consumes: Task 1's `readRuns`, `RunRecord`.
- Produces: `export class RunsService {}` (empty sibling-pattern marker, mirrors `EvalsService`); `registerRunsMethods(engine)` registering `engine.runs.list` with params schema `z.object({ projectDir: z.string().min(1), kind: z.enum(["orchestrate","evals","generate","card"]).optional(), limit: z.number().int().min(1).max(200).optional() })` → returns `readRuns(projectDir, { kind, limit })` verbatim (`{ records, skipped }`). No git guard (an absent ledger is a normal empty state; the method must work on any directory). Engine gains `readonly runs = new RunsService();` and `registerRunsMethods(this);`.

- [ ] **Step 1: Failing tests** (dispatch-level, mirroring `harness-methods-read.test.ts` conventions): dispatch `engine.runs.list` on a dir with two appended records → both returned newest-first; `kind`/`limit` params respected; empty dir → `{records: [], skipped: 0}`; limit 0 rejected at the schema level (INVALID_PARAMS).
- [ ] **Step 2: RED → implement → GREEN** (full suite + typecheck) → Commit `feat(engine): engine.runs.list RPC over the run ledger`

---

### Task 3: orchestrate write point (+ contextBranch and toolCallCounts plumbing)

**Files:**
- Modify: `packages/engine/src/orchestrate/orchestrate.ts` (two ADDITIVE result-shape changes only), `packages/engine/src/worker/methods.ts` (surface counts on the run result), `packages/engine/src/orchestrate/methods.ts` (the write point)
- Test: extend `packages/engine/test/orchestrate.test.ts` (or its methods-level suite — wherever `engine.orchestrate` is dispatched through the RPC layer; check both files and pick the one that already dispatches via `engine.dispatcher`), extend `packages/engine/test/worker-methods.test.ts`

**Interfaces:**
- Consumes: Task 1's `recordRun`/`RunRecord`.
- Produces:
  1. `OrchestrateResult` gains `contextBranch: "approved-card" | "build-and-test-fallback" | "none"` — set from the existing `buildWorkerContext(harness).branch` computed at ~line 630 (thread the value into every `return`/`finish()` path; the `finish` closure at ~line 556 is the main assembly point — add the field there and to the direct-return sites at ~812/828).
  2. Worker run result (worker/methods.ts — the object `engine.worker.run` resolves with) gains `toolCallCounts: Record<string, number>` — the tally the Task-7 telemetry already computes; keep the log line unchanged. `orchestrate.ts` aggregates across attempts: sum each tool's counts over every worker attempt's result into a local `toolCallCounts`, surfaced on `OrchestrateResult` as `toolCallCounts?: Record<string, number>` (undefined when no worker attempt ran, i.e. straight-to-frontier routing).
  3. The write point, in `orchestrate/methods.ts`'s `engine.orchestrate` handler: capture `const startedAt = Date.now()` first; on SUCCESS build and `recordRun(engine, params.projectDir, …)` from the result:
```ts
recordRun(engine, params.projectDir, {
  v: 1, kind: "orchestrate", at: new Date().toISOString(),
  taskClass: result.taskClass, agent: result.agent,
  workerModel: result.resolution === "frontier" ? "frontier" : result.resolution.model,
  attempts: result.attempts.length, outcome: result.outcome,
  escalated: result.outcome === "escalated",
  reviews: result.attempts.flatMap((a) => (a.verdict ? [{ decision: a.verdict.decision, reasons: a.verdict.reasons }] : [])),
  contextBranch: result.contextBranch,
  ...(result.toolCallCounts !== undefined ? { toolCallCounts: result.toolCallCounts } : {}),
  cost: result.cost, durationMs: Date.now() - startedAt,
  ...(params.runId !== undefined ? { runId: params.runId } : {}),
});
```
  (NOTE: `a.summary` is deliberately never read — content line.) On ERROR (the handler's catch), record `outcome: "error"` with `errorCategory` mapped by inspection: message includes `"no harness"` → `"no-harness"`; the error is/wraps `HarnessValidationError` or message includes `"structural validation"` → `"load-failed"`; the cancelled marker (`cancelled: true` data or message includes `"cancelled"`) → `"cancelled"`; else `"unknown"`. Error records use `taskClass: "unknown"`, `agent: "unknown"`, `workerModel: "unknown"`, `attempts: 0`, `escalated: false`, `reviews: []`, `contextBranch: "none"`, null costs. Never put the error MESSAGE in the record. Then rethrow unchanged.
- Eval-internal orchestrate runs are NOT recorded — `evals/run.ts` calls `orchestrate()` directly (line ~651), bypassing this handler. State this in a doc comment at the write point.

- [ ] **Step 1: Failing tests.** (a) worker-methods: `engine.worker.run` result carries `toolCallCounts` with the expected tool names (extend the existing telemetry test's fixture). (b) orchestrate RPC-level: run the existing approved-card fake-model fixture THROUGH the dispatcher → `readRuns(dir)` yields exactly one `orchestrate` record with `outcome`, `contextBranch: "approved-card"`, `reviews` matching the scripted verdicts, correct `workerModel`, `durationMs >= 0`; **the content pin**: `JSON.stringify` of the record does NOT contain the fixture's task text (use a distinctive task string like `"UNIQUE-TASK-MARKER-XYZ"`) nor any attempt summary marker. (c) error path: dispatch against a projectDir with no harness → SERVER_ERROR thrown AND one record with `outcome: "error"`, `errorCategory: "no-harness"`. (d) `OrchestrateResult.contextBranch` asserted on the three existing branch fixtures.
- [ ] **Step 2: RED → implement → GREEN.** Full suite (evals tests must stay green UNMODIFIED — their direct `orchestrate()` calls bypass the write point but consume `OrchestrateResult`, which only GAINED optional/additive fields) + typecheck → Commit `feat(engine): record orchestrate runs in the ledger; surface contextBranch and toolCallCounts`

---

### Task 4: evals, generate, and card write points

**Files:**
- Modify: `packages/engine/src/evals/methods.ts`, `packages/engine/src/harness/methods.ts`
- Test: extend `packages/engine/test/evals-run.test.ts` (RPC-layer describe block), `packages/engine/test/harness-generate.test.ts`, `packages/engine/test/harness-methods-update.test.ts`

**Interfaces:**
- Consumes: Task 1's `recordRun`.
- Produces, all at the RPC handler layer:
  - `evals/methods.ts` (`engine.evals.run` handler): `startedAt` before `runEvals`; on success record `{ v:1, kind:"evals", at, taskCount: report.taskCount, verdict: report.verdict, savingsPct: report.savingsPct, cleanSavingsPct: report.cleanSavingsPct, qualityHeld: report.qualityHeld, qualityGapWithinNoise: report.qualityGapWithinNoise, pricingConfidence: report.pricingConfidence, measurementFailureCount: report.measurementFailureCount, perTask: report.perTask.map(({id, baselinePassed, harnessPassed, harnessOutcome, baselineOutcome}) => ({id, baselinePassed, harnessPassed, harnessOutcome, baselineOutcome})), note: report.note, durationMs, ...(runId && {runId}) }` — per-task USD deliberately dropped (spec §3). No record on error/cancel (an eval that produced no report card has nothing trustworthy to persist; the orchestrate-style error record is not mirrored here — state this in a doc comment).
  - `harness/methods.ts` generate handler: on success record `{ v:1, kind:"generate", at, pages: result.pages, agents: result.agents, estimatedCostUsd: result.estimatedCostUsd, headSha: harnessStatus(projectDir).headSha ?? "unknown", cardStripped: result.cardStripped, durationMs }`.
  - `harness/methods.ts` card handlers: after the serialized write succeeds, record `{ v:1, kind:"card", at, action: "update" }` / `action: "approve"` respectively.
- [ ] **Step 1: Failing tests.** evals: the existing RPC-wire golden-task test → one `evals` record whose `verdict`/`taskCount` mirror the returned report and whose perTask entries carry NO `baselineUsd`/`harnessUsd` keys; generate: the scripted happy-path → one `generate` record with `pages: 5` and the stripped item; card: update → `{action:"update"}` record, approve → `{action:"approve"}` record (assert via `readRuns(dir, {kind:"card"})` order).
- [ ] **Step 2: RED → implement → GREEN** (full suite + typecheck) → Commit `feat(engine): record eval, generation, and card actions in the run ledger`

---

### Task 5: desktop client + EvalsScreen history strip

**Files:**
- Modify: `apps/desktop/src/engineClient.ts`, `apps/desktop/src/screens/EvalsScreen.tsx`, `apps/desktop/src/styles.css` (minimal, existing-class-consistent)
- Test: extend `apps/desktop/src/screens/EvalsScreen.test.tsx`

**Interfaces:**
- Consumes: Task 2's `engine.runs.list`.
- Produces (`engineClient.ts`): `export type RunRecordKind = "orchestrate" | "evals" | "generate" | "card";` · `export interface EvalsRunRecord { v: 1; kind: "evals"; at: string; taskCount: number; verdict: "pass" | "fail" | "inconclusive"; savingsPct: number | null; /* remaining evals fields mirrored from the engine schema */ }` · `export interface OrchestrateRunRecord { v: 1; kind: "orchestrate"; at: string; taskClass: string; outcome: "worker-approved" | "escalated" | "failed" | "error"; /* remaining orchestrate fields mirrored */ }` · `export async function runsList(projectDir: string, kind?: RunRecordKind, limit?: number): Promise<{ records: Array<EvalsRunRecord | OrchestrateRunRecord | Record<string, unknown>>; skipped: number }>` (thin `call("engine.runs.list", …)` wrapper in the established style; the desktop only narrows the two kinds it renders).
- EvalsScreen: on load (and after a run completes), fetch `runsList(dir, "evals", 10)`; when non-empty render a `section.evals-history` UNDER the current report area — heading "History", one compact row per record: local date-time from `at`, verdict badge (reuse the screen's existing verdict styling/classes), `savingsPct` as a percentage (em-dash when null), task count. Newest first (already the RPC order). Empty history → section absent. Stale-guarded via the screen's existing project-ref pattern; fetch failures render nothing (history is best-effort chrome, never an error state).

- [ ] **Step 1: Failing tests** (RTL, existing mock conventions; add `runsList` to the engineClient mock with `card: null`-style defaults for other suites if the mock is shared): two mocked evals records → History section with two rows, newest first, verdict badges + formatted savings; empty records → no "History" heading; a rejected `runsList` → screen still renders normally.
- [ ] **Step 2: RED → implement → GREEN** (`pnpm --filter desktop test`, `pnpm --filter desktop typecheck`) → Commit `feat(desktop): evals history strip from the run ledger`

---

### Task 6: OrchestrateScreen recent-outcomes row + docs

**Files:**
- Modify: `apps/desktop/src/screens/OrchestrateScreen.tsx`, `README.md`, `docs/superpowers/specs/2026-07-08-run-ledger-design.md` (status line only)
- Test: extend `apps/desktop/src/screens/OrchestrateScreen.test.tsx`

**Interfaces:**
- Consumes: Task 5's `runsList` client fn + `OrchestrateRunRecord`.
- Produces: when a project is selected and `runsList(dir, "orchestrate", 5)` returns records, render one row (`div.recent-runs`) above the composer: for each record an `OutcomeBadge`-styled chip (the component exists in this file — reuse it for the three OrchestrateResult outcomes; render `error` records with the existing failure styling and label "Error") with `title={record.taskClass + " · " + local time}` tooltips. Absent/empty/failed fetch → row absent. Refetch after a run completes (the same place the screen refreshes harness status post-run). Stale-guarded per the screen's `projectDirRef` pattern. `canRun`/composer behavior untouched.
- README: one short paragraph in the harness/orchestrate section — every orchestrate/eval/generation/card action appends a metadata-only record to `.openfusion/cache/runs.jsonl` (local, gitignored, never task text/diffs/prompts); `engine.runs.list` reads it; this is the data substrate for the planned weakness-mining/self-improvement loop. Spec status line → `implemented — docs/superpowers/plans/2026-07-08-run-ledger.md`.

- [ ] **Step 1: Failing tests.** Mocked records → chips render with outcome labels + tooltips, newest first; empty → no `.recent-runs`; fetch rejection → screen renders normally; Run-button enablement unchanged by history presence.
- [ ] **Step 2: RED → implement → GREEN** (desktop suite + typecheck; engine suite once to confirm docs-only there) → Commit `feat(desktop): recent-outcomes row in chat; run-ledger docs`

---

## Milestone exit checklist

- [ ] Full stack green from clean checkout (engine suite + typecheck, desktop suite + tsc), no live keys
- [ ] One fake-model orchestrate through the RPC → exactly one ledger record; content pin holds (no task text); error path records `errorCategory`
- [ ] Eval/generate/card actions each append their record; eval-internal orchestrate runs do NOT pollute the ledger
- [ ] `engine.runs.list` returns newest-first with kind/limit; corrupt lines skipped and counted
- [ ] Desktop: evals history strip + chat recent-outcomes row, both best-effort (never an error state), stale-guarded
- [ ] `.openfusion/cache/runs.jsonl` confirmed gitignored via the existing guard (no new ignore machinery needed)

## Self-Review

- **Spec coverage:** §1 decisions → T1 (path/cache semantics), T3/T4 (content line + failure causes), T5/T6 (minimal desktop). §2 architecture → recordRun wrapper (T1), RPC-layer write points (T3/T4), observer-never-load-bearing pinned (T1 fs-failure test + T3 flow). §3 schema → T1 verbatim incl. error-path categories (T3 maps them). §4 interface → T1. §5 RPC + strips → T2/T5/T6. §6 testing list → mapped 1:1 (corrupt-line T1; write-point integration T3/T4; content pin T3; append-failure T1; RTL T5/T6). §7 deferrals appear in no task. §8 risks → documented in T1 comments (concurrency note) per spec.
- **Placeholder scan:** all code steps carry real code or exact field-by-field construction; the two engineClient record interfaces say "remaining fields mirrored from the engine schema" — acceptable because T1 defines every field explicitly and the client needs only the rendered subset narrowed; no TBDs.
- **Type consistency:** `RunRecord`/`recordRun`/`readRuns`/`runsLedgerPath` (T1) consumed by T2/T3/T4 under the same names; `contextBranch` enum matches T6-wiki's `WorkerContextBranch` values; `runsList(projectDir, kind?, limit?)` (T5) used by T6; the RPC name `engine.runs.list` is identical in T2/T5. `errorCategory` only ever set with `outcome: "error"` (schema comment + T3 construction agree).
