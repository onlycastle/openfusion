# OpenFusion knowledge index

Read [`README.md`](README.md) for the query, ingest, lint, refresh, and promotion
workflows.

## Repository map

- [`docs/agents/product-vision.md`](../agents/product-vision.md) — product
  requirements, owned evaluation/execution loop, provider-neutral runtime
  strategy, target users, and delivery guardrails.
- [`docs/agents/project-map.md`](../agents/project-map.md) — package ownership,
  directory responsibilities, and entry points.
- [`docs/agents/architecture.md`](../agents/architecture.md) — processes,
  storage, protocol, trust boundaries, and shutdown.
- [`docs/agents/workflows.md`](../agents/workflows.md) — project readiness, task
  execution, apply, cancellation, harness health, and system benchmarks.
- [`docs/agents/conventions.md`](../agents/conventions.md) — engineering
  invariants and implementation posture.
- [`docs/agents/testing.md`](../agents/testing.md) — verification commands and
  test tiers.

## Subsystems

- [`docs/agents/subsystems/desktop.md`](../agents/subsystems/desktop.md) — React
  workspace, Tauri host, projects, secrets, and bridge lifecycle.
- [`docs/agents/subsystems/engine.md`](../agents/subsystems/engine.md) — engine
  services, JSON-RPC, notifications, cancellation, and shutdown.
- [`docs/agents/subsystems/runtime.md`](../agents/subsystems/runtime.md) —
  durable sessions, encryption, recovery, policy, extensions, children, and
  evidence-backed routing.
- [`docs/agents/subsystems/wiki-harness.md`](../agents/subsystems/wiki-harness.md)
  — symbol indexing, MCP retrieval, generated harness pages, health, and persistence.
- [`docs/agents/subsystems/orchestration.md`](../agents/subsystems/orchestration.md)
  — routing, isolated workers, review, retry, escalation, and apply.
- [`docs/agents/subsystems/evaluations.md`](../agents/subsystems/evaluations.md)
  — occasional system benchmarks, oracles, verdicts, quality, and cost.

For machine-readable routing, use [`docs/agents/map.json`](../agents/map.json) or
`pnpm docs:query -- <terms>`.
