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
loopback HTTP (M1b complete). Frontier sessions now exist (M3) over a
concurrency-bounded RPC protocol; the engine is auth-agnostic. OpenFusion
never handles frontier credentials — the embedded official CLI uses whatever
login you have configured; review your provider's terms for subscription use.

## Engine Protocol

The engine exposes its capabilities over stdio via ndjson-encoded JSON-RPC 2.0.
Responses are written in completion order (correlate by request `id`). The
server issues notifications to the client (`frontier.event {sessionId, seq, event}`)
for async events. **Concurrency ownership:** the client is responsible for
bounding in-flight expensive calls (`engine.models.complete`, `engine.frontier.prompt`);
the pipeline itself intentionally carries no cap.

## Development

Requires Node >= 22 and pnpm (via corepack).

    corepack enable
    pnpm install
    pnpm build
    pnpm test

## License

Apache-2.0
