# OpenFusion documentation

OpenFusion documentation has three maintained entry points and two historical
source collections.

| Area | Audience | Purpose |
|---|---|---|
| [`knowledge_base/`](knowledge_base/README.md) | Contributors and coding agents | LLM knowledge-base schema, catalog, operations, and maintenance log. |
| [`human/`](human/README.md) | Contributors and operators | Evergreen guides explaining the product, architecture, workflows, and development. |
| [`agents/`](agents/README.md) | Coding agents and automation | Compact, source-backed topic pages plus a machine-readable retrieval map. |
| [`research/`](research/) | Maintainers | Dated investigations, external evidence, and API verification. |
| [`superpowers/`](superpowers/) | Maintainers | Historical specs and implementation plans. These record decisions but may not describe current code. |

## Where to begin

- Canonical product direction and requirements:
  [Product vision and requirements](human/product-vision.md)
- Active dated PRD:
  [Evidence-driven harness PRD](superpowers/specs/2026-07-12-evidence-driven-harness-prd.md)
- New user or contributor: [Human documentation](human/README.md)
- Coding agent: [Agent wiki](agents/README.md)
- Repository knowledge workflow: [LLM knowledge base](knowledge_base/README.md)
- Documentation contributor: [Documentation maintenance](human/documentation.md)
- Looking for why a decision was made: search `research/` and
  `superpowers/specs/`, then verify the result against current source.

## Maintenance rule

Code is the source of truth for runtime behavior. Human and agent docs are
evergreen summaries of that behavior. Research, specs, and plans are dated
records and are not silently rewritten when implementation changes.

Run these commands after documentation changes:

```sh
pnpm docs:check
pnpm docs:query -- orchestration review
```
