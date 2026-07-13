# Harness Engineering: Deep Research Brief

**Date:** 2026-07-10  
**Scope:** coding and general-purpose agent harnesses; inner loops, context, tools,
durability, evaluation, orchestration, multi-agent systems, and self-evolution  
**Audience:** OpenFusion architecture and product decisions  
**Method:** primary-source-first web research across official engineering reports,
peer-reviewed papers, recent preprints, documentation, and source repositories.
Vendor performance claims are treated as case evidence, not universal results.

**Follow-up:** the focused [Weng + WPTI research
delta](./2026-07-10-weng-wpti-self-improvement-deltas.md) adds causal
Self-Harness weakness signatures, a ToolSpec single-source registry, separate
candidate/capability lanes, and evaluator prompt-source isolation to the project
recommendations below.

## Executive conclusion

The useful unit of design is not the model and not the prompt. It is a
**controlled learning system around the model**:

```text
task contract
  -> context compiler
  -> durable agent state machine
  -> safe action runtime
  -> outcome verifier
  -> trace + artifact ledger
  -> eval-selected change
  -> canary / promote / rollback
```

Five conclusions survive triangulation across the sources:

1. **The harness can move performance almost as much as the model.** The
   peer-reviewed SWE-agent work showed that an agent-computer interface changes
   coding outcomes materially; a newer Claw-SWE-Bench preprint reports a 54.3
   percentage-point difference between minimal and full adapters for the same
   model, with harness and model changes contributing similar maximum swings
   across its sweep. The exact preprint numbers need replication, but the
   direction is consistent with production reports and older research.
   ([SWE-agent](https://arxiv.org/abs/2405.15793),
   [Claw-SWE-Bench](https://arxiv.org/abs/2606.12344))

2. **“Self-evolving” is mostly an evaluation problem.** Memory writes,
   self-critique, and prompt mutation are not improvement unless a protected
   external evaluator demonstrates a repeatable gain on held-out and regression
   cases. Intrinsic self-correction can degrade reasoning when no reliable
   external feedback is available. ([Huang et al., ICLR
   2024](https://openreview.net/forum?id=IkmD3fKBPQ), [Anthropic agent-eval
   methodology](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents))

3. **Multi-agent is a conditional scaling technique, not a default
   architecture.** It helps when work can be decomposed, executed in isolation,
   and merged or verified cheaply. It hurts sequential, shared-state work.
   Google's 180-configuration study reports an 80.9% improvement from centralized
   coordination on a parallelizable finance task, but a 39–70% degradation from
   every multi-agent configuration on sequential PlanCraft. Anthropic likewise
   reports strong breadth-first research gains while warning that coding is often
   less parallelizable. ([Google Research](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/),
   [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system))

4. **Durable artifacts beat conversational memory.** A task contract, feature
   list, progress record, event log, test output, and isolated workspace survive
   context loss and make recovery auditable. Compaction should be a derived view;
   it should never become the only record of what happened. This pattern appears
   independently in Anthropic's long-running harness, Codex's loop and compaction
   design, Pi's JSONL session tree, and Symphony's issue/workspace model.
   ([Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents),
   [OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop/),
   [Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md),
   [Symphony](https://github.com/openai/symphony/blob/main/SPEC.md))

5. **Complexity must earn its place through ablation.** Anthropic's 2026
   long-running-app study says explicitly that each harness component encodes an
   assumption about a model weakness, and newer models can make old scaffolding
   counterproductive. The modern minimum is therefore not “fewest features”; it
   is **the smallest configuration that wins a matched, controlled evaluation**.
   ([Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps))

## 1. What “the harness” actually contains

A `while tool_call` loop is necessary but insufficient. A production harness has
at least eight separable layers. Keeping them separable matters because each can
be ablated, versioned, evaluated, and rolled back independently.

| Layer | Responsibility | Failure if absent |
|---|---|---|
| **Task contract** | Goal, acceptance criteria, risk class, budget, allowed side effects | Agent optimizes a vague request or silently expands scope |
| **Context compiler** | Stable instructions, just-in-time repo retrieval, working set, memory, skills, compaction | Context bloat, stale knowledge, cache misses, lost decisions |
| **Agent state machine** | Turn lifecycle, interrupts, retries, savepoints, resumability, event emission | A crash loses work; retries duplicate side effects |
| **Action runtime** | Typed tools, shell/browser/code execution, sandbox, approvals, idempotency | Unsafe or irreproducible action; tool ambiguity |
| **Verifier** | Tests, browser checks, environment-state assertions, calibrated judges | The agent's claim of success becomes the score |
| **Trace and artifact ledger** | Inputs, outputs, tool events, patches, costs, environment, provenance | Failures cannot be reproduced or learned from |
| **Orchestrator** | Scheduling, isolated workspaces, dependency graph, concurrency, retries, backpressure | Workers collide or coordination cost dominates |
| **Learning and governance** | Failure taxonomy, candidate mutations, held-out eval, promotion, rollback, audit | “Self-improvement” overfits, tampers with graders, or drifts |

OpenAI's account of the Codex loop is especially useful here: prompts, tool
definitions, tool results, compaction items, and environment updates form an
append-only state protocol around a stateless inference API. Prompt caching works
because stable prefixes remain byte-identical; mutating earlier context, changing
tool order, or changing the sandbox breaks that property. This makes the harness
better understood as a **state machine + event log + context compiler** than a
chat wrapper. ([OpenAI](https://openai.com/index/unrolling-the-codex-agent-loop/))

OpenAI's internal “Harness engineering” case adds the organizational layer:
short map-like repository instructions, versioned repo-local documentation,
mechanically enforced architectural boundaries, agent-visible logs, and recurring
cleanup agents. Its reported scale—roughly one million lines and 1,500 pull
requests over five months—shows feasibility inside that team, but the authors
also caution that the result depends on substantial repository structure and
investment. Treat it as a strong design case, not a controlled productivity
study. ([OpenAI](https://openai.com/index/harness-engineering/))

## 2. The minimum viable self-evolution loop

“Self-evolving” currently names several very different systems. A useful maturity
ladder is:

| Level | Mechanism | What it really provides | Representative evidence |
|---|---|---|---|
| **0. In-episode repair** | Retry, critique, reflection in the same run | More test-time compute; no durable learning | [Self-Refine](https://openreview.net/forum?id=S37hOerQLB), [Reflexion](https://openreview.net/forum?id=vAElhFcKW6) |
| **1. Episodic memory** | Store a compact lesson or prior trace | Better retrieval on similar future work; poisoning/staleness risk | [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [ExpeL](https://arxiv.org/abs/2308.10144) |
| **2. Reusable skills/playbooks** | Save executable or procedural modules | Compositional reuse if selection and validation work | [Voyager](https://arxiv.org/abs/2305.16291), [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) |
| **3. Eval-selected configuration** | Search prompts, tools, policies, or workflows | Empirical tuning for a fixed suite | [GEPA](https://arxiv.org/abs/2507.19457), [AFlow](https://openreview.net/forum?id=z5uVAKwmjf), [ACE](https://arxiv.org/abs/2510.04618) |
| **4. Harness/code evolution** | Propose changes to the runtime itself | Broader search space, much higher overfit and safety risk | [AHE](https://arxiv.org/abs/2604.25850), [Meta-Harness](https://arxiv.org/abs/2603.28052) |
| **5. Production closed loop** | Real traces + domain corrections + regression + canary/rollback | Evidence-backed continuous adaptation | [OpenAI Tax case study](https://openai.com/index/building-self-improving-tax-agents-with-codex/) |

The first three levels are often described as self-improvement, but only Levels
3–5 contain an explicit selection mechanism. Even then, selection is trustworthy
only when the evaluator is external to the candidate, the evaluation set has a
protected portion, and promotions are reversible.

### The loop worth implementing

1. Capture the complete trace, final environment state, patch, tests, cost,
   latency, intervention, and model/harness versions.
2. Classify the failure at the **earliest causal layer**: contract, retrieval,
   reasoning, tool selection, tool execution, verification, coordination, or
   environment.
3. Turn the failure into a reproducible case. Confirm it fails more than once;
   one stochastic miss is weak evidence.
4. Propose one scoped, versioned mutation: prompt fragment, memory item, skill,
   tool schema, context policy, routing rule, or code component.
5. Record the expected causal effect before running the candidate. This makes
   post-hoc stories detectable.
6. Run the targeted case, nearby regressions, a protected held-out set, and
   safety/cost gates under the same environment and budget.
7. Canary the candidate. Promote only if the multidimensional verdict passes;
   otherwise retain its trace as negative evidence and roll back.

This is close to the production loop OpenAI describes for tax preparation:
practitioner corrections and production traces become grouped failure modes and
new eval targets; Codex inspects the trace, repository, skills, and eval, makes a
targeted change, and runs both targeted and regression cases. The published
accuracy and throughput numbers are company-reported and not independently
audited, but the feedback architecture is sound. ([OpenAI](https://openai.com/index/building-self-improving-tax-agents-with-codex/))

Recent automated-harness research supplies useful mechanisms but not yet
production-grade proof. AHE makes editable components explicit, distills large
trace corpora into drill-down experience, and pairs each edit with a predicted
effect; it reports Terminal-Bench 2 improvement from 69.7 to 77.0 over ten
iterations. Meta-Harness searches harness code using prior candidates and traces.
Both are 2026 preprints and should be treated as promising experiments requiring
independent replication. ([AHE](https://arxiv.org/abs/2604.25850),
[Meta-Harness](https://arxiv.org/abs/2603.28052))

### Required containment

The evolver may read traces and create a candidate branch, but it should not be
able to modify hidden tests, the grader, protected traces, promotion thresholds,
or the production evidence store. Workspace-agent studies already observe
evaluator tampering and train/test leakage; one 2026 preprint reports that locking
the evaluator removed this behavior at a 25–31% runtime overhead. The exact rate
needs replication, but immutable evaluation infrastructure is the correct default.
([Reward Hacking in Workspace Agents](https://arxiv.org/abs/2603.11337))

## 3. Evaluation is the control system

An agent evaluation measures **model × harness × environment × budget**, not the
model alone. This has several practical consequences.

### Outcome first, trace second

Grade the final environment state whenever possible: passing hidden tests, a UI
behavior observed in a browser, a valid database transition, or an exact artifact.
Do not grade the agent's declaration that it finished. Inspect the trace afterward
to diagnose why the outcome occurred. Anthropic's eval guide makes this distinction
explicit and recommends starting with 20–50 tasks derived from real failures.
([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents))

Use deterministic graders for facts that code can verify. Use LLM judges only for
semantic dimensions that cannot be reduced to code, calibrate them against human
labels, and keep the judge independent of the actor. Do not require a particular
tool trajectory unless the path itself is the behavior being tested.

### Two suites, two jobs

- A **capability suite** should contain unsolved or partially solved tasks. It
  gives the optimizer a hill to climb.
- A **regression suite** should stay near 100%. Once a capability task is solved
  reliably, graduate it into regression.
- A **held-out suite** must remain unavailable to the mutator and routing tuner.
  It detects suite-specific overfitting.

Run repeated trials and report both `pass@k`—at least one success—and
`pass^k`—consistent success across all trials. The latter matters more for a
harness that will act autonomously.

### The environment is part of the benchmark

Anthropic held model and harness constant on Terminal-Bench 2.0 and observed a
six-percentage-point spread from resource configuration alone; strict limits
also produced a 5.8% infrastructure-error rate versus 0.5% without the cap. More
than three times the resources began to make some tasks substantively easier.
This means the eval manifest must record CPU, memory, timeouts, concurrency,
network policy, container image, dependency cache, and model endpoint—not just
model name and prompt. ([Anthropic](https://www.anthropic.com/engineering/infrastructure-noise))

### Measure a vector, not one score

At minimum, retain:

- task success and success by failure class;
- `pass@1`, `pass@k`, and `pass^k`;
- tokens, dollars, wall time, and peak parallelism;
- tool calls, tool errors, retries, and context-compaction events;
- human interventions and approval denials;
- safety-policy violations and attempted out-of-scope writes;
- regressions and newly solved cases;
- context efficiency: useful evidence retrieved per token, plus cache hit rate.

Never collapse this vector into a single reward before storing the components.
A scalar is convenient for search but hides quality-cost and safety tradeoffs.

## 4. Multi-agent orchestration: use a decision rule

The empirical evidence resolves an apparent conflict. Anthropic reports a 90.2%
improvement from a lead agent with subagents over a single agent on breadth-first
research; the system used roughly 15 times the tokens of ordinary chat and was
designed to exploit parallel information gathering. Google's broader study finds
centralized teams strong on parallelizable work and uniformly harmful on a
sequential planning benchmark. A 2026 equal-thinking-token preprint further finds
that single agents match or beat multi-agent systems on multi-hop reasoning when
the reasoning budget is controlled, except where the single agent's context use
degrades. ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system),
[Google Research](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/),
[Equal-token study](https://arxiv.org/abs/2604.02460))

The right interpretation is:

> Multi-agent systems buy parallel compute, isolated context windows, and role
> specialization. They do not provide free intelligence.

Default to one agent. Add workers only when all four tests pass:

1. **Decomposable:** subtasks can be specified without continuously sharing tacit
   state.
2. **Isolatable:** workers can use separate read contexts or worktrees.
3. **Mergeable:** outputs have typed contracts or non-overlapping ownership.
4. **Verifiable:** a cheap, independent check can reject bad partial work.

Prefer a shallow centralized topology: scheduler/orchestrator → isolated workers
→ independent verifier. Avoid an all-to-all conversational mesh. Google's study
reports much larger error amplification in independent-agent configurations than
centralized ones, and the ICML 2024 “Should we be going MAD?” study found debate
systems sensitive to tuning and not reliably superior to simpler ensembling.
([Google Research](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/),
[Liang et al., ICML 2024](https://openreview.net/forum?id=CrUmgUaAQp))

For coding, parallelize exploration, log analysis, test discovery, and genuinely
independent worktree tasks. Serialize changes to a shared architectural surface.
Communicate through artifacts—task contracts, patches, test reports, issue state,
and ownership boundaries—rather than long free-form agent conversations.

OpenAI Symphony is a particularly clean outer-loop reference. It treats the issue
tracker as the control plane, assigns each issue a dedicated workspace and agent,
uses bounded concurrency with reconciliation and retries, and separates policy
(`WORKFLOW.md`) from tracker, workspace, execution, and observability adapters. It
is a scheduler/runner, not an inner reasoning framework or general workflow engine.
([Symphony specification](https://github.com/openai/symphony/blob/main/SPEC.md),
[OpenAI overview](https://openai.com/index/open-source-codex-orchestration-symphony/))

## 5. Context and memory engineering

### Use a map, not a manual

The strongest pattern is a very small stable prefix containing non-inferable rules
and navigation pointers, with the rest retrieved just in time. Anthropic describes
this as progressive disclosure; OpenAI's repository case used a roughly 100-line
`AGENTS.md` as a table of contents into versioned local documentation. Both reject
loading the full repository explanation up front. ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[OpenAI](https://openai.com/index/harness-engineering/))

Separate four kinds of state:

- **Working context:** current observations and decisions; expendable and compactable.
- **Durable task state:** plan, checklist, blockers, artifacts, test state; authoritative.
- **Episodic memory:** what happened in prior runs; retrieved on similarity or query.
- **Reusable skills:** validated procedures or code with explicit applicability.

The raw event log should be immutable. Compaction, summaries, and memories are
indexed projections with provenance back to source events. Memory writes need a
version, author/model, source trace, confidence, scope, and expiration or
invalidation rule. Without those, an early hallucination becomes a durable policy.

Hermes Agent is instructive here. Its built-in memory is intentionally bounded and
frozen at session start to preserve a stable prompt prefix, while older sessions are
searched on demand through SQLite FTS5. A background review can propose memory or
skill updates behind write approvals. This is useful reflective persistence, but it
is not automatically verified fitness improvement. ([Hermes architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture),
[Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory),
[Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills))

The separate Hermes self-evolution repository is even more revealing: its README
states that only the first skill-file phase is implemented, while tool-description,
system-prompt, code, and continuous-evolution phases remain planned. This is a good
reason to inspect implementation status rather than infer capability from a project
name. ([Hermes Agent Self-Evolution](https://github.com/NousResearch/hermes-agent-self-evolution))

## 6. Tool engineering

Tools are interfaces between deterministic software and a stochastic caller. The
best tool layer therefore resembles a good public API:

- keep 3–8 frequent, general tools loaded; defer the long tail with tool search;
- use namespaced, unambiguous names and strict input/output schemas;
- return compact observations with filtering, pagination, and truncation controls;
- make errors actionable: explain the invalid assumption and the next valid action;
- expose side-effect, idempotency, retry, timeout, and permission semantics;
- separate actuation tools from verifier tools;
- give code/programmatic orchestration to large result sets and deterministic
  loops rather than serializing every intermediate row through model context;
- record every call and result in the event ledger.

Anthropic's tool-engineering work recommends eval-driven refinement using held-out,
multi-step tasks and tracking accuracy, runtime, calls, tokens, and errors. Its
advanced-tool-use case reports that 58 tools consumed roughly 55,000 tokens of
schema and describes deferred loading and programmatic tool calling as remedies.
The performance deltas are vendor-internal, but the context-economics argument is
directly inspectable. ([Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
[Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use))

Tool search becomes important when the active surface is large; it should not be
an excuse for dozens of overlapping tools. First reduce and normalize the API,
then retrieve the uncommon remainder.

## 7. Repository study map

There is no single “best harness repo.” The useful set covers distinct layers.

| Repository | Best for | Read first | What to borrow | Important caveat |
|---|---|---|---|---|
| [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) | Minimal executable baseline and clean ablations | [`default.py`](https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/agents/default.py) | Tiny loop, Bash-only action surface, linear history, easy benchmark integration | Deliberately omits many production concerns; project benchmark numbers are not independent proof |
| [Pi](https://github.com/earendil-works/pi) | Hackable custom coding agent | [coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md), [`agent-loop.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts), [harness design](https://github.com/earendil-works/pi/blob/main/packages/agent/docs/agent-harness.md) | Four-tool core, extension system, JSONL tree sessions, branching, retained raw history, custom compaction | Generic `AgentHarness` is under active migration; some durability/hook design is not finished |
| [OpenAI Codex](https://github.com/openai/codex) | Production inner loop, approvals, sandbox, events, compaction, multi-agent control | [`turn.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs), [`orchestrator.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/orchestrator.rs), [`compact.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs), [app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [sandbox](https://github.com/openai/codex/blob/main/docs/sandbox.md) | Typed lifecycle/events, cache-aware context, UI-independent server protocol, policy boundaries | Large and optimized for a mature product; poor first repo for learning the basic loop |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Persistent personal agent, memory, skills, provider abstraction, messaging gateway | [architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture), [memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) | Stable/context/volatile prompt partition, bounded memory, searchable sessions, approval-gated skill capture | Broad system with many backends and tools; reflection is not by itself verified evolution |
| [OpenHands](https://github.com/OpenHands/OpenHands) | Sandboxed remote runtime and full client-server product | [runtime architecture](https://docs.openhands.dev/openhands/usage/architecture/runtime), [SDK architecture](https://docs.openhands.dev/sdk/arch/sdk), [CodeAct](https://docs.openhands.dev/openhands/usage/agents) | Event streaming, container/runtime boundary, remote execution, deployable SDK/product separation | Enterprise-scale architecture; too heavy as a minimal substrate |
| [OpenAI Symphony](https://github.com/openai/symphony) | Outer-loop issue orchestration | [`SPEC.md`](https://github.com/openai/symphony/blob/main/SPEC.md) | Tracker as state machine, per-task workspace, bounded concurrency, retries/reconciliation, policy/runtime separation | Does not supply the inner agent loop or universal workflow semantics |
| [Claude Code](https://github.com/anthropics/claude-code) + [docs](https://code.claude.com/docs/en/features-overview) | Extension and governance surface | [subagents](https://code.claude.com/docs/en/sub-agents), [hooks](https://code.claude.com/docs/en/hooks), [permissions](https://code.claude.com/docs/en/permissions) | Fresh-context subagents, per-agent tool/model/permission boundaries, deterministic lifecycle hooks, plugins | **The public repo does not contain the core Claude Code loop.** Study it as an extension API, changelog, and examples repository, not as an open harness implementation |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) | Historical ACI design and benchmark research | [architecture](https://swe-agent.com/latest/background/architecture/), [paper](https://arxiv.org/abs/2405.15793) | Constrained editing/navigation interfaces and environment feedback | Main project is now maintenance-oriented and points new users to mini-swe-agent |

Two optional breadth references are [Goose](https://github.com/aaif-goose/goose)
for a Rust/MCP/provider-extensible desktop agent and
[OpenCode](https://github.com/anomalyco/opencode) for a provider-agnostic
TypeScript coding product. They are worth comparing after the primary set, not
before it.

### Recommended reading order

1. Implement or trace one mini-swe-agent task end to end.
2. Read Pi to see how a minimal loop becomes a usable, extensible product without
   immediately becoming a platform.
3. Read the Codex turn, tool, compaction, approval, and app-server paths for
   production lifecycle design.
4. Read Symphony for the outer scheduler/workspace boundary.
5. Compare Hermes and OpenHands for two different expansions: persistent personal
   agent versus remote sandbox platform.
6. Read Claude Code's hooks/subagent/permission docs as an extension-contract
   benchmark, while keeping its closed core out of source-level comparisons.

## 8. Minimal versus elaborate harnesses: the productive tension

The SWE-agent paper argued that purpose-built navigation and editing interfaces
materially improved coding agents. Mini-swe-agent later demonstrated that stronger
models can perform well with little more than Bash and a short loop. These do not
contradict each other. They imply a moving frontier:

- weaker or poorly calibrated models benefit from stronger affordances and
  constraints;
- stronger models can make prescriptive interfaces unnecessary or harmful;
- safety, recovery, audit, and measurement remain necessary even when reasoning
  scaffolds disappear;
- therefore every prompt module, role, memory source, tool, planning phase, and
  reviewer must face an ablation against the current model.

The comparison must hold model, task set, environment, token/dollar budget, and
retry policy constant. Otherwise a “better harness” may simply be using more
test-time compute.

## 9. Implications for OpenFusion

OpenFusion already has several evidence-aligned choices: just-in-time wiki tools,
a small human-approved Project Card, isolated worktrees, frontier review, a paired
baseline-versus-harness eval, cost accounting, and a conservative pass verdict.
The next gains are less likely to come from adding more agents than from making
the existing loop more observable, ablatable, and causally learnable.

### Prioritized changes

1. **Make every run a replayable ledger.** Persist event types, stable IDs, model
   and harness digests, tool schemas, prompts or prompt hashes, environment,
   workspace base commit, patches, verifier outputs, costs, approvals, and all
   compaction boundaries.
2. **Create a component registry.** Assign independent versions to Project Card,
   wiki retrieval policy, role prompts, routing policy, model roster, tool surface,
   reviewer, retry/escalation policy, and evaluator. An experiment should declare
   exactly which component changed.
3. **Add failure taxonomy at the earliest causal layer.** “Task failed” is not an
   optimization signal. Distinguish missing context, wrong context, wrong plan,
   tool misuse, execution error, verification gap, merge conflict, reviewer miss,
   and environment failure.
4. **Make verifier independence explicit.** The actor/reviewer must not control
   hidden tests or the verdict. Prefer tests/browser/build checks before frontier
   review; use the reviewer for intent, design, security, and uncovered edge cases.
5. **Keep multi-agent shallow.** One orchestrator, one writer per dependency
   surface, optional parallel read-only scouts, and an independent verifier. Use
   separate worktrees and explicit ownership for parallel writers.
6. **Evolve one component at a time.** Start with prompt/retrieval/routing
   mutations. Do not permit runtime-code self-modification until the held-out,
   immutable-grader, canary, rollback, and experiment-ledger machinery is proven.
7. **Add an ablation matrix to the benchmark.** At least: no harness; Project Card
   only; wiki tools only; routing only; routing + reviewer; full harness. Match
   budgets and run order. This will tell OpenFusion which parts actually earn
   their cost.
8. **Measure consistency and coordination tax.** Add repeated trials, `pass^k`,
   wall-clock, context tokens, tool-schema tokens, retry count, and verifier
   disagreement. A savings claim should fail if quality holds only through many
   retries or large unmetered frontier review.

### Reference design for a first safe evolver

```text
immutable run ledger + outcome
        |
failure classifier (read-only)
        |
candidate proposal in isolated git branch
        |  one registered component only
targeted eval -> regression eval -> hidden eval -> safety/cost gates
        |
   reject and retain evidence
        or
   canary -> monitor -> promote / automatic rollback
```

The evolver should optimize a Pareto set rather than one scalar: quality,
consistency, cost, latency, safety, and intervention rate. A candidate is valuable
only if it is not dominated on those dimensions and survives the protected suite.

## 10. What is consensus, what conflicts, what is missing

### Strong consensus

- External environment feedback is more trustworthy than self-assessment.
- Repository and task state should live in durable artifacts, not only context.
- Context should be small, high-signal, and retrieved progressively.
- Tool contracts, error messages, isolation, permissions, and observability are
  first-class harness design.
- Agent evaluations require trace inspection, repeated trials, and environment
  control.
- Centralized orchestration is safer than unconstrained peer-to-peer agents.

### Real conflicts

- **Specialized tools vs Bash-only:** results depend on model capability and task;
  resolve through current-model ablation.
- **Compaction vs fresh context:** compaction preserves conversational continuity;
  structured reset can reduce context anxiety. Preserve raw history and test both.
- **One agent vs many:** breadth-first, parallelizable work favors isolated
  workers; sequential shared-state work favors one agent. Compare at matched
  token, cost, and wall-clock budgets.
- **Memory vs retrieval:** durable memory can transfer knowledge but can also lock
  in stale or false conclusions. Require provenance, invalidation, and eval gates.

### Important missing evidence

- Independent replications of 2026 automated-harness-evolution results.
- Longitudinal evidence that self-written skills improve future production work
  without memory poisoning or benchmark overfit.
- Equal-cost, equal-time comparisons of single-agent and multi-agent coding on
  real repositories with merge conflicts included.
- Standard measurements for compaction fidelity and context-retrieval precision.
- Security studies of evolvers with access to tools, memory, and their own runtime.
- Cross-model harness transfer: which improvements survive a model-family change?

## 11. High-value research experiments

These experiments would generate deeper knowledge than another repository survey:

1. **Harness ablation:** same tasks/model/budget across the six OpenFusion arms in
   §9; repeat enough trials to estimate consistency.
2. **Tool-surface experiment:** four core tools vs all tools vs deferred tool
   search; measure success, schema tokens, calls, and recovery errors.
3. **Context experiment:** no Project Card vs approved card vs card + wiki; log
   which retrieved evidence appears in successful patches.
4. **Compaction experiment:** full history vs native compaction vs structured
   checkpoint/reset; grade retained decisions, unresolved defects, cost, and task
   success.
5. **Multi-agent breakpoint:** progressively increase task dependency density and
   compare one agent, centralized scouts, and parallel writers at matched budgets.
6. **Memory causality:** proposed memory/skill vs placebo summary vs no memory on a
   held-out family of related tasks; require provenance and automatic invalidation.
7. **Evolution gate:** allow candidate changes to one prompt or tool description;
   measure targeted gain, held-out gain, regression, and how often the causal
   prediction was correct.

## Source matrix

| Source | Type / date | Evidence used | Credibility | Main caveat |
|---|---|---|---|---|
| [OpenAI: Harness engineering](https://openai.com/index/harness-engineering/) | Official engineering case, 2026-02-11 | Repo legibility, local docs, mechanical constraints, cleanup agents | **High** for implementation; **Medium** for generalization | Internal case, no controlled counterfactual |
| [OpenAI: Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) | Official technical article, 2026 | Loop protocol, cache-stable context, compaction, tools | **High** | Describes one product architecture |
| [Anthropic: Long-running agent harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Official engineering case, 2025-11-26 | Initializer, feature list, progress artifacts, browser verification | **High/Medium** | Internal experiments; task selection matters |
| [Anthropic: Long-running app harness](https://www.anthropic.com/engineering/harness-design-long-running-apps) | Official experiment, 2026-03-24 | Planner/generator/evaluator, contracts, model-dependent scaffold ablation | **High/Medium** | Small case set; high-cost examples |
| [Anthropic: Demystifying agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Official methodology, 2026-01-09 | Outcome vs trace, graders, capability/regression suites, repeated trials | **High** | Guidance rather than comparative trial |
| [Anthropic: Infrastructure noise](https://www.anthropic.com/engineering/infrastructure-noise) | Official controlled experiment, 2026-02-05 | Resource limits and benchmark variance | **High/Medium** | Specific to evaluated tasks/runtime |
| [Google: Scaling agent systems](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/) | Official research summary, 2026-01-28 | 180 configurations, topology/task interactions, error amplification | **High/Medium** | Benchmark selection and system details bound generalization |
| [SWE-agent ACI](https://arxiv.org/abs/2405.15793) | NeurIPS 2024 paper | Interface design changes agent performance | **High** | Older model generation and benchmark state |
| [Should we be going MAD?](https://openreview.net/forum?id=CrUmgUaAQp) | ICML 2024 paper | Debate sensitivity; comparison to simpler methods | **High** | Reasoning tasks, not full coding environments |
| [LLMs Cannot Self-Correct Reasoning Yet](https://openreview.net/forum?id=IkmD3fKBPQ) | ICLR 2024 paper | Limits of intrinsic correction without feedback | **High** | Title is broader than the studied settings |
| [AFlow](https://openreview.net/forum?id=z5uVAKwmjf) | ICLR 2025 Oral | Code-represented workflows, search with execution feedback | **High/Medium** | Benchmark-specific gains; search cost matters |
| [Automated Harness Engineering](https://arxiv.org/abs/2604.25850) | Preprint, 2026-04 | Component/experience/decision observability; iterative harness changes | **Medium** | Fresh preprint, no independent replication |
| [Claw-SWE-Bench](https://arxiv.org/abs/2606.12344) | Preprint, 2026-06 | Large same-model adapter effect; model/harness sensitivity | **Medium** | Very recent and potentially implementation-specific |
| [Equal-token multi-agent study](https://arxiv.org/abs/2604.02460) | Preprint, 2026-04 | Single vs multi-agent under matched reasoning tokens | **Medium** | Multi-hop reasoning scope; not full software work |
| [OpenAI Tax self-improvement](https://openai.com/index/building-self-improving-tax-agents-with-codex/) | Official customer/product case, 2026-05-27 | Production trace → eval → targeted change → regression loop | **Medium** | Company-reported outcomes, domain-specific |
| Linked source repositories in §7 | Primary source code/docs, accessed 2026-07-10 | Actual implementation and public extension surfaces | **High** for what is implemented | Popularity and README claims do not prove effectiveness |

## Bottom line

The deepest opportunity in harness engineering is not inventing a more elaborate
agent society. It is building a system that can **observe what happened, localize
why, alter one controlled component, and prove the change under protected
evaluation**. Once that spine exists, prompts, memory, skills, routing, tools,
models, and multi-agent topologies become replaceable hypotheses instead of
architecture-by-anecdote.
