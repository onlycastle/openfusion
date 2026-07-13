---
title: Universal runtime subsystem
summary: SQLite sessions, encrypted traces/artifacts, approvals, recovery, context, policy, sandbox, extensions, children, and evidence routing.
status: canonical
verified: 2026-07-12
source_paths: ["packages/shared/src/contracts.ts", "packages/engine/src/runtime/store.ts", "packages/engine/src/runtime/service.ts", "packages/engine/src/runtime/methods.ts", "packages/engine/src/runtime/types.ts", "packages/engine/src/runtime/policy.ts", "packages/engine/src/runtime/sandbox.ts", "packages/engine/src/runtime/context.ts", "packages/engine/src/runtime/context-compiler.ts", "packages/engine/src/runtime/read-cache.ts", "packages/engine/src/runtime/hooks.ts", "packages/engine/src/runtime/skills.ts", "packages/engine/src/runtime/mcp.ts", "packages/engine/src/runtime/children.ts", "packages/engine/src/runtime/evidence.ts", "packages/engine/src/runtime/evidence-methods.ts", "packages/engine/src/tools/gateway.ts", "packages/engine/src/worker/loop.ts", "packages/engine/src/worker/methods.ts", "native/sandbox-runner/src/main.rs"]
---

# Universal runtime

`RuntimeStore` owns authoritative project state at
`.openfusion/cache/runtime.db` using SQLite WAL, `synchronous=FULL`,
forward-only migrations, transactions, and optimistic session versions.
JSONL run/event files are content-free compatibility projections, not session
authority.

Session content is optional. Enabled traces encrypt each record with
AES-256-GCM; encrypted files are temporary-file/fsync/rename artifacts and are
garbage-collected after crash windows. The host supplies the per-project
Keychain key in memory. Missing keys yield `locked` content while metadata
remains usable. Limits are 16 MiB per artifact/tool-output stream and 256 MiB
per session; default trace retention is seven days or 2 GiB.

The OpenFusion-owned AI SDK loop persists each response batch before
continuation and persists tool/approval boundaries. Mutating pauses create a
compressed binary-diff checkpoint against the immutable base. Startup never
replays an incomplete side effect. Recovery chooses current worktree,
checkpoint reconstruction, or cancellation; exact history needs an unlocked
trace.

`WorkerService` admits each worker RPC before its first setup await. Shutdown
stops later admissions, aborts and drains admitted handlers, and only then
allows `RuntimeStore` to close.

`PolicyEvaluator` composes a hard ceiling, project grants, session grants,
extension restrictions, and child intersection. The native macOS runner
canonicalizes policy paths, clears environment inheritance, denies network by
default, kills process groups, and fails closed. Bash has no fallback.

Core, approved MCP/skill, and child tools use registry-backed schemas or
approved inventories and `ToolGateway` dynamic claims.
Every parent/role/tool claim layer must cover a requested resource before the
composed policy runs; unknown tools, uncovered claims, and unresolved headless
approvals are denied. Metadata records IDs, counts, decisions, and reason codes
without resource paths or tool content.

`ContextCompiler` binds the initial view to base SHA and wiki source identity,
then orders stable instructions, approved project context, and task-conditioned
wiki retrieval before volatile task text. Inline retrieved context is limited
to 32 KiB; larger output is represented by validated artifact references. The
compiled fingerprint is frozen and checked on exact resume.

Frozen session context includes instruction/tool order, policy, sandbox,
skills, MCP, hooks, and adapters. Compaction starts at 70%, retains a stable
prefix and recent tail, stores source ranges, and never rewrites authoritative
events. Read caching keys canonical path/range/stat/hash plus a mutation epoch.

Skill adapters normalize Claude and Codex metadata with explicit diagnostics.
Approved hooks can observe or narrow normalized facts. MCP stdio and
HTTPS/loopback Streamable HTTP tools are fingerprinted and wrapped by the same
policy, timeout, cancellation, hook, and artifact boundaries.

Children reuse `RuntimeSession`, are depth-one and opt-in, and have independent
worktrees/budgets/traces. Import is explicit, version/checkpoint guarded,
serialized, conflict-reporting, and rollback-safe.

`spawn_child` exposes only a bounded task. The runtime validates the configured
provider, reserves budget, and creates a typed `DelegationRequest` bound to the
parent, base SHA, adapter target, deadline, and inherited-authority digest.
Credentials never enter that request or the child environment. Child control
and import calls remain subject to parent/role/tool claims.

`EvidenceService` transactionally records seeded matched trials and compiles
one-component routing-v3 tables from safe metadata. Safety, pricing, sample,
quality, savings, shadow, current-harness, and human-approval gates precede
promotion. Runtime resolution is deterministic and falls back to configured
routing on a missing, sparse, or stale match. Rollback restores the exact
previous active candidate.
