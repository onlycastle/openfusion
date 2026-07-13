# Documentation maintenance

The documentation system separates explanation for people from retrieval
context for coding agents while keeping both tied to the same source code.

## Information architecture

### `docs/knowledge_base/`

The stable entry point for the repository's LLM knowledge base. It contains a
human-readable catalog and append-only maintenance log, while the canonical
compiled pages remain under `docs/agents/`. This separation follows the
Karpathy LLM Wiki pattern without creating a second, drifting copy of the same
knowledge.

### `docs/human/`

Evergreen, narrative guidance. A human page should explain goals, concepts,
decisions, and operational steps without requiring readers to inspect code.

### `docs/agents/`

Compact, source-backed retrieval pages. Agent pages should answer one topic,
avoid narrative history, and include frontmatter with:

- `title`
- `summary`
- `status`
- `verified` date
- `source_paths` containing current code or configuration anchors

`map.json` routes search terms to these pages. `pnpm docs:query -- <terms>` is
the local equivalent of a small wiki query operation.

### Historical records

`docs/research/` and `docs/superpowers/` remain dated. Do not rewrite old
evidence or plans to make them appear current. Add a new dated document or an
explicit supersession note instead.

## Update workflow

When behavior changes:

1. Update the code and tests.
2. Update the relevant human guide if the change affects users, contributors,
   architecture, or operations.
3. Update the smallest relevant agent page and its `verified` date.
4. Update `docs/agents/map.json` when topics, keywords, paths, or page ownership
   change.
5. Append a concise `docs/knowledge_base/log.md` entry when the knowledge base
   itself changes.
6. Run `pnpm docs:check`.

## Avoiding drift

- Prefer links to source paths over copying implementation details.
- State defaults only when they matter; name the source that owns them.
- Keep agent pages small enough to load independently.
- Use the current code as source of truth. Specs and plans explain intent, not
  necessarily current behavior.
- Do not place secrets, user prompts, diffs, or model outputs in documentation.

## Validation

`scripts/check-docs.mjs` checks the curated structure, agent frontmatter,
machine-readable map, source paths, and local Markdown links. It intentionally
does not rewrite or enforce metadata on the historical document collections.
