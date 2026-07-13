# OpenFusion LLM knowledge base

This directory is the stable entry point for OpenFusion's repository knowledge
base. It follows [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
without duplicating the source-backed wiki that already lives in
[`docs/agents/`](../agents/README.md).

## Layers

- **Raw sources:** Git-tracked code, configuration, tests, `docs/human/`, and
  dated material under `docs/research/` and `docs/superpowers/`. These remain
  the source of truth; never change them merely to make a wiki claim pass.
- **Compiled wiki:** concise pages under `docs/agents/`, routed through
  `docs/agents/map.json`. Every page names the source paths that support it.
- **Schema:** the repository [`AGENTS.md`](../../AGENTS.md) and
  [`docs/human/documentation.md`](../human/documentation.md) define how agents
  retrieve, verify, update, and validate knowledge.
- **Derived symbol index:** `.openfusion/cache/wiki.db` is a local, rebuildable
  tree-sitter index served through `wiki_map` and `wiki_query`. It is not the
  durable Markdown knowledge base and should not be committed.

[`index.md`](index.md) is the content catalog. [`log.md`](log.md) is the
append-only maintenance record.

## Operations

### Query

1. Run `pnpm docs:query -- <terms>` or inspect `docs/agents/map.json`.
2. Read the smallest matching page.
3. Verify important claims against that page's `source_paths`.
4. Use `engine.wiki.map` or `engine.wiki.query` when symbol-level navigation is
   useful.

### Ingest

1. Treat the changed code, configuration, or human guide as the raw source.
2. Update the smallest affected `docs/agents/` page; merge into an existing
   page instead of creating a near-duplicate.
3. Keep `source_paths` precise and update the page's `verified` date.
4. Update `docs/agents/map.json` and this directory's `index.md` only when
   routing or page ownership changes.
5. Append one concise entry to `log.md` for knowledge-base maintenance.

### Lint

Run `pnpm docs:check`. Also check for unsupported claims, stale verification
dates, duplicate topics, missing cross-links, and pages that should be merged.

### Refresh the symbol index

Run `engine.wiki.build` for this repository, or use the desktop setup flow.
The index reads supported-language blobs from the exact Git `HEAD`; dirty
tracked edits and untracked working-tree files are not part of that snapshot.
Use `engine.wiki.map` with a task `query` to rank likely files, or omit the
query for global repository orientation.

### Promote

When dated research becomes current behavior, update the implementation first,
then the relevant human guide and agent page. Keep the original research or
historical plan intact.
