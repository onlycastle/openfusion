# Best-Harness Component Checklist (web-grounded, adversarially verified)

**Date:** 2026-07-12
**Method:** deep-research workflow — 5 parallel search angles → 15 primary sources fetched → every extracted claim verified by 3 independent adversarial voters (≥2/3 refutations kill a claim). 13 findings survived; several headline vendor claims were refuted and are listed below. Cross-referenced against a same-day full inventory of this repo (including the uncommitted 2026-07-10 wave).

**Question:** What components does a best-in-class, model-neutral coding-agent harness need in 2026, and which should OpenFusion prepare first?

---

## 1. The governing evidence: the harness is not optional

All verified, primary-source-checked:

| Finding | Numbers | Source |
|---|---|---|
| Harness choice alone (model fixed) swings Pass@1 | 12.5 pp (GLM 5.1), 27.4 pp (Qwen 3.6-flash) across 5 harnesses | Claw-SWE-Bench, arXiv:2606.12344 |
| The file-edit/patch **adapter alone** spans | 19.1% (bare unified-diff) → 73.4% (tool-mediated edits, patch from git state, <1.5% apply failures), same model | arXiv:2606.12344 (single-backbone caveat) |
| Scaffold choice swings **cost** at near-equal accuracy | $171 vs $1,577 (9×) for ~2 pp accuracy delta | HAL, arXiv:2510.11977 (ICLR 2026, 21,730 rollouts) |
| Cost-aware eval changes rankings | Most expensive model on the accuracy-cost Pareto frontier in only **1 of 9** benchmarks | HAL |
| Explicit verification actions correlate with success | +13–87% per-task success; mid-run self-correction 1.5–4× (correlational) | HAL §4.2 |
| LLM-inferred least-privilege fails, esp. open models | 70–83% optimality (frontier) → **20–34% (open-source)** vs mechanical ILP baseline | MiniScope, arXiv:2512.11147 (Berkeley Sky Lab + IBM) |
| Real-world policies are not statically definable | 74% context-dependent, 16% stateful, 81% of repos have ≥1 cross-event policy (64-repo study); agents bypass the tool layer via scripts | ActPlane, arXiv:2606.25189 |

Implication for open-model BYOK workers specifically: they are the *worst* at self-restraint (20–34% least-privilege optimality) and the *most* harness-sensitive (27.4 pp swing) — the exact population OpenFusion routes work to. The harness thesis is strongest for our architecture.

## 2. Prioritized checklist vs. current OpenFusion status

Status legend: ✅ implemented · 🟡 partial/inert · ❌ absent. Statuses include the uncommitted wave.

### P0 — prepare first

| # | Component | Status | Gap to close |
|---|---|---|---|
| 1 | **Harness self-eval: fixed-model harness-A/B mode.** Swap harness variants (loop, tools, workspace mgmt, stopping policy) with the model held constant; always disclose scaffold with any score. | 🟡 | Bench CLI has baseline-vs-harness arms but no harness-variant-vs-variant mode (learning-spine variants phase unbuilt). **Sub-gap: eval runs still don't attach the wiki MCP — our central context artifact is untested by our own gate.** |
| 2 | **Patch/edit adapter hardening + apply-failure metric.** Target <1.5% patch-apply failure; measure it. | 🟡 | Worker apply-patch + candidates `git apply --3way` exist; the ledger does not record apply-failure rate, so we can't see the 19→73% lever. |
| 3 | **Two-dimensional quality+cost gate.** | ✅ | Validated by HAL. Extend: per-run Pareto-frontier (accuracy vs cost) reporting into the run ledger; re-price when vendor prices move. |
| 4 | **Verification actions inside the worker loop**, not only the final gate. | 🟡 | Stage-verification + review gate landed; the worker itself doesn't systematically construct tests/artifacts mid-run. |

### P1 — the durable moat (article layers 2–3)

| # | Component | Status | Gap to close |
|---|---|---|---|
| 5 | **Policy engine v2: dynamic, stateful, action-level.** Static allowlists structurally miss 74% of real policies; agents route around the tool layer via scripts they wrote earlier. Must be **mechanical, never LLM-inferred**. | 🟡 | `PolicyEvaluator` is wired and mechanical (good), but grants are static; no cross-event state; no visibility into indirect execution paths. macOS problem: the strong evidence is eBPF/Linux — our options are Endpoint Security-style monitoring or Linux-microVM workers (open question). |
| 6 | **Sandbox + deterministic pre-action authorization as complementary layers**, with per-tool-call authorization decisions written to the audit ledger. | 🟡 | Both bones exist (Seatbelt backend + PolicyEvaluator + two ledgers); the ledger doesn't record per-action authorization decisions. Worker process isolation still deferred (M7) — the repo's most-repeated caveat. |
| 7 | **Context-management runtime: staged compaction (~70/80/85/90/99% pressure), tool-result clearing, event-driven system reminders.** Large windows don't substitute (context rot). | ❌ | Fully scaffolded, fully inert: `compaction:false`, every `compactionThresholdSteps` = 0. This is the biggest built-but-dead subsystem. |
| 8 | **Long-running task management: initializer (setup script + progress file + initial commit) + one-feature-at-a-time incremental merge-ready commits.** Not absorbed by models (Anthropic first-party, Nov 2025; boundary moving — Opus 4.6-era compaction absorbed manual resets within ~4 months). | 🟡 | RunKernel budgets/admission/cancel are solid. No initializer/progress-artifact pattern; OpenFusion never commits (HITL design choice) — an in-worktree incremental checkpoint equivalent is the compatible shape. |
| 9 | **Rollback/undo.** | ❌ | Apply is working-tree only; no snapshot/undo. Already proposed in learning-spine plan; unbuilt. |

### P2 — extend what's validated

| # | Component | Status | Gap to close |
|---|---|---|---|
| 10 | **Persistent memory write-back**: run outcomes → playbook/wiki deltas (selector/reflector/curator pattern); precursor to weakness mining. | ❌ | Ledger exists (substrate ready); no consumer. This is the deferred "weakness mining" lane. |
| 11 | **Per-cognitive-workflow model binding** (think/critique/compaction/VLM/execute) via config with fallback chains — vendor swap = config change. | 🟡 | Route-by-task-class exists (keyword v1); per-workflow binding partial (`updateAgentModel`); frontier-backed classifier still deferred. |
| 12 | **Wiki v1 hybrid design (curated card + JIT retrieval, no vector index).** | ✅ | Exactly matches the verified shipped pattern (Claude Code). Keep. Do NOT build a vector substrate first. Wiki `quality` verification stub still hardcoded "inconclusive". |
| 13 | **Defense-in-depth completeness audit** (5 layers: prompt guardrails / schema restrictions / runtime approvals / tool validation / lifecycle hooks). | 🟡 | Use as a checklist over the tool-execution layer; layers 1 and 5 are thinnest. Design pattern, not validated requirement. |

### Housekeeping gaps surfaced by the inventory (not from web research)

- `engine.evals.run` lost its desktop entry point (EvalsScreen deleted, HarnessHealthScreen doesn't call it); `engine.runs.list` has no engineClient binding; no sidecar restart control.
- Engine tests 67 failed / 743 passed — tests lag the new store layout/contracts; wave is mid-flight, not commit-ready.

## 3. What's safe to NOT build (layer 1)

Elaborate prompt/workflow scaffolding (planner/executor/verifier chains, manual context resets) is being absorbed — but the verified lesson is **"the space of interesting harness combinations doesn't shrink as models improve; it moves."** So: build layer-1 pieces as swappable, versioned configuration (the fingerprinted `REVIEW_POLICY_VERSION` pattern is the right instinct), never as core architecture.

## 4. Refuted / unsettled — flag for our own thesis

- **"Task-specific scaffolds consistently beat generalist" — REFUTED 0-3 for overreach.** HAL compared against its own weak generalist baseline only. This is a core OpenFusion bet (generated specialist harness per repo); it is *unsettled*, not validated — which makes P0 #1 (harness-A/B self-eval) the item that protects the whole thesis.
- All three quantitative claims from the OAP vendor preprint (arXiv:2603.20953: 0% attack success, 53ms latency, hook standardization) — refuted 0-3. Only its architectural "sandbox+authorization are complementary" claim survived.

## 5. Where verified evidence was NOT obtained (don't mistake silence for unimportance)

No claims survived verification for: GEPA/self-improvement loops, weakness-mining efficacy, KV-cache/prompt-cache economics, session persistence, terminal-bench, most vendor feature matrices (OpenAI AgentKit/Codex, Google ADK/Antigravity, OpenHands, LangGraph, Cursor, Devin, Aider), and — notably — **whether machine-generated repo context helps or hurts** (the ETH question our wiki design hinges on remains open at web scale; our in-repo `2026-07-07-harness-composition.md` treatment stands).

**Follow-up:** a later, separately scoped audit found primary production and
cross-provider evidence for cache-aware routing and prompt-cache economics.
See
[`2026-07-12-harness-economics-model-mix-caching-and-owned-loop.md`](2026-07-12-harness-economics-model-mix-caching-and-owned-loop.md).
This link does not revise the original adversarial vote record above, and the
generated-project-context question remains unresolved.

Source-concentration caveat: 13 surviving claims trace mostly to four documents (two Anthropic engineering posts + three preprints with author conflicts; only HAL is peer-reviewed).

## 6. Mapping to the three-layer taxonomy (harness-obsolescence debate)

The framing (prompt/workflow harness → absorbed; tool-execution harness → model-capability-independent; runtime/memory/infra harness → most important, barely started) is quantitatively supported by the verified evidence above. OpenFusion's current shape scores: layer 1 correctly minimized and versioned; layer 2 ~70% built (policy v2 depth + isolation + rollback missing); layer 3 ~40% built (kernel/ledger/cost strong; compaction/caching/memory-write-back inert or absent). The "model-neutral orchestration that big vendors can't do" position is exactly where the strongest verified evidence (BYOK workers most harness-sensitive, least self-restrained) concentrates.

## 7. Open questions carried forward

1. macOS-native equivalent of eBPF-grade action-level enforcement (Endpoint Security vs Linux-microVM workers): overhead and portability unproven.
2. Do GEPA-style loops / ledger weakness-mining pay for their eval cost in production? (No surviving evidence either way.)
3. Is the generated project card net-positive? → answerable with our own gate once evals attach the wiki MCP (P0 #1 sub-gap).
4. Which layer gets absorbed next, and should the harness carry per-model capability flags that auto-disable absorbed features?
