# M1 API Verification Cheat-Sheet (verified 2026-07-03)

Pre-plan verification for the wiki milestone. Versions pulled live from npm
+ primary docs. Full snippets in the research agent output; essentials here.

## Tree-sitter: web-tree-sitter (wasm), NOT node-tree-sitter

- `web-tree-sitter@0.26.10` (active) + ~~`tree-sitter-wasms@0.1.13`~~
  **CORRECTION (M1a Task 4, empirical):** tree-sitter-wasms' prebuilt wasms
  use an old emscripten dylink ABI and DO NOT load in web-tree-sitter 0.26
  (Query construction memory-faults even after section renaming). Use
  **`@vscode/tree-sitter-wasm@^0.3`** (Microsoft, actively maintained,
  `wasm/tree-sitter-<lang>.wasm` layout) — verified working with 0.26.
  M1b: check its grammar coverage for python/go/rust/java before planning;
  gaps need per-language wasm builds or another verified source.
- Native `tree-sitter` npm pkg is >1yr stale and has per-OS/arch/ABI rebuild
  pain — wrong choice for a Tauri-shipped sidecar.
- Grammar wasm packages ship NO `.scm` queries. Official per-language source
  repos bundle `queries/tags.scm` (aider-style `@definition.*`/`@name`/
  `@reference.*`) — vendor those files (MIT) into the repo.
- API: `await Parser.init()`; `Language.load(wasmPath)`; `new Query(lang,
  scm)` (not `lang.query()`); WASM heap requires explicit `.delete()` on
  Tree/Query/Parser; reuse one Parser; for thousands of files consider
  worker recycling (emscripten heap growth is one-directional).

## SQLite: better-sqlite3, NOT node:sqlite (yet)

- `node:sqlite` unflagged since 22.13.0 but still Stability 1.1 on the 22.x
  line; only reached RC in 25.7/26.x. Node 22 is Maintenance LTS (EOL
  2027-04-30) and won't inherit the promotion.
- Use `better-sqlite3@12.x` + `@types/better-sqlite3`. CJS default-import
  works under NodeNext. Prebuilt binaries via prebuild-install; pnpm ≥10
  needs `pnpm.onlyBuiltDependencies: ["better-sqlite3"]`.
- Migration to `node:sqlite` (DatabaseSync, near-identical API) once stable
  on a target LTS — revisit at M8.

## MCP TypeScript SDK: v1 now, v2 imminent

- Build against `@modelcontextprotocol/sdk@1.29.0` (production-supported).
- **v2 (`@modelcontextprotocol/server` / `/client`) GA expected 2026-07-28**
  alongside the new MCP spec; v1 gets fixes ≥6 months after. → M1b builds on
  v1; roadmap carries a v2 migration checkpoint.
- Transports: Streamable HTTP is current; **SSE deprecated**; stdio unusable
  for us (engine stdout is our own JSON-RPC). Use Streamable HTTP bound to
  `127.0.0.1:<port>`, stateless mode (`sessionIdGenerator: undefined`).
- `registerTool` inputSchema takes a raw zod SHAPE (`{ q: z.string() }`),
  not `z.object(...)`. express/cors ship as SDK deps.
- Claude Code wiring: `claude mcp add --transport http wiki
  http://127.0.0.1:<port>/mcp`.
