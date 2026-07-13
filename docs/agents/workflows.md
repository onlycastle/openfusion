---
title: Runtime workflows
summary: Project readiness, immutable snapshots, candidate verification, approval-bound Apply, cancellation, health, and experiments.
status: canonical
verified: 2026-07-12
source_paths: ["apps/desktop/src/screens/OrchestrateScreen.tsx", "packages/engine/src/models/gateway.ts", "packages/engine/src/tools/gateway.ts", "packages/engine/src/runtime/context-compiler.ts", "packages/engine/src/runtime/snapshot.ts", "packages/engine/src/runtime/supervisor.ts", "packages/engine/src/orchestrate/orchestrate.ts", "packages/engine/src/worker/methods.ts", "packages/engine/src/wiki/store.ts", "packages/engine/src/candidates/service.ts", "packages/engine/src/harness/store.ts", "packages/engine/src/evals/run.ts", "packages/engine/src/evals/experiment.ts"]
---

# Workflows

Readiness is `Git project -> role capability probes -> committed-source wiki ->
valid active harness generation -> worker provider`. Harness writes build a
complete immutable generation and publish it with an atomic `current.json`
swap; legacy flat layouts remain readable.

Before any model call, a supervisor captures committed HEAD/tree, dirty-state
digest, harness/wiki/tool/policy identity, and runtime capabilities. Dirty
content is excluded and reported to Studio. A final `HEAD` check runs after
capability probing; drift rejects capture. Every attempt and verifier clone
starts from the captured SHA in a detached host-private worktree. Each worker
is admitted with the captured base, harness generation, and wiki identity and
uses a read-only in-memory copy of the matching wiki database. Missing or
drifted pins fail closed; a concurrent rebuild cannot change retrieval.

`ProviderGateway` bounds every production model turn. `ContextCompiler` binds
stable instructions, approved project context, and selective wiki retrieval to
the base/wiki identity before volatile task text. Core tool calls declare
dynamic resources through `ToolGateway`; every parent/role/tool layer must
cover a claim before policy and native containment execute it.

The task pipeline is `route -> sandboxed author -> canonical diff -> disposable
verifier clone -> deterministic commands -> structured coverage -> independent
read-only review in the exact tree -> CandidateRef`. Escalation uses the same
verification/review path. If any required gate or reviewer is unavailable,
Apply is not exposed.

Apply is `engine.candidates.prepareApply -> ApprovalGrant ->
engine.orchestrate.apply`. Both calls recompute freshness and exact diff
identity; the latter consumes the grant and applies without committing.

Cancellation belongs to the root supervisor and reaches nested sessions and
descendant processes. Journals have one root terminal event. Without an
enabled encrypted vault, a startup-recovered interruption is explicitly
non-resumable and transient content is expired.

`engine.evals.run` is the directional one-trial comparison.
`engine.evals.experiment` adds seeded arm order, durable repeated trials,
resume, pass@k/pass^k, clustered intervals, latency/cost distributions, and
promotion-gate evidence. Evaluator-only tests and fixtures are materialized
only after author and reviewer sessions close.
