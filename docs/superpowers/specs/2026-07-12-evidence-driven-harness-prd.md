# Product Requirements: Evidence-Driven Project Harness

**Date:** 2026-07-12  
**Status:** Active product requirements  
**Supersedes:** the product assumptions, success metrics, and routing defaults in
the [2026-07-03 Harness Fusion design](2026-07-03-harness-fusion-app-design.md).
That document remains the historical implementation origin and is not rewritten
by this PRD.  
**Research basis:**
[harness economics, model mix, caching, and the owned loop](../../research/2026-07-12-harness-economics-model-mix-caching-and-owned-loop.md),
[best-harness component checklist](../../research/2026-07-12-best-harness-components.md),
and [harness engineering deep research](../../research/2026-07-10-harness-engineering-deep-research.md).

## 1. Executive product decision

OpenFusion will be the project-specific evaluation and execution control plane
that keeps models replaceable.

The product does not assume that an API model is intrinsically worse than a
model embedded in a first-party coding product. An API is transport. Coding
performance emerges from the model together with its tools, edit adapter,
context policy, session state, verification loop, permissions, and project
knowledge.

OpenFusion therefore owns the parts that must remain stable as models and
providers change:

- representative project tasks and protected evaluators;
- model, harness, adapter, and workflow qualification evidence;
- project knowledge and just-in-time retrieval;
- routing, cache affinity, budgets, and escalation;
- mechanical authorization, containment, and audit;
- durable task state, verification, review, rollback, and explicit Apply; and
- a controlled improvement loop with human promotion.

Frontier lead runtimes, lower-cost APIs, and self-hosted models are replaceable
execution backends. Owning or training model weights is an optional later
strategy for workloads whose economics justify it, not the initial product
thesis.

## 2. Customer problem

Teams want to increase agent usage without allowing model spend, operational
risk, or provider dependency to grow at the same rate. The naive alternatives
are inadequate:

- using the strongest model for every step overpays for routine work;
- routing every turn to the nominally cheapest model can destroy prompt-cache
  locality and increase retries;
- selecting models from public leaderboards ignores the project, harness, tool
  surface, and acceptance criteria;
- adding specialist agents or context by default can increase coordination and
  attention costs without improving outcomes; and
- owning a frozen checkpoint does not provide the data, evaluators, deployment
  controls, or refresh loop needed to keep it competitive.

The hard problem is not access to more models. It is proving which complete
model-harness route produces an acceptable result for a particular project and
workflow, at what fully burdened cost, and changing that route safely as the
evidence changes.

## 3. Product hypotheses

| Hypothesis | Research status | Product consequence |
|---|---|---|
| Users prefer a cheaper model when accepted quality is unchanged. | Supported conditionally. Price alone has weak explanatory power; quality, trust, latency, and ease of adoption matter. | Optimize total cost at a declared quality bar, not token price. Preserve user override. |
| Lower-cost API workers underperform because they are “outside the harness.” | Rejected as phrased. API is transport; model-runtime compatibility is the variable. | Qualify APIs, BYOK endpoints, and local models through the same controlled runtime. |
| More agents or more model diversity improves quality. | Conditional. Staged scout/candidate and verifier designs can help; general swarms can amplify cost and error. | Every additional agent must pass a matched-budget marginal-value test. |
| Harnesses become irrelevant as models improve. | Partly rejected. Prompt micro-scaffolds may be absorbed; tools, policy, state, verification, and project evaluation remain. | Keep layer-one scaffolds swappable. Invest in the execution and runtime layers. |
| Generated project context or specialist profiles improve results. | Unresolved. External evidence does not establish a general benefit. | Treat generated context and specialists as candidates that must survive fixed-model A/B evaluation. |
| Owning weights is the durable enterprise advantage. | Conditional and usually premature. Narrow specialists can win, but training and requalification costs are substantial. | Own the improvement loop first. Escalate to fine-tuning only for qualified workloads. |

These are falsifiable product hypotheses, not marketing premises. The product
must retain the ability to conclude that a generic or direct-frontier route is
better for a workload.

## 4. Target users and qualifying workloads

### Primary users

OpenFusion is for engineering teams and serious individual operators that:

- repeatedly use coding agents in one or more repositories;
- have meaningful API spend, quota pressure, or provider-risk concerns;
- possess tests, builds, review evidence, or other acceptance signals;
- want an official Claude Code or Codex runtime to remain available as a
  trusted planner, reviewer, escalation path, or baseline;
- want lower-cost APIs or local models without surrendering model-specific
  effectiveness; and
- require local execution, inspectable evidence, mechanical policy, and an
  explicit repository-change boundary.

### Best initial workloads

The strongest initial workloads are repeated and mechanically checkable:

- test and configuration changes;
- bounded bug fixes and refactors;
- review scouting and issue triage;
- repository search and localization;
- patch formatting and repair;
- documentation with link or build validation; and
- other tasks for which success and regressions can be observed.

### Weak initial fit

OpenFusion is not initially optimized for low-volume users whose frontier
subscription already absorbs their cost, one-off ambiguous work without a
quality oracle, or organizations seeking a turnkey foundation-model training
platform.

## 5. Product architecture and owned assets

```text
OpenFusion control plane
  project scope, evidence, routing, cost, safety, review, Apply, rollback

Universal agent runtime
  tools, context, sessions, policy, containment, hooks, MCP, children

Model and workflow adapters
  protocol, tool dialect, edit strategy, reasoning controls, recovery, cache behavior

Project-specific layer
  approved Project Card, JIT wiki, optional workflow profiles, private evals

Execution backends
  official lead runtimes, hosted APIs, enterprise gateways, local/open models
```

The durable customer asset is the combination of private task distribution,
project policy, verified outcome history, and route-qualification evidence.
Generated prose, a current routing table, and any particular model checkpoint
are versioned outputs of that loop.

OpenFusion should interoperate with enterprise LLM gateways rather than require
replacing them. Its distinctive unit is the project-scoped coding action and
accepted candidate, which a generic API gateway cannot safely observe or
apply.

## 6. Required product behavior

### R1. Project-private evaluation

OpenFusion must compare complete routes on project-representative tasks with
identical starting state and evaluator-owned oracles.

Required experiment arms include:

1. direct official lead runtime;
2. lower-cost worker with a generic runtime;
3. the same worker and model with the project-specific layer;
4. a cache-aware dynamic model mixture; and
5. component ablations when the causal question requires them.

The fixed-model generic-versus-project-harness comparison is the existential
product-thesis gate. Baseline-versus-full-system comparison alone cannot show
whether generated project context or specialist scaffolding helped.

Experiments must support repeated trials, randomized or balanced arm order,
quality and cost intervals, protected graders, complete run artifacts, and
chronological or otherwise held-out tasks for evolution claims. The wiki MCP
and other context sources must be deliberately matched or isolated according
to the experiment question, never attached to only one arm accidentally.

### R2. Model-harness compatibility qualification

The unit of qualification is:

`project × workflow × model × adapter × harness version × tool policy`

Public benchmarks may nominate candidates but cannot promote a route for a
project. A route is eligible only after it meets the project's quality, safety,
latency, and cost constraints. Compatibility profiles must include tool-call
reliability, structured-output failures, patch/apply behavior, context limits,
cache behavior, and recovery requirements.

### R3. Cache-aware, boundary-based routing

Routing must consider expected accepted-result cost, capability evidence,
provider health, policy eligibility, and warm-cache state.

The system should choose or reconsider a route at natural boundaries:

- task or child-session start;
- an explicit plan-to-execution handoff;
- compaction or structured checkpoint;
- cache TTL expiry;
- provider failure;
- failed verification or explicit escalation; or
- a user override.

It must not switch models every turn merely because another model has a lower
list price. A conversation remains model-affine while its reusable prefix is
valuable unless quality, safety, or availability requires a change.

The context compiler should keep stable instructions and tool schemas before
task-specific content, load tools and project knowledge just in time, and make
cache invalidations observable. Each isolated worktree or cold subagent may be
a separate cache-affinity island and must be measured accordingly.

### R4. Reliable tools and patch application

Tool execution is a mechanical runtime responsibility. Models must receive
bounded, recoverable tool results and actionable error guidance. Patch and file
edit adapters must be versioned and evaluated separately from the model.

The ledger must distinguish:

- model or reasoning failure;
- malformed tool or structured output;
- tool execution failure;
- edit mismatch;
- patch materialization or Apply failure;
- verification failure;
- reviewer rejection;
- environment or measurement failure; and
- later regression or rollback.

### R5. Verification inside and after execution

Verification is not only a final frontier review. Workers should construct and
run the cheapest relevant mechanical checks during execution, use their
results to correct the candidate, and leave durable evidence for the final
gate.

The final acceptance path remains defense in depth:

```text
worker verification
  -> exact candidate materialization
  -> evaluator-owned deterministic checks
  -> independent read-only review where required
  -> explicit user approval
  -> Apply with rollback information
```

Frontier review complements tests and policy; it does not replace them.

### R6. Mechanical policy and containment

Permission decisions must be deterministic and occur before actions. An LLM
may explain a request for elevation but may not grant itself authority.

Policy must eventually support action arguments, project state, prior events,
and indirect execution paths. Filesystem, process, secret, and network
containment remain separate enforcement layers. A child receives no authority
broader than its parent without explicit human elevation.

### R7. Durable state and controlled memory

Long-running tasks require append-only events, resumable checkpoints, bounded
context projections, explicit progress artifacts, cancellation, and rollback.
Compaction is derived state, never the authoritative record.

Run outcomes do not become project memory automatically. A memory candidate
requires provenance, a failure or success category, supporting evidence, an
invalidation rule, regression evaluation, and human promotion. Human acceptance
alone is not ground truth; later reverts, test results, repeated outcomes, and
review adjudication can change the conclusion.

Raw prompts, diffs, and model outputs must not silently become a training
corpus. Any future export needs explicit consent, encryption, provenance, data
rights, and provider-term checks.

### R8. Controlled harness evolution

“Self-evolving harness” means a governed release workflow:

```text
verified run outcomes
  -> failure/weakness classification
  -> one-component candidate in isolation
  -> targeted + held-out + regression evaluation
  -> safety/cost/Pareto gate
  -> canary
  -> human promote or reject
  -> exact rollback
```

Candidates may change prompts, retrieval policies, tool descriptions, routing,
verification, or other registered components. Production state does not mutate
itself, and same-batch improvement is not evidence of durable learning.

## 7. Model-mixture policy

OpenFusion supports several topologies but assumes none is universally best:

- direct frontier execution;
- one qualified lower-cost worker;
- lower-cost scout or candidate generator followed by a strong verifier;
- multiple read-only scouts with one writer;
- staged planner and implementer sessions; and
- escalation through a capability ladder.

Every topology must be evaluated at matched quality, cost, and wall-clock
budgets. Additional agents must earn their coordination, context, cache, merge,
and verification cost. Parallel writers require explicit dependency and file
ownership; a default peer-to-peer swarm is out of scope.

## 8. Success metrics

### Primary metric

**Fully burdened cost per accepted result at a declared quality band.**

It includes worker and lead inference, cache writes and reads, output tokens,
tools, retries, verification, review, escalation, failed applications, human
intervention where measurable, and observed regressions or rollback.

There is no fixed 50–70% savings requirement until project evidence establishes
a credible target. A route succeeds when it is on the project's quality-cost-
latency Pareto frontier and satisfies its safety constraints.

### Required metric vector

- oracle task success and regression rate;
- repeated-trial consistency and confidence interval;
- critical or high-impact miss rate where severity applies;
- cost per run and per accepted result;
- latency to accepted result;
- retries, escalation, and human-intervention rate;
- tool, structured-output, edit, patch, and Apply failure rates;
- cache read/write tokens, invalidation cause, and dollar-weighted savings;
- route regret versus the best observed eligible route;
- verifier disagreement and reviewer rejection;
- safety and policy violations; and
- later revert, rollback, or production failure.

## 9. Delivery priorities

### P0 — prove or falsify the product thesis

1. First-class fixed-model harness-variant A/B, including explicit wiki-MCP
   treatment and pairwise reporting.
2. Complete patch/edit/apply failure-rate and causal-category reporting.
3. Per-run and aggregate quality-cost-latency Pareto reporting.
4. Systematic verification actions inside worker execution.
5. Cache-aware accounting and route-boundary experiments, including cold
   worktree and subagent costs.

### P1 — deepen the durable execution moat

1. Stateful, context-dependent, action-level mechanical policy.
2. Production-grade context pressure, compaction, and checkpoint controls.
3. Long-running progress and recovery artifacts compatible with the invariant
   that OpenFusion never commits user code.
4. User-visible undo and rollback for Apply.
5. Complete per-action authorization and execution evidence.

### P2 — learn from verified outcomes

1. Provenance-gated memory candidates and weakness aggregation.
2. Per-workflow model binding and route qualification.
3. Controlled one-component harness evolution.
4. A workload qualification report that determines whether fine-tuning or RL
   could beat continued routing and harness improvements.

## 10. Fine-tuning and weight ownership decision gate

OpenFusion may recommend or integrate a training loop only when all of the
following hold:

- the workload is high-volume, narrow, and stable;
- rewards are mechanically verifiable or have strong expert agreement;
- sufficient rights-cleared examples or trajectories exist;
- prompting, retrieval, tools, routing, and harness changes leave a persistent
  performance or unit-cost gap;
- projected savings cover labeling, training, serving, monitoring, governance,
  and repeated requalification; and
- held-out and time-separated tasks demonstrate generalization.

Repository-wide software engineering usually fails several of these tests.
Narrow mechanics such as tool selection, patch repair, test classification, or
review triage are more plausible early candidates.

## 11. Non-goals

OpenFusion is not:

- a generic provider gateway differentiated only by one API format;
- an “open models first” or “frontier models last” routing policy;
- a per-turn cheapest-model switcher that ignores cache state;
- a promise that specialists, generated context, or agent diversity help by
  default;
- a default multi-agent mesh;
- an autonomous online optimizer that promotes its own changes;
- a vector-index-first memory product;
- an RL or foundation-model training platform;
- a mechanism for turning restricted provider outputs into training data; or
- an autonomous committer, merger, pusher, or repository mutator.

## 12. Risks and falsification criteria

| Risk | Falsifier or control |
|---|---|
| Project harness adds cost but not quality. | Same-model generic-versus-project A/B on held-out tasks. Retire components that do not earn their cost. |
| Router cannot predict model advantage. | Compare simple rules, project router, and hindsight oracle. If project routing does not close meaningful oracle regret, do not claim routing as the moat. |
| Cache-aware routing saves nominal tokens but not money. | Record billed cache reads/writes, cold starts, retries, TTL, and invalidations; compare against a sticky baseline. |
| Private eval overfits historical tasks. | Use chronological holdouts, refresh cases, preserve hidden graders, and monitor later production outcomes. |
| Multi-model complexity exceeds savings. | Include provider operations, cache fragmentation, tool incompatibility, and review cost in accepted-result economics. |
| Memory poisons future work. | Candidate-only writes, provenance, invalidation, placebo/no-memory comparisons, regression gates, and rollback. |
| Models absorb the useful harness layer. | Maintain model capability flags and ablate each component against current models instead of preserving it ceremonially. |
| Provider change breaks the product. | Simulate outage and retirement; routes, policies, evidence, and project memory must survive backend substitution. |

## 13. Current-versus-target boundary

This PRD defines product requirements, not a claim that every item is shipped.
Current behavior must be verified against source and the evergreen
[product vision](../../human/product-vision.md),
[workflows](../../human/workflows.md), and
[runtime guide](../../human/runtime.md). Historical plans remain evidence of
intent only.
