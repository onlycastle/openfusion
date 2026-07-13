# OpenFusion agent guide

Use this file as a table of contents, not as a substitute for reading the
relevant source.

## Start here

1. Read [`docs/agents/README.md`](docs/agents/README.md).
2. Use [`docs/agents/map.json`](docs/agents/map.json) or run
   `pnpm docs:query -- <terms>` to find the smallest relevant topic page.
3. Verify important claims against the `source_paths` listed in that page.
4. If code behavior changes, update the affected human guide and agent page
   in the same change. Run `pnpm docs:check` before finishing.

## Repository commands

- `./dev.sh check`: build, typecheck, documentation checks, TypeScript tests,
  and Rust host tests.
- `./dev.sh sidecar`: build, stage, and ping the engine sidecar.
- `./dev.sh app`: launch the Tauri desktop app.
- Package-level loops are documented in
  [`docs/agents/testing.md`](docs/agents/testing.md).

## LLM knowledge base

- [`docs/knowledge_base/README.md`](docs/knowledge_base/README.md) defines the
  query, ingest, lint, refresh, and promotion workflows.
- [`docs/knowledge_base/index.md`](docs/knowledge_base/index.md) is the human-readable
  catalog; `docs/agents/map.json` is the machine-readable router.
- [`docs/knowledge_base/log.md`](docs/knowledge_base/log.md) is append-only. Never put
  prompts, diffs, model output, RPC payloads, credentials, or secrets in it.
- `docs/agents/` remains the canonical compiled wiki. Do not create duplicate
  knowledge pages under `docs/knowledge_base/`.

## Non-negotiable invariants

- The engine sidecar writes JSON-RPC only to stdout; diagnostics go to stderr.
- Do not log prompts, diffs, model output, RPC payloads, or secret values.
- Workers edit isolated Git worktrees. The selected repository changes only
  after explicit user approval through `engine.orchestrate.apply`.
- OpenFusion never commits, merges, or pushes user code.
- Generated Project Cards are untrusted until a human approves them.
- Preserve unrelated changes in a dirty worktree.

## Documentation ownership

- `docs/human/`: evergreen explanation and operational guidance for people.
- `docs/agents/`: concise retrieval pages for coding agents; every page names
  its source paths and verification date.
- `docs/research/`: dated evidence and technical investigations.
- `docs/superpowers/specs/`: historical product/design decisions.
- `docs/superpowers/plans/`: historical implementation plans, not current
  behavior unless confirmed by source.
- `docs/knowledge_base/`: discovery, catalog, and maintenance log for the
  canonical wiki; not a second copy of `docs/agents/`.
