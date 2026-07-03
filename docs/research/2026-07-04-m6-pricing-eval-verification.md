# M6 Pricing + Eval-Design Verification (verified 2026-07-04)

The savings report card depends on these prices. Confidence: [V] verified
official this week / [S] secondary or soft-documented / [U] unverified.

## Pricing table ($/Mtok) — for the M6 pricing refresh

| Model id (our kind/model) | input | output | cache-read | cache field | conf |
|---|---|---|---|---|---|
| moonshot/kimi-k2.6 | 0.95 | 4.00 | 0.16 | `usage.cached_tokens` (example-only) | S |
| moonshot/kimi-k2.7-code | 0.95 | 4.00 | 0.19 | same | S |
| zai/glm-5.2 | 1.40 | 4.40 | 0.26 | `usage.prompt_tokens_details.cached_tokens` | V |
| deepseek/deepseek-v4-flash | 0.14 | 0.28 | 0.0028 | `prompt_cache_hit_tokens`/`_miss_tokens` | V |
| deepseek/deepseek-v4-pro | 0.435 | 0.87 | 0.003625 | same | V |
| openai-compatible/qwen3-coder-next | 0.11 | 0.80 | 0.07 | `usage.prompt_tokens_details.cached_tokens` | V |
| openai-compatible/qwen3-coder | 0.22 | 1.80 | 0.10 | same | V |
| openai-compatible/minimax-m2.5 | 0.15 | 1.00 | 0.03 | same (promo 0.12/0.48) | V |
| reference/claude-sonnet-5 | 2.00→3.00(2026-09-01) | 10.00→15.00 | 0.20 | `cache_read_input_tokens` | V |
| reference/claude-opus-4-8 | 5.00 | 25.00 | 0.50 | same | V |
| reference/gpt-5.5 | 5.00 | 30.00 | 0.50 | `usage.prompt_tokens_details.cached_tokens` | V |
| reference/gpt-5.4 | 2.50 | 15.00 | 0.25 | same | V |

Anthropic cache-WRITE (not modeled by our meter's read-only cache field):
Sonnet5 5m 2.50 / 1h 4.00; Opus4.8 5m 6.25 / 1h 10.00.

## Meter shape notes (IMPORTANT for correct pricing)

- Our `estimateCostUsd` = `(inputTokens - cacheRead)*inputPerMtok +
  cacheRead*(cacheReadPerMtok ?? inputPerMtok) + output*outputPerMtok`.
- **DeepSeek fits this correctly**: set inputPerMtok = the cache-MISS rate
  (0.14 flash / 0.435 pro), cacheReadPerMtok = the cache-HIT rate. DeepSeek's
  input price IS the miss rate (not base+discount), so miss = total −
  cacheRead priced at inputPerMtok is exactly right. No meter re-architecture.
- Anthropic/OpenAI/GLM/Qwen fit the standard "input rate applies to
  non-cached, cache-read is the discounted rate" — same formula.
- **OpenRouter multi-endpoint spread**: qwen/minimax have 4–16 endpoints at
  different prices. Pin a SPECIFIC endpoint in pricing, or mark the price as
  endpoint-dependent (confidence-flag). "The OpenRouter price" is not a
  single number.

## Flags (must ship as confidence != verified)

- Moonshot cache field is example-only in the API ref → [S]. If we can't
  confirm cache-token reporting on a first live call, the kimi cache-read
  price is unusable (mark unverified). Same discipline for GLM if its live
  response omits the field.
- DeepSeek `deepseek-chat`/`deepseek-reasoner` aliases HARD-RETIRE 2026-07-24
  — pricing table + any config must use `deepseek-v4-flash`/`-v4-pro` ids.
- Sonnet 5 intro→standard flip 2026-09-01: pricing entries need a
  time-awareness note (verifiedAt captures which regime).

## Eval design (Q2) — verified best practice

- **Correctness oracle**: SWE-bench-style — apply the change, run the repo's
  OWN test suite, pass/fail on exit code, in an isolated checkout. Hand-roll
  "run the project's test command in the worktree, check exit code" is the
  pragmatic default. (Harbor is a real reusable library if we want sandboxing
  + pluggable verifiers later; not needed for v1.)
- **Golden tasks from commits** = the SWE-bench recipe: check out the
  pre-commit state, the task is "reproduce this change", oracle = the tests
  that the commit made pass now pass. GOTCHAS: (a) git-history leakage — an
  agent can `git log --all`/reflog to read the answer; strip history / use a
  shallow checkout with the target commit removed; (b) flaky tests; (c)
  overly-narrow test assertions rejecting correct-but-different solutions
  (~59% on hard tasks in one audit); (d) prefer few-file commits WITH their
  own tests; avoid docs-only/test-only commits.
- **Sample size**: Anthropic guidance — 20–50 tasks is a solid start for a
  credible claim when the effect is large; halving the detectable effect ≈ 4×
  samples; PAIRED comparison (same task, both harnesses) reduces variance for
  free. A 5-task run is a demo, not a claim. (arXiv:2411.00640; Anthropic
  "Demystifying evals".) → v1 CI uses a handful of SYNTHETIC fixture tasks
  (mechanics test); the real repo-mined 20–50 task run is an operator smoke.
- **Baseline vs harness**: baseline = frontier does the task directly (a
  frontier session in a worktree, primary not fallback); harness = the full
  orchestrate loop (cheap worker + review + escalate-if-needed). Score BOTH
  by the same oracle; savings = (baselineCost − harnessCost)/baselineCost at
  held quality (harness pass-rate ≈ baseline pass-rate). ETH hazard (spec
  §12.1): a harness whose pass rate is materially BELOW baseline is FLAGGED,
  not "passed".
