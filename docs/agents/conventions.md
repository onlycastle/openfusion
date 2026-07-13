---
title: Engineering conventions
summary: Transport, privacy, immutable identity, containment, verification, cost, persistence, and documentation invariants.
status: canonical
verified: 2026-07-12
source_paths: ["packages/shared/src/contracts.ts", "packages/shared/src/verification.ts", "packages/engine/src/harness/registry.ts", "packages/engine/src/runtime/supervisor.ts", "packages/engine/src/runtime/sandbox.ts", "packages/engine/src/candidates/service.ts", "packages/engine/src/harness/store.ts", "packages/engine/src/main.ts"]
---

# Conventions

- Engine stdout contains complete NDJSON JSON-RPC lines only; diagnostics use
  stderr.
- Never persist prompts, tasks, diffs, model/command output, raw RPC payloads,
  paths, credentials, or secrets in metadata journals.
- Durable v2 stage checks use catalogued stage IDs, check IDs, message IDs,
  reason codes, component IDs, tool IDs, and policy versions from the
  authoritative harness registry. Readers continue accepting v1 reports.
- Capture one immutable task snapshot before model work and never resolve a
  later HEAD for retries, review, verification, or escalation.
- Missing security capabilities fail closed. Filesystem/process/network/secret
  authority is the intersection of parent, role, tool, and invocation claims.
- Candidate identity is a digest-bound capability. Apply always needs a fresh,
  single-use approval grant and never commits, merges, or pushes.
- Harness persistence uses immutable generations plus an atomic pointer;
  readers never infer whole-bundle atomicity from per-file renames.
- `knownUsd` is not `totalUsd` unless pricing completeness is `complete`.
- Preserve unrelated dirty-worktree changes.
- Update human and agent docs with behavior changes and verify listed source
  paths.
