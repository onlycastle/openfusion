---
title: System architecture
summary: Process boundaries, run ownership, native containment, storage, trust, and shutdown ordering.
status: canonical
verified: 2026-07-12
source_paths: ["apps/desktop/src-tauri/src/engine_bridge.rs", "apps/desktop/src-tauri/src/lib.rs", "apps/desktop/src-tauri/tauri.conf.json", "packages/engine/src/main.ts", "packages/engine/src/engine.ts", "packages/engine/src/runtime/supervisor.ts", "packages/engine/src/runtime/snapshot.ts", "packages/engine/src/runtime/sandbox.ts", "native/sandbox-runner/src/main.rs"]
---

# Architecture

`React -> Tauri invoke/Channel -> Rust EngineBridge -> stdio NDJSON JSON-RPC ->
TypeScript Engine`. The bundle also carries the standalone Rust
`openfusion-sandbox` runner used by the engine for native process containment.

One `RunSupervisor` owns a top-level run's immutable `TaskSnapshotRef`, budget,
cancellation tree, journal, sessions, processes, worktrees, candidate state,
and cleanup. `RunKernel` admits at most two active and eight queued top-level
runs globally and one writer per project. RPC dispatch is capped at 32
concurrent handlers; inbound lines and outbound buffers are byte bounded.

Task worktrees and encrypted artifacts live under host application storage,
outside the selected repository. The project keeps immutable harness
generations, the active `current.json` pointer, wiki/runtime databases, and the
metadata-only production ledger under `.openfusion/`.

The macOS sandbox runner canonicalizes roots, clears the inherited environment,
denies network by default, supervises descendants, and has distinct author,
verify, review, eval, and scout profiles. Missing or unsupported containment
fails closed. API-worker Bash is registered only after a successful probe.

Candidate-bound Apply requires one exact `CandidateRef` and a one-use,
ten-minute `ApprovalGrant`. It rejects changed HEAD, dirty touched paths,
candidate substitution, and reused grants; it never commits.

Shutdown stops admission, aborts supervisor/frontier trees, closes worker and
runtime children, enforces cleanup deadlines, closes frontier then wiki/MCP
sessions, drains admitted RPC handlers, and finally drains terminal responses.
The Rust bridge closes stdin, then kills and reaps the sidecar on deadline.
