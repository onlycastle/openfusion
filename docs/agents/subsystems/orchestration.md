---
title: Orchestration subsystem
summary: Snapshot-pinned routing, sandboxed authoring, exact candidate verification/review, truthful cost, and approval-bound Apply.
status: canonical
verified: 2026-07-12
source_paths: ["packages/engine/src/runtime/snapshot.ts", "packages/engine/src/runtime/sandbox.ts", "packages/engine/src/orchestrate/orchestrate.ts", "packages/engine/src/orchestrate/review-policy.ts", "packages/engine/src/tools/gateway.ts", "packages/engine/src/worker/methods.ts", "packages/engine/src/worker/tools.ts", "packages/engine/src/worker/worktree.ts", "packages/engine/src/candidates/service.ts", "packages/engine/src/candidates/methods.ts", "packages/engine/src/orchestrate/methods.ts"]
---

# Orchestration

One run captures a `TaskSnapshotRef`, then deterministically classifies and
routes the task. All author/retry/escalation worktrees are detached, host
private, and created from the snapshot base SHA.

An active routing-v3 table may override the configured route only when task
class, difficulty, harness fingerprint, and project fingerprint all match.
Sparse, absent, or stale evidence falls back to the configured harness route.
Candidate compilation, shadowing, human promotion, and rollback live in the
runtime evidence service; orchestration performs no online exploration.

API workers use scoped file/edit tools and receive Bash only when the native
sandbox is certified. The sandbox clears inherited environment, denies network
by default, supervises descendants, and applies role-specific path policy.
Every built-in invocation declares dynamic resource claims through
`ToolGateway`; uncovered or unknown claims fail closed and approval never
widens parent/role/tool authority.
Claude authoring is disabled because its adapter reports unsupported sandbox
compatibility; Codex uses explicit native workspace-write/read-only policy.

Every non-empty author result is canonicalized, policy checked, materialized in
a disposable verifier clone, and run through deterministic project commands.
Coverage binds the structured task contract. A fresh reviewer session, distinct
from the author, inspects the exact candidate tree and StageReportV2 evidence
under read-only policy. Escalation is not exempt from these gates.

Only a passing pipeline mints `CandidateRef`. Results may retain legacy diff
presentation fields, but Apply authority comes only from candidate identity.
`prepareApply` mints a one-use ten-minute grant after freshness checks. Apply
rechecks candidate/destination/base/digest, rejects dirty overlapping paths,
performs `git apply --check --3way`, applies, and consumes the grant.

Cost is `CostEstimate { knownUsd, completeness, unpricedCalls,
pricingVersion, confidence }`; `cost.totalUsd` is null unless complete.
