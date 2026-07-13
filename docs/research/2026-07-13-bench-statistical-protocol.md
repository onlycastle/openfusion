# Proving "same accuracy, much cheaper" on a budget — statistical protocol for the bench CLI

**Date**: 2026-07-13
**Question**: How do we rigorously but cheaply prove the harness matches the baseline's
resolve rate while costing 50–70% less on SWE-bench Verified Mini, given each full run is
expensive?
**Method**: deep-research workflow (5 search angles → 24 sources → 118 extracted claims →
top 25 adversarially verified by 3-vote panels: **14 confirmed 3-0, 3 refuted and excluded**,
8 unverified because the verification wave hit a session limit — those are flagged
`[standard literature, unverified this run]` below and are all textbook statistics).

---

## 0. The headline reframe: you cannot prove "same accuracy" — and you don't need to

A non-significant difference test is **not** evidence of equivalence. Regulatory practice
(FDA non-inferiority guidance) is explicit: the claim to make is one-sided
**non-inferiority** — "the harness is not materially worse than baseline by more than a
pre-specified margin δ" — not sameness ([FDA NI guidance][fda], verified 3-0).

The claim also decomposes **asymmetrically**, and this is where the spend savings live:

| Sub-claim | Metric type | Effect size | Provable at n=50? |
|---|---|---|---|
| "≥50–70% cheaper" | continuous (USD/instance) | huge (2–3×) | **Yes, easily** — paired CI |
| "resolve rate held" | binary (resolved?) | ~zero (that's the point) | **Only at a ~10pp margin** |

The cost half of the verdict is cheap to prove because cost is continuous and the effect is
enormous. The accuracy half is the expensive part, because "no difference" on a binary
outcome is the hardest thing to bound. All the budget discipline goes there.

## 1. The paired design is the single biggest lever (we already have it)

`runner.ts` runs both arms on the same instance — keep that sacred. Inference must be done
on **per-instance paired differences**, never on the two arms' summary rates:

- Paired differences are a "free" variance reduction of 2·Cov(x_A,x_B)/n because scores on
  the same instances are positively correlated across systems ([Miller, *Adding Error Bars
  to Evals*, arXiv:2411.00640][miller], verified 3-0).
- Empirically, paired McNemar requires a **median 2.15× smaller n** than Miller's unpaired
  formula on 40 real leaderboard model pairs, matching the textbook 1/(1−ρ) gain
  ([arXiv:2605.30315][paired-n], verified 3-0).
- In a paired binary test, only **discordant** instances (arms disagree) carry information;
  concordant instances contribute nothing. Effective n ≈ n·p_d where p_d is the discordance
  rate — not 50 ([MetricGate][metricgate], unverified this run; standard).

**Tests to implement** (all closed-form, no dependencies):
- Accuracy difference: **exact McNemar** (binomial test on the discordant 2×2 cells b vs c —
  exact, because discordant counts at n=50 will be small; the χ² approximation needs many
  disagreements) ([Dror et al., ACL 2018][acl], verified 3-0).
- Accuracy non-inferiority: paired-binary NI test with **RMLE variance**, which controls
  type I error better than the naive Wald statistic ([Liu et al. 2002, *Stat Med*][liu],
  verified 3-0).
- Sample-size planning: **McNemar–Connor required-N** using the empirically observed paired
  correlation ρ̂ / discordance p_d ([arXiv:2605.30315][paired-n], verified 3-0; Connor 1987
  formula: n = [z₁₋α√p_d + z₁₋β√(p_d−Δ²)]² / Δ²).
- Cost savings: **paired bootstrap CI** on 1 − Σcost_H/Σcost_B. Caveat: bootstrap on n=50 is
  at the small end of reliability ([Dror et al.][acl], verified 3-0) — report the CI, and
  treat a lower bound clearing the target (e.g. ≥50%) as the pass condition, not the point
  estimate. The paired bootstrap tracks parametric required-N within 4–6% and is calibrated
  within 1.1pp of nominal α ([arXiv:2605.30315][paired-n], verified 3-0).

## 2. What n=50 can and cannot conclude (pre-register the margin)

- Detecting a **3pp** accuracy difference at 80% power needs **≈969 independent questions**
  ([Miller][miller], verified 3-0). n=50 cannot certify tight equivalence, full stop.
- Non-inferiority margins have regulatory precedent: **10–15% absolute** margins are common
  practice where comparator effects are large (antibiotic trials), and "preserve ≥50% of the
  comparator's effect" (M2 = 50% of M1) elsewhere ([FDA][fda], verified 3-0).
- Margin **scale matters**: defining δ on risk difference vs risk ratio vs odds ratio can
  change required n by up to ~2× for the same clinical intent ([PMC8847766][scale],
  verified 3-0). For a resolve-rate claim, absolute risk difference is the honest,
  legible choice.
- Empirical noise floor on this exact subset: HAL's leaderboard shows **±7pp (±3.5
  instances) across just 2 runs** of the same agent on Verified Mini (HAL page, fetch-phase
  claim, unverified) — single-run resolve rates at n=50 carry that much run-to-run noise.

**Practical pre-registration for n=50**: δ = 10pp absolute on resolve rate, one-sided
α = 0.05. That is the tightest margin n=50 plausibly supports, and it has citable precedent.
A tighter claim (δ = 5pp) requires escalating to the full 500-instance Verified set or
heavy repeats — budget accordingly and say so in the claim's fine print.

(Excluded as refuted 0-3 by the verify panel: "±0.15 equivalence needs ~120 pairs",
"2pp gaps are never resolvable / 5pp always are", and one claim about a test-battery repo.)

## 3. Sequential testing: stop spending the moment the verdict is clear — but pre-register it

All `[standard literature, unverified this run]` (the verify wave for these hit the session
limit; none were refuted):

- **Peeking is not free**: re-running a fixed-horizon test after every instance and stopping
  at first significance inflates false-positive rates — toward 1 in continuous-monitoring
  simulations ([arXiv:2302.10108][peeking]; [Johari et al., *Always Valid Inference*,
  Operations Research 2022][avi]).
- Two legitimate designs:
  1. **Group-sequential with alpha spending** (e.g. O'Brien–Fleming): pre-register 2–3 looks
     (e.g. after 20, 35, 50 instances) with adjusted per-look thresholds.
  2. **Always-valid inference / mSPRT / e-values**: CIs valid at *any* stopping time —
     maximal flexibility, somewhat wider intervals ([Johari et al.][avi]).
- Early stopping **biases the naive point estimate** (runs that got lucky stop earlier), so
  a stopped run should report the boundary-adjusted estimate or flag the bias
  ([PMC9691580][gsbias]).

Given `runner.ts` already writes durable `rows.json` after every instance and resumes by
skipping done ids, a group-sequential batch design needs **zero new execution machinery** —
only a pre-registered look schedule and the adjusted thresholds in the verdict math.

## 4. Nondeterminism: repeats vs more instances

- Variance decomposes as Var(μ̂) = (Var(x) + E[σᵢ²])/n: instance-sampling variance plus
  per-instance run-to-run variance. Repeating each instance K times shrinks only the second
  term — for binary scores K=1→2 cuts total variance by 1/3, K=4 by 1/2, with sharply
  diminishing returns after that ([Miller][miller], verified 3-0).
- Published practice for agents: **5 runs per config, report mean ± 95% CI via Student's t**
  ("AI Agents That Matter", [arXiv:2407.01502][aatm], fetch-phase claim) — motivated by LLMs
  being nondeterministic even at temperature 0.
- Given HAL's observed ±7pp on this subset, **K=2–3 repeats is the right buy** once the 50
  instances are exhausted: it directly attacks the noise term that makes the accuracy
  verdict inconclusive. Score each arm's per-instance resolve as the K-run mean (pass@1
  average), then run the paired tests on those.

## 5. Dataset honesty: what Verified Mini can carry

- Construction (author's repo, fetch-phase): k-means over all 500 Verified instances + linear
  programming to match marginal distributions of performance/difficulty **while minimizing
  Docker storage** — validated visually across 16 models, not statistically.
- **Verified empirically in our own vendored snapshot: the 50 instances are exactly
  25 django/django + 25 sphinx-doc/sphinx.** (HAL's description of it as a random 12-repo
  subset is wrong.) Any verdict generalizes to "django+sphinx-style mature Python
  codebases", not "software engineering". State that scope in the claim.
- The tinyBenchmarks line of work says ~100 IRT-selected anchors estimate full-benchmark
  scores within 2% ([arXiv:2402.14992][tiny], fetch-phase) — but with a caveat that lands
  directly on us: curated subsets **degrade for atypical models**, and a novel harness is
  exactly an atypical system. So: make the claim *about the subset itself* ("on SWE-bench
  Verified Mini") and escalate to full Verified for any headline "on SWE-bench Verified"
  claim.

## 6. Cost accounting: how published claims survive scrutiny

From "AI Agents That Matter" ([arXiv:2407.01502][aatm]) and the HAL leaderboard
(fetch-phase claims):

- Report **raw input/output token counts alongside USD**, so the claim is recomputable when
  prices change overnight. (Our `run-meta.json` should add per-arm token totals next to
  `pricingConfidence`.)
- **Prompt-caching discounts**: HAL's costs ignore them and overstate spend — our meter must
  price cached tokens at their discounted rate or the savings number is attackable in either
  direction. The existing `unpricedCalls > 0 → inconclusive` gate in `verdict.ts` is exactly
  right; keep it.
- The established presentation for two-dimensional verdicts is the **cost–accuracy Pareto
  frontier** with joint optimization framing — the paper's own DSPy case study is literally
  our claim shape (≈50% cost cut at unchanged accuracy), and its HumanEval table (93.2% @
  $2.45 vs 93.3% @ $6.36 vs 88.0% @ $134.50, "difference not significant") is the template:
  accuracy ± CI and dollars, per system, same plot.
- Cost-controlled evaluation is argued as mandatory even when cost isn't the headline,
  because accuracy alone is inflatable by meaningless spend (retries). Our two-dimensional
  M6.1 verdict is already the right frame; it needs interval-based decisions instead of
  point comparisons.

## 7. The protocol (minimal-spend ladder)

**Stage 0 — pre-register (free).** Commit to the repo before running: δ = 0.10 absolute NI
margin, one-sided α = 0.05; savings target CI lower bound (0 for "cheaper", 0.50 for the
strong claim); look schedule {20, 35, 50} with alpha-spending; K (repeats) policy; pinned
`harnessConfig` (already exists). A margin chosen after seeing data is worthless ([FDA][fda]).

**Stage 1 — smoke, n=10, K=1.** Existing `--limit`. No claims; verify measurement-failure
rate < 20% and pricing confidence, estimate p_d (discordance) and per-instance cost. Feed
p_d into Connor's formula to *forecast* whether n=50 can close the NI test — abort and
redesign here if not, before burning the other 40 instances.

**Stage 2 — the run, n=50, K=1, sequential looks.** At each pre-registered look:
- **Cost verdict**: paired bootstrap 95% CI on savings; pass when the lower bound clears the
  target. This will typically resolve at the first look — a 2–3× cost gap is a massive
  effect.
- **Accuracy verdict**: exact McNemar on discordants + paired NI test (RMLE) at δ. Stop
  early only across a pre-registered boundary; flag boundary-adjusted estimates.

**Stage 3 — only if accuracy is inconclusive.** Buy variance reduction in this order:
(a) K=2–3 repeats on all 50 (cuts noise ~1/3–1/2, attacks the ±7pp run noise);
(b) escalate instance count on full SWE-bench Verified (500) — required n from Connor's
formula with the observed p_d. Never just re-run n=50 K=1 until it passes — that's
p-hacking with extra steps.

**Standing spend-saver**: cache the **baseline arm** per (dataset snapshot, baseline
model+version, prompt config) and reuse it across harness iterations — the baseline doesn't
change when the harness does. Invalidate on any model/config change. This halves every run
after the first during development.

**Reporting** (what makes the claim credible): per-instance `rows.json` published; the 2×2
McNemar table (both discordant cells, not just the rates); resolve rate ± CI per arm; NI
test result at the pre-registered δ; savings CI; token counts + USD (cache-priced); Pareto
plot; scope statement ("SWE-bench Verified Mini = 25 django + 25 sphinx"); K and look
schedule.

## 8. Mapping to code (verdict.ts is the only real change)

Current `computeEvalsVerdict` decides on point estimates: `qualityHeld = harnessPassed >=
baselinePassed` with a flat 5% band; savings pass = `cleanSavingsPct > 0` at ≥20 tasks.
Replace the decision core, keep the gates:

- Keep: measurement-failure materiality (20%), `unpricedCalls → inconclusive`,
  clean-subset logic, MIN_TASK floors.
- Replace `qualityHeld`/noise-band with: exact McNemar p-value + one-sided paired NI test at
  pre-registered δ (RMLE variance). The 5% band was a hand-rolled NI margin — this makes it
  principled and citable.
- Replace `cleanSavingsPct > 0` with: paired-bootstrap CI lower bound vs target.
- Add to the report card: discordant counts (b, c), p_d, CI bounds, the pre-registered
  parameters used, and boundary-adjustment flag when stopped early.
- New pure module alongside `verdict.ts` (e.g. `stats.ts`): exact binomial McNemar,
  RMLE NI statistic, Connor required-N, seeded paired bootstrap. All closed-form or
  simple loops; no dependencies; property-testable.

## Sources

Verified 3-0 unless noted.

- [Miller, E. *Adding Error Bars to Evals* (Anthropic), arXiv:2411.00640][miller] — paired
  differences, power formula (969-question example), variance decomposition/resampling.
- [Dror et al., *The Hitchhiker's Guide to Testing Statistical Significance in NLP*, ACL
  2018][acl] — McNemar applicability, bootstrap small-n caveat, test-selection tree.
- [*Paired McNemar required-N for LLM evals*, arXiv:2605.30315][paired-n] — 2.15× paired
  efficiency on real leaderboard data; McNemar–Connor Eq. 6; calibrated paired bootstrap.
- [Liu et al., *Tests for equivalence or non-inferiority for paired binary data*, Stat Med
  2002][liu] — RMLE-based paired NI test.
- [FDA, *Non-Inferiority Clinical Trials to Establish Effectiveness* (guidance)][fda] —
  one-sided NI framing, M1/M2 margin tiers, margin–sample-size tradeoff.
- [*NI margin scale for binary endpoints*, PMC8847766][scale] — RD vs RR vs OR changes n up
  to ~2×.
- [MetricGate, McNemar paired sample size][metricgate] — Connor formula, discordant-only
  information *(2-1 / unverified mix)*.
- [Johari, Koomen, Pekelis, Walsh, *Always Valid Inference*, Oper. Res. 2022][avi] — peeking
  invalidity; always-valid p-values/CIs *(unverified this run)*.
- [*Peeking simulations*, arXiv:2302.10108][peeking] — continuous-monitoring FPR → 1
  *(unverified this run)*.
- [*Bias after group-sequential stopping*, PMC9691580][gsbias] *(unverified this run)*.
- [*tinyBenchmarks*, arXiv:2402.14992][tiny] — 100 IRT anchors, <2% error; atypical-model
  caveat *(fetch-phase)*.
- [*AI Agents That Matter*, arXiv:2407.01502][aatm] — cost-controlled eval, Pareto frontier,
  5-run t-CIs, token/price reporting *(fetch-phase)*.
- [SWEBench-verified-mini repo (Hobbhahn)][minirepo] — k-means+LP storage-optimized
  construction *(fetch-phase; 25+25 repo split verified against our vendored snapshot)*.
- [HAL leaderboard, SWE-bench Verified Mini][hal] — ±7pp across 2 runs; cache-discount cost
  pitfall *(fetch-phase; its "random subset" construction description is contradicted by
  the author's repo and our snapshot)*.

[miller]: https://arxiv.org/abs/2411.00640
[acl]: https://aclanthology.org/P18-1128/
[paired-n]: https://arxiv.org/pdf/2605.30315
[liu]: https://onlinelibrary.wiley.com/doi/abs/10.1002/sim.1012
[fda]: https://www.fda.gov/media/78504/download
[scale]: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8847766/
[metricgate]: https://metricgate.com/docs/sample-size-mcnemar-paired/
[avi]: https://pubsonline.informs.org/doi/10.1287/opre.2021.2135
[peeking]: https://arxiv.org/pdf/2302.10108
[gsbias]: https://pmc.ncbi.nlm.nih.gov/articles/PMC9691580/
[tiny]: https://arxiv.org/abs/2402.14992
[aatm]: https://arxiv.org/abs/2407.01502
[minirepo]: https://github.com/mariushobbhahn/SWEBench-verified-mini
[hal]: https://hal.cs.princeton.edu/swebench_verified_mini
