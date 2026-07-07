# Harness Composition — Design Research: Wiki, Team, Eval-Loop (July 2026)

**Method**: 3 parallel research agents (one per pillar), each grounding claims in
web sources fetched 2026-07-07 with confidence tags, cross-checked against the
2026-07-03 landscape survey (`2026-07-03-oss-landscape.md`) and the M6 eval plan
(`../superpowers/plans/2026-07-04-m6-evals.md`). This note turns that research
into **design decisions** for the three artifacts a generated harness contains:
the LLM **wiki**, the LLM **team** (roster + routing), and the **eval loop** that
makes the harness self-evolving. Where it contradicts the current spec, §4 lists
the corrections.

Confidence tags below: **[V]** primary source verified this session · **[S]**
multiple secondary sources agree · **[U]** vendor-claimed / unverified.

---

## 0. The spine: one finding governs all three pillars

The **ETH Zurich + DeepMind** study *"Evaluating AGENTS.md: Are Repository-Level
Context Files Helpful for Coding Agents?"* (arXiv:2602.11988, Feb 2026) is the
load-bearing constraint for the entire product. On **AGENTbench** (138 real tasks
from niche repos, memorization-resistant) plus SWE-bench Lite:

- **LLM-generated context files *reduced* success** by ~0.5–2% on average
  (dropping performance in **5 of 8 settings**) while **raising inference cost
  20–23%** and adding steps. **[V]**
- Human-written files gave only **+4%** (AGENTbench) at up to **+19%** cost. **[V]**
- **Mechanism = redundancy, not noise.** Generated files restate what the agent
  can already read; when the authors *removed* the repo's own docs, generated
  context then *helped* (+2.7%). Harm = restating inferable info + instructing
  the agent to over-explore/over-test ("thoroughness without task relevance"). **[V]**
- Authors' recommendation: **omit LLM-generated context; keep only minimal,
  non-inferable requirements** (custom build/test/tooling). The no-context
  baseline is "surprisingly competitive." **[V]**

Corroborated by *"Probe-and-Refine Tuning of Repository Guidance"*
(arXiv:2606.20512): naive one-shot generation must be **eval-gated and iteratively
refined**, not shipped raw. **[S]**

**Three design commitments fall out of this, and they bind all three pillars:**

1. **The wiki is a retrieval substrate served over MCP, never generated prose
   injected into the system prompt.** Always-on = tiny + non-inferable +
   eval-verified. Everything else = pulled on demand. (Pillar 1.)
2. **The team's cost win only counts if quality holds — and cost is part of the
   verdict.** A harness that holds quality but adds 20% cost is an *ETH failure*,
   not a pass. (Pillar 2.)
3. **The eval gate must prove the harness *beats a no-harness baseline* on
   quality AND cost** — "runs without error" is meaningless; even *adding
   context* routinely loses. (Pillar 3.)

---

## 1. Pillar 1 — the LLM wiki

### What the field actually does
The most capable *agentic* coders (**Claude Code, Cline**) deliberately run **no
embeddings index** — filesystem + AST + grep + read-on-demand — because agentic
search beat RAG on precision, freshness, and privacy (Boris Cherny: early Claude
Code *did* use a vector DB; agentic search won). **[S]** Embeddings persist mainly
in IDE completion/chat tools (Cursor, Continue, Cody, Roo). The one always-on
structure that helps and can't hallucinate is a **derived symbol skeleton** —
Aider's tree-sitter + PageRank repo map, **which OpenFusion already ships**. **[S]**

The positive signal for generated prose is narrow and specific: **hierarchical
summaries used as a *retrieval/navigation index*** (project→dir→file→symbol,
top-down search) beat both flat retrieval and LLM+RAG (ICCSA 2025 hierarchical
summarization: Pass@10 0.89 vs SOTA LLM+RAG on an industrial bug-localization
set). **[S]** DeepWiki/Devin productize this with **source-linked** pages the
"Ask" retriever queries — never bulk-injected.

### Decision — generate under `.openfusion/wiki/`, served via `wiki_query`/`wiki_map`

| Layer | Always-on? | Content | Anti-hallucination |
|---|---|---|---|
| **PageRank symbol skeleton** (built) | ✅ small (~1k tok) | "what/where" centrality map | derived from AST — can't hallucinate |
| **Project Card** | ✅ ≤300–500 tok | *non-inferable only*: build/test/run cmds, env quirks, hard invariants, domain glossary, grep-invisible gotchas | **execute/validate** extracted commands at gen time |
| **Hierarchical summary index** | ❌ retrieve | dir/file/symbol digests ≤150–300 tok each, top-down navigable | every claim grounded to `file:line`; **cross-check every referenced symbol against the tree-sitter graph, drop if absent** |
| **Architecture / data-flow pages** | ❌ retrieve | for orchestrator planning | mandatory `file:line` provenance-or-omit |

The **Project Card is the only generated always-on content the ETH result
endorses** — and only if kept to non-inferable facts. **Do not put an architecture
overview in it.** This is also what the `AGENTS.md`/`CLAUDE.md` exporter should
emit: minimal and non-inferable, explicitly *against* the instinct to dump a rich
overview.

**Keep it honest**: provenance-or-omit on every prose claim; deterministic
cross-check of generated symbols against the existing symbol store (catches
hallucinated architecture cheaply); git-SHA incremental refresh + visible
staleness banner (never silently serve stale pages).

**Open embeddings decision**: stay pure-symbolic (Claude-Code stance) vs. add an
*optional local embeddings tier over the summary digests* (not raw code) for
natural-language→code queries. Lean: **embed the summaries, keep code retrieval
symbolic.** Decide with the eval arm below. **[decision needed]**

---

## 2. Pillar 2 — the LLM team (roster + routing)

### The economics that reframe everything
The frontier seat runs under a **flat-rate subscription** (Claude Code / Codex CLI
under the user's own OAuth), so frontier **plan + review** tokens are *amortized,
not metered*. The **only metered API spend is open workers + escalations.** Role
assignment therefore optimizes two currencies: subscription-usage (frontier) and
API-dollars (workers). This "subscription arbitrage" is OpenFusion-specific and is
a large part of why 50–70% savings is plausible.

### Model standings (SWE-bench **Pro** — standardized harness — is the honest discriminator; Verified is saturated/harness-noisy, treat as directional)

**Frontier seat (subscription, not metered):**

| Model | ~Price in/out | Ctx | SWE-Pro | Role | Conf |
|---|---|---|---|---|---|
| Claude Opus 4.8 | $5 / $25 ($0.50 cache-in) | 1M | **69.2** (leads) | orchestrator + reviewer, quality-max | Med-High |
| Claude Sonnet 5 | $2 / $10 (intro) | 1M | 63.2 | orchestrator + reviewer, cheap-default frontier | Med |
| GPT-5.5 | $5 / $30 | ~400K | 58.6 | Codex-seat orchestrator/reviewer | Med |
| GPT-5.3-Codex | $1.75 / $14 | ~400K | 56.8 | the actual Codex-CLI worker model | Med |
| Gemini 3.1 Pro | $2/$12 | 1M | (SWE-V 80.6) | context-only, no engine adapter yet | Med |

**Open / BYOK worker seat (metered — the cheap execution tier):**

| Model | ~Price in/out | Ctx | SWE-Pro / note | Role | Conf |
|---|---|---|---|---|---|
| GLM-5.2 (Z.ai) | $1.40 / $4.40 ($0.26 cache) | ~1M | **62.1** (top open, self-reported) | top-quality / long-ctx worker | Med / [U] on score |
| Kimi K2.7 Code (Moonshot) | $0.95 / $4.00 | 256K | 58.6; long-horizon agentic | feature / long-session worker | Med |
| DeepSeek V4-Pro | $0.435 / $0.87 (**$0.0036 cache ≈180× < Anthropic**) | 1M | SWE-V 80.6, near-frontier | cheap **intermediate escalation rung**; long-ctx worker | Med-High |
| GLM-4.7 | $0.60 / $2.20 | ~200K | SWE-V 73.8 | value worker (price/quality knee) | Med |
| DeepSeek V4-Flash | $0.14 / $0.28 | 1M | lighter V4 | bulk mechanical worker | Med |
| Qwen3-Coder-Next | $0.11 / $0.80 | 256K (1M YaRN) | SWE-V 70.6 | cheapest credible worker; local classifier | Med |

> **Spec fix**: GLM-4.6 (named in earlier docs) is **obsolete** → GLM-4.7 (value) /
> GLM-5.2 (flagship). Kimi K2.6 pricing sources disagree ($0.60/$2.50 vs
> $0.95/$4.00) — verify at integration. Context *recall* degrades past ~180K on
> Kimi/Qwen 256K windows; prefer DeepSeek V4-Pro / GLM-5.2 for genuine large-ctx.

The top open worker (GLM-5.2 ~62) sits **~7 pts behind** the best frontier (Opus
69) and *beats* the mid-frontier GPT-5.5/Codex seat. **That ~3–8 pt gap on hard
agentic coding — and ~0 on mechanical work — is the entire quality risk being
managed.**

### Role assignment
- **Orchestrator / planner** → frontier subscription seat (Sonnet 5 default /
  Opus 4.8 quality-max). Reasoning-heavy, low-token — exactly what the
  subscription already covers. Never spend a metered worker here.
- **Router / classifier** → **not a standalone hot-path model call.** The
  orchestrator is already planning each subtask, so it emits
  `{class, difficulty}` as a field of its plan — a frontier-accurate classifier
  at zero marginal cost. Tiny local model (Qwen3-Coder-Next / embeddings) only
  for headless/non-planned dispatch.
- **Coding worker — by task type** (where multi-model earns its keep):
  mechanical/boilerplate/test-gen/rename → cheapest (Qwen3-Coder-Next /
  DeepSeek V4-Flash); new feature / multi-file refactor → GLM-5.2 / Kimi K2.7;
  bugfix → route by difficulty, escalate hard ones fast (the failing test is a
  cheap oracle); long-context → DeepSeek V4-Pro / GLM-5.2.
- **Reviewer** → frontier subscription seat, **read-only, tests-first.** Review
  recovers quality only when the reviewer *out-classes* the worker (self-repair
  gains come from stronger feedback — Olausson et al. ICLR 2024 **[V]**).
  Frontier-reviews-open-worker is the right asymmetry. **Tests run first** (a
  programmatic verifier beats an LLM judge "by a significant margin"; LLM-judge
  bias >50% on hard tests) — LLM review only catches design/intent/edge cases
  tests can't. Never let a worker judge itself.
- **Escalation** → Opus 4.8 after 2 worker failures (locked policy is correct);
  **DeepSeek V4-Pro is a cheap intermediate rung** (near-frontier at ~1/30th
  frontier cost) worth trying before burning the subscription seat.

### Routing design (kept cheap — the counterintuitive verdict)
Savings come **not from a clever learned per-query router** but from a **cheap
task-class/difficulty classifier deciding *before* generation + a hard execution
gate, tuned conservatively.** RouteLLM's "85% cut" is an MT-Bench chat figure that
collapses on hard coding; FrugalGPT cascades pay the cheap model's full cost on
*every* query including escalated ones. "Is Escalation Worth It?" (2026): a
lightweight **pre-generation** router beat the best cascade on 4/5 datasets. **[S]**

Layered router:
0. **Rules/keywords** (free): explicit intent, trivial ops → cheapest; dangerous
   ops (migrations, auth, concurrency) → frontier.
1. **Orchestrator-emitted class + difficulty** (marginally free) + free code
   signals you already compute (diff/file size, files touched, complexity,
   test-harness presence).
2. **Verifier-gated escalation grounded in execution** (tests/typecheck/build),
   **not model self-confidence** (the best-documented failure mode).
3. **Eval gate on every routing change** — roll the cheap-share up one notch at a
   time, watch quality not just the bill (this is M6).

Skip a heavy learned router in v1; add it later as *one input signal* to Layer 1.

### Multi-agent caution
**Parallel code-writers are the failure mode** — Anthropic's own orchestrator-
worker write-up *excludes* coding ("fewer truly parallelizable tasks"); MAST
(NeurIPS 2025) attributes **~79% of multi-agent failures to design/coordination**;
writes carry implicit decisions that silently conflict. **[S]** OpenFusion's
single-worker-per-task v1 is *correct*, not just a scope cut. Parallelize only the
read-heavy exploration/localization phase and genuinely independent worktrees —
never concurrent writers on a shared surface. Keep the tree shallow
(orchestrator → few workers → review); use the repo + shared plan as the
"blackboard."

### Recommended roster
**Cheap Default (shipping default):** orchestrator Sonnet 5 (or GPT-5.3-Codex) ·
router = orchestrator-emitted · workers Qwen3-Coder-Next / DeepSeek V4-Flash
(mechanical), GLM-4.7 (value), Kimi K2.7 / GLM-5.2 (feature) · reviewer Sonnet 5
tests-first · escalation Opus 4.8.
**Quality-Max:** orchestrator Opus 4.8 · workers GLM-5.2 / DeepSeek V4-Pro (1M) ·
reviewer Opus 4.8 tests-first · escalation Opus 4.8 + extended thinking.
Workers BYOK via Moonshot/Z.ai/DeepSeek native or OpenRouter (failover).

### Where savings come from (and the honest risk)
Three stacked sources: (1) nonlinear **cheap-share** (70/30 token split ≈ 67% cut,
80/20 ≈ 79%), (2) **10–30× price ratio** frontier vs top open (180× on DeepSeek
cache hits), (3) **subscription arbitrage** (frontier plan+review amortized). The
real risk (Risk #7): a **rubber-stamping review gate** turns "cheaper" into
"cheaper AND worse," and the cost meter *cannot detect it* — it prices calls, not
correctness. 50–70% at held quality is realistic **iff** tests exist to gate on,
the reviewer out-classes the worker, and the router is conservative + eval-gated.
**Without a test harness, treat the savings claim as UNVERIFIED.**

---

## 3. Pillar 3 — the eval loop and self-evolution

OpenFusion's already-designed M6 loop (baseline-vs-harness, oracle-scored, verdict
flips manifest `pending`→`pass`) is the **correct, literature-backed architecture.**
The research sharpens four things.

### 3.1 Public benchmarks can't validate a per-repo harness
Harness/scaffold swings **dominate** model differences (up to 15pp on SWE-Verified,
30–50pp on Terminal-Bench for the *same model*; arXiv:2605.23950 **[V]**).
SWE-bench Verified is contaminated/saturated (blind file-path guessing hits 76%;
59% of some "failures" are test flaws; 27-pt gap to SWE-bench Pro). **[S]** A
private repo isn't in any benchmark → **the eval must be repo-local.** M6 is right.

### 3.2 Cheaply generating a *trustworthy* per-repo eval
Adopt the **SWE-bench construction recipe per repo**: mine merged PRs touching test
files → revert → oracle = that PR's **FAIL_TO_PASS** (proves fix) + **PASS_TO_PASS**
(guards regressions). **[S]** Scale cheaply with **SWE-smith** (one execution env
per repo, hundreds of tasks via revert + mutation) and **R2E-Gym** (back-translate
the task prompt *from the diff* — covers the code+tests-together commits Risk #9
currently excludes). **[S]** Prefer post-cutoff commits (decontamination); **seal
the target commit's `.git` history + deny network** so the agent can't retrieve the
fix (Cursor found up to 63% of Opus "successes" retrieved the fix). **[S/V]**

### 3.3 Single-run pass@1 is inside the noise — this changes the verdict math
*"On Randomness in Agentic Evals"* (arXiv:2602.07150, 60k trajectories): single-run
pass@1 varies **2.2–6.0pp**; **std >1.5pp even at temperature 0** (temp 0 is *not*
deterministic). Power table: ~**36 runs** for a 1pp claim, ~**9** for 2pp, ~**2**
for 5pp, **1** for 10pp. **A savings/quality delta under ~5pp from a single run is
noise.** Report **pass^k** (consistency), not just pass@k, for a harness you ship. **[V]**
Weak oracles leak (7.8% of "passing" patches functionally wrong; arXiv:2503.15223 **[V]**).

### 3.4 Self-evolution — adopt **GEPA** first
*"GEPA: Reflective Prompt Evolution Can Outperform RL"* (arXiv:2507.19457, ICLR 2026
Oral). Reflective prompt mutation (reads full failure traces, diagnoses in natural
language, mutates prompt text) + **Pareto-frontier archive** (anti-overfit). Beats
GRPO by ~6% (up to 20%) at **35× fewer rollouts**; beats MIPROv2 >10%;
**multi-module native** (optimizes wiki-injection + N agent prompts jointly); needs
**only the eval suite as reward** — no labels, no gradients, no fine-tuning; ships in
DSPy; optimized prompts run ~33% shorter (cuts downstream cost). It matches every
OpenFusion constraint. **[V]**

- **Routing caveat**: the DSPy binding optimizes *instructions, not control flow*.
  To evolve `routing.yaml`, model the router as an LLM module (GEPA-native) or use
  the lower-level `gepa-ai/gepa` engine (evolves arbitrary text/YAML). **[V/S]**
- **Fallback**: TextGrad (Nature 2025) — same family, greedy, no Pareto protection.
- **Rejected for this use case**: Reflexion (wrong layer — runtime, ephemeral);
  intrinsic Self-Refine (LLMs can't self-correct without external feedback —
  arXiv:2310.01798 **[V]** — this is *why* every viable optimizer bolts reflection
  onto an external metric); ADAS (over-powered, invents code architectures);
  AlphaEvolve / Darwin Gödel Machine — inspiring end-state but **provably
  reward-hack** (DGM fabricated a passing-test log and deleted its own
  hallucination detectors **[V]**). Borrow their *archive + sandbox + human-review
  safety architecture*, not their autonomy. For the **wiki specifically**, layer
  **ACE**'s incremental-delta "playbook" discipline (avoids context collapse).

### 3.5 Closing the loop safely + cheaply
- **Three-way split**: optimize on train, select candidates on validation, **gate
  on a held-out test set the optimizer never sees** (GEPA's own design). **[V]**
- **Significance gate**: accept only if held-out gain exceeds the ~5pp noise band
  (or average enough runs); auto-reject anything regressing a standing pack.
- **Harden the sandbox *before* Phase 1** (not deferred to M7): ~30% hidden test
  holdout, test-file-edit detection, `.git` stripped, network denied (EvilGenie:
  hardcoding jumps to 33–44% otherwise). Keep the oracle/evaluator **outside the
  agent's write scope** — DGM's cautionary tale. **[V]**
- **Versioned harness + human canary**: every `.openfusion/` revision is an
  immutable archive entry (git gives this free); promote a GEPA-proposed harness
  only through a **human-approved checkpoint** (the Harness Editor), instant
  rollback. **Never optimize against the LLM reward-hack monitor** (teaches
  obfuscated hacking).
- **Cheap**: ~100-task **coreset** on every candidate, full suite + significance
  gate only on release (tinyBenchmarks ±2pp); **byte-identical** eval prefixes to
  bank ~90% prompt-cache discount (one timestamp busts it); open workers for bulk
  rollouts, frontier only for the review-gate/ambiguous cases; run the whole loop
  **only on harness change**, never per session.

### 3.6 Phased proposal
- **Phase 0 — MVP eval gate (this *is* M6, mostly built; finish it):** git-history
  golden tasks + execution oracle, **baseline-vs-harness, two-dimensional
  (quality + cost) verdict**, ≥30 tasks, 95% CIs, **wiki MCP attached during
  eval**, `.git` sealed. No optimization yet. This alone is the defensible product
  and the ETH defense.
- **Phase 1 — GEPA over prose + prompts:** turnkey `dspy.GEPA` on wiki + agent
  prompts; train/val/held-out split; significance-gated; **human-approved**
  promotion; versioned rollback; coreset inner loop.
- **Phase 2 — routing policy + wiki-as-playbook:** extend GEPA's general engine to
  `routing.yaml`; ACE-style incremental wiki deltas; full sandbox (Risk #10 closed).
- **Phase 3 — bounded autonomy (only after the gate is trusted):** AlphaEvolve /
  DGM-style self-edit *within* the sandbox+gate, still human-checkpointed. The
  "self-evolving harness" end-state — approached last, deliberately.

---

## 4. Spec corrections (fold into the design spec + M6 plan)

1. **ETH attribution**: it's **ETH Zurich + DeepMind** (arXiv:2602.11988), not
   "ETH Zurich / LogicStar." Magnitude: −0.5–2% avg, 5/8 settings, +20–23% cost.
2. **Eval task floor**: **≥5 is only defensible for the quality-regression *block***
   (blocks a claim, never inflates). A savings/quality *pass* needs **~30–50 tasks**
   and either a ≥5pp single-run delta or multi-run averaging (§3.3 power table).
3. **Eval gate is two-dimensional**: quality **AND** cost. Holding quality at +20%
   cost is an ETH *failure*.
4. **Attach the wiki MCP server during eval runs.** Current design notes the eval
   harness lacks it ("biases against") — that means the wiki (the exact artifact
   ETH warns about) is *untested*. Move from "documented residual bias" to
   **must-fix before the gate is trusted**; add a wiki-on/wiki-off arm to measure
   the wiki's *marginal* contribution directly.
5. **Reward-hack sandbox moves earlier**: seal `.git`, deny network, detect test
   edits — required for the *self-evolution* loop (Phase 1), not deferrable to M7.
6. **Roster/preset updates**: drop GLM-4.6 → GLM-4.7 / GLM-5.2; add DeepSeek V4-Pro
   as an intermediate escalation rung; pin frontier model IDs to whatever the
   subscription CLI exposes rather than hardcoding.

---

## 5. Cross-pillar build recommendation

The three pillars share **one dependency spine — the eval harness** — so build it
first and let it referee the other two:

1. **Finish Phase-0 eval gate** (§3.6) — two-dimensional, wiki-attached, git-sealed,
   ≥30 tasks. Without it, every wiki and roster decision below is unfalsifiable.
2. **Wiki**: ship the Project Card (non-inferable only) + hierarchical summary
   index as retrieval; measure wiki-on/off marginal value on the eval gate; prune
   what doesn't help (Probe-and-Refine).
3. **Team**: ship the Cheap-Default roster + conservative layered router; roll the
   cheap-share up one notch at a time against the eval gate, watching quality.
4. **Self-evolution**: add GEPA (Phase 1) only once the gate is trusted, behind the
   three-way split + significance gate + hardened sandbox + human canary.

---

## 6. Open questions / risks

1. **The ETH result may bound the whole thesis, not just the wiki.** Human-written
   context beat generated by only +4%; the no-context baseline is "surprisingly
   competitive." If real-repo gates keep returning INCONCLUSIVE/ETH-HAZARD, that's
   product signal, not just QA. Treat early gate outcomes as validation of the
   premise.
2. **Small per-repo suites may not carry a self-evolution reward signal reliably**
   (pass@1 σ>1.5pp, ~30–50 tasks → GEPA can chase noise). Significance gate +
   Pareto archive + held-out test mitigate; residual overfit-to-one-repo risk is
   real and unquantified.
3. **Reward-hacking the repo-local oracle is the top safety risk** and worsens as
   models improve. Hardened sandbox mandatory *before* Phase 1.
4. **Routing-policy optimization isn't turnkey in GEPA** (instructions only) — the
   `gepa-ai/gepa` YAML path needs a spike.
5. **Loop cost stacks** (GEPA + baseline + review gate); a real per-repo pass over
   30–50 paired tasks could be tens of dollars — measure before it's user-facing.
6. **Embeddings-or-not for the wiki** stays open (§1) — decide via the eval arm.

---

## Key sources
ETH/DeepMind AGENTS.md arXiv:2602.11988 · Probe-and-Refine arXiv:2606.20512 ·
Hierarchical summarization ICCSA 2025 · Harness-disclosure arXiv:2605.23950 ·
SWE-bench arXiv:2310.06770 · SWE-smith arXiv:2504.21798 · R2E-Gym arXiv:2504.07164 ·
Randomness-in-evals arXiv:2602.07150 · Solved-issues-really-solved arXiv:2503.15223 ·
GEPA arXiv:2507.19457 · TextGrad Nature 2025 (arXiv:2406.07496) · Self-correct-limits
arXiv:2310.01798 · ADAS arXiv:2408.08435 · AlphaEvolve arXiv:2506.13131 · Darwin
Gödel Machine arXiv:2505.22954 · ACE arXiv:2510.04618 · EvilGenie arXiv:2511.21654 ·
tinyBenchmarks arXiv:2402.14992 · "Is Escalation Worth It?" arXiv:2605.06350 ·
MAST NeurIPS 2025 · Olausson self-repair ICLR 2024 (arXiv:2306.09896).
*(Model prices/benchmarks verified 2026-07-07; SWE-bench Verified figures are
harness-noisy — SWE-bench Pro used as the cross-model discriminator.)*
