---
title: Repository project map
summary: Ownership map for OpenFusion packages, applications, tests, benchmarks, and documentation.
status: canonical
verified: 2026-07-10
source_paths: ["package.json", "pnpm-workspace.yaml", "apps/desktop/package.json", "packages/engine/package.json", "packages/shared/package.json"]
---

# Project map

| Path | Owns | Primary entry points |
|---|---|---|
| `apps/desktop/src/` | React workspace and typed engine client | `main.tsx`, `App.tsx`, `engineClient.ts` |
| `apps/desktop/src-tauri/` | Tauri lifecycle, sidecar bridge, native projects/secrets/frontier commands | `src/lib.rs`, `src/engine_bridge.rs`, `src/commands.rs` |
| `packages/engine/src/rpc/` | JSON-RPC dispatcher, NDJSON transport, cancellation | `dispatcher.ts`, `stdio.ts`, `cancel-registry.ts` |
| `packages/engine/src/wiki/` | tree-sitter index, SQLite store, ranking, MCP tools | `methods.ts`, `indexer.ts`, `store.ts`, `mcp.ts` |
| `packages/engine/src/models/` | Provider registry, model families/dialects, pricing and metering | `methods.ts`, `providers.ts`, `catalog.ts`, `meter.ts` |
| `packages/engine/src/engines/` | Frontier adapter contract, role selection, Claude and Codex implementations | `types.ts`, `selection.ts`, `methods.ts`, `claude.ts`, `codex.ts` |
| `packages/engine/src/harness/` | Harness generation, schema, storage, Project Card, export | `generate.ts`, `schema.ts`, `store.ts`, `card.ts` |
| `packages/engine/src/worker/` | Worktrees, scoped tools, dialect runtime, worker loop | `methods.ts`, `worktree.ts`, `tools.ts`, `runtime.ts` |
| `packages/engine/src/orchestrate/` | Classification, routing, frontier review, retries and escalation | `orchestrate.ts`, `routing.ts`, `review.ts` |
| `packages/engine/src/runtime/` | SQLite sessions, encryption, policy, sandbox, context, extensions, children and evidence routing | `store.ts`, `service.ts`, `children.ts`, `evidence.ts` |
| `packages/engine/src/evals/` | Golden tasks, paired evaluation, verdicts, benchmark CLI | `run.ts`, `tasks.ts`, `verdict.ts`, `bench/` |
| `packages/engine/src/runs/` | Local JSONL run ledger | `ledger.ts`, `methods.ts` |
| `packages/shared/` | Shared Zod RPC and wiki types | `src/rpc.ts`, `src/wiki.ts` |
| `benchmarks/` | SWE-bench Verified Mini inputs and durable benchmark notes | `README.md`, dataset JSON |
| `docs/human/` | Evergreen contributor/operator documentation | `README.md` |
| `docs/agents/` | Agent retrieval map and source-backed pages | `README.md`, `map.json` |
| `docs/research/` | Dated investigations and evidence | date-prefixed Markdown |
| `docs/superpowers/` | Dated product specs and implementation plans | `specs/`, `plans/` |

Tests usually mirror ownership under `packages/*/test`,
`apps/desktop/src/**/*.test.tsx`, and `apps/desktop/src-tauri/tests`.
