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
Harness generation (M4) drives a frontier session over the indexed repo to
produce a committable `.openfusion/` harness — an LLM wiki, a specialist
agent roster, and a routing policy — gated by structural validation at
generation time; the eval loop that flips `verification.evals` from
`"pending"` to `"pass"` lands in M6. Two exporters turn that harness into
interop artifacts other tools can read: an `AGENTS.md` project brief and
per-agent Claude Code subagents under `.claude/agents/`.

## Generating a harness

    engine.harness.generate  { "projectDir": "/path/to/repo" }
    engine.harness.status    { "projectDir": "/path/to/repo" }
    engine.harness.export    { "projectDir": "/path/to/repo", "format": "agents-md" }
    engine.harness.export    { "projectDir": "/path/to/repo", "format": "claude-subagents" }

`generate` requires a git repository and a registered frontier adapter; it
writes `.openfusion/` (wiki pages, agent defs, `routing.yaml`, `manifest.json`)
and is safe to re-run — regeneration prunes only the artifacts the prior
generation itself wrote, never hand-edited additions. `status` is a cheap,
poll-friendly read of `manifest.json` alone. `export` requires a harness that
is both present and structurally valid (else `SERVER_ERROR`); `agents-md`
writes `<projectDir>/AGENTS.md`, `claude-subagents` writes one file per agent
under `<projectDir>/.claude/agents/`. **Unverified until the eval gate
passes**: every exported harness is marked `UNVERIFIED` in `AGENTS.md` (and
the eval status is visible via `engine.harness.status`) until
`manifest.verification.evals` reads `"pass"` — treat agent prompts and
routing as unproven against your project until then.

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
