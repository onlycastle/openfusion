# OpenFusion knowledge-base log

Append entries in the form `## [YYYY-MM-DD] operation | subject`. Do not record
prompts, diffs, model output, RPC payloads, credentials, or secret values.

## [2026-07-10] setup | Karpathy-style repository knowledge base

- Established `knowledge_base/` as the discoverable entry point and operations
  layer.
- Kept `docs/agents/` as the canonical compiled wiki to avoid duplicated pages.
- Built the local symbol index at Git HEAD `87f977add683f2023079e962c1c8390dbfae29cd`:
  199 files, 1,347 symbols, and 18,428 references.

## [2026-07-10] organize | Move entry point under docs

- Moved the entry point, catalog, and maintenance log to
  `docs/knowledge_base/` so durable documentation shares one repository-owned
  parent directory.

## [2026-07-10] ingest | Role-based Claude and Codex orchestration

- Updated human and agent pages for account-visible frontier model discovery
  and independent planning, review, escalation, and evaluation-baseline roles.
- Added the Codex app-server and frontier-selection sources to the canonical
  subsystem routing pages.

## [2026-07-10] ingest | ToolSpec registry and protected review identity

- Added the wiki ToolSpec registry and its worker, MCP, frontier, and harness
  fingerprint projections to the canonical wiki/harness documentation.
- Documented the evaluator-owned, content-fingerprinted review template and
  the exclusion of dynamic task and worker content from its identity.

## [2026-07-10] ingest | Project harness health and system benchmarks

- Reframed golden-task comparisons as occasional system benchmarks that do
  not certify or mutate individual project harnesses.
- Documented deterministic harness/wiki verification and metadata-only
  production evidence as the project Health workflow.

## [2026-07-10] ingest | Product vision and universal runtime strategy

- Added the evergreen product north star for combining official Claude
  Code/Codex lead runtimes with lower-cost worker models.
- Defined the universal runtime boundary and linked the existing pinned
  Claude Code, Codex, and OpenCode source audit as implementation evidence.

## [2026-07-10] ingest | Task-conditioned repository navigation index

- Pinned symbol indexing to immutable blobs from the exact Git `HEAD` and
  invalidated stale rows when supported files cannot be indexed.
- Added local FTS5 task matching, personalized repository-map ranking,
  relevance reasons, and symbol line anchors to guide narrow file reads.

## [2026-07-12] ingest | Transactional universal runtime

- Documented SQLite-authoritative sessions, encrypted traces and artifacts,
  approvals, recovery, native containment, context management, and approved
  extensions.
- Added bounded child sessions and offline evidence-compiled routing with
  shadow, human promotion, deterministic fallback, and exact rollback.

## [2026-07-12] refresh | Robust run and artifact boundaries

- Reconciled snapshot-pinned candidate verification, approval-bound Apply,
  native containment, immutable harness generations, and matched evaluation
  behavior across the canonical human and agent pages.
- Pinned content limits to 16 MiB per artifact and 256 MiB per session, with
  opt-in trace retention defaulting to seven days or 2 GiB.

## [2026-07-12] correct | Universal runtime limits and shutdown drain

- Corrected the runtime contract to 64 MiB per artifact/tool-output stream,
  1 GiB per session, and seven-day-or-1-GiB trace retention.
- Documented whole-handler worker admission and draining before SQLite closes.

## [2026-07-12] ingest | Evidence-driven harness product requirements

- Replaced the original aggressive cheap-worker thesis with qualification of
  complete project-specific model-harness routes and fully burdened
  accepted-result economics.
- Added the active PRD, source audit, cache-aware routing requirements,
  controlled harness/memory promotion, and the “own the improvement loop”
  product position.

## [2026-07-12] correct | Robust-harness limits and gateway wiring

- Superseded the preceding stale quota correction after reconciling it with
  the robust-harness contract and current source: 16 MiB per artifact,
  256 MiB per session, and seven-day-or-2-GiB opt-in trace retention.
- Documented bounded provider admission, registry-backed dynamic tool claims,
  and snapshot-identified context compilation with artifact references.

## [2026-07-12] correct | Atomic wiki and harness snapshot identity

- Documented single-read harness generation identity and read-only worker wiki
  snapshots that remain stable while the live committed-source index rebuilds.
- Added fail-closed wiki identity pins and bounded public-worker admission to
  the affected workflow, engine, and wiki/harness source maps.
