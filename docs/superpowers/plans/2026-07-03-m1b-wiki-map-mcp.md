# M1b: Wiki Map + MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The wiki gains build-concurrency safety, four more languages (Python, Go, Rust, Java), a token-budgeted PageRank repo map (`engine.wiki.map`), and an in-engine MCP server (Streamable HTTP on loopback) exposing `wiki_query`/`wiki_map` tools bound to registered project roots — so a Claude Code session can consume the wiki without ever re-grepping the repo.

**Architecture:** Task 1 restructures `buildIndex` into parse-then-atomically-write (single transaction via a new `WikiStore.applyBuild`) with per-project build coalescing — the TOCTOU fix that MUST precede MCP concurrency. Task 2 extends `LANGUAGE_SPECS` (wasm smoke probe first — M1a Task 4 lesson). Task 3 adds `wiki/rank.ts` (ref-name ∩ def-name filtered PageRank over file→file edges) and `engine.wiki.map`. Task 4 adds `wiki/mcp.ts` (MCP SDK v1.29, node:http loopback, one server per registered root — tools take NO path input). Task 5 is the carried-cleanup batch.

**Tech Stack:** MCP decision (per roadmap checkpoint): build on `@modelcontextprotocol/sdk@^1.29` — v2 GA is ~2026-07-28 but v1 is the declared production line with ≥6 months of fixes; migration is an M8-adjacent follow-up. Grammars from the already-installed `@vscode/tree-sitter-wasm@^0.3` (python/go/rust/java presence re-verified by probe in Task 2). No express — node:http + the SDK transport.

## Global Constraints

- Everything from M1a: Node ≥22, strict TS, NodeNext `.js` imports, tsconfig.test.json typecheck coverage, stdout = JSON-RPC only, fixture repos in tmp dirs only, conventional commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, nothing under `.superpowers/`/`.claude/`, no `.openfusion/` in the checkout.
- **MCP trust boundary:** the HTTP server binds `127.0.0.1` ONLY; tools never accept a path/projectDir input — each server instance is bound at registration time to one validated project root.
- **Schema policy:** any wiki.db schema change bumps `SCHEMA_VERSION`; on mismatch the store deletes and recreates the DB file (derived cache — never migrate).
- pnpm build-script allowlist lives in `pnpm-workspace.yaml` (`allowBuilds`), not root package.json (pnpm 11).
- Every new language addition starts with a wasm load smoke probe before any other work.

---

### Task 1: Build concurrency + store hardening

**Files:**
- Modify: `packages/engine/src/wiki/store.ts` (busy_timeout, `applyBuild`, schema-version mismatch handling)
- Modify: `packages/engine/src/wiki/indexer.ts` (parse-then-write restructure)
- Modify: `packages/engine/src/wiki/methods.ts` (realpath store keys, build coalescing, fault-tolerant close)
- Test: extend `packages/engine/test/wiki-store.test.ts`, `wiki-indexer.test.ts`, `wiki-methods.test.ts`

**Interfaces:**
- Consumes: M1a's `WikiStore`, `buildIndex`, `WikiService`.
- Produces:
  - `WikiStore.applyBuild(updates: FileUpdate[], removals: string[], meta: { headSha: string }): void` where `interface FileUpdate { path: string; hash: string; lang: string; symbols: SymbolEntry[]; refs: SymbolEntry[] }` — ONE transaction covering all upserts, removals, and meta stamping.
  - `buildIndex` unchanged signature; internally: phase 1 reads+parses with zero DB writes, phase 2 calls `applyBuild` once. `upsertFile` stays for tests but buildIndex no longer calls it.
  - `WikiService`: store cache keyed by `realpathSync(path.resolve(projectDir))`; concurrent `engine.wiki.build` calls for the same key coalesce onto one in-flight promise; `close()` continues past a throwing store.
  - `openWikiStore`: `db.pragma("busy_timeout = 5000")`; if `user_version` ≠ `SCHEMA_VERSION` and DB is non-empty, close+delete+recreate.

- [ ] **Step 1: Write failing tests**

Append to `packages/engine/test/wiki-store.test.ts`:

```ts
  it("applyBuild applies updates, removals, and meta in one shot", () => {
    const store = makeStore();
    store.upsertFile("old.ts", "h0", "typescript", [
      { name: "gone", kind: "function", row: 0, col: 0 },
    ], []);
    store.applyBuild(
      [
        {
          path: "new.ts",
          hash: "h1",
          lang: "typescript",
          symbols: [{ name: "fresh", kind: "function", row: 1, col: 0 }],
          refs: [],
        },
      ],
      ["old.ts"],
      { headSha: "sha-xyz" },
    );
    expect(store.listFiles()).toEqual(["new.ts"]);
    expect(store.symbolsByName("gone")).toEqual([]);
    expect(store.symbolsByName("fresh")).toHaveLength(1);
    expect(store.getMeta("head_sha")).toBe("sha-xyz");
  });

  it("recreates the database when schema version mismatches", () => {
    const store = makeStore();
    store.setMeta("marker", "will-vanish");
    store.close();
    const dbPath = path.join(dir, ".openfusion/cache/wiki.db");
    const raw = new Database(dbPath);
    raw.pragma("user_version = 99");
    raw.close();
    const reopened = openWikiStore(dir);
    expect(reopened.getMeta("marker")).toBeNull();
    reopened.close();
  });
```

Append to `packages/engine/test/wiki-methods.test.ts`:

```ts
  it("coalesces concurrent builds for the same project", async () => {
    makeRepo();
    const [a, b] = await Promise.all([
      call("engine.wiki.build", { projectDir: dir }),
      call("engine.wiki.build", { projectDir: dir }),
    ]);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(a.result.headSha).toBe(b.result.headSha);
  }, 30_000);
```

- [ ] **Step 2: RED run** — `pnpm --filter @openfusion/engine test`: applyBuild/schema tests fail (method missing / marker survives); coalescing test passes trivially today (document that — it pins behavior for the refactor).

- [ ] **Step 3: Implement**

`store.ts` — add near SCHEMA: nothing new. Inside class:

```ts
  applyBuild(
    updates: FileUpdate[],
    removals: string[],
    meta: { headSha: string },
  ): void {
    this.#db.transaction(() => {
      for (const u of updates) {
        this.#applyFileTx(u.path, u.hash, u.lang, u.symbols, u.refs);
      }
      for (const r of removals) this.#removeFileTx(r);
      this.#setMetaTx("head_sha", meta.headSha);
      this.#setMetaTx("indexed_at", String(Date.now()));
    })();
  }
```

Refactor: extract the bodies of `upsertFile`/`removeFile`/`setMeta` into private `#applyFileTx`/`#removeFileTx`/`#setMetaTx` (statement logic unchanged) and have the public methods wrap them in their own transactions exactly as before — public behavior identical, `applyBuild` reuses the same statements inside one outer transaction. Add `export interface FileUpdate {...}` as specified. In `openWikiStore`: after opening, `db.pragma("busy_timeout = 5000");` then check `db.pragma("user_version", { simple: true })` — if it differs from `SCHEMA_VERSION` AND the files table exists (`sqlite_master` probe), `db.close()`, `rmSync(dbPath)`, reopen fresh, re-exec SCHEMA, stamp version.

`indexer.ts` — restructure `buildIndex`: phase 1 builds `const updates: FileUpdate[] = []` (read/hash/skip-check/parse exactly as today, but push instead of `store.upsertFile`); after the loop compute `removals = store.listFiles().filter(f => !seen.has(f))`; phase 2 `store.applyBuild(updates, removals, { headSha });`. Stats fields keep identical meanings.

`methods.ts` — `WikiService`: key via `realpathSync(path.resolve(projectDir))` (fall back to `path.resolve` if realpath throws — dir may not exist; the git guard will reject it anyway); add `#building = new Map<string, Promise<IndexStats>>()`; build handler wraps: existing in-flight promise for the key is awaited and returned; otherwise create, store, and `finally` delete. `close()`: wrap each `store.close()` in try/catch (log via engine when available — pass nothing; swallow with a comment), always dispose parser.

- [ ] **Step 4: GREEN** — `pnpm build && pnpm typecheck && pnpm test` all green (63 tests: 60 + 3 new). Report exact totals.

- [ ] **Step 5: Commit** — `feat(engine): atomic build writes, schema-mismatch rebuild, build coalescing, realpath store keys`

---

### Task 2: Languages — Python, Go, Rust, Java

**Files:**
- Modify: `packages/engine/src/wiki/languages.ts` (4 new specs)
- Create: `packages/engine/queries/{python,go,rust,java}/tags.scm` (vendored) + update `packages/engine/queries/README.md`
- Test: `packages/engine/test/wiki-parser-langs.test.ts`

**Interfaces:**
- Consumes: `LANGUAGE_SPECS`/`wasmDir()` extension point (M1a).
- Produces: `.py .go .rs .java` in `supportedExtensions()`; parseFile yields defs/refs for all four.

- [ ] **Step 1: Wasm load smoke probe FIRST (M1a lesson — hard gate)**

Run (from repo root):

```bash
node -e "
const { createRequire } = require('module'); const path = require('path'); const fs = require('fs');
const dir = path.join(path.dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
for (const l of ['python','go','rust','java']) {
  const f = path.join(dir, 'tree-sitter-' + l + '.wasm');
  console.log(l, fs.existsSync(f) ? 'OK' : 'MISSING', f);
}"
```

Then a RUNTIME probe (write a throwaway script in the scratch area or run inline): `Parser.init()`, `Language.load()` each of the four wasms, `new Query(lang, "(comment) @c")` (or a trivially valid node type per grammar — if `(comment)` errors for a grammar, use any capture-bearing query that constructs). Every language must load and construct a Query. **If any is MISSING or fails to load: STOP, report NEEDS_CONTEXT with the probe output.** Do not improvise alternate wasm sources.

- [ ] **Step 2: Vendor tags.scm per language**

```bash
mkdir -p packages/engine/queries/{python,go,rust,java}
curl -fsSL -o packages/engine/queries/python/tags.scm https://raw.githubusercontent.com/tree-sitter/tree-sitter-python/master/queries/tags.scm
curl -fsSL -o packages/engine/queries/go/tags.scm https://raw.githubusercontent.com/tree-sitter/tree-sitter-go/master/queries/tags.scm
curl -fsSL -o packages/engine/queries/rust/tags.scm https://raw.githubusercontent.com/tree-sitter/tree-sitter-rust/master/queries/tags.scm
curl -fsSL -o packages/engine/queries/java/tags.scm https://raw.githubusercontent.com/tree-sitter/tree-sitter-java/master/queries/tags.scm
grep -c "@definition" packages/engine/queries/{python,go,rust,java}/tags.scm
```

All four must contain `@definition` captures. Update `queries/README.md` provenance list (repo + ref for each). Known-risk fallbacks from M1a apply (doc-directive stripping; note anything stripped).

- [ ] **Step 3: Failing test** — `packages/engine/test/wiki-parser-langs.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WikiParser } from "../src/wiki/parser.js";

let parser: WikiParser;
beforeAll(async () => {
  parser = await WikiParser.create();
}, 60_000);
afterAll(() => parser.dispose());

const CASES: Array<{ file: string; source: string; def: string }> = [
  { file: "a.py", source: "def snake(x):\n    return x\n", def: "snake" },
  { file: "b.go", source: "package p\n\nfunc Gopher() int { return 1 }\n", def: "Gopher" },
  { file: "c.rs", source: "pub fn ferris() -> i32 { 1 }\n", def: "ferris" },
  {
    file: "D.java",
    source: "class D {\n  int brew() { return 1; }\n}\n",
    def: "brew",
  },
];

describe("multi-language parsing", () => {
  for (const c of CASES) {
    it(`extracts definitions from ${c.file}`, () => {
      const result = parser.parseFile(c.file, c.source);
      expect(result).not.toBeNull();
      expect(result!.symbols.map((s) => s.name)).toContain(c.def);
    });
  }

  it("reports the new extensions as supported", () => {
    const exts = parser.supportedExtensions();
    for (const e of [".py", ".go", ".rs", ".java"]) {
      expect(exts.has(e)).toBe(true);
    }
  });
});
```

- [ ] **Step 4: RED run**, then implement — append to `LANGUAGE_SPECS`:

```ts
  { id: "python", wasmFile: "tree-sitter-python.wasm", queryDir: "python", extensions: [".py"] },
  { id: "go", wasmFile: "tree-sitter-go.wasm", queryDir: "go", extensions: [".go"] },
  { id: "rust", wasmFile: "tree-sitter-rust.wasm", queryDir: "rust", extensions: [".rs"] },
  { id: "java", wasmFile: "tree-sitter-java.wasm", queryDir: "java", extensions: [".java"] },
```

- [ ] **Step 5: GREEN** — full suite green (68 tests: 63 + 5). Exact totals.
- [ ] **Step 6: Commit** — `feat(engine): python, go, rust, java language support with vendored tags queries`

---

### Task 3: Repo map — PageRank + token-budgeted render

**Files:**
- Create: `packages/engine/src/wiki/rank.ts`
- Modify: `packages/engine/src/wiki/store.ts` (bulk readers), `packages/engine/src/wiki/methods.ts` (engine.wiki.map)
- Test: `packages/engine/test/wiki-rank.test.ts`, extend `wiki-methods.test.ts`

**Interfaces:**
- Consumes: `WikiStore` (Task 1 state), `registerMethod`.
- Produces:
  - Store additions: `allSymbols(): SymbolHit[]`, `allRefs(): SymbolHit[]`.
  - `rankFiles(symbols: SymbolHit[], refs: SymbolHit[], options?: { damping?: number; iterations?: number }): RankedFile[]` where `interface RankedFile { file: string; score: number; definedSymbols: string[] }` — sorted descending; **refs whose name is not defined anywhere are excluded** (property-name noise: M1a measured 912 refs vs 61 symbols on self-index).
  - `renderRepoMap(ranked: RankedFile[], budgetTokens: number): string` — markdown, ~4 chars/token estimate, truncates whole file-blocks to stay under budget.
  - RPC `engine.wiki.map { projectDir, budgetTokens? (default 1024, int, 64–32768) }` → `{ map: string, files: number, truncated: boolean }`; requires a built index (`SERVER_ERROR` "wiki not built" if `head_sha` meta absent); non-git → SERVER_ERROR (same guard as siblings).

- [ ] **Step 1: Failing tests** — `packages/engine/test/wiki-rank.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rankFiles, renderRepoMap } from "../src/wiki/rank.js";
import type { SymbolHit } from "../src/wiki/store.js";

function sym(file: string, name: string): SymbolHit {
  return { file, name, kind: "function", row: 0, col: 0 };
}

describe("rankFiles", () => {
  it("ranks the file everyone references highest", () => {
    const symbols = [sym("core.ts", "util"), sym("a.ts", "a"), sym("b.ts", "b")];
    const refs = [sym("a.ts", "util"), sym("b.ts", "util")];
    const ranked = rankFiles(symbols, refs);
    expect(ranked[0]?.file).toBe("core.ts");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("ignores refs to names defined nowhere (noise filter)", () => {
    const symbols = [sym("a.ts", "a"), sym("b.ts", "b")];
    const refs = [sym("a.ts", "toString"), sym("a.ts", "b")];
    const ranked = rankFiles(symbols, refs);
    expect(ranked[0]?.file).toBe("b.ts");
  });

  it("lists defined symbols per ranked file", () => {
    const symbols = [sym("a.ts", "one"), sym("a.ts", "two")];
    const ranked = rankFiles(symbols, []);
    expect(ranked[0]?.definedSymbols).toEqual(["one", "two"]);
  });
});

describe("renderRepoMap", () => {
  it("stays within the token budget by dropping whole blocks", () => {
    const ranked = Array.from({ length: 50 }, (_, i) => ({
      file: `src/file${i}.ts`,
      score: 1 - i / 100,
      definedSymbols: ["alpha", "beta", "gamma"],
    }));
    const map = renderRepoMap(ranked, 100);
    expect(map.length / 4).toBeLessThanOrEqual(100);
    expect(map).toContain("src/file0.ts");
    expect(map).not.toContain("src/file49.ts");
  });
});
```

Extend `wiki-methods.test.ts`:

```ts
  it("map returns a budgeted markdown map after build", async () => {
    makeRepo();
    await call("engine.wiki.build", { projectDir: dir });
    const res = await call("engine.wiki.map", { projectDir: dir, budgetTokens: 256 });
    expect(res.error).toBeUndefined();
    expect(res.result.map).toContain("x.ts");
    expect(res.result.truncated).toBe(false);
  }, 30_000);

  it("map on an unbuilt project returns SERVER_ERROR", async () => {
    makeRepo();
    const res = await call("engine.wiki.map", { projectDir: dir });
    expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
  }, 30_000);
```

- [ ] **Step 2: RED run.**
- [ ] **Step 3: Implement**

`store.ts`: `allSymbols()`/`allRefs()` — `SELECT file, name, kind, row, col FROM symbols ORDER BY file, row` (resp. refs).

`rank.ts`:

```ts
import type { SymbolHit } from "./store.js";

export interface RankedFile {
  file: string;
  score: number;
  definedSymbols: string[];
}

export function rankFiles(
  symbols: SymbolHit[],
  refs: SymbolHit[],
  options: { damping?: number; iterations?: number } = {},
): RankedFile[] {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 30;

  const definers = new Map<string, string[]>();
  const files = new Set<string>();
  const symbolsByFile = new Map<string, string[]>();
  for (const s of symbols) {
    files.add(s.file);
    (definers.get(s.name) ?? definers.set(s.name, []).get(s.name)!).push(s.file);
    (symbolsByFile.get(s.file) ?? symbolsByFile.set(s.file, []).get(s.file)!).push(s.name);
  }

  // edges: referencing file -> defining file, noise-filtered by defined names
  const outEdges = new Map<string, Map<string, number>>();
  for (const r of refs) {
    const targets = definers.get(r.name);
    if (targets === undefined) continue; // name defined nowhere: noise
    files.add(r.file);
    const out = outEdges.get(r.file) ?? new Map<string, number>();
    outEdges.set(r.file, out);
    const w = 1 / targets.length;
    for (const t of targets) {
      if (t === r.file) continue;
      out.set(t, (out.get(t) ?? 0) + w);
    }
  }

  const n = files.size;
  if (n === 0) return [];
  let rank = new Map<string, number>();
  for (const f of files) rank.set(f, 1 / n);
  for (let i = 0; i < iterations; i += 1) {
    const next = new Map<string, number>();
    for (const f of files) next.set(f, (1 - damping) / n);
    for (const [src, out] of outEdges) {
      const total = [...out.values()].reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      const srcRank = rank.get(src) ?? 0;
      for (const [dst, w] of out) {
        next.set(dst, (next.get(dst) ?? 0) + damping * srcRank * (w / total));
      }
    }
    rank = next;
  }

  return [...files]
    .map((file) => ({
      file,
      score: rank.get(file) ?? 0,
      definedSymbols: [...new Set(symbolsByFile.get(file) ?? [])],
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

export function renderRepoMap(ranked: RankedFile[], budgetTokens: number): string {
  const budgetChars = budgetTokens * 4;
  const lines: string[] = [];
  let used = 0;
  for (const r of ranked) {
    const block = `${r.file}\n  ${r.definedSymbols.slice(0, 8).join(", ")}\n`;
    if (used + block.length > budgetChars) break;
    lines.push(block);
    used += block.length;
  }
  return lines.join("");
}
```

`methods.ts`: `MapParamsSchema = ProjectParamsSchema.extend({ budgetTokens: z.number().int().min(64).max(32768).optional() })`; handler:

```ts
    ({ projectDir, budgetTokens }) => {
      requireHeadSha(projectDir);
      const store = engine.wiki.getStore(projectDir);
      if (store.getMeta("head_sha") === null) {
        throw new RpcMethodError(
          RpcErrorCodes.SERVER_ERROR,
          "wiki not built — run engine.wiki.build first",
        );
      }
      const ranked = rankFiles(store.allSymbols(), store.allRefs());
      const map = renderRepoMap(ranked, budgetTokens ?? 1024);
      // each rendered block is exactly two lines (file + symbols)
      const rendered = map.length === 0 ? 0 : map.trimEnd().split("\n").length / 2;
      return { map, files: ranked.length, truncated: rendered < ranked.length };
    }
```

- [ ] **Step 4: GREEN** — full suite green (74 tests: 68 + 6). Exact totals.
- [ ] **Step 5: Commit** — `feat(engine): PageRank repo map with token-budgeted rendering and engine.wiki.map`

---

### Task 4: MCP server — wiki over Streamable HTTP loopback

**Files:**
- Modify: `packages/engine/package.json` (add `@modelcontextprotocol/sdk`)
- Create: `packages/engine/src/wiki/mcp.ts`
- Modify: `packages/engine/src/wiki/methods.ts` (engine.mcp.* RPC), `packages/engine/src/engine.ts` (close hook + re-exports)
- Test: `packages/engine/test/wiki-mcp.test.ts`

**Interfaces:**
- Consumes: WikiService/store/rank (Tasks 1,3).
- Produces:
  - `class McpWikiServer { static start(engine: Engine, projectDir: string): Promise<McpWikiServer>; readonly url: string; readonly projectDir: string; stop(): Promise<void> }` — node:http server on `127.0.0.1:0` (ephemeral port), POST `/mcp` via `StreamableHTTPServerTransport` (stateless: `sessionIdGenerator: undefined`), tools `wiki_query { symbol: string }` and `wiki_map { budgetTokens?: number }` — **no path inputs; the project root is fixed at start()** and was validated (git guard) before the server exists.
  - RPC: `engine.mcp.start { projectDir }` → `{ url }` (idempotent per resolved root — returns existing url); `engine.mcp.stop { projectDir }` → `{ stopped: boolean }`; `engine.mcp.status {}` → `{ servers: Array<{ projectDir, url }> }`. Engine.close() stops all servers.
  - Tool results: MCP text content containing JSON (`JSON.stringify` of the same shapes the RPC returns).

- [ ] **Step 1: Install** — `pnpm add @modelcontextprotocol/sdk --filter @openfusion/engine`. Verify import resolves: `cd packages/engine && node -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(m => console.log('mcp-ok', typeof m.McpServer))"` → `mcp-ok function`. If the subpath differs in the installed version, STOP and report NEEDS_CONTEXT with `ls node_modules/@modelcontextprotocol/sdk/dist` output.

- [ ] **Step 2: Failing test** — `packages/engine/test/wiki-mcp.test.ts` (uses the SDK's own client for a real round-trip):

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";

let dir: string;
let engine: Engine;
afterEach(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): void {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-mcp-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(path.join(dir, "m.ts"), "export function mercury() {}\nmercury();\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
  engine = createEngine();
}

async function rpc(method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

describe("MCP wiki server", () => {
  it("serves wiki_query over streamable HTTP to the official client", async () => {
    makeRepo();
    await rpc("engine.wiki.build", { projectDir: dir });
    const started = await rpc("engine.mcp.start", { projectDir: dir });
    expect(started.error).toBeUndefined();
    const url = started.result.url as string;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["wiki_map", "wiki_query"]);
    const result = await client.callTool({
      name: "wiki_query",
      arguments: { symbol: "mercury" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(JSON.parse(text).definitions[0].file).toBe("m.ts");
    await client.close();
  }, 30_000);

  it("start is idempotent per root and status lists it; stop removes it", async () => {
    makeRepo();
    await rpc("engine.wiki.build", { projectDir: dir });
    const a = await rpc("engine.mcp.start", { projectDir: dir });
    const b = await rpc("engine.mcp.start", { projectDir: dir });
    expect(b.result.url).toBe(a.result.url);
    const status = await rpc("engine.mcp.status", {});
    expect(status.result.servers).toHaveLength(1);
    const stopped = await rpc("engine.mcp.stop", { projectDir: dir });
    expect(stopped.result.stopped).toBe(true);
    const after = await rpc("engine.mcp.status", {});
    expect(after.result.servers).toHaveLength(0);
  }, 30_000);

  it("start on a non-git dir returns SERVER_ERROR", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-mcp-nogit-"));
    engine = createEngine();
    const res = await rpc("engine.mcp.start", { projectDir: dir });
    expect(res.error?.code).toBe(-32000);
  });
});
```

- [ ] **Step 3: RED run** (METHOD_NOT_FOUND on engine.mcp.start).

- [ ] **Step 4: Implement `packages/engine/src/wiki/mcp.ts`**

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Engine } from "../engine.js";
import { rankFiles, renderRepoMap } from "./rank.js";

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined;
}

export class McpWikiServer {
  private constructor(
    readonly projectDir: string,
    readonly url: string,
    private readonly http: Server,
  ) {}

  static async start(engine: Engine, projectDir: string): Promise<McpWikiServer> {
    const mcp = new McpServer({ name: "openfusion-wiki", version: "0.0.1" });

    mcp.registerTool(
      "wiki_query",
      {
        description:
          "Look up where a symbol is defined and referenced in this project's code index",
        inputSchema: { symbol: z.string().min(1) },
      },
      ({ symbol }) => {
        const store = engine.wiki.getStore(projectDir);
        const payload = {
          definitions: store.symbolsByName(symbol),
          references: store.refsByName(symbol),
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    );

    mcp.registerTool(
      "wiki_map",
      {
        description:
          "Get a token-budgeted map of this project's most important files and symbols",
        inputSchema: { budgetTokens: z.number().int().min(64).max(32768).optional() },
      },
      ({ budgetTokens }) => {
        const store = engine.wiki.getStore(projectDir);
        const ranked = rankFiles(store.allSymbols(), store.allRefs());
        const map = renderRepoMap(ranked, budgetTokens ?? 1024);
        return { content: [{ type: "text", text: map }] };
      },
    );

    const http = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        if (req.method !== "POST" || req.url !== "/mcp") {
          res.writeHead(404).end();
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => void transport.close());
        await mcp.connect(transport);
        await transport.handleRequest(req, res, await readBody(req));
      })().catch((err: unknown) => {
        engine.log(`mcp request error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });

    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (address === null || typeof address === "string") {
      throw new Error("mcp server failed to bind a port");
    }
    const url = `http://127.0.0.1:${address.port}/mcp`;
    engine.log(`mcp wiki server for ${projectDir} at ${url}`);
    return new McpWikiServer(projectDir, url, http);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.http.close((err) => (err ? reject(err) : resolve())),
    );
  }
}
```

`methods.ts`: add to WikiService: `#mcpServers = new Map<string, McpWikiServer>()`, `getMcpServers()` accessor for status, plus start/stop management; register `engine.mcp.start` (guard `requireHeadSha`; resolve key like stores; idempotent), `engine.mcp.stop` (`{ stopped: boolean }` false when none), `engine.mcp.status` (schema `z.object({})`); `close()` stops all servers (try/catch each) before closing stores. `engine.ts`: re-export `McpWikiServer`.

**Known-risk notes:** (a) if `registerTool`'s option key differs in the installed SDK minor (e.g. `inputSchema` shape), adapt per the SDK's own TypeScript types and report the difference; (b) if stateless per-request transport trips the client on `initialize`, switch to a single long-lived transport instance created once per server (still loopback-only) and report.

- [ ] **Step 5: GREEN** — full suite green (77 tests: 74 + 3). Exact totals.
- [ ] **Step 6: Commit** — `feat(engine): MCP wiki server (streamable HTTP loopback) with root-bound wiki_query and wiki_map tools`

---

### Task 5: Carried cleanups + docs

**Files:**
- Modify: `packages/engine/src/wiki/indexer.ts` (+`filesFailed`), `packages/engine/src/rpc/register.ts` (zod issues → error.data), `packages/engine/src/wiki/methods.ts` (status side-effect check), `README.md`
- Test: extend `register.test.ts`, `wiki-methods.test.ts`

**Interfaces:**
- Produces: `IndexStats.filesFailed: number` (parseFile-null on a supported extension); `INVALID_PARAMS` errors carry `data: { issues: [{ path: string[], message: string }] }` while keeping the current message; `engine.wiki.status` no longer creates `.openfusion/` for never-built projects (existence check before `openWikiStore`; returns `built: false` zeros without side effects).

- [ ] **Step 1: Failing tests**

`register.test.ts` addition:

```ts
  it("includes structured zod issues in error.data", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 9,
      method: "greet",
      params: { who: 42 },
    });
    const data = res?.error?.data as { issues: Array<{ path: string[]; message: string }> };
    expect(data.issues[0]?.path).toEqual(["who"]);
    expect(typeof data.issues[0]?.message).toBe("string");
  });
```

`wiki-methods.test.ts` addition:

```ts
  it("status on a never-built project reports built:false without creating .openfusion", async () => {
    makeRepo();
    const res = await call("engine.wiki.status", { projectDir: dir });
    expect(res.result.built).toBe(false);
    expect(existsSync(path.join(dir, ".openfusion"))).toBe(false);
  });
```

(`IndexStats.filesFailed`: assert `stats.filesFailed` is `0` in the existing first indexer test — parser failures aren't deterministically inducible; the field's wiring is verified by the type + zero-count.)

- [ ] **Step 2: RED run** (status test fails: `.openfusion` gets created today).
- [ ] **Step 3: Implement** — indexer: `filesFailed` counter on the `result === null` branch (which must then `continue` — it already effectively does) + field in `IndexStats`; register.ts: build `data` from `parsed.error.issues.map(i => ({ path: i.path.map(String), message: i.message }))` and pass as the third `RpcMethodError` arg; methods.ts status: `existsSync(path.join(resolvedDir, ".openfusion/cache/wiki.db"))` gate — when absent return `{ built: false, headSha: null, currentSha, stale: false, files: 0, symbols: 0, refs: 0 }` without opening a store. README.md: update the one-paragraph status ("engine indexes TS/JS/Python/Go/Rust/Java repos; repo map; MCP server — M1b complete").
- [ ] **Step 4: GREEN** — full suite green (79+ tests). Exact totals.
- [ ] **Step 5: Commit** — `feat(engine): filesFailed stat, structured INVALID_PARAMS data, side-effect-free wiki status`

---

## Milestone exit checklist

- [ ] `pnpm install && pnpm build && pnpm typecheck && pnpm test` green from clean checkout
- [ ] Scratch-clone smoke: build + `engine.wiki.map` returns a plausible map with `packages/engine/src/engine.ts` ranked near the top; `engine.mcp.start` + `claude mcp add --transport http wiki <url>`-style manual connect optional
- [ ] No `.openfusion/` in the real checkout
- [ ] Next per roadmap: M2 (models layer) plan — verify current AI SDK provider APIs at plan time
