# Eval Benchmark Suite v1: SWE-bench Verified Mini + Bench CLI — Design

**Date:** 2026-07-09 · **Status:** implemented (v1 code in `packages/engine/src/evals/bench/` + `verdict.ts`)
**Supersedes:** the same-day first draft (mined-OSS-repo golden tasks). The user's
direction: benchmark against a **public dataset**, not a self-curated exam. The
run-side structure (paired arms, cost metering, verdict, CLI) carries over; the
task-supply and scoring halves are replaced.
**Purpose decision (user-locked):** validate the product's core claim — harness
orchestration holds quality while cutting cost vs a direct frontier baseline —
on tasks nobody can accuse us of writing ourselves. Absolute leaderboard
comparability is **secondary and directional only** (see §8); the primary claim
is the **paired** harness-vs-baseline result on the same pinned instances.

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
a canonical **50-instance** subset of SWE-bench Verified (500 human-validated
real GitHub issues). Mini is **not** a 12-repo sample: the public dataset has
**exactly two repos** (`django/django` and `sphinx-doc/sphinx`), chosen so the
subset preserves roughly the full set's difficulty/pass-rate distribution at
~5GB of Docker image footprint (vs ~130GB for full Verified). It has a public
HAL leaderboard (Princeton). Why it fits:

- **Canonical, pinned, small.** No invented sampling; 50 instances comfortably
  clear the existing 20-task savings-PASS floor when measurement failures stay
  low; local Docker fallback is ~5GB, not 130GB.
- **Repo-level agentic tasks** — exercises repo analysis, wiki retrieval, and
  routing, unlike function-level datasets (HumanEval et al.).
- **All-Python, two large mature codebases** — a deliberately hard generality
  test for a TS-first product (§8, caveat 1). Only two repos also means
  **per-repo harness reuse is coarser** than a multi-repo suite would be
  (django instances span many years/versions) — accepted for v1, called out
  in every report (§8, caveat 3).

The dataset snapshot is vendored into `benchmarks/swe-bench-verified-mini.json`
at implementation time so runs never depend on HuggingFace availability and
the exam is git-sealed in-repo.

**Vendored fields:** `instance_id`, `repo`, `base_commit`, `problem_statement`,
plus any metadata needed for sb-cli submission identity. Gold `patch` and
hidden `test_patch` may be stored in the vendored file for offline harness use
but are **never** exposed on run-side types or agent prompts (schema + unit
tests enforce this). `hints_text` is **not** fed to either arm in v1 (PR
discussion can leak free solution hints; optional ablation is deferred).

## 3. Design at a glance

The benchmark produces **patches**; the official harness produces truth;
OpenFusion's verdict math turns paired truth + metered cost into the product
claim.

```
SWE-bench Verified Mini (50 pinned instances, 2 repos: django + sphinx)
        │
  bench prepare: clone each repo, generate harness ONCE PER REPO (2 total),
                 card approval = interactive terminal gate
        │
  bench run: per instance, TWO metered arms on identical checkouts
        ├── baseline arm: direct frontier turn  → export model_patch A
        └── harness arm:  full orchestrate loop → export model_patch B
        │
  two predictions JSON files ──► sb-cli: swe-bench_verified + --instance_ids
                                  (local Docker harness fallback)
        │
  bench report: ① resolved-rate per arm (resolved / N, N=50 or --limit)
                ② M6.1 two-dimensional cost/quality verdict computed
                   over official resolved-status + metered USD
                   (including unpriced-call false-pass gate)
```

New code lives in `packages/engine/src/evals/bench/` plus a second `bin`
(`openfusion-bench`). Desktop app and RPC surface untouched.

## 4. Components

### 4.1 Dataset module (`dataset.ts`)

Loads and zod-validates the vendored instance file. Per instance it exposes:
`instance_id`, `repo`, `base_commit`, `problem_statement`, plus the fields the
predictions file needs. Run-side types deliberately omit `test_patch`, gold
`patch`, and `hints_text` so agents cannot see them through the typed API
(answer leakage / free hints). Scoring alone uses `test_patch`, inside the
official harness.

### 4.2 Prepare (`prepare.ts`) — idempotent, one-time per machine

1. Clone each distinct repo into `~/.openfusion/bench/<repo>/` (outside any
   source repo, per `tasks.ts`'s security note on eval directories). Mini →
   **two** clones (`django/django`, `sphinx-doc/sphinx`).
2. **Harness generation once per repo** ( **2 generations, not 50** ), at that
   repo's most recent instance `base_commit`, reused across the repo's
   instances. Approximation accepted for v1: card content (build/test
   commands, invariants) is the stable-per-repo layer. On mini this is a
   **larger** bias than a multi-repo suite (django spans many versions); if
   results show card staleness dominating, per-instance generation is the v2
   refinement.
3. **Card approval is a mandatory interactive terminal gate**: the CLI prints
   each drafted card digest and requires an explicit `y` before approving via
   the same `HarnessService` path the desktop uses. No silent `--yes` for live
   generate. Idempotent re-prepare **skips** already-approved cards when the
   on-disk digest matches (no re-prompt). Smoke / automated paths use
   **fixture harness bundles** or `bench prepare --approve-from <path>` for a
   previously human-approved digest — never auto-approve a freshly generated
   card.
4. Best-effort per-instance Python env provisioning with `uv` (see §8
   caveat 2): create the venv, editable-install the repo. Failure to
   provision is recorded but does not exclude the instance — agents can still
   patch without running tests locally.

### 4.3 Run (`runner.ts`, `cli.ts`)

`bench run [--limit N] [--instance <id>]`:

1. Per instance, materialize a fresh checkout at `base_commit` using the
   **archive + fresh-init** history-strip pattern from `tasks.ts` (same
   isolation property as `goldenTaskFromCommit`'s setup): `git archive` the
   `base_commit` tree from the prepared clone into a fresh directory +
   from-scratch `git init` + single baseline commit. **Do not call
   `goldenTaskFromCommit` itself** — that API takes a *fix* commit SHA,
   archives `commit^`, builds a subject-line prompt, and requires a local
   `testCommand`. SWE-bench needs archive of **`base_commit` itself**,
   prompt = `problem_statement` only, and no local oracle command. Extract or
   share only the archive/init primitive.
2. **Baseline arm**: direct frontier turn (same primitive `runEvals` uses)
   with the `problem_statement` as the task, cwd-pinned to the checkout.
   Then **export `model_patch` via the shared patch helper** (§4.3.1).
3. **Harness arm**: copy the repo's approved harness bundle into the
   checkout (same `writeHarness` mechanism `runEvals` uses), run the full
   orchestrate loop (route → worker attempts → review → escalate). Then
   **export `model_patch` via the same helper** from the **final tree
   state** after apply (or no-op if empty/failed apply paths mark measurement
   failure — see §5). Do not trust `orchestrate`'s internal `result.diff`
   alone if it can include harness-only paths; re-diff the final tree with
   the shared helper's path filters.
4. Both arms metered per instance (existing meter infrastructure); the report
   records USD per arm per instance **and** run-scoped unpriced-call counts
   from the meter (required by the verdict gate — §4.5).
5. Emit `predictions-baseline.json` and `predictions-harness.json` in the
   **sb-cli JSON** format (dict or list of
   `{instance_id, model_name_or_path, model_patch}` — **not** JSONL).

Arm order per instance is fixed (baseline first) and both arms always run —
no `--baseline-only`/`--harness-only`: the verdict is only meaningful paired,
and partial sweeps invite cherry-picking. `--limit` preserves pairing at
reduced scale. Default execution is **sequential** per instance; resume skips
instance_ids that already have durable prediction rows for both arms.

#### 4.3.1 Shared patch export (`patchExport.ts`)

`runEvals` baseline never needs a SWE-bench patch today (it scores in place
with `runOracle`). The bench **must** produce official `model_patch` strings.

**Contract:** after an arm finishes, export a unified diff of the checkout's
final tree against the setup baseline commit:

1. Stage with `git add -A` semantics (same reason as
   `WorktreeManager.diff()` in `packages/engine/src/worker/worktree.ts`: bare
   `git diff` drops untracked/new files agents routinely create).
2. Diff the index against the **fixed baseline commit** created at setup (not
   `HEAD`, so an unprompted mid-task `git commit` cannot empty the patch —
   same load-bearing choice as `WorktreeManager.diff()`).
3. **Path filters:** exclude harness metadata and OpenFusion artifacts
   (e.g. `.openfusion/`, approved harness wiki/card files written into the
   tree, `AGENTS.md` if injected only for the harness arm) so they never
   enter `model_patch`. Prefer an allowlist of repo source paths if filters
   prove ambiguous; v1 minimum is a documented exclude list shared by both
   arms.
4. Empty deliberate patch → still emit empty `model_patch` and send to scoring
   (it will not resolve). Empty patch from an **error path** is a measurement
   failure (§5), not a scored attempt.

Both arms call this one helper so baseline and harness patches are format-
identical for the official harness.

### 4.4 Scoring (`score.ts`)

**Default:** official cloud evaluation via **sb-cli**. There is **no**
`swe-bench_verified_mini` subset in sb-cli. Mini is submitted as:

```
sb-cli submit swe-bench_verified test \
  --predictions_path <preds.json> \
  --instance_ids <comma-separated 50 mini instance ids> \
  --run_id <run-id>
```

- Predictions are **JSON** (dict or list), not JSONL; convert at the score
  boundary if intermediate artifacts prefer line-oriented storage.
- The 50 mini `instance_id`s are pinned next to the vendored dataset.
- **Resolved-rate denominator** is always **resolved / N** where N is the
  number of instances in *this* run (50 full mini, or fewer under `--limit`),
  **never** /500. Do not report raw “% of Verified” without renormalizing.
- Operator setup: sb-cli auth/API key and quota are required for the default
  path; document them in the CLI help.

**Fallback:** official local containerized harness behind `--local-docker` for
offline use. The ~5GB mini image footprint applies **only** to this path (not
to sb-cli cloud).

Scoring consumes the run's predictions and returns per-instance resolved
status per arm. The bench never re-implements the oracle. Submission/retrieval
failures are retryable without re-running arms — predictions are durable;
`bench score` is a separate subcommand.

### 4.5 Verdict + report (`report.ts`) — one small engine change

The M6.1 verdict math is currently embedded in `runEvals`. **Extract it into
a pure shared function.** Behavior must stay byte-for-byte identical for
`runEvals`'s existing tests.

**Required inputs** (incomplete rows reintroduce known false-pass paths):

| Input | Role |
|---|---|
| Per-task `{passedA, passedB, usdA, usdB, measurementFailure}` | Clean-subset quality/cost, floors, noise band, cost-regression fail |
| **`unpricedCalls` (run-scoped, ≥0)** | **Must-have.** Current gate at `run.ts` (~L970): if any model call in the run was unpriced, savings PASS is forbidden even when mixed-priced totals look positive (`addCost` null-skips undercount the expensive arm). Omitting this reopens the C1 mixed-priced false pass. |
| Task count / sample floors | Savings PASS ≥20; hazard FAIL may fire at low floor ≥5 |

Output: existing verdict/report-card shape (including clean-subset fields,
`qualityGapWithinNoise`, notes).

`runEvals` calls the extracted function with oracle-sourced rows + its
run-scoped meter `unpricedCalls`; the bench calls it with official
resolved-status rows + the same meter field. **One verdict definition, two
oracles.**

**Side-effect boundary:** the pure function **only** returns the report card.
`setEvalsVerdict(projectDir, …)` stays inside `runEvals` and must **not** run
on bench checkouts (throwaway django/sphinx trees under
`~/.openfusion/bench/`). Bench never flips a project `manifest.verification.evals`.

Report output: `benchmarks/results/<run-id>.json` (per-instance table:
resolved per arm, USD per arm, outcomes, measurement-failure flags) + a
human-readable `.md` summary (both arms' resolved-rate with /N denominator,
savings %, verdict, unpriced-call note if any, metered spend, environment
record, caveats from §8). `benchmarks/results/` is gitignored; summaries are
committed manually to seal milestone numbers.

## 5. Error handling

Guiding rule inherited from M6.1: **infrastructure failures are measurement
failures, never quality evidence.**

- **Prepare:** clone/harness-generation failures abort before any per-instance
  API spend, naming the failing phase. `uv` env-provisioning failure is
  recorded metadata, not an exclusion.
- **Run:** a per-instance arm error (frontier turn threw, orchestrate threw,
  apply-failed, empty diff from an error path) marks that instance's row as a
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
  PASS; the summary surfaces this explicitly. Material measurement-failure
  fraction still forces inconclusive (symmetric pass/fail gate).

## 6. Determinism & reproducibility

- Vendored dataset snapshot; pinned instance `base_commit`s (from the dataset
  itself); single-run pass@1 (multi-run significance stays deferred).
- The report records Node version, engine version, model roster, pricing
  snapshot, dataset snapshot hash, sb-cli/harness version, and the pinned
  mini instance-id list hash.
- Scoring authority is the official harness. **Paired** harness-vs-baseline
  numbers are the product claim. Absolute resolved rates are **directional**
  only relative to HAL / full-Verified public figures (plain local checkouts
  and a different scaffold; see §8). Never market absolute rates as
  HAL-comparable without container-native execution (v2).

## 7. Testing & cost controls

**CI-safe tests (no keys, no network, no Docker):**
- Dataset module: schema round-trip on a 2-instance fixture; rejection of
  malformed instances; assertion that `test_patch` / gold `patch` /
  `hints_text` are never exposed to run-side types.
- Verdict extraction: the decisive test is that `runEvals`'s existing suite
  passes unchanged after the refactor; plus direct unit tests of the pure
  function on synthetic rows (floors, noise band, cost regression,
  **unpricedCalls false-pass gate**, material measurement-failure fraction).
- Patch export: fixture tree with new file + modified tracked file + harness
  metadata path — asserts new/modified appear, harness paths excluded,
  baseline-commit anchor survives mid-export `git commit`.
- Runner dry-run: full per-instance flow against a synthetic local fixture
  repo with a stub model layer — checkout reset, harness copy, predictions
  **JSON** format — zero tokens.
- Scoring module: builds sb-cli argv with `swe-bench_verified` +
  `--instance_ids`; parses recorded sb-cli response fixtures; never
  re-derives pass/fail itself; asserts denominator is /N not /500.

**Env-gated smoke (real keys, operator-run):** `OPENFUSION_BENCH_SMOKE=1`
runs ONE instance end-to-end (both arms + sb-cli scoring), following the
existing env-gated generate-smoke pattern. Uses fixture or
`--approve-from` cards so smoke does not need a live interactive generate
gate.

**Cost controls & operator economics:**
- `--limit N` / `--instance <id>` validate plumbing on 1–3 instances before a
  50-instance sweep; every report prints metered USD so a small run
  extrapolates a full sweep's cost (print the extrapolation explicitly).
- Full mini ≈ 50 × 2 arms of frontier-grade work (baseline turn + full
  orchestrate, often with review/escalate) — expect **large** wall-clock and
  USD; never surprise-run 50 without a priced smoke first.
- Harness generation is once per repo (**2 total**), at prepare time, metered.
- Scoring via sb-cli is free of model spend; mini's image footprint (~5GB)
  only matters in the `--local-docker` fallback.
- Default sequential; resume by skipping completed prediction rows.
- Per-arm timeouts align with existing eval/orchestrate defaults (e.g.
  baseline 600s) unless operator overrides.

**BYOK/keys:** worker providers registered at startup from a gitignored JSON
file of `ProviderConfig` entries located via `OPENFUSION_BENCH_PROVIDERS`;
the frontier baseline rides the operator's existing subscription OAuth
through the embedded engines (same bootstrap path the desktop/engine already
uses for Claude).

## 8. Caveats (accepted for v1, stated in every report)

1. **Python repos, TS-first product.** Verified/Mini are all-Python; the
   card's deterministic command miner leans on tox/CI configs instead of
   package.json. This is a deliberate generality stress, not home turf.
2. **Agents work on plain local checkouts** with best-effort `uv` envs; some
   instances' tests won't run locally mid-task, so agents get weaker test
   feedback than container-native setups. Scoring is still always sound (the
   official Docker oracle is the authority). Absolute resolved rates will
   lag container-native public scaffolds; **paired** comparison remains valid
   because both arms share the same limitation. Container-native worker
   execution is v2.
3. **Per-repo (not per-instance) harness generation on only two repos** —
   card staleness on old django base commits is likely more material than on
   a 12-repo suite; per-instance generation is the v2 refinement if it shows
   up in results.
4. **No `hints_text` in v1** — problem statement only; keeps scores from
   free PR-discussion hints.
5. **Leaderboard context is directional** — different scaffold + local
   checkouts; do not claim HAL parity.

## 9. Non-goals (v1)

Full 500-instance Verified sweeps; leaderboard submission automation;
multi-run statistical significance; wiki-on/off ablation arms (both deferred
pending user sign-off); container-native agent execution; non-SWE-bench
datasets; CI-scheduled sweeps; feeding `hints_text` to agents.

## 10. Decisions resolved during design

- **Purpose:** validate the core **paired** claim; absolute rates secondary /
  directional — user-locked product claim, review-adjusted comparability.
- **Task source:** public dataset, not self-mined OSS repos — user-locked
  (supersedes the first draft).
- **Dataset:** SWE-bench Verified Mini (50 instances, **2 repos**: django +
  sphinx) — user-locked; design doc corrected from earlier “~10/~12 repos”
  language.
- **Scoring:** official harness only. Default: sb-cli
  `swe-bench_verified` + `--instance_ids` for the 50 mini ids; JSON
  predictions; resolved denominator /N. Local Docker fallback. The bench
  never re-implements the oracle.
- **Patch export:** shared helper after final tree state; `git add -A` +
  baseline-commit anchor (WorktreeManager.diff pattern); harness-path
  excludes; both arms identical format.
- **Verdict:** M6.1 math extracted to a pure shared function; inputs include
  **`unpricedCalls`** (required false-pass gate) and measurement-failure
  rows; one verdict definition across both oracles; **no**
  `setEvalsVerdict` on bench trees.
- **Checkout construction:** archive `base_commit` + fresh init primitive;
  do not call full `goldenTaskFromCommit`.
- **Prompt policy:** `problem_statement` only; no `hints_text` in v1.
- **Card gate:** interactive terminal approval for live generate; idempotent
  skip on matching digest; smoke via fixtures / `--approve-from`; never silent
  auto-approve of a fresh draft.
- **Workspace:** `~/.openfusion/bench/`, outside any source repo.
- **Execution:** sequential default; resume-safe predictions; cost
  extrapolation from small runs before full mini.
