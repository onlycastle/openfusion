# Run Ledger v1 — Design

**Date:** 2026-07-08 · **Status:** implemented — docs/superpowers/plans/2026-07-08-run-ledger.md
**Motivation:** Weng, "Harness Engineering for Self-Improvement" (2026-07-04) — durable
artifacts over transient context ("outputs that only live in a transient chat context
quickly become obsolete and hidden"), and failure records carrying the "terminal
verifier-level cause" as the substrate for weakness mining. Today OpenFusion persists a
one-word eval verdict (`manifest.verification.evals`) and discards everything else each
run learns: orchestrate outcomes, review-rejection reasons, eval report cards, tool-call
telemetry. The Self-Harness loop this project plans (weakness mining → GEPA proposals →
eval-gated validation) is impossible without this data. The ledger is that substrate.

## 1. Decisions (user-approved 2026-07-08)

1. **Local cache only.** `<projectDir>/.openfusion/cache/runs.jsonl`. Inherits the
   established `cache/` semantics for free: auto-gitignored (`ensureGitignoreGuard(dir,
   ["cache/"])` in `harness/store.ts`), never touched by regeneration pruning, lives with
   the project. Not committed; a committable export is a possible later feature.
2. **Metadata + failure causes.** Records carry outcome metadata plus the verifier-level
   failure signals weakness mining needs — review-rejection reason text and outcome
   categories. **The content line, explicitly:** no task text, no diffs, no prompts, no
   file content, ever. The existing "prompts/model-output/file-content never logged"
   rule governs `engine.log`/stdout; this file is a local, gitignored data store, not a
   log stream — but it holds the SAME line except for review-reason text (model-generated
   prose ABOUT an attempt, not the attempt's content), which is admitted deliberately as
   the mining signal. A test pins the exclusion of task text.
3. **Engine + minimal desktop history.** Recorder + `engine.runs.list` RPC + two compact
   read-only strips (EvalsScreen verdict history, OrchestrateScreen recent outcomes).
   No new Rail-2 section.

## 2. Architecture

A small, self-contained module — `packages/engine/src/runs/ledger.ts` — with two
operations, called from each pipeline's completion point. The ledger OBSERVES the
harness; it is never load-bearing: every append is wrapped so a failure logs one line
(`engine.log`, metadata only) and the run proceeds untouched.

```
orchestrate() ─ return/error path ─┐
runEvals()   ─ return ────────────┼──▶ appendRun(projectDir, record) ──▶ cache/runs.jsonl
generateHarness() ─ return ───────┤        (fire-and-forget, never throws)
card.update / card.approve ───────┘
engine.runs.list {projectDir, kind?, limit?} ──▶ readRuns() ──▶ newest-first records
Desktop: EvalsScreen history strip · OrchestrateScreen recent-outcomes row
```

Format: JSONL, append-only, one record per line. Chosen over SQLite (schema/migration
ceremony for an append-and-read-tail workload) and over tapping the notification bus
(progress events are deliberately thin; records are written from the final result
objects — exact shapes, no reconstruction). JSONL can be upgraded to SQLite later
without breaking consumers (same records, new store).

## 3. Record schema

Every record: `{ v: 1, kind, at: <ISO-8601> }` plus kind-specific fields. Discriminated
union `RunRecord`, zod-validated on read (invalid/corrupt/partial lines are SKIPPED with
a count surfaced, never a throw — a crashed write must not poison history).

- **`kind: "orchestrate"`** — `taskClass`, `agent` (name), `workerModel` (id string or
  `"frontier"`), `attempts`, `outcome` (OrchestrateResult["outcome"]), `escalated:
  boolean`, `reviews: Array<{ decision, reasons: string[] }>` (per attempt; the approved
  failure-cause text), `contextBranch` ("approved-card" | "build-and-test-fallback" |
  "none"), `toolCallCounts?: Record<string, number>`, `cost: { workerUsd, reviewUsd,
  escalateUsd, totalUsd }` (nullables as in OrchestrateResult), `durationMs`, `runId?`.
  Error-path variant: when orchestrate throws, record `outcome: "error"` with the error
  CATEGORY (e.g. "no-harness", "load-failed", "cancelled", "unknown") — never the
  message verbatim if it could embed user content; categories are enum-mapped.
- **`kind: "evals"`** — the `EvalsReportCard` fields verbatim minus nothing (it is
  already engine-composed metadata: taskCount, verdict, savingsPct, qualityHeld,
  clean-subset figures, pricingConfidence, measurementFailureCount,
  qualityGapWithinNoise, note) with `perTask` reduced to `Array<{ id, baselinePassed,
  harnessPassed, harnessOutcome, baselineOutcome }>` (drop the per-task USD to keep
  lines small; totals live in the top-level figures), plus `durationMs`, `runId?`.
- **`kind: "generate"`** — `pages`, `agents`, `estimatedCostUsd`, `headSha`,
  `cardStripped: Array<{ item, reason }>` (already metadata), `durationMs`.
- **`kind: "card"`** — `action: "update" | "approve"`. One line each; makes
  who-approved-when reconstructable alongside `generate` records.

`projectDir` is NOT in the record (the file is per-project by location).

## 4. Module interface

```ts
// packages/engine/src/runs/ledger.ts
export function runsLedgerPath(projectDir: string): string; // .openfusion/cache/runs.jsonl
export async function appendRun(projectDir: string, record: RunRecord): Promise<void>;
   // mkdir -p cache/, appendFile one line + "\n". Throws only to its caller-wrapper.
export function readRuns(projectDir: string, opts?: { kind?: RunRecord["kind"]; limit?: number }):
   { records: RunRecord[]; skipped: number }; // newest-first, default limit 50, sync read
```
Call sites use a shared `recordRun(engine, projectDir, record)` helper that try/catches
`appendRun` and logs `run-ledger: append failed (<kind>)` on error — the ONLY coupling
any pipeline has to the ledger. Concurrency: appends are single-line `appendFile` calls
(O_APPEND); the engine is a single process and pipelines already serialize writes per
project where it matters — no locking in v1, documented.

**Amendments (implementation, Task 3):** `recordRun` returns a never-rejecting
`Promise<void>`, and every write point AWAITS it before its RPC handler resolves or
rethrows. The original fire-and-forget contract above raced its callers — a caller
(and, worse, process teardown in tests) could observe the run's result before the
ledger append had actually landed, making both "one run → one record" assertions and
graceful shutdown non-deterministic. Awaiting a promise that itself never rejects
preserves the original guarantee (a ledger failure still never fails the pipeline) while
making the append happen-before its caller's continuation.

## 5. RPC + desktop

- **`engine.runs.list`** — params `{ projectDir, kind?: "orchestrate"|"evals"|
  "generate"|"card", limit?: number (1..200, default 50) }` → `{ records, skipped }`.
  Read-only; requires nothing but the directory (an absent file → empty list).
- **EvalsScreen**: below the current report card, a compact history strip — one row per
  past `evals` record: date, verdict badge (reusing the existing verdict styling),
  savings %, task count. Read via a new `engineClient.runsList(dir, "evals", 10)`.
- **OrchestrateScreen**: a single recent-outcomes row above the composer when history
  exists: the last ~5 `orchestrate` records as outcome badges (reusing `OutcomeBadge`)
  with taskClass tooltips. Stale-guarded like every other fetch on these screens.

## 6. Testing

- Ledger unit: append→read roundtrip (newest-first, limit, kind filter); corrupt-line
  tolerance (garbage line + valid lines → skipped: 1, valid records returned); absent
  file → empty; path under `cache/`.
- Write-point integration (existing fake-model fixtures): one orchestrate run → exactly
  one `orchestrate` record with correct outcome/branch/costs AND — pinned test — the
  record's serialized line does NOT contain the fixture's task text; one eval run → one
  `evals` record mirroring the returned report card; generation → `generate` record
  with cardStripped; card approve → `card` record. A ledger-append failure (fs mocked
  to throw) → the pipeline still returns success.
- Desktop RTL: history strip renders records / hides when empty; recent-outcomes row
  badges; stale-guard on project switch.

## 7. Out of scope (deferred)

Rotation/compaction (documented growth limit; human-paced volume), SQLite upgrade,
committable/team export, weakness mining & clustering (the consumer this enables),
analytics section, cross-machine merge.

## 8. Risks

- **Unbounded growth**: JSONL grows forever; at human-paced run volume this is years
  away from mattering. Revisit with rotation when mining lands.
- **Review-reason text sensitivity**: model prose about attempts could conceivably quote
  a code identifier. Accepted deliberately (local-only, gitignored, user-approved);
  the hard exclusions (task text/diffs/prompts/file content) are structural — those
  fields are never passed to the record constructors.
- **Two engines, one project**: concurrent appends from two engine processes could
  interleave mid-line on some filesystems. Single-line appends make this unlikely;
  corrupt-line-tolerant reads make it harmless. Documented, not solved, in v1.
