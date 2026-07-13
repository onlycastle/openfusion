# Harness Economics, Model Mix, Caching, and the Owned Loop

**Date:** 2026-07-12  
**Purpose:** audit the recent Coinbase, DoorDash, routing, caching, and
“own your weights” claims and translate only durable conclusions into
OpenFusion product requirements.  
**Method:** primary-source-first source matrix, explicit separation of
first-party production disclosures from controlled experiments, and active
search for counterevidence. Prices and model standings are dated observations,
not evergreen facts.

This is a focused delta to the broader
[harness-engineering research](2026-07-10-harness-engineering-deep-research.md),
the adversarially verified
[component checklist](2026-07-12-best-harness-components.md), and the
[coding-harness source audit](2026-07-10-coding-harness-source-audit.md).

## Executive verdict

The new evidence strengthens a narrower OpenFusion thesis:

> Own the project-specific evaluation, routing, execution, policy, and outcome
> loop; keep models and weights replaceable.

It does not validate a general claim that cheap models, open weights,
specialist agents, or multi-agent systems outperform frontier models.

- Coinbase provides credible firsthand evidence that cheaper defaults,
  cache-aware routing, and a unified gateway can reduce organizational spend.
  Its numerical results are unaudited and not causally decomposed.
- GitHub independently reports the same cache-affinity routing architecture and
  provides stronger evidence that model switching should occur at natural
  boundaries rather than every turn.
- DoorDash DashBench is the strongest evidence that a private workflow
  benchmark can discover a non-obvious model mixture. It supports a cheaper
  scout plus frontier verifier, not an all-cheap replacement.
- Broad router evidence is mixed. Learned routers can save money, but several
  modern routers fail to beat simple baselines reliably.
- Prompt caching is a material systems lever, but hit rate alone is not an
  economic metric. Prefix stability, writes, TTL, provider/model affinity,
  retries, and output tokens determine realized savings.
- Narrow task-specific models can beat older frontier baselines. The stronger
  claim that they usually do so at lower fully burdened cost is unproven.
- “Own your weights” is weaker than “own your improvement loop.” Open weights
  alone do not provide the training data, code, evaluators, or operating system
  needed to reproduce or continuously improve a model.

## Claim ledger

| Claim | Verdict | Evidence quality | Important qualification |
|---|---|---|---|
| Coinbase cut AI spend nearly in half while usage grew. | Supported as a first-party quarterly disclosure. | Medium-low | No absolute spend, normalized period, quality guardrail, causal ablation, or auditable chart. |
| Cheaper defaults beat lowering usage caps. | Plausible and implemented at Coinbase. | Medium | The reported 91% non-cap-hit figure lacks population, period, and cap definitions. |
| LibreChat cache hit rose 5% to 60%. | Supported as a first-party internal metric. | Medium-low | The denominator is undisclosed; request-level and token-weighted hit rates differ materially. |
| Per-turn model routing minimizes cost. | Refuted as a general rule. | High for mechanism; medium for outcomes | Model switching can destroy exact-prefix cache affinity and cost more than it saves. |
| A trained router can preserve quality while lowering coding-agent cost. | Supported conditionally. | Medium | Results are model-pool, harness, task, pricing, and cache dependent. |
| Kimi K2.6 + Fable 5 vastly outperformed Sonnet 4.6 + Opus 4.8 more cheaply. | Partially supported; wording overstated. | Medium-high first-party benchmark | Quality improved meaningfully; cost improved only 2.6%; Fable remained a frontier reviewer. |
| Task-specific scaffolds consistently beat generalists. | Unresolved. | Low | DoorDash's specialist fan-out missed architectural issues; project specialists require OpenFusion A/B evidence. |
| Companies should own weights rather than rent frontier APIs. | Conditional, not general. | Low-medium | Control can mean portability, data governance, versioning, and recoverability without self-hosting. |
| Narrow tuned models can beat frontier generalists. | Supported for some tasks. | High | Does not establish lower total lifecycle cost or current-frontier superiority. |
| Frontier labs routinely train on enterprise API data. | Contradicted by current published commercial defaults. | High for stated policies | Retention, jurisdiction, outage, pricing, deprecation, and dependency risks remain. |
| Generated project context improves coding outcomes. | Unresolved. | Low | This is an OpenFusion experiment, not an established market fact. |
| Open models will handle 80% of workloads at 99% lower cost. | Forecast only. | Low | The quoted statement was explicitly a 12–18 month guess, not an observed result. |

## Coinbase: what is and is not established

Brian Armstrong's [June 27, 2026 post](https://x.com/brian_armstrong/status/2070670644577280109)
describes cheaper defaults, task routing, cache-aware requests, lean context,
and spend visibility. Coinbase Senior Staff Engineer Mark Landgrebe says his
team built the infrastructure and adds the useful implementation detail:

- one internal endpoint normalizes dozens of models;
- failover, redaction, logging, and cost controls run before provider calls;
- the reusable prefix is model-specific;
- a conversation stays on its model while the cache remains warm; and
- the router reconsiders the model after the cache TTL expires.

Sources:
[Landgrebe on X](https://x.com/markletree/status/2070969409230057947) and
[Landgrebe's complete LinkedIn post](https://www.linkedin.com/posts/mark-landgrebe_at-coinbase-our-ai-spend-is-down-nearly-half-activity-7476715711420084225-CEOz).

This validates the existence and plausibility of the architecture. It does not
identify how much of the spend change came from defaults, prompt caching,
provider pricing, routing, workload mix, or another factor. The associated
chart lacks usable date and value axes, and no accepted-quality metric is
reported.

The frequently repeated “80% of workloads on models that are 99% cheaper” is
Armstrong's stated forecast for the following 12–18 months. It must not become
an OpenFusion routing target or market fact.

## Independent routing and caching evidence

GitHub reports that Copilot Auto combines task intent, model health, speed,
error rate, and cost. It found that switching models mid-conversation could
cost more than it saved, so Auto routes on the first turn and after compaction,
then preserves model affinity between those boundaries. GitHub also defers
tool schemas and recommends focused sessions and context.

Source:
[Getting more from each token](https://github.blog/ai-and-ml/github-copilot/getting-more-from-each-token-how-copilot-improves-context-handling-and-model-routing/).

GitHub's vendor-authored [HyDRA preprint](https://arxiv.org/abs/2605.17106)
reports a Sonnet-level SWE-bench Verified operating point with 54.1% savings
and a more aggressive point with 72.5% savings for a 3.2-point resolution
tradeoff. A separate 100-case
[TwinRouterBench preprint](https://arxiv.org/html/2605.18859) reports 75 solved
cases for its trained route versus 74 for an unrouted Opus baseline at 53.1%
lower realized API cost, including cache, retries, and failures. These results
are promising but small or vendor-authored and will age with models and prices.

[RouteLLM](https://proceedings.iclr.cc/paper_files/paper/2025/hash/5503a7c69d48a2f86fc00b3dc09de686-Abstract-Conference.html)
provides peer-reviewed evidence that preference-trained routing can reduce cost
without quality loss on its evaluated tasks. The counterweight is
[LLMRouterBench](https://arxiv.org/html/2601.07206): across 400,000 instances,
21 datasets, and 33 models, several recent and commercial routers did not
reliably outperform simple baselines, and expanding the model pool had
diminishing returns.

The product conclusion is not “build an intelligent router.” It is “compare a
simple rule, a project-evidence router, and the hindsight oracle, then ship the
simplest approach that closes meaningful oracle regret.”

## Prompt-cache economics

Anthropic documents exact-prefix caching and the consequences most relevant to
OpenFusion:

- switching model or effort level starts a different cache;
- changing loaded tool definitions can invalidate the prefix;
- compaction creates a natural routing and cache boundary;
- cached reads and cache writes have different prices;
- separate working directories, including worktrees of the same repository,
  normally produce different prefixes; and
- a subagent starts a separate cold conversation unless it is an exact fork.

Source:
[How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching).

This matters directly because OpenFusion gives workers isolated worktrees and
bounded child sessions. A high organizational cache-hit headline can coexist
with poor worker economics if each child is a cold affinity island.

A 500-plus-session preprint across OpenAI, Anthropic, and Google reports cost
reductions of 41–80% and time-to-first-token reductions of 13–31% from prompt
caching, while also finding that naive full-context caching sometimes worsened
latency and that stable system-prefix caching was more consistent.

Source:
[Don't Break the Cache](https://arxiv.org/html/2601.06007).

OpenFusion must distinguish at least four mechanisms:

1. provider prefix/KV caching;
2. response or semantic caching;
3. repository retrieval/index caching; and
4. OpenFusion's local file-read or tool-result cache.

They have different correctness, privacy, freshness, and cost semantics.

The useful cache metrics are dollar weighted:

- cached-read tokens and cost;
- cache-write tokens and cost;
- fresh input and output tokens;
- time-to-first-token;
- invalidation reason;
- cold-start cost;
- expected remaining turns under the affinity decision; and
- the accepted-result counterfactual with no cache-aware policy.

“Percentage of requests with any cache hit” is insufficient.

## DoorDash DashBench audit

DoorDash built a private 105-case code-review benchmark from roughly 1,000
historical PR candidates. It combines original findings, author annotations,
an LLM judge, and manual disagreement adjudication. Within each comparison it
freezes the case set and grading path, while treating the harness profile as
part of the system under evaluation.

Source:
[How we learned to trust our AI code reviewer](https://careersatdoordash.com/blog/how-we-learned-to-trust-our-ai-code-reviewer-at-doordash/).

| Configuration | Weighted precision | Weighted recall | Weighted F1 | Cost/PR | Latency/PR |
|---|---:|---:|---:|---:|---:|
| Kimi K2.6 scout + Claude Fable 5 reviewer | 89.2% | 65.2% | 75.3% | $3.81 | 589.3s |
| Claude Sonnet 4.6-high scout + Claude Opus 4.8-high reviewer | 87.0% | 53.6% | 66.3% | $3.91 | 725.0s |

The first mixture improved recall by 11.6 percentage points, F1 by 9.0
points, and precision by 2.2 points. It was 2.6% cheaper and 18.7% faster.
That is a meaningful quality result and a slight cost result. Fable remained a
proprietary frontier reviewer, so the case supports heterogeneous stage
assignment rather than replacing frontier models.

The result is not independently reproducible. The code, cases, prompts,
trajectories, and labels are private; no confidence intervals or exact
per-configuration trial count are disclosed; and cost lacks a token, cache,
retry, and discount breakdown. DoorDash explicitly concludes that no
configuration dominates precision, recall, cost, and latency.

DoorDash's preceding architecture report is more instructive for project
harness design:

- a specialist fan-out missed architectural issues;
- parallel generalists spread attention too thin;
- a scout followed by deep verifiers worked better;
- project review profiles were mined from incidents, reviews, Slack decisions,
  and only relevant AGENTS.md invariants;
- profiles were loaded just in time; and
- rules already covered by CI, generic model knowledge, or lacking concrete
  evidence were removed.

Source:
[How DoorDash built an AI code reviewer engineers actually listen to](https://careersatdoordash.com/blog/doordash-built-an-ai-code-reviewer-engineers-actually-listen-to/).

This validates private workflow evaluation and curated JIT project doctrine.
It weakens any assumption that generated specialist meshes help by default.

## Owning weights versus owning the loop

Jamin Ball's
[Clouded Judgement essay](https://cloudedjudgement.substack.com/p/clouded-judgement-71026-own-your)
is strategically useful commentary: a checkpoint becomes relatively outdated,
and the more durable asset is the pipeline that evaluates, adapts, and replaces
it. Its broad claim that task-specific models typically beat frontier models
at a fraction of inference cost is not accompanied by a source matrix or total
cost calculation.

The Alex Karp interview behind the discussion was adjacent to a
[Palantir-NVIDIA sovereign AI product announcement](https://blogs.nvidia.com/blog/palantir-secure-ai-us-agencies-nemotron-open-models/).
Karp was a conflicted seller of the proposed ownership architecture. His
argument is product positioning, not independent outcome evidence.

The Open Source Initiative's
[Open Source AI Definition](https://opensource.org/ai/open-source-ai-definition)
explains why weights alone are incomplete: meaningful study and modification
also require training-data information and the code used to process, train,
validate, and run the system.

Enterprise control is nevertheless a real concern. An IBM/Oxford Economics
[survey of 1,000 senior executives](https://newsroom.ibm.com/2026-06-17-ibm-study-limited-control-and-rising-dependencies-leave-enterprises-exposed-in-the-age-of-ai)
reports high perceived switching difficulty and widespread multi-vendor intent.
IBM sells hybrid AI, so the result is medium-credibility stated-preference
evidence, not proof that enterprises should train models.

[McKinsey's survey of 703 practitioners](https://www.mckinsey.com/capabilities/quantumblack/our-insights/open-source-technology-in-the-age-of-ai)
finds widespread open-model use and cost interest, while proprietary systems
retain a time-to-value advantage and open deployments face security, support,
and IP barriers. The likely equilibrium is hybrid.

## Task-specific model evidence and total cost

Narrow specialists can win:

- [Gorilla](https://proceedings.neurips.cc/paper_files/paper/2024/hash/e4c61f578ff07830f5c37378dd3ecb0d-Abstract-Conference.html)
  fine-tuned a 7B model that beat GPT-4-0314 on its API-selection benchmark;
- [SWE-RL](https://proceedings.neurips.cc/paper_files/paper/2025/file/7107d4d2e837bde2171c6b71b5bde954-Paper-Conference.pdf)
  trained a 70B model to approach the GPT-4o baseline of its period on
  SWE-bench Verified; and
- [Self-play SWE-RL](https://arxiv.org/abs/2512.18552) reports gains from
  injecting and fixing bugs in sandboxed repositories.

These establish possibility, not typical business economics. SWE-RL used
16,384 H100-hours and generated hundreds of repair candidates per problem in
its headline evaluation. Training, data preparation, reward design, serving,
governance, and repeated requalification must be amortized against a stable,
high-volume workload.

The correct decision question is:

> Which workloads justify owning a training loop after routing, retrieval,
> tools, verification, and harness adaptation have been exhausted?

## Data rights and the claimed enterprise-data transfer

OpenAI's current
[enterprise privacy policy](https://openai.com/enterprise-privacy/) says
business and API inputs and outputs are not used to train models by default and
that customers own their inputs and outputs where permitted by law.
Anthropic's
[commercial terms](https://www.anthropic.com/legal/commercial-terms) say the
customer retains inputs, owns outputs, and Anthropic may not train on customer
content from the commercial services.

Those are provider assertions rather than independent audits. Retention,
residency, operational access, outages, price changes, policy changes, and
deprecation remain legitimate risks. The narrower sovereignty argument
survives; the literal claim that ordinary commercial API traffic is routinely
absorbed into frontier weights does not.

Any OpenFusion training-data export must also account for provider terms that
restrict using outputs to build competing models. A frontier lead's output is
not automatically a rights-cleared open-worker training trajectory.

## Implications adopted by the PRD

1. **API is transport.** OpenFusion qualifies the whole route rather than
   classifying hosted models as “outside the harness.”
2. **Own the improvement loop.** Private tasks, evaluators, policy, route
   evidence, and verified outcomes are the durable asset.
3. **Route at boundaries.** Preserve cache affinity and reconsider at task,
   compaction, TTL, failure, or escalation boundaries.
4. **Use stage-specific model mixtures.** Cheap scout plus strong verifier is
   eligible, not mandatory.
5. **Optimize accepted-result cost.** Include cache, failures, tools, retries,
   review, escalation, human intervention, and regression.
6. **Keep generated project context falsifiable.** Attach the wiki MCP to the
   intended arm and run same-model context/harness ablations.
7. **Promote memory and harness candidates, not anecdotes.** Require
   provenance, held-out evidence, regression gates, human approval, and
   rollback.
8. **Defer weight training.** First produce the evidence that determines
   whether a stable narrow workload can amortize the loop.

## OpenFusion falsification experiments

1. Compare direct lead, generic cheap worker, project-harnessed cheap worker,
   and cache-aware dynamic mixture on identical project tasks.
2. Hold the model fixed while changing only project context, tool adapter, or
   another registered harness component.
3. Compare a simple route rule, a generic learned router, a project-evidence
   router, and the hindsight oracle.
4. Measure sticky routing versus per-turn and boundary-based routing using
   actual cache reads, writes, TTLs, invalidations, retries, and billed cost.
5. Reproduce the DoorDash scout-verifier result on OpenFusion review tasks with
   multiple seeds and confidence intervals.
6. Evaluate harness evolution prequentially: learn from earlier tasks and
   score an unchanged candidate on later chronological tasks.
7. Select one stable repeated workflow and compare frontier, routed/harnessed
   worker, and tuned open model using fully burdened lifecycle cost.
8. Simulate provider outage and retirement. Project state, policy, evaluation,
   and routing evidence must survive backend substitution.

## Source matrix

| Source | Type | Evidence used | Credibility | Main limitation |
|---|---|---|---|---|
| [Armstrong](https://x.com/brian_armstrong/status/2070670644577280109) and [Landgrebe](https://www.linkedin.com/posts/mark-landgrebe_at-coinbase-our-ai-spend-is-down-nearly-half-activity-7476715711420084225-CEOz) | First-party production disclosure | Defaults, gateway, exact-prefix cache-affinity routing, internal spend direction | Medium | Unavailable data and causal decomposition |
| [GitHub Copilot routing](https://github.blog/ai-and-ml/github-copilot/getting-more-from-each-token-how-copilot-improves-context-handling-and-model-routing/) | First-party production report | Natural cache boundaries, task-aware routing, deferred tools, focused context | Medium-high | Vendor report; limited raw production data |
| [DoorDash DashBench](https://careersatdoordash.com/blog/how-we-learned-to-trust-our-ai-code-reviewer-at-doordash/) | First-party private benchmark | Non-obvious model mixture, multi-metric tradeoffs, continuous private eval | Medium-high | Private 105-case dataset; no intervals or public runs |
| [DoorDash architecture](https://careersatdoordash.com/blog/doordash-built-an-ai-code-reviewer-engineers-actually-listen-to/) | First-party production report | Scout-verifier topology, JIT project profiles, specialist-fanout failure | Medium-high | One company and code-review workflow |
| [RouteLLM](https://proceedings.iclr.cc/paper_files/paper/2025/hash/5503a7c69d48a2f86fc00b3dc09de686-Abstract-Conference.html) | Peer-reviewed routing paper | Conditional quality-preserving cost reduction | High | Mostly non-agentic benchmark settings |
| [LLMRouterBench](https://arxiv.org/html/2601.07206) | Broad preprint benchmark | Router failures and diminishing model-pool returns | Medium | Preprint; benchmark-to-production gap |
| [Anthropic cache docs](https://code.claude.com/docs/en/prompt-caching) | Official mechanism documentation | Exact prefixes, invalidation, worktree and subagent cache scope | High for mechanism | Product/provider-specific behavior |
| [Prompt-cache study](https://arxiv.org/html/2601.06007) | Cross-provider preprint | Cost and TTFT savings plus naive-cache failure modes | Medium | Preprint; evaluated workload mix |
| [Clouded Judgement](https://cloudedjudgement.substack.com/p/clouded-judgement-71026-own-your) | Investor commentary | Own the loop rather than a checkpoint | Medium-low | Broad observations lack published cases and TCO |
| [OSI definition](https://opensource.org/ai/open-source-ai-definition) | Standards definition | Weights alone are not a reproducible open system | High for definition | Not an economic evaluation |
| [OpenAI](https://openai.com/enterprise-privacy/) and [Anthropic](https://www.anthropic.com/legal/commercial-terms) commercial policies | Provider terms and policy | Default business-data training claims and customer-content rights | High for stated policy | Not an independent audit |
| [Gorilla](https://proceedings.neurips.cc/paper_files/paper/2024/hash/e4c61f578ff07830f5c37378dd3ecb0d-Abstract-Conference.html) and [SWE-RL](https://proceedings.neurips.cc/paper_files/paper/2025/file/7107d4d2e837bde2171c6b71b5bde954-Paper-Conference.pdf) | Peer-reviewed specialist-model evidence | Narrow specialists can beat or approach older frontier baselines | High | Does not establish lower lifecycle TCO |

## Open questions retained

1. Does approved generated project context improve implementation success on
   later project tasks?
2. Which model-harness improvements transfer across model-family upgrades?
3. Can project routing materially close hindsight-oracle regret after cache and
   retry costs are included?
4. When does a scout-verifier topology beat a single stronger agent at matched
   cost, time, and recall requirements?
5. Can outcome-derived memory improve future work without stale-policy or
   benchmark-poisoning effects?
6. Which narrow workflows justify training after the next frontier release
   resets the comparison bar?
