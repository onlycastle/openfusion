---
title: Agent wiki entry point
summary: Retrieval protocol and topic index for source-backed OpenFusion agent documentation.
status: canonical
verified: 2026-07-12
source_paths: ["AGENTS.md", "docs/knowledge_base/README.md", "docs/knowledge_base/index.md", "docs/agents/map.json", "scripts/query-docs.mjs", "scripts/check-docs.mjs"]
---

# Agent wiki

This directory is a committed, low-token repository wiki. It complements the
runtime `.openfusion` symbol wiki; it does not replace source inspection.

It is also the compiled Markdown layer of the repository's Karpathy-style LLM
knowledge base. `docs/knowledge_base/` provides the discoverable entry point,
content catalog, and maintenance log without duplicating these pages.

## Retrieval protocol

1. Start with `map.json` or run `pnpm docs:query -- <terms>`.
2. Load only the highest-scoring relevant page.
3. Follow that page's `source_paths` into current source for exact behavior.
4. Consult human docs for explanation and dated research/specs for rationale.

## Maintenance protocol

Follow [`docs/knowledge_base/README.md`](../knowledge_base/README.md) for ingest,
lint, symbol-index refresh, and promotion. Append knowledge-base maintenance to
[`docs/knowledge_base/log.md`](../knowledge_base/log.md), but never record
prompts, diffs, model output, RPC payloads, credentials, or secrets.

## Pages

- [`product-vision.md`](product-vision.md): canonical product requirements,
  owned evaluation/execution loop, universal runtime boundaries, and
  current-versus-target guardrail.
- [`project-map.md`](project-map.md): repository ownership and entry points.
- [`architecture.md`](architecture.md): process, protocol, data, and trust
  boundaries.
- [`workflows.md`](workflows.md): cross-subsystem runtime sequences.
- [`conventions.md`](conventions.md): invariants and implementation posture.
- [`testing.md`](testing.md): verification matrix and commands.
- [`subsystems/desktop.md`](subsystems/desktop.md)
- [`subsystems/engine.md`](subsystems/engine.md)
- [`subsystems/runtime.md`](subsystems/runtime.md)
- [`subsystems/wiki-harness.md`](subsystems/wiki-harness.md)
- [`subsystems/orchestration.md`](subsystems/orchestration.md)
- [`subsystems/evaluations.md`](subsystems/evaluations.md): occasional system benchmarks with objective oracles.

## Freshness semantics

`verified` means a maintainer checked the summary against the listed source
paths on that date. It is not a promise that every line remains unchanged.
When a source path changes materially, update the relevant page and date.
