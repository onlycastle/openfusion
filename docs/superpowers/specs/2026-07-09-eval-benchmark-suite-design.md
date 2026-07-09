# Eval Benchmark Suite v1: SWE-bench Verified Mini + Bench CLI — Design

**Date:** 2026-07-09 · **Status:** approved, awaiting implementation plan
**Supersedes:** the same-day first draft (mined-OSS-repo golden tasks). The user's
direction: benchmark against a **public dataset**, not a self-curated exam. The
run-side structure (paired arms, cost metering, verdict, CLI) carries over; the
task-supply and scoring halves are replaced.
**Purpose decision (user-locked):** validate the product's core claim — harness
orchestration holds quality while cutting cost vs a direct frontier baseline —
on tasks nobody can accuse us of writing ourselves, with numbers additionally
comparable to public leaderboards.

## 1. Problem

The measurement machinery is finished; the benchmark is not. `runEvals`
(`packages/engine/src/evals/run.ts`, hardened in M6.1) issues a two-dimensional
quality+cost verdict with task floors and noise guards — but nothing supplies
it trusted tasks, and its repo-tests oracle (`runOracle`) is the wrong oracle
for a public benchmark: SWE-bench instances are scored by a *hidden* test patch
applied inside a pinned Docker environment, not by whatever tests sit in the
worktree. A self-mined task suite would also invite "you wrote your own exam"
criticism and produce numbers comparable to nothing.

## 2. Dataset (user-locked)

**SWE-bench Verified Mini** (HuggingFace: `MariusHobbhahn/swe-bench-verified-mini`):
a canonical 50-instance subset of SWE-bench Verified (500 human-validated real
GitHub issues across ~12 Python repos), selected to preserve the full set's
difficulty/pass-rate distribution, with its own public leaderboard (Princeton
HAL). Why it fits:

- **Canonical, pinned, small.** No invented sampling; ~5GB of eval images vs
  130GB for full Verified; 50 instances comfortably clears the existing
  20-task verdict floor.
- **Repo-level agentic tasks** — exercises repo analysis, wiki retrieval, and
  routing, unlike function-level datasets (HumanEval et al.).
- **All-Python** — a deliberately hard generality test for a TS-first product
  (§8, caveat 1).

The dataset snapshot (instance ids + fields used) is vendored into
`benchmarks/swe-bench-verified-mini.json` at implementation time, so runs
never depend on HuggingFace availability and the exam is git-sealed in-repo.

## 3. Design at a glance

The benchmark produces **patches**; the official harness produces truth;
OpenFusion's verdict math turns paired truth + metered cost into the product
claim.

```
SWE-bench Verified Mini (50 pinned instances, ~10 Python repos)
        │
  bench prepare: clone each repo, generate harness ONCE PER REPO,
                 card approval = interactive terminal gate
        │
  bench run: per instance, TWO metered arms on identical checkouts
        ├── baseline arm: direct frontier turn  → patch A
        └── harness arm:  full orchestrate loop → patch B
        │
  two predictions.jsonl files ──► official scoring: sb-cli (cloud)
                                  or local Docker harness (fallback)
        │
  bench report: ① resolved-rate per arm (externally comparable)
                ② M6.1 two-dimensional cost/quality verdict computed
                   over official resolved-status + metered USD
```

New code lives in `packages/engine/src/evals/bench/` plus a second `bin`
(`openfusion-bench`). Desktop app and RPC surface untouched.

## 4. Components

### 4.1 Dataset module (`dataset.ts`)

Loads and zod-validates the vendored instance file. Per instance it exposes:
`instance_id`, `repo`, `base_commit`, `problem_statement`, plus the fields the
predictions file needs. The hidden test patch is deliberately **not** consumed
by the run pipeline — agents must never see it (that would be answer leakage;
scoring alone uses it, inside the official harness).

### 4.2 Prepare (`prepare.ts`) — idempotent, one-time per machine

1. Clone each distinct repo into `~/.openfusion/bench/<repo>/` (outside any
   source repo, per `tasks.ts`'s security note on eval directories).
2. **Harness generation once per repo**, at that repo's most recent instance
   `base_commit`, reused across the repo's instances (~10 generations, not
   50). Approximation accepted for v1: card content (build/test commands,
   invariants) is the stable-per-repo layer; per-instance regeneration is a
   v2 refinement if per-repo cards prove stale on old base commits.
3. **Card approval is a mandatory interactive terminal gate**: the CLI prints
   each drafted card digest and requires an explicit `y` before approving via
   the same `HarnessService` path the desktop uses. No `--yes` flag; the
   human gate is relocated, never bypassed.
4. Best-effort per-instance Python env provisioning with `uv` (see §8
   caveat 2): create the venv, editable-install the repo. Failure to
   provision is recorded but does not exclude the instance — agents can still
   patch without running tests locally.

### 4.3 Run (`runner.ts`, `cli.ts`)

`bench run [--limit N] [--instance <id>]`:

1. Per instance, materialize a fresh checkout at `base_commit` using the
   SAME history-strip mechanism as `goldenTaskFromCommit` (`tasks.ts`):
   `git archive` the `base_commit` tree from the prepared clone into a fresh
   directory + from-scratch `git init`. This matters because the real fix
   exists in the repo's LATER history — a plain clone reset to `base_commit`
   would leave the answer one `git log --all` away. The stripped checkout
   shares no objects/refs with the clone; the fix and hidden test patch are
   unreachable by construction.
2. **Baseline arm**: direct frontier turn (same primitive `runEvals` uses)
   with the `problem_statement` as the task, cwd-pinned to the checkout.
   Diff the working tree → patch A.
3. **Harness arm**: copy the repo's approved harness bundle into the
   checkout (same `writeHarness` mechanism `runEvals` uses), run the full
   orchestrate loop (route → worker attempts → review → escalate) → patch B.
4. Both arms metered per instance (existing meter infrastructure); the report
   records USD per arm per instance.
5. Emit `predictions-baseline.jsonl` and `predictions-harness.jsonl` in the
   official format (`instance_id`, `model_name_or_path`, `model_patch`).

Arm order per instance is fixed (baseline first) and both arms always run —
no `--baseline-only`/`--harness-only`: the verdict is only meaningful paired,
and partial sweeps invite cherry-picking. `--limit` preserves pairing at
reduced scale.

### 4.4 Scoring (`score.ts`)

Default: submit both predictions files via **sb-cli** (official cloud
evaluation — no local Docker needed on macOS/arm64). Fallback: the official
local containerized harness behind `--local-docker` for offline use. Scoring
consumes the run's predictions and returns per-instance resolved status per
arm. The bench never re-implements the oracle.

### 4.5 Verdict + report (`report.ts`) — one small engine change

The M6.1 verdict math (savings-PASS ≥20-task floor, hazard floor, quality
noise band 0.05, ≥10% cost-regression → fail) is currently embedded in
`runEvals`. **Extract it into a pure shared function** (inputs: per-task
`{passedA, passedB, usdA, usdB, measurementFailure}` rows; output: the
existing verdict/report-card shape). `runEvals` calls the extracted function
with oracle-sourced rows (behavior identical, its existing tests keep
guarding the math); the bench calls it with official-resolved-status rows.
One verdict definition, two oracles.

Report output: `benchmarks/results/<run-id>.json` (per-instance table:
resolved per arm, USD per arm, outcomes) + a human-readable `.md` summary
(both arms' resolved-rate vs the public leaderboard context, savings %,
verdict, metered spend, environment record). `benchmarks/results/` is
gitignored; summaries are committed manually to seal milestone numbers.

## 5. Error handling

Guiding rule inherited from M6.1: **infrastructure failures are measurement
failures, never quality evidence.**

- **Prepare:** clone/harness-generation failures abort before any per-instance
  API spend, naming the failing phase. `uv` env-provisioning failure is
  recorded metadata, not an exclusion.
- **Run:** a per-instance arm error (frontier turn threw, orchestrate threw,
  empty diff produced by an error path) marks that instance's row as a
  measurement failure for the extracted verdict function — exactly how
  `runEvals` treats `"error"`/`"apply-failed"` today. An empty patch that the
  agent *deliberately* produced still goes to scoring (it will simply not
  resolve).
- **Scoring:** sb-cli submission/retrieval failures are retryable without
  re-running arms — predictions files are durable artifacts; scoring is a
  separate subcommand (`bench score`) so a scoring hiccup never wastes agent
  spend.
- **Floor interaction:** if measurement failures push valid pairs below the
  20-task floor, the extracted verdict function already refuses a savings
  PASS; the summary surfaces this explicitly.

## 6. Determinism & reproducibility

- Vendored dataset snapshot; pinned instance `base_commit`s (from the dataset
  itself); single-run pass@1 (multi-run significance stays deferred).
- The report records Node version, engine version, model roster, pricing
  snapshot, dataset snapshot hash, and sb-cli/harness version.
- Scoring authority is the official harness — our numbers are comparable to
  the HAL Verified-Mini leaderboard and directionally to full-Verified
  numbers (with the subset caveat stated in every summary).

## 7. Testing & cost controls

**CI-safe tests (no keys, no network, no Docker):**
- Dataset module: schema round-trip on a 2-instance fixture; rejection of
  malformed instances; assertion that the test-patch field is never exposed
  to run-side types.
- Verdict extraction: the decisive test is that `runEvals`'s existing suite
  passes unchanged after the refactor; plus direct unit tests of the pure
  function on synthetic rows (floors, noise band, cost regression).
- Runner dry-run: full per-instance flow against a synthetic local fixture
  repo with a stub model layer — checkout reset, harness copy, predictions
  format — zero tokens.
- Scoring module: parses recorded sb-cli response fixtures; never re-derives
  pass/fail itself.

**Env-gated smoke (real keys, operator-run):** `OPENFUSION_BENCH_SMOKE=1`
runs ONE instance end-to-end (both arms + sb-cli scoring), following the
existing env-gated generate-smoke pattern.

**Cost controls:**
- `--limit N` / `--instance <id>` validate plumbing on 1–3 instances before a
  50-instance sweep; every report prints metered USD so a small run
  extrapolates a full sweep's cost.
- Harness generation is once per repo (~10 total), at prepare time, metered.
- Scoring via sb-cli is free of model spend; mini's image footprint (~5GB)
  only matters in the `--local-docker` fallback.

**BYOK/keys:** worker providers registered at startup from a gitignored JSON
file of `ProviderConfig` entries located via `OPENFUSION_BENCH_PROVIDERS`;
the frontier baseline rides the operator's existing subscription OAuth
through the embedded engines.

## 8. Caveats (accepted for v1, stated in every report)

1. **Python repos, TS-first product.** Verified is all-Python; the card's
   deterministic command miner leans on tox/CI configs instead of
   package.json. This is a deliberate generality stress, not home turf.
2. **Agents work on plain local checkouts** with best-effort `uv` envs; some
   instances' tests won't run locally mid-task, so agents get weaker test
   feedback than container-native setups. Scoring is still always sound (the
   official Docker oracle is the authority). Container-native worker
   execution is v2.
3. **Per-repo (not per-instance) harness generation** — card staleness on old
   base commits is possible; per-instance generation is the v2 refinement if
   it shows up in results.

## 9. Non-goals (v1)

Full 500-instance Verified sweeps; leaderboard submission automation;
multi-run statistical significance; wiki-on/off ablation arms (both deferred
pending user sign-off); container-native agent execution; non-SWE-bench
datasets; CI-scheduled sweeps.

## 10. Decisions resolved during design

- **Purpose:** validate the core claim, with externally comparable numbers —
  user-locked.
- **Task source:** public dataset, not self-mined OSS repos — user-locked
  (supersedes the first draft).
- **Dataset:** SWE-bench Verified Mini (50, canonical subset) — user-locked.
- **Scoring:** official harness only; sb-cli cloud default, local Docker
  fallback. The bench never re-implements the oracle.
- **Verdict:** M6.1 math extracted to a pure shared function; one verdict
  definition across both oracles.
- **Card gate:** interactive terminal approval, never auto.
- **Workspace:** `~/.openfusion/bench/`, outside any source repo.
