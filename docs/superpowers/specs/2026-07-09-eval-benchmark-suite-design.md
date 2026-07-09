# Eval Benchmark Suite v1: Verified Golden-Task Mining + Bench CLI — Design

**Date:** 2026-07-09 · **Status:** approved, awaiting implementation plan
**Purpose decision (user-locked):** validate the product's core claim — harness
orchestration holds quality while cutting cost, measured by the existing M6/M6.1
eval gate — with a real, reproducible **30-task** suite mined from **pinned
external OSS repos**.

## 1. Problem

The measurement machinery is finished; the benchmark is not. `runEvals`
(`packages/engine/src/evals/run.ts`, hardened in M6.1) issues a two-dimensional
quality+cost verdict, requires ≥20 tasks for a savings PASS, and guards against
noise and measurement failures. But its input — `EvalTask[]` built from
`{commitSha, testCommand}` descriptors — has no supply line:

- Task selection is explicitly the **caller's** responsibility
  (`tasks.ts` v1 scope constraint): a golden commit must be a *pure
  fail-to-pass fix against tests that already existed at the parent commit*.
  Nothing enforces or discovers this today; a hand-picked commit that violates
  it silently corrupts the pass-rate.
- The only trigger is the desktop RPC (`engine.evals.run`) with hand-typed
  SHAs. There is no curated suite, no reproducible manifest, no script.
- OpenFusion's own history is heavily TDD (tests land with fixes), so it
  cannot supply 20+ valid golden commits — hence external repos.

## 2. Design at a glance

The benchmark is a **composition layer over existing, tested primitives**
(`goldenTaskFromCommit`, `runOracle`, `runEvals`, `engine.harness.generate`).
The verdict engine, RPC surface, and desktop app are untouched.

```
pinned OSS repos ──► bench mine ──► verified candidates ──► human curation
                     (local CPU only,                            │
                      empirical fail→pass)                       ▼
                                                   benchmarks/suite-v1.json
                                                   (committed, git-sealed)
                                                                 │
real keys (env + subscription OAuth) ──► bench run ──► runEvals (unchanged)
                                         │                       │
                          clone @ pinned SHA,                    ▼
                          frozen install,          benchmarks/results/<run-id>.json
                          harness gen +                        + .md summary
                          terminal card approval
```

## 3. Components

All new code lives in `packages/engine/src/evals/bench/` plus one committed
data file and a second `bin` entry in the engine package.

### 3.1 Miner (`mine.ts`)

Finds golden commits **empirically**, so every task in the suite is
machine-verified fail→pass. Two stages:

1. **Cheap deterministic filters** (no test execution): non-merge commits
   whose diff touches source files and adds **no new test files** (the
   golden-task constraint — a commit that ships its own test leaves the parent
   state without that test). Bounded diff size. Commits that only touch
   docs/config are skipped.
2. **Empirical verification** per surviving candidate: build the parent-state
   tree (reusing `goldenTaskFromCommit(...).setup`), run the repo's install
   command, run the test command → **must fail** (nonzero exit — an ENOENT or
   install error discards the candidate as a setup problem, mirroring
   `runOracle`'s ENOENT-vs-nonzero distinction); rebuild at the fix commit →
   **must pass**. Only commits that demonstrably flip fail→pass are emitted.

Output: a candidate report (commit sha, subject, diff stats, test runtime) for
human curation. Mining costs zero API tokens — it is git + local test runs.

Flaky-suite immunity falls out for free: a commit whose fail→pass cannot be
reproduced deterministically in one verification pass never enters the suite.

### 3.2 Suite manifest (`benchmarks/suite-v1.json`)

The git-sealed benchmark definition, zod-validated (`manifest.ts`):

```json
{
  "suite": "v1",
  "repos": [
    {
      "id": "zod",
      "gitUrl": "https://github.com/colinhacks/zod.git",
      "pinnedSha": "<full sha>",
      "install": ["pnpm", "install", "--frozen-lockfile"],
      "test": ["pnpm", "test"]
    }
  ],
  "tasks": [
    { "repo": "zod", "commitSha": "<full sha>", "promptOverride": null }
  ]
}
```

- **30 tasks** across 2–3 repos (comfortably above the 20-task savings-PASS
  floor so a few dropped tasks cannot void a sweep).
- `promptOverride` (optional, default null): the golden prompt is the commit
  subject (`goldenTaskFromCommit`'s existing behavior); curation may override
  when a subject is too cryptic to serve as a task statement. Overrides are
  visible in the committed manifest — no hidden prompt engineering.
- Repo entries listed above are **illustrative**; final repo picks are made
  during implementation by mining yield against the selection criteria (§6).
- Validation rejects duplicate `(repo, commitSha)` pairs and tasks referencing
  unknown repo ids.

### 3.3 Runner + CLI (`runner.ts`, `cli.ts`)

A second bin (`openfusion-bench`) beside the sidecar entry. Subcommands:

- **`bench mine --repo <id> [--max N]`** — stage 1+2 above, prints the
  candidate report. Repos are declared in the manifest **before** tasks exist
  (a manifest with repos and an empty `tasks` array is valid); mining reads
  the repo's `gitUrl`/`pinnedSha`/`install`/`test` from there, so install and
  test commands are stated exactly once.
- **`bench run [--limit N] [--task <id>]`** — the measured sweep:
  1. **Prepare** (idempotent): clone each repo at `pinnedSha` into
     `~/.openfusion/bench/<repo-id>/` — outside any source repo, per
     `tasks.ts`'s security note that eval dirs must live away from `repoDir` —
     then run the frozen install.
  2. **Harness ensure**: if the clone has no `.openfusion/` harness, run
     `engine.harness.generate`. Card approval is a **mandatory interactive
     terminal gate**: the CLI prints the drafted card digest and requires an
     explicit `y` before approving via the same `HarnessService` path the
     desktop uses. The human gate is relocated, never bypassed; there is no
     `--yes` flag for card approval in v1.
  3. **Task construction**: for each manifest task, build the `EvalTask` via
     `goldenTaskFromCommit`, then **wrap** its `setup` closure to append the
     repo's install command (external repos need dependencies inside the
     history-stripped eval worktree; `EvalTask.setup` being a plain closure
     means `runEvals` needs no change).
  4. **Measure**: call `runEvals` in-process with all (or `--limit`ed) tasks.
  5. **Report**: write `benchmarks/results/<run-id>.json` (full
     `EvalsReportCard` + per-task table + environment record) and a
     human-readable `.md` summary (verdict, pass rates, savings %, metered
     USD). `benchmarks/results/` is gitignored; a summary is committed
     manually when the user wants to seal a milestone number.

Engine construction mirrors `main.ts` (`createEngine({log, notify})`), with
notifications logged to stderr. BYOK worker providers are registered at
startup from a gitignored JSON file of `ProviderConfig` entries (same shape
the desktop registers over RPC), located via the `OPENFUSION_BENCH_PROVIDERS`
env var — one mechanism, no per-provider env-var sprawl. The frontier
baseline rides the operator's existing subscription OAuth through the
embedded engines.

## 4. Error handling

Guiding rule inherited from M6.1: **infrastructure failures are measurement
failures, never quality evidence.**

- **Mining:** parent-state test *errors* (ENOENT, install failure, timeout)
  discard the candidate; they are never counted as the required "fail" leg.
- **Run setup:** clone/install/harness-generation failures abort **before any
  API spend**, with the failing phase named in the error.
- **Per-task infra errors during a sweep:** already handled inside `runEvals`
  (`"error"` / `"apply-failed"` outcomes are measurement failures). The bench
  layer adds nothing here.
- **Floor interaction:** if dropped tasks push a sweep below the 20-task
  floor, the existing verdict engine already refuses a savings PASS; the
  summary surfaces this state explicitly rather than re-implementing a guard.

## 5. Determinism & reproducibility

- Pinned full SHAs for repos and task commits; frozen-lockfile installs.
- The report records Node version, engine version, model roster, and pricing
  snapshot alongside results.
- Suite manifest committed in-repo → any future run is the exact same exam.
- Single-run pass@1 remains the v1 measurement (multi-run significance is a
  deferred pillar pending user sign-off; see §8).

## 6. Repo selection criteria

Candidate repos must be: TypeScript/JavaScript; test suite fast (<5 min) and
deterministic; **no network access in tests**; installable offline-ish via a
committed lockfile at the pinned SHA; rich non-merge history (several hundred
commits) with fix-shaped commits. 2–3 repos diversify codebase style without
multiplying install surface. Final picks are an implementation-time decision
driven by actual mining yield.

## 7. Testing & cost controls

**CI-safe tests (no keys, no network):**
- Miner unit tests against synthetic on-the-fly git fixture repos: a
  known-good pure fail→pass fix survives; adds-test-with-fix, merge commits,
  and erroring suites are rejected — asserting exactly which candidates emerge.
- Manifest schema tests: round-trip, malformed entries, duplicate detection.
- Runner dry-run: full `bench run` wiring against a `synthEvalTask`-style
  fixture repo with a stub model layer — workspace layout, setup wrapping,
  report emission — zero tokens.

**Env-gated smoke (real keys, operator-run):** one `OPENFUSION_BENCH_SMOKE=1`
test running a single task end-to-end, following the existing env-gated
generate-smoke pattern.

**Cost controls:**
- `--limit N` / `--task <id>` validate plumbing on 2–3 tasks before a full
  sweep. No `--baseline-only` / `--harness-only` flags: the verdict is only
  meaningful paired, and partial sweeps invite cherry-picking; `--limit`
  reduces scale while preserving pairing.
- Every report prints metered spend (existing meter infrastructure), so a
  small run extrapolates the cost of a full sweep before you commit to one.
- Mining and curation are API-free by construction.

## 8. Non-goals (v1)

Explicitly out of scope, aligned with the deferred-pending-sign-off list:
multi-run statistical significance; wiki-on/off ablation arms; difficulty
stratification; non-JS/TS repos; CI-scheduled sweeps; public benchmark
adapters (SWE-bench et al. — a different question: model capability, not the
harness cost/quality claim).

## 9. Open items resolved during design

- **Purpose:** validate the core claim (not CI regression, not public
  numbers, not smoke-only) — user-locked.
- **Task source:** pinned external OSS repos — user-locked. OpenFusion's own
  TDD-heavy history cannot reach the task floor.
- **Scale:** 30 tasks — user-locked.
- **Approach:** verified-mining CLI over manual curation or SWE-bench
  adaptation — user-locked.
- **Card gate:** interactive terminal approval, never auto-approve.
- **Workspace:** `~/.openfusion/bench/`, outside any source repo.
