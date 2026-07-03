# OpenFusion (working name)

Open-source macOS app that analyzes your repo with a frontier model and
generates a dedicated multi-model harness: an LLM wiki, specialist agents,
and a cost-optimizing routing policy — frontier orchestration, open-model
workers.

- Design spec: `docs/superpowers/specs/2026-07-03-harness-fusion-app-design.md`
- Roadmap: `docs/superpowers/plans/2026-07-03-roadmap.md`
- Landscape research: `docs/research/2026-07-03-oss-landscape.md`

Status: the engine indexes TypeScript/JavaScript/Python/Go/Rust/Java git
repositories into a per-project symbol store, serves a token-budgeted
PageRank repo map, and exposes `wiki_query`/`wiki_map` to MCP clients over
loopback HTTP (M1b complete).

## Development

Requires Node >= 22 and pnpm (via corepack).

    corepack enable
    pnpm install
    pnpm build
    pnpm test

## License

Apache-2.0
