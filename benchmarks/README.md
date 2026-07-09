# OpenFusion SWE-bench Verified Mini bench

Pinned public exam for the product claim: harness holds quality while cutting cost vs a direct frontier baseline.

## Dataset

- **Source:** [MariusHobbhahn/swe-bench-verified-mini](https://huggingface.co/datasets/MariusHobbhahn/swe-bench-verified-mini)
- **Vendored:** `swe-bench-verified-mini.json` (50 instances, 2 repos: `django/django`, `sphinx-doc/sphinx`)
- Run-side code never exposes gold `patch`, `test_patch`, or `hints_text`

## CLI

```bash
# From packages/engine after build:
pnpm build
pnpm exec openfusion-bench help

# 1. Clone repos (no API keys); harness gen needs frontier OAuth separately
openfusion-bench prepare --clones-only
openfusion-bench prepare   # interactive card approval per repo

# 2. Paired run (start small)
openfusion-bench run --limit 1
openfusion-bench run --instance django__django-11790

# 3. Score via sb-cli (needs sb-cli auth) or fixtures
openfusion-bench score --run-id <id>
openfusion-bench score --run-id <id> \
  --fixture-baseline path/to/baseline-report.json \
  --fixture-harness path/to/harness-report.json

# 4. Verdict report (M6.1 math + resolved rates / N)
openfusion-bench report --run-id <id>
```

Scoring submits as:

```text
sb-cli submit swe-bench_verified test \
  --predictions_path preds.json \
  --instance_ids <comma-separated mini ids>
```

Resolved rates use denominator **N** (instances in this run), never 500.

## Layout

| Path | Purpose |
|---|---|
| `~/.openfusion/bench/clones/` | Full git clones of django + sphinx |
| `~/.openfusion/bench/harness/` | Approved harness bundles per repo |
| `~/.openfusion/bench/runs/<run-id>/` | Predictions JSON, rows, score, report |
| `benchmarks/results/` | Optional committed milestone summaries (gitignored by default) |

## Environment

| Variable | Purpose |
|---|---|
| `OPENFUSION_BENCH_ROOT` | Override `~/.openfusion/bench` |
| `OPENFUSION_BENCH_PROVIDERS` | Worker provider config JSON (optional) |
| `OPENFUSION_BENCH_SMOKE=1` | Documented for operator one-instance smoke |

Provider config JSON can be a single provider, an array, or `{ "providers": [...] }`:

```json
{
  "providers": [
    {
      "id": "deepseek-bench",
      "kind": "deepseek",
      "apiKey": "sk-..."
    },
    {
      "id": "zai-bench",
      "kind": "zai",
      "apiKey": "sk-..."
    }
  ]
}
```

Use either:

```bash
OPENFUSION_BENCH_PROVIDERS=/path/to/providers.json openfusion-bench run --limit 1
openfusion-bench run --limit 1 --providers /path/to/providers.json
```

## Efficient Run Protocol

Do not start with all 50 instances. Use a gated ladder:

1. `pnpm --filter @openfusion/engine exec vitest run test/evals-bench-runner.test.ts`
   validates local benchmark plumbing with zero external spend.
2. `openfusion-bench prepare --clones-only` validates dataset clones and disk layout.
3. `openfusion-bench prepare --approve-from <approved-harness>` avoids fresh harness-generation spend while testing runner/scoring mechanics.
4. `openfusion-bench run --limit 1 --providers <providers.json>` estimates per-instance spend and catches provider/routing failures.
5. `openfusion-bench score --run-id <id> --fixture-baseline <json> --fixture-harness <json>` validates report generation without sb-cli spend/quota.
6. Run 3-5 instances from both repos before a full sweep:
   `openfusion-bench run --instance <django-id>` and `openfusion-bench run --instance <sphinx-id>`.
7. Only run all 50 when the small paired run has low measurement failures, priced calls, and sane patches.

For a real claim, use the full mini set. For engineering iteration, prefer 1,
then 3-5, then 10, and only then 50.

## Caveats (always stated in reports)

- Absolute % resolved is directional (local checkouts ≠ container-native scaffolds)
- Per-repo harness on only two repos can be stale on old base commits
- No `hints_text` in v1 prompts
