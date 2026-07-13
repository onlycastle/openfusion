# Product vision and requirements: an evidence-driven universal coding harness

This is the evergreen product north star. The dated
[evidence-driven harness PRD](../superpowers/specs/2026-07-12-evidence-driven-harness-prd.md)
defines the active product requirements and supersedes the assumptions in the
original July 3 design. Current behavior still belongs to the source-backed
workflow and runtime guides.

## Goal

OpenFusion's goal is to let people combine the lead coding agent they already
trust with a choice of less expensive worker models, without giving up the
agent-runtime capabilities that make Claude Code and Codex effective. The
durable product is the project-specific evaluation and execution loop that
keeps those models replaceable.

The product promise is:

> Bring an authenticated Claude Code or Codex runtime, connect compatible
> worker-model APIs, and let OpenFusion continuously qualify the least
> expensive safe route for each project workflow, with mechanical
> verification, lead-model supervision where it adds value, and explicit human
> control over the final repository change.

The lead runtime is used for high-leverage work such as project planning,
review, escalation, and controlled baselines. Worker models handle suitable
implementation work through OpenFusion's local engine. OpenFusion uses the
official runtime's authenticated session; it does not extract credentials or
turn a subscription into a generic API credential.

## Why OpenFusion exists

A model API is transport, not a complete coding agent. Coding quality also
depends on the harness around the model: tool design, context assembly,
session state, output truncation and recovery, permissions, hooks, skills, MCP
access, delegation, and model-specific interaction patterns.

Those capabilities are currently concentrated in separate products. A user
who wants Claude Code or Codex quality controls together with Kimi, GLM,
DeepSeek, Qwen, or another worker model should not have to operate several
unrelated agents or accept a thin wire-format proxy as the integration layer.

OpenFusion's thesis is that these techniques can be expressed as a universal
runtime with model-family adapters and evaluated on private project work. The
common runtime supplies durable and safe agent semantics; adapters preserve
the tool dialect, prompt shape, reasoning controls, context behavior, cache
behavior, and recovery guidance that work best for each model family.
Universality must not collapse into a lowest-common-denominator prompt and
toolset.

The asset OpenFusion and its users should own is not a frozen model checkpoint
or a generated prompt bundle. It is the improvement loop: representative
tasks, protected evaluators, project policy, route evidence, verified outcome
history, and the ability to qualify, promote, roll back, or replace a model and
harness component safely. The
[research audit](../research/2026-07-12-harness-economics-model-mix-caching-and-owned-loop.md)
records the evidence and caveats behind this decision.

## Research-backed hypothesis register

| Hypothesis | Current conclusion |
|---|---|
| Users prefer a cheaper model at equivalent performance. | Directionally supported, but equivalence must be measured as accepted-result quality and fully burdened cost. |
| Lower-cost models are weak because they are accessed through APIs. | Rejected. API is transport; the model-runtime-adapter-project combination determines performance. |
| More agents or more model diversity improves outcomes. | Conditional. Staged scout/candidate and verifier roles can help; default swarms can amplify cost and error. |
| Harnesses disappear as models improve. | Only prompt micro-scaffolds are likely to be absorbed. Tools, policy, state, verification, and project evaluation remain. |
| Generated project context and specialist profiles help. | Unresolved. They remain candidates that must pass fixed-model A/B evaluation. |
| Owning weights is the durable advantage. | Usually premature. Own the evaluation and improvement loop first; train only narrow workloads whose lifecycle economics work. |

## Target users

OpenFusion is primarily for people who:

- already use an official Claude Code or Codex account and want it to remain
  the trusted lead or fallback;
- want to use one or more lower-cost model APIs for appropriate coding work;
- value local repositories, isolated execution, inspectable diffs, and an
  explicit apply boundary;
- want quality, cost, and routing evidence instead of choosing models from
  anecdotes; and
- do not want provider choice to require learning a different agent product
  for every model.

The strongest initial fit is repeated work in a small number of repositories
with tests, builds, review history, or another observable quality signal. The
product is a weaker fit for one-off ambiguous tasks or low-volume users whose
frontier subscription already absorbs their practical cost.

## Product architecture

OpenFusion separates a stable control plane, a universal agent runtime,
model-specific adapters, and project-specific harness data.

```text
OpenFusion control plane
  project selection, worktrees, routing, review, evaluation, cost, apply

Universal agent runtime
  tools, context, sessions, permissions, hooks, skills, MCP, subagents

Model-family adapters
  Claude, Codex/OpenAI, Kimi, GLM, DeepSeek, Qwen, and compatible APIs

Project harness
  repository knowledge, Project Card, optional workflow profiles, private evals,
  routing, and policy
```

The control plane decides which route may run, where it may write, how its
result is reviewed, and whether the user may apply it. The universal runtime
defines consistent agent behavior. A model-family adapter specializes that
behavior without bypassing control-plane safety. The project harness supplies
repository-specific context and policy; it is not the runtime itself.

### Universal runtime capabilities

- **Tools:** typed, bounded operations with recoverable output and consistent
  result semantics.
- **Context management:** layered instructions, targeted retrieval, token
  budgets, stable prefixes, and trace-derived compaction.
- **Sessions:** append-only events, cancellation, replay, checkpointing, and
  safe resumption after interruption.
- **Permissions:** an `allow | ask | deny` decision before execution, followed
  by filesystem, process, secret, and network containment. A child agent must
  never silently receive more authority than its parent.
- **Hooks:** observable lifecycle points around model turns and tool calls for
  policy, telemetry, and extensions.
- **Skills:** discoverable, on-demand instructions and reusable workflows that
  do not inflate every prompt.
- **MCP:** standard discovery and invocation of external tools and repository
  knowledge under the same permission policy as built-in tools.
- **Subagents:** isolated child sessions with explicit task, context, model,
  budget, permissions, and a structured result returned to the parent.

## Relationship to the generated project harness

The generated `.openfusion/` harness configures the runtime for one
repository. Its parts have distinct jobs:

- the Project Card provides a small, human-approved set of shared repository
  facts;
- wiki pages and symbol tools provide deeper knowledge on demand;
- agent definitions may hold evidence-backed workflow roles and prompts;
- routing selects agents, models, and fallback chains; and
- the manifest pins versions and verification state.

The Project Card is therefore one context source, not a description of the
agent roster or an orchestrator prompt. The lasting product advantage should
come from private project evaluation, the universal runtime, verified outcome
history, policy, and evidence-backed routing—not from generating more
always-on prose or speculative specialist personas.

## Learning from Claude Code, Codex, and OpenCode

OpenFusion treats other coding harnesses as implementation evidence, not as
brands to imitate. The dated
[coding-harness source audit](../research/2026-07-10-coding-harness-source-audit.md)
records pinned source revisions and concrete patterns worth studying.

- Claude Code is a reference for mature tool use, context and session
  management, permissions, hooks, skills, MCP, and delegated agents.
- Codex is a reference for event-driven execution, patch-oriented editing,
  sandbox and approval boundaries, output shaping, and compaction.
- Current OpenCode is a reference for composing providers, agents, sessions,
  tools, permissions, MCP, plugins, and subtasks in an open provider-neutral
  codebase.

Patterns should be reimplemented narrowly behind OpenFusion contracts, with
provenance and tests. OpenFusion should not copy full prompts, claim native
parity from a profile name, or import a feature before its safety and quality
effects can be measured.

## User experience

The intended ordinary task path is:

```text
user task
  -> choose the least expensive qualified route at a task/cache boundary
  -> run the worker with its model-aware harness in an isolated worktree
  -> verify mechanically during execution and correct from real feedback
  -> inspect the complete diff and execution evidence
  -> review with the selected Claude Code or Codex lead runtime
  -> retry with feedback, advance to a stronger worker, or escalate
  -> return one reviewed diff
  -> change the selected repository only after explicit user approval
```

“Cheaper” means lower total cost for an accepted result, not a lower input-token
price. Cache writes and misses, failed worker attempts, tool and patch errors,
repeated review, latency, escalation, human intervention, and later regression
all count. Hard tasks should route directly to a lead model when that is the
safer or less expensive expected path. A warm session should remain model-
affine until a natural boundary unless quality, safety, availability, or an
explicit override requires a switch.

## Success criteria

OpenFusion succeeds when it can demonstrate that:

- a worker route preserves an accepted quality band relative to a direct lead
  baseline while reducing fully burdened accepted-result cost;
- a fixed-model project-harness variant beats or justifies its cost relative
  to the corresponding generic runtime on held-out project tasks;
- model-family adapters measurably outperform a generic worker loop for the
  models they claim to support;
- routing decisions are reproducible and increasingly grounded in observed
  project/task/model outcomes;
- route reports expose quality-cost-latency Pareto position, cache economics,
  retries, and tool/edit/patch/Apply failure categories rather than only token
  totals;
- sessions and tool artifacts are inspectable, resumable, and safe to compact;
- permissions are enforced independently of model instructions, including
  across subagents;
- memory and harness changes remain candidates until protected evaluation and
  explicit promotion; and
- no generated change reaches the selected repository without explicit human
  approval.

## Current state and direction

OpenFusion now has official Claude Code and Codex lead-runtime adapters,
configurable API workers, model-family dialect packs, immutable task snapshots,
detached host-private worktrees, a native macOS process sandbox, one bounded
provider gateway for production model traffic, durable session/event state,
encrypted opt-in traces, artifact pagination, policy decisions and approvals,
lifecycle hooks, approved skill/MCP/hook extensions, bounded child sessions,
snapshot-pinned context compilation, exact candidate verification, independent
read-only review, and approval-bound Apply.

The universal runtime is still maturing. Core wiki/file/edit/process tools,
approved MCP/skill extensions, and child controls now share registry-backed
`ToolGateway` claims. Adapter-native exact resume for
every official runtime, official lead-runtime delegation through the typed
child contract, and non-macOS sandbox backends remain
incomplete. Routing is deterministic: an offline
evidence compiler can propose routing-v3 tables, but promotion still requires
protected evidence, shadowing, and human approval. Online exploration and
automatic promotion are deliberate non-goals.

Near-term product priority is to make the thesis directly falsifiable: clear
fixed-model harness comparisons, explicit wiki-MCP treatment, complete
patch/apply failure reporting, quality-cost-latency Pareto views, mid-run
verification, and cache-aware route-boundary experiments. The active PRD
separates these requirements from shipped behavior.

This distinction is intentional: the vision defines where OpenFusion is going,
while [How OpenFusion works](workflows.md) remains the source for behavior
available today.

## Non-goals

OpenFusion is not intended to be:

- a generic API gateway that only translates provider wire formats;
- a per-turn cheapest-model switcher that ignores cache affinity;
- a promise that the cheapest model should attempt every task;
- a clone of Claude Code, Codex, or OpenCode prompts and private internals;
- a default mesh of collaborating agents without durable sessions,
  permissions, and measured benefit;
- a claim that generated specialists or project context help without matched
  evidence;
- an autonomous memory or harness optimizer that promotes its own output;
- a vector-index-first memory system or foundation-model training platform;
- a way to turn provider outputs into training data without explicit rights
  and provenance; or
- an autonomous system that commits, merges, pushes, or applies user code
  without approval.
