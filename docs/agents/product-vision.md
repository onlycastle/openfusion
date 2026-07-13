---
title: Product requirements and evidence-driven harness strategy
summary: Own the project-specific evaluation and execution loop, qualify complete model-harness routes, and keep models replaceable.
status: canonical
verified: 2026-07-12
source_paths: ["README.md", "docs/human/product-vision.md", "docs/superpowers/specs/2026-07-12-evidence-driven-harness-prd.md", "docs/research/2026-07-12-harness-economics-model-mix-caching-and-owned-loop.md", "packages/engine/src/engines/types.ts", "packages/engine/src/models/gateway.ts", "packages/engine/src/models/catalog.ts", "packages/engine/src/runtime/service.ts", "packages/engine/src/runtime/context-compiler.ts", "packages/engine/src/runtime/context.ts", "packages/engine/src/runtime/evidence.ts", "packages/engine/src/runtime/sandbox.ts", "packages/engine/src/worker/runtime.ts", "packages/engine/src/evals/experiment.ts", "packages/engine/src/orchestrate/orchestrate.ts", "packages/engine/src/candidates/service.ts"]
---

# Product requirements and vision

## North star

OpenFusion lets users keep an authenticated Claude Code or Codex runtime as a
trusted lead while running suitable implementation work on lower-cost model
APIs. It aims to reduce total cost for an accepted change without giving up
coding-harness quality, isolated execution, lead review, or human control over
the selected repository.

API is transport. A provider API becomes a capable coding worker through the
runtime around it: tools, edit adapters, context lifecycle, sessions,
permissions, hooks, skills, MCP, subagents, verification, and model-specific
dialects.

The owned asset is the project-specific improvement loop: representative
tasks, protected evaluators, policy, verified outcome history, and evidence
for qualifying or replacing complete model-harness routes. A frozen checkpoint,
current routing table, generated context bundle, or specialist roster is a
replaceable output of that loop.

## Architectural ownership

| Layer | OpenFusion responsibility |
|---|---|
| Control plane | Project scope, worktrees, routing, review, evaluation, cost, cancellation, and apply |
| Universal runtime | Tools, context, durable sessions, permissions, hooks, skills, MCP, and subagents |
| Model adapters | Tool/prompt dialect, reasoning controls, context behavior, recovery, and provider protocol |
| Project harness | Repository knowledge, Project Card, optional workflow profiles, private evals, routing, and versioned policy |

The generated project harness configures the runtime; it is not the runtime.
The Project Card is one approved context input. Optional workflow prompts live
in agent definitions, and orchestration policy lives in routing plus engine
code. Generated context and specialist profiles remain unproven until a
fixed-model project evaluation demonstrates their value.

## Design rules

- Preserve provider neutrality without reducing every model to one prompt and
  toolset. Dialect adapters must produce observable runtime differences.
- Treat API, enterprise-gateway, and self-hosted models as replaceable
  execution backends. Do not encode “open first” or “frontier last” into the
  architecture.
- Use official Claude Code/Codex sessions for configured lead roles without
  extracting their credentials or treating subscription auth as a generic API.
- Count total accepted-result cost. Worker failures, lead review, retries,
  cache writes and misses, tool/edit/patch failures, latency, escalation, and
  regression can erase a cheap token price.
- Route at task, handoff, compaction, TTL, provider-failure, or escalation
  boundaries. Preserve a warm session's model affinity unless quality, safety,
  availability, or explicit override requires a switch.
- Keep the append-only session/event record authoritative; compaction and
  prompt views are derived projections.
- Put permission decisions before tool execution. Filesystem containment,
  process sandboxing, and model instructions are separate defenses.
- Child-agent authority is monotonic: a child receives no permission broader
  than its parent unless a human explicitly approves elevation.
- Load skills and repository knowledge on demand. Do not turn runtime richness
  into bulk always-on prompt text.
- Require evaluation evidence before claiming that a model-family profile,
  specialist, route, or borrowed harness pattern improves quality or cost.
- Use fixed-model generic-versus-project-harness A/B tests to decide whether
  generated context and workflow profiles earn their cost. Baseline-versus-
  full-system comparison does not isolate that causal question.
- Treat memory and harness changes as candidates. Protected repeated and
  held-out evaluation, human promotion, and exact rollback precede use.
- Add agents only when a matched-budget experiment shows positive marginal
  accepted-result value. Scout/candidate plus verifier is eligible, not a
  universal default.
- Preserve the existing trust boundary: OpenFusion returns a reviewed diff and
  changes the selected repository only through explicit apply.

## Reference strategy

Use the pinned
[`coding-harness source audit`](../research/2026-07-10-coding-harness-source-audit.md)
when porting behaviors:

- Claude Code: tools, context/session management, permissions, hooks, skills,
  MCP, and delegation.
- Codex: event protocol, patch editing, sandbox/approval policy, recoverable
  output shaping, and compaction.
- Current OpenCode: open provider-neutral composition of providers, sessions,
  agents, tools, permissions, MCP, plugins, and subtasks.

Port narrow behavior behind an OpenFusion contract with provenance,
conformance tests, and evaluation. Do not clone full prompts/toolsets or imply
native parity from `claude-like`, `codex-like`, or `opencode-like` names.

Use the
[`harness economics and owned-loop audit`](../research/2026-07-12-harness-economics-model-mix-caching-and-owned-loop.md)
for product claims about cheaper defaults, routing, prompt caching, model
mixtures, task-specific training, and enterprise ownership. Coinbase is a
credible but unaudited case study; DoorDash is private workflow evidence; the
“80% on 99%-cheaper models” statement remains a forecast.

## Current versus target

Current source implements Claude/Codex adapters, configurable API workers,
model-family dialect packs, immutable task snapshots, a native macOS sandbox,
one bounded provider gateway, registry-backed core tools with dynamic claim
enforcement, snapshot-pinned context compilation, durable encrypted runtime
sessions/artifacts, policy approvals, hooks, approved skills/MCP extensions,
bounded child sessions, independent candidate review, approval-bound Apply,
and offline evidence-compiled deterministic routing with shadow, human
promotion, fallback, and rollback.

The following remain incomplete unless a narrower source path proves otherwise:
exact adapter-native resume across every runtime, official lead-runtime delegation through the typed
child contract, and sandbox backends beyond macOS. Online learning and automatic promotion are
non-goals, not incomplete routing work.

Near-term requirements are clear fixed-model harness comparisons with explicit
wiki-MCP treatment, complete patch/apply failure-rate reporting, quality-cost-
latency Pareto views, mid-run verification, and cache-aware route-boundary
experiments. Verify narrower implementation status in the owning subsystem
pages rather than inferring it from this north star.

## Decision test

A proposed feature belongs in OpenFusion when it strengthens at least one of:

1. accepted quality across heterogeneous models;
2. total cost or latency to an accepted result;
3. runtime safety, inspectability, or recovery; or
4. provider choice without sacrificing model-specific effectiveness; or
5. the quality of evidence used to qualify, promote, replace, or roll back a
   route or harness component.

Features that only generate more prose, add persona labels, or translate API
formats without measurable runtime benefit are not sufficient expressions of
the product goal.
