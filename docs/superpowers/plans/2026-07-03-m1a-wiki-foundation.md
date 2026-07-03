# M1a: Wiki Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine can index a TypeScript/JavaScript git repository into a per-project SQLite symbol store (tree-sitter defs/refs), refresh incrementally via git-SHA + content-hash watermarks, and answer `engine.wiki.build` / `engine.wiki.status` / `engine.wiki.query` over JSON-RPC.

**Architecture:** Four new units in `packages/engine`: `rpc/errors.ts` + `rpc/register.ts` (typed RPC errors + zod-validated method registration — M0 review feed-in), `wiki/store.ts` (better-sqlite3), `wiki/languages.ts` + `wiki/parser.ts` (web-tree-sitter wasm + vendored tags.scm queries), `wiki/indexer.ts` (git-driven incremental walk), `wiki/methods.ts` (RPC surface via a `WikiService` hung on the new `Engine` class). `createEngine()` changes from returning a bare dispatcher to returning an `Engine` (M0 review feed-in, done now before call sites multiply).

**Tech Stack (versions verified 2026-07-03):** web-tree-sitter@^0.26, tree-sitter-wasms@^0.1 (prebuilt grammar wasm), better-sqlite3@^12 (+@types/better-sqlite3), zod (workspace-consistent), existing M0 stack.

## Global Constraints

- Node `>=22`; TypeScript strict, `module`/`moduleResolution` `NodeNext` — relative imports use `.js` extensions.
- Every tsconfig change keeps the M0 pattern: `tsconfig.json` (build, `include: ["src"]`) + `tsconfig.test.json` (typecheck, `include: ["src", "test"]`); `typecheck` scripts point at `tsconfig.test.json`.
- Engine stdout carries JSON-RPC ONLY; all diagnostics to stderr (`Engine.log` wired to stderr in main.ts).
- Wiki cache lives at `<projectDir>/.openfusion/cache/wiki.db`; `openWikiStore` creates `<projectDir>/.openfusion/.gitignore` containing `cache/` so derived state never gets committed in user projects.
- pnpm ≥10 blocks dependency build scripts by default: root package.json must gain `"pnpm": { "onlyBuiltDependencies": ["better-sqlite3"] }` when better-sqlite3 is added.
- Tests create fixture git repos in `fs.mkdtempSync(path.join(os.tmpdir(), ...))` — never in the checkout. The self-index smoke test clones the repo locally to a temp dir; it must not write `.openfusion/` into the real checkout.
- Commit messages: conventional commits, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Nothing under `.superpowers/`, `.claude/`, or `dist/` may be committed.

---

### Task 1: RPC hardening — typed errors, zod-validated registration, id/int, version drift guard

**Files:**
- Modify: `packages/shared/src/rpc.ts` (RpcIdSchema `.int()`, add `SERVER_ERROR` code)
- Modify: `packages/shared/test/rpc.test.ts` (add 2 tests)
- Create: `packages/engine/src/rpc/errors.ts`
- Create: `packages/engine/src/rpc/register.ts`
- Modify: `packages/engine/src/rpc/dispatcher.ts` (RpcMethodError-aware catch)
- Modify: `packages/engine/src/engine.ts` (re-export new symbols)
- Test: `packages/engine/test/register.test.ts`, `packages/engine/test/version.test.ts`
- Modify: `packages/engine/package.json` (add zod dependency)

**Interfaces:**
- Consumes: M0's `RpcDispatcher`, `RpcErrorCodes`, `ENGINE_VERSION`.
- Produces: `class RpcMethodError extends Error { constructor(code: number, message: string, data?: unknown) }`; `registerMethod(dispatcher, method, schema, handler)` where invalid params → INVALID_PARAMS error response and `RpcMethodError` thrown by handlers surfaces its own code; `RpcErrorCodes.SERVER_ERROR = -32000`; number ids must be integers.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/test/rpc.test.ts` inside `describe("RpcRequestSchema", ...)`:

```ts
  it("rejects a fractional numeric id", () => {
    expect(
      RpcRequestSchema.safeParse({ jsonrpc: "2.0", id: 1.5, method: "x" }).success,
    ).toBe(false);
  });

  it("accepts a string id", () => {
    expect(
      RpcRequestSchema.safeParse({ jsonrpc: "2.0", id: "req-1", method: "x" }).success,
    ).toBe(true);
  });
```

Create `packages/engine/test/register.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import { RpcDispatcher } from "../src/rpc/dispatcher.js";
import { RpcMethodError } from "../src/rpc/errors.js";
import { registerMethod } from "../src/rpc/register.js";

const ParamsSchema = z.object({ who: z.string().min(1) });

function makeDispatcher(): RpcDispatcher {
  const dispatcher = new RpcDispatcher();
  registerMethod(dispatcher, "greet", ParamsSchema, ({ who }) => `hi ${who}`);
  registerMethod(dispatcher, "fail.custom", ParamsSchema, () => {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "app broke", { detail: 1 });
  });
  return dispatcher;
}

describe("registerMethod", () => {
  it("passes validated params to the handler", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "greet",
      params: { who: "ada" },
    });
    expect(res?.result).toBe("hi ada");
  });

  it("rejects invalid params with INVALID_PARAMS", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "greet",
      params: { who: 42 },
    });
    expect(res?.error?.code).toBe(RpcErrorCodes.INVALID_PARAMS);
    expect(res?.error?.message).toContain("greet");
  });

  it("lets RpcMethodError carry its own code and data", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "fail.custom",
      params: { who: "x" },
    });
    expect(res?.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res?.error?.message).toBe("app broke");
    expect(res?.error?.data).toEqual({ detail: 1 });
  });

  it("still maps plain throws to INTERNAL_ERROR", async () => {
    const dispatcher = new RpcDispatcher();
    registerMethod(dispatcher, "boom", z.object({}), () => {
      throw new Error("plain");
    });
    const res = await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "boom",
      params: {},
    });
    expect(res?.error?.code).toBe(RpcErrorCodes.INTERNAL_ERROR);
  });
});
```

Create `packages/engine/test/version.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "../src/version.js";

describe("ENGINE_VERSION", () => {
  it("matches package.json version (drift guard)", () => {
    const manifestPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../package.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version: string;
    };
    expect(ENGINE_VERSION).toBe(manifest.version);
  });
});
```

- [ ] **Step 2: Install zod in engine, run tests to verify failures**

Run: `pnpm add zod --filter @openfusion/engine`
Run: `pnpm --filter @openfusion/shared test`
Expected: FAIL — fractional-id test fails (schema currently accepts 1.5).
Run: `pnpm --filter @openfusion/engine test`
Expected: FAIL — register.test.ts cannot resolve `../src/rpc/errors.js`; version.test.ts PASSES already (0.0.1 == 0.0.1) — that's fine, it's a guard.

- [ ] **Step 3: Implement**

In `packages/shared/src/rpc.ts`, change the id schema line and add the error code:

```ts
export const RpcIdSchema = z.union([z.string(), z.number().int()]);
```

```ts
export const RpcErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
} as const;
```

Create `packages/engine/src/rpc/errors.ts`:

```ts
export class RpcMethodError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcMethodError";
  }
}
```

Create `packages/engine/src/rpc/register.ts`:

```ts
import type { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { RpcDispatcher } from "./dispatcher.js";
import { RpcMethodError } from "./errors.js";

export function registerMethod<S extends z.ZodType>(
  dispatcher: RpcDispatcher,
  method: string,
  schema: S,
  handler: (params: z.infer<S>) => Promise<unknown> | unknown,
): void {
  dispatcher.register(method, (params) => {
    const parsed = schema.safeParse(params);
    if (!parsed.success) {
      throw new RpcMethodError(
        RpcErrorCodes.INVALID_PARAMS,
        `invalid params for ${method}: ${parsed.error.message}`,
      );
    }
    return handler(parsed.data as z.infer<S>);
  });
}
```

In `packages/engine/src/rpc/dispatcher.ts`, add the import and replace the catch block:

```ts
import { RpcMethodError } from "./errors.js";
```

```ts
    } catch (err) {
      if (id === undefined) return null;
      if (err instanceof RpcMethodError) {
        return {
          jsonrpc: JSONRPC_VERSION,
          id,
          error: {
            code: err.code,
            message: err.message,
            ...(err.data !== undefined ? { data: err.data } : {}),
          },
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: { code: RpcErrorCodes.INTERNAL_ERROR, message },
      };
    }
```

In `packages/engine/src/engine.ts`, add to the re-export block:

```ts
export { RpcMethodError } from "./rpc/errors.js";
export { registerMethod } from "./rpc/register.js";
```

- [ ] **Step 4: Run all tests + typecheck**

Run: `pnpm --filter @openfusion/shared build && pnpm build && pnpm typecheck && pnpm test`
Expected: all green — shared 10 tests, engine 25 tests (20 existing + 4 register + 1 version).
(Count check, not gospel: assert zero failures, report exact totals.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared packages/engine pnpm-lock.yaml
git commit -m "feat(engine): typed RPC errors, zod-validated method registration, integer ids, version drift guard"
```

---

### Task 2: `createEngine(options): Engine`

**Files:**
- Modify: `packages/engine/src/engine.ts` (Engine class replaces bare-dispatcher factory)
- Modify: `packages/engine/src/main.ts` (use Engine, close on stdin end)
- Modify: `packages/engine/test/methods.test.ts` (dispatch via `.dispatcher`)
- Test: `packages/engine/test/engine.test.ts`

**Interfaces:**
- Consumes: Task 1's dispatcher/registration.
- Produces: `interface EngineOptions { log?: (message: string) => void }`; `class Engine { readonly dispatcher: RpcDispatcher; readonly log: (message: string) => void; close(): Promise<void> }`; `createEngine(options?: EngineOptions): Engine`. Task 6 extends Engine with a `wiki` service; M2+ modules follow the same pattern.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/test/engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";

describe("createEngine", () => {
  it("returns an Engine whose dispatcher answers engine.ping", async () => {
    const engine = createEngine();
    const res = await engine.dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "engine.ping",
    });
    expect((res?.result as { pong: boolean }).pong).toBe(true);
    await engine.close();
  });

  it("defaults log to a no-op and accepts an injected logger", () => {
    const lines: string[] = [];
    const engine = createEngine({ log: (m) => lines.push(m) });
    engine.log("hello");
    expect(lines).toEqual(["hello"]);
    expect(() => createEngine().log("ignored")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/engine test`
Expected: FAIL — `createEngine()` currently returns `RpcDispatcher` (no `.dispatcher` property); engine.test.ts fails, methods.test.ts still passes.

- [ ] **Step 3: Implement**

Replace the factory section of `packages/engine/src/engine.ts` (keep the existing re-export block, including Task 1's additions):

```ts
import { RpcDispatcher } from "./rpc/dispatcher.js";
import { registerCoreMethods } from "./methods.js";

export interface EngineOptions {
  log?: (message: string) => void;
}

export class Engine {
  readonly dispatcher = new RpcDispatcher();
  readonly log: (message: string) => void;

  constructor(options: EngineOptions = {}) {
    this.log = options.log ?? (() => {});
    registerCoreMethods(this.dispatcher);
  }

  async close(): Promise<void> {
    // Services with resources (wiki store, etc.) hook in here in later tasks.
  }
}

export function createEngine(options: EngineOptions = {}): Engine {
  return new Engine(options);
}
```

Update `packages/engine/test/methods.test.ts`: replace both `createEngine().dispatch(` calls with `createEngine().dispatcher.dispatch(`.

Update `packages/engine/src/main.ts` `main()` body:

```ts
async function main(): Promise<void> {
  const engine = createEngine({
    log: (message) => process.stderr.write(`${message}\n`),
  });
  const decoder = new NdjsonDecoder();
  process.stdin.setEncoding("utf8");
  process.stderr.write(`openfusion-engine started (pid ${process.pid})\n`);
  for await (const chunk of process.stdin) {
    for (const line of decoder.push(chunk as string)) {
      const response = line.ok
        ? await engine.dispatcher.dispatch(line.value)
        : engine.dispatcher.parseError();
      if (response !== null) {
        process.stdout.write(encodeNdjson(response));
      }
    }
  }
  await engine.close();
}
```

- [ ] **Step 4: Run tests + typecheck + build**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: all green (engine gains 2 tests; stdio integration tests still pass against rebuilt dist).

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): Engine class with injectable logger replaces bare-dispatcher factory"
```

---

### Task 3: Wiki store (better-sqlite3)

**Files:**
- Modify: root `package.json` (pnpm.onlyBuiltDependencies), `packages/engine/package.json` (deps)
- Create: `packages/engine/src/wiki/store.ts`
- Test: `packages/engine/test/wiki-store.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2 (standalone unit).
- Produces:
  - `interface SymbolEntry { name: string; kind: string; row: number; col: number }` (row/col 0-based)
  - `interface SymbolHit extends SymbolEntry { file: string }`
  - `class WikiStore { upsertFile(path: string, hash: string, lang: string, symbols: SymbolEntry[], refs: SymbolEntry[]): void; removeFile(path: string): void; getFileHash(path: string): string | null; listFiles(): string[]; symbolsByName(name: string): SymbolHit[]; refsByName(name: string): SymbolHit[]; counts(): { files: number; symbols: number; refs: number }; setMeta(key: string, value: string): void; getMeta(key: string): string | null; close(): void }`
  - `openWikiStore(projectDir: string): WikiStore` — creates `<projectDir>/.openfusion/cache/`, writes `<projectDir>/.openfusion/.gitignore` (`cache/`) if absent, opens `cache/wiki.db` in WAL mode.

- [ ] **Step 1: Add dependencies and allow the native build**

Run: `pnpm add better-sqlite3 --filter @openfusion/engine && pnpm add -D @types/better-sqlite3 --filter @openfusion/engine`

Edit root `package.json`: add top-level

```json
  "pnpm": { "onlyBuiltDependencies": ["better-sqlite3"] }
```

Run: `pnpm install`
Then verify the native module loads (from the engine package dir so resolution hits its node_modules):
Run: `cd packages/engine && node -e "const D=require('better-sqlite3'); new D(':memory:').exec('create table t(x)'); console.log('sqlite-ok')" && cd ../..`
Expected: prints `sqlite-ok`. If it errors about build scripts being skipped, run `pnpm rebuild better-sqlite3` and re-verify; report if that was needed.

- [ ] **Step 2: Write the failing test**

Create `packages/engine/test/wiki-store.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openWikiStore } from "../src/wiki/store.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeStore() {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-store-"));
  return openWikiStore(dir);
}

describe("openWikiStore", () => {
  it("creates cache dir, db file, and a .gitignore guarding cache/", () => {
    const store = makeStore();
    expect(existsSync(path.join(dir, ".openfusion/cache/wiki.db"))).toBe(true);
    expect(readFileSync(path.join(dir, ".openfusion/.gitignore"), "utf8")).toContain(
      "cache/",
    );
    store.close();
  });
});

describe("WikiStore", () => {
  it("round-trips symbols and refs for a file", () => {
    const store = makeStore();
    store.upsertFile(
      "src/a.ts",
      "hash1",
      "typescript",
      [{ name: "foo", kind: "function", row: 3, col: 9 }],
      [{ name: "bar", kind: "call", row: 4, col: 2 }],
    );
    expect(store.getFileHash("src/a.ts")).toBe("hash1");
    expect(store.symbolsByName("foo")).toEqual([
      { file: "src/a.ts", name: "foo", kind: "function", row: 3, col: 9 },
    ]);
    expect(store.refsByName("bar")).toHaveLength(1);
    expect(store.counts()).toEqual({ files: 1, symbols: 1, refs: 1 });
    store.close();
  });

  it("upsert replaces prior rows for the same file", () => {
    const store = makeStore();
    store.upsertFile("a.ts", "h1", "typescript", [
      { name: "old", kind: "function", row: 0, col: 0 },
    ], []);
    store.upsertFile("a.ts", "h2", "typescript", [
      { name: "new", kind: "function", row: 1, col: 0 },
    ], []);
    expect(store.symbolsByName("old")).toEqual([]);
    expect(store.symbolsByName("new")).toHaveLength(1);
    expect(store.getFileHash("a.ts")).toBe("h2");
    store.close();
  });

  it("removeFile deletes the file and its rows; listFiles reflects state", () => {
    const store = makeStore();
    store.upsertFile("a.ts", "h", "typescript", [
      { name: "s", kind: "class", row: 0, col: 0 },
    ], []);
    expect(store.listFiles()).toEqual(["a.ts"]);
    store.removeFile("a.ts");
    expect(store.listFiles()).toEqual([]);
    expect(store.symbolsByName("s")).toEqual([]);
    store.close();
  });

  it("meta round-trips and returns null when missing", () => {
    const store = makeStore();
    expect(store.getMeta("head_sha")).toBeNull();
    store.setMeta("head_sha", "abc123");
    expect(store.getMeta("head_sha")).toBe("abc123");
    store.setMeta("head_sha", "def456");
    expect(store.getMeta("head_sha")).toBe("def456");
    store.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @openfusion/engine test`
Expected: FAIL — cannot resolve `../src/wiki/store.js`.

- [ ] **Step 4: Implement the store**

Create `packages/engine/src/wiki/store.ts`:

```ts
import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SymbolEntry {
  name: string;
  kind: string;
  row: number;
  col: number;
}

export interface SymbolHit extends SymbolEntry {
  file: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, hash TEXT NOT NULL, lang TEXT NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL, row INTEGER NOT NULL, col INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL, row INTEGER NOT NULL, col INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file);
`;

export class WikiStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  upsertFile(
    filePath: string,
    hash: string,
    lang: string,
    symbols: SymbolEntry[],
    refs: SymbolEntry[],
  ): void {
    const insertFile = this.#db.prepare(
      `INSERT INTO files (path, hash, lang, indexed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET hash = excluded.hash,
         lang = excluded.lang, indexed_at = excluded.indexed_at`,
    );
    const delSymbols = this.#db.prepare("DELETE FROM symbols WHERE file = ?");
    const delRefs = this.#db.prepare("DELETE FROM refs WHERE file = ?");
    const insSymbol = this.#db.prepare(
      "INSERT INTO symbols (file, name, kind, row, col) VALUES (?, ?, ?, ?, ?)",
    );
    const insRef = this.#db.prepare(
      "INSERT INTO refs (file, name, kind, row, col) VALUES (?, ?, ?, ?, ?)",
    );
    this.#db.transaction(() => {
      insertFile.run(filePath, hash, lang, Date.now());
      delSymbols.run(filePath);
      delRefs.run(filePath);
      for (const s of symbols) insSymbol.run(filePath, s.name, s.kind, s.row, s.col);
      for (const r of refs) insRef.run(filePath, r.name, r.kind, r.row, r.col);
    })();
  }

  removeFile(filePath: string): void {
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM symbols WHERE file = ?").run(filePath);
      this.#db.prepare("DELETE FROM refs WHERE file = ?").run(filePath);
      this.#db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
    })();
  }

  getFileHash(filePath: string): string | null {
    const row = this.#db
      .prepare("SELECT hash FROM files WHERE path = ?")
      .get(filePath) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  listFiles(): string[] {
    const rows = this.#db
      .prepare("SELECT path FROM files ORDER BY path")
      .all() as { path: string }[];
    return rows.map((r) => r.path);
  }

  symbolsByName(name: string): SymbolHit[] {
    return this.#db
      .prepare(
        "SELECT file, name, kind, row, col FROM symbols WHERE name = ? ORDER BY file, row",
      )
      .all(name) as SymbolHit[];
  }

  refsByName(name: string): SymbolHit[] {
    return this.#db
      .prepare(
        "SELECT file, name, kind, row, col FROM refs WHERE name = ? ORDER BY file, row",
      )
      .all(name) as SymbolHit[];
  }

  counts(): { files: number; symbols: number; refs: number } {
    const one = (sql: string): number =>
      (this.#db.prepare(sql).get() as { n: number }).n;
    return {
      files: one("SELECT COUNT(*) AS n FROM files"),
      symbols: one("SELECT COUNT(*) AS n FROM symbols"),
      refs: one("SELECT COUNT(*) AS n FROM refs"),
    };
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.#db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  close(): void {
    this.#db.close();
  }
}

export function openWikiStore(projectDir: string): WikiStore {
  const openfusionDir = path.join(projectDir, ".openfusion");
  const cacheDir = path.join(openfusionDir, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const gitignorePath = path.join(openfusionDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "cache/\n");
  }
  const db = new Database(path.join(cacheDir, "wiki.db"));
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return new WikiStore(db);
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @openfusion/engine typecheck && pnpm --filter @openfusion/engine test`
Expected: all green (5 new store tests).

- [ ] **Step 6: Commit**

```bash
git add package.json packages/engine pnpm-lock.yaml
git commit -m "feat(engine): SQLite wiki store with per-project cache dir and gitignore guard"
```

---

### Task 4: Tree-sitter parser (TypeScript/TSX/JavaScript)

**Files:**
- Modify: `packages/engine/package.json` (deps: web-tree-sitter, tree-sitter-wasms; files: add "queries")
- Create: `packages/engine/queries/typescript/tags.scm`, `packages/engine/queries/javascript/tags.scm` (vendored)
- Create: `packages/engine/src/wiki/languages.ts`, `packages/engine/src/wiki/parser.ts`
- Test: `packages/engine/test/wiki-parser.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface ParseResult { symbols: SymbolEntry[]; refs: SymbolEntry[] }` (reuses Task 3's `SymbolEntry` from `./store.js`)
  - `class WikiParser { static create(): Promise<WikiParser>; parseFile(relPath: string, source: string): ParseResult | null; supportedExtensions(): Set<string>; dispose(): void }` — `null` for unsupported extensions; kinds come from tags.scm capture names (`function`, `class`, `method`, `call`, …).
  - `languages.ts` exports `LANGUAGE_SPECS` and `wasmDir()`; M1b adds more languages by appending specs.

- [ ] **Step 1: Install deps and verify the wasm layout**

Run: `pnpm add web-tree-sitter tree-sitter-wasms --filter @openfusion/engine`
Run: `node -e "const p = require.resolve('tree-sitter-wasms/package.json'); const fs = require('fs'), path = require('path'); const out = path.join(path.dirname(p), 'out'); console.log(fs.readdirSync(out).filter(f => /typescript|tsx|javascript/.test(f)).join('\n'))"`
Expected: lists `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`, `tree-sitter-javascript.wasm`. **If the `out/` directory or these names differ, STOP and report NEEDS_CONTEXT with the actual layout** — languages.ts below assumes it.

- [ ] **Step 2: Vendor the tags queries**

```bash
mkdir -p packages/engine/queries/typescript packages/engine/queries/javascript
curl -fsSL -o packages/engine/queries/typescript/tags.scm https://raw.githubusercontent.com/tree-sitter/tree-sitter-typescript/v0.23.2/queries/tags.scm
curl -fsSL -o packages/engine/queries/javascript/tags.scm https://raw.githubusercontent.com/tree-sitter/tree-sitter-javascript/v0.23.1/queries/tags.scm
grep -l "@definition" packages/engine/queries/typescript/tags.scm packages/engine/queries/javascript/tags.scm
```

Expected: both files download and both contain `@definition` captures. If a tag URL 404s, retry with `master` instead of the version tag and note the substitution in your report. Add a `NOTICE` line: create `packages/engine/queries/README.md` with:

```markdown
Vendored tree-sitter tags queries (MIT):
- typescript/tags.scm from tree-sitter/tree-sitter-typescript (v0.23.2), also used for .tsx
- javascript/tags.scm from tree-sitter/tree-sitter-javascript (v0.23.1)
```

In `packages/engine/package.json`, change `"files": ["dist"]` to `"files": ["dist", "queries"]`.

- [ ] **Step 3: Write the failing test**

Create `packages/engine/test/wiki-parser.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WikiParser } from "../src/wiki/parser.js";

let parser: WikiParser;
beforeAll(async () => {
  parser = await WikiParser.create();
}, 30_000);
afterAll(() => parser.dispose());

const TS_SOURCE = `
export function greet(name: string): string {
  return format(name);
}
export class Greeter {
  wave(): void {
    greet("hi");
  }
}
`;

describe("WikiParser", () => {
  it("extracts definitions from TypeScript source", () => {
    const result = parser.parseFile("src/a.ts", TS_SOURCE);
    expect(result).not.toBeNull();
    const names = result!.symbols.map((s) => s.name);
    expect(names).toContain("greet");
    expect(names).toContain("Greeter");
    expect(names).toContain("wave");
    const greet = result!.symbols.find((s) => s.name === "greet")!;
    expect(greet.kind.length).toBeGreaterThan(0);
    expect(greet.row).toBeGreaterThan(0);
  });

  it("extracts references (calls)", () => {
    const result = parser.parseFile("src/a.ts", TS_SOURCE);
    const refNames = result!.refs.map((r) => r.name);
    expect(refNames).toContain("format");
    expect(refNames).toContain("greet");
  });

  it("parses .tsx and .js via their grammars", () => {
    expect(
      parser.parseFile("c.tsx", "export function App() { return <div/>; }"),
    ).not.toBeNull();
    expect(
      parser.parseFile("b.js", "function jsOnly() {} jsOnly();"),
    ).not.toBeNull();
  });

  it("returns null for unsupported extensions", () => {
    expect(parser.parseFile("readme.md", "# hi")).toBeNull();
  });

  it("reports supported extensions", () => {
    const exts = parser.supportedExtensions();
    expect(exts.has(".ts")).toBe(true);
    expect(exts.has(".tsx")).toBe(true);
    expect(exts.has(".js")).toBe(true);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @openfusion/engine test`
Expected: FAIL — cannot resolve `../src/wiki/parser.js`.

- [ ] **Step 5: Implement languages + parser**

Create `packages/engine/src/wiki/languages.ts`:

```ts
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LanguageSpec {
  id: string;
  wasmFile: string;
  queryDir: string;
  extensions: string[];
}

export const LANGUAGE_SPECS: LanguageSpec[] = [
  {
    id: "typescript",
    wasmFile: "tree-sitter-typescript.wasm",
    queryDir: "typescript",
    extensions: [".ts", ".mts", ".cts"],
  },
  {
    id: "tsx",
    wasmFile: "tree-sitter-tsx.wasm",
    queryDir: "typescript",
    extensions: [".tsx"],
  },
  {
    id: "javascript",
    wasmFile: "tree-sitter-javascript.wasm",
    queryDir: "javascript",
    extensions: [".js", ".mjs", ".cjs", ".jsx"],
  },
];

export function wasmDir(): string {
  const require = createRequire(import.meta.url);
  return path.join(
    path.dirname(require.resolve("tree-sitter-wasms/package.json")),
    "out",
  );
}

export function queriesDir(): string {
  // src/wiki/ and dist/wiki/ are both two levels below the package root,
  // where queries/ lives (shipped via package.json "files").
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../queries",
  );
}
```

Create `packages/engine/src/wiki/parser.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Language, Parser, Query } from "web-tree-sitter";
import { LANGUAGE_SPECS, queriesDir, wasmDir } from "./languages.js";
import type { SymbolEntry } from "./store.js";

export interface ParseResult {
  symbols: SymbolEntry[];
  refs: SymbolEntry[];
}

interface LoadedLanguage {
  id: string;
  language: Language;
  query: Query;
}

export class WikiParser {
  #parser: Parser;
  #byExtension: Map<string, LoadedLanguage>;

  private constructor(parser: Parser, byExtension: Map<string, LoadedLanguage>) {
    this.#parser = parser;
    this.#byExtension = byExtension;
  }

  static async create(): Promise<WikiParser> {
    await Parser.init();
    const parser = new Parser();
    const byExtension = new Map<string, LoadedLanguage>();
    const queryCache = new Map<string, string>();
    for (const spec of LANGUAGE_SPECS) {
      const language = await Language.load(path.join(wasmDir(), spec.wasmFile));
      let tags = queryCache.get(spec.queryDir);
      if (tags === undefined) {
        tags = await readFile(
          path.join(queriesDir(), spec.queryDir, "tags.scm"),
          "utf8",
        );
        queryCache.set(spec.queryDir, tags);
      }
      const query = new Query(language, tags);
      const loaded: LoadedLanguage = { id: spec.id, language, query };
      for (const ext of spec.extensions) byExtension.set(ext, loaded);
    }
    return new WikiParser(parser, byExtension);
  }

  supportedExtensions(): Set<string> {
    return new Set(this.#byExtension.keys());
  }

  languageFor(relPath: string): string | null {
    return this.#byExtension.get(path.extname(relPath))?.id ?? null;
  }

  parseFile(relPath: string, source: string): ParseResult | null {
    const loaded = this.#byExtension.get(path.extname(relPath));
    if (loaded === undefined) return null;
    this.#parser.setLanguage(loaded.language);
    const tree = this.#parser.parse(source);
    if (tree === null) return null;
    try {
      const symbols: SymbolEntry[] = [];
      const refs: SymbolEntry[] = [];
      for (const match of loaded.query.matches(tree.rootNode)) {
        let nameNode: { text: string; startPosition: { row: number; column: number } } | null =
          null;
        let tag: { kind: string; isDefinition: boolean } | null = null;
        for (const capture of match.captures) {
          if (capture.name === "name") {
            nameNode = capture.node;
          } else if (capture.name.startsWith("definition.")) {
            tag = { kind: capture.name.slice("definition.".length), isDefinition: true };
          } else if (capture.name.startsWith("reference.")) {
            tag = { kind: capture.name.slice("reference.".length), isDefinition: false };
          }
        }
        if (nameNode === null || tag === null) continue;
        const entry: SymbolEntry = {
          name: nameNode.text,
          kind: tag.kind,
          row: nameNode.startPosition.row,
          col: nameNode.startPosition.column,
        };
        (tag.isDefinition ? symbols : refs).push(entry);
      }
      return { symbols, refs };
    } finally {
      tree.delete();
    }
  }

  dispose(): void {
    for (const loaded of new Set(this.#byExtension.values())) {
      loaded.query.delete();
    }
    this.#parser.delete();
  }
}
```

**Known-risk fallbacks (report whichever you hit):** (a) if `new Query(...)` throws on a vendored tags.scm (unsupported doc-directives like `#strip!`/`#select-adjacent!`), delete the `@doc`-related patterns from that .scm file and note it in queries/README.md; (b) if capture names in matches carry a `name.` prefix instead of plain `name` (older query convention), adapt the capture-name checks accordingly and report.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @openfusion/engine typecheck && pnpm --filter @openfusion/engine test`
Expected: all green (5 new parser tests; first run may take a few seconds loading wasm).

- [ ] **Step 7: Commit**

```bash
git add packages/engine pnpm-lock.yaml
git commit -m "feat(engine): tree-sitter wasm parser with vendored tags queries for TS/TSX/JS"
```

---

### Task 5: Incremental indexer with git watermark

**Files:**
- Create: `packages/engine/src/wiki/indexer.ts`
- Test: `packages/engine/test/wiki-indexer.test.ts`

**Interfaces:**
- Consumes: `WikiStore` (Task 3), `WikiParser` (Task 4).
- Produces:
  - `interface IndexStats { filesSeen: number; filesIndexed: number; filesSkipped: number; filesRemoved: number; symbols: number; refs: number; headSha: string }`
  - `buildIndex(projectDir: string, store: WikiStore, parser: WikiParser): Promise<IndexStats>` — indexes tracked files with supported extensions; skips files whose sha256 matches the stored hash; removes DB entries for files no longer tracked; stamps `meta.head_sha`; skips files > 1 MiB.
  - `getHeadSha(projectDir: string): string` — throws `Error` if not a git repo (method layer converts to RpcMethodError in Task 6).

- [ ] **Step 1: Write the failing test**

Create `packages/engine/test/wiki-indexer.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildIndex, getHeadSha } from "../src/wiki/indexer.js";
import { WikiParser } from "../src/wiki/parser.js";
import { openWikiStore, type WikiStore } from "../src/wiki/store.js";

let parser: WikiParser;
beforeAll(async () => {
  parser = await WikiParser.create();
}, 30_000);
afterAll(() => parser.dispose());

let dir: string;
let store: WikiStore;
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): void {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-idx-"));
  execFileSync("git", ["init", "-q", dir]);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.ts"), "export function alpha() {}\n");
  writeFileSync(path.join(dir, "b.ts"), "export function beta() { alpha(); }\n");
  writeFileSync(path.join(dir, "note.md"), "# not code\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  store = openWikiStore(dir);
}

describe("buildIndex", () => {
  it("indexes tracked supported files and stamps the head sha", async () => {
    makeRepo();
    const stats = await buildIndex(dir, store, parser);
    expect(stats.filesSeen).toBe(2);
    expect(stats.filesIndexed).toBe(2);
    expect(stats.filesSkipped).toBe(0);
    expect(stats.symbols).toBeGreaterThanOrEqual(2);
    expect(stats.headSha).toBe(getHeadSha(dir));
    expect(store.getMeta("head_sha")).toBe(stats.headSha);
    expect(store.symbolsByName("alpha")[0]?.file).toBe("a.ts");
  });

  it("skips unchanged files on rebuild and re-indexes modified ones", async () => {
    makeRepo();
    await buildIndex(dir, store, parser);
    writeFileSync(path.join(dir, "b.ts"), "export function betaTwo() {}\n");
    git("add", "-A");
    git("commit", "-qm", "edit b");
    const stats = await buildIndex(dir, store, parser);
    expect(stats.filesSkipped).toBe(1);
    expect(stats.filesIndexed).toBe(1);
    expect(store.symbolsByName("beta")).toEqual([]);
    expect(store.symbolsByName("betaTwo")).toHaveLength(1);
  });

  it("removes entries for deleted files", async () => {
    makeRepo();
    await buildIndex(dir, store, parser);
    git("rm", "-q", "b.ts");
    git("commit", "-qm", "rm b");
    const stats = await buildIndex(dir, store, parser);
    expect(stats.filesRemoved).toBe(1);
    expect(store.listFiles()).toEqual(["a.ts"]);
  });
});

describe("getHeadSha", () => {
  it("throws outside a git repository", () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), "of-nogit-"));
    try {
      expect(() => getHeadSha(plain)).toThrow();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/engine test`
Expected: FAIL — cannot resolve `../src/wiki/indexer.js`.

- [ ] **Step 3: Implement the indexer**

Create `packages/engine/src/wiki/indexer.ts`:

```ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { WikiParser } from "./parser.js";
import type { WikiStore } from "./store.js";

export interface IndexStats {
  filesSeen: number;
  filesIndexed: number;
  filesSkipped: number;
  filesRemoved: number;
  symbols: number;
  refs: number;
  headSha: string;
}

const MAX_FILE_BYTES = 1024 * 1024;

export function getHeadSha(projectDir: string): string {
  return execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function listTrackedFiles(projectDir: string): string[] {
  const out = execFileSync("git", ["-C", projectDir, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((p) => p.length > 0);
}

export async function buildIndex(
  projectDir: string,
  store: WikiStore,
  parser: WikiParser,
): Promise<IndexStats> {
  const headSha = getHeadSha(projectDir);
  const extensions = parser.supportedExtensions();
  const tracked = listTrackedFiles(projectDir).filter((p) =>
    extensions.has(path.extname(p)),
  );

  let filesIndexed = 0;
  let filesSkipped = 0;
  const seen = new Set<string>();

  for (const relPath of tracked) {
    const absPath = path.join(projectDir, relPath);
    let size: number;
    try {
      size = statSync(absPath).size;
    } catch {
      continue; // tracked but missing on disk (mid-operation); skip
    }
    if (size > MAX_FILE_BYTES) continue;
    seen.add(relPath);
    const source = readFileSync(absPath, "utf8");
    const hash = createHash("sha256").update(source).digest("hex");
    if (store.getFileHash(relPath) === hash) {
      filesSkipped += 1;
      continue;
    }
    const result = parser.parseFile(relPath, source);
    if (result === null) continue;
    store.upsertFile(
      relPath,
      hash,
      parser.languageFor(relPath) ?? "unknown",
      result.symbols,
      result.refs,
    );
    filesIndexed += 1;
  }

  let filesRemoved = 0;
  for (const known of store.listFiles()) {
    if (!seen.has(known)) {
      store.removeFile(known);
      filesRemoved += 1;
    }
  }

  store.setMeta("head_sha", headSha);
  store.setMeta("indexed_at", String(Date.now()));

  const counts = store.counts();
  return {
    filesSeen: seen.size,
    filesIndexed,
    filesSkipped,
    filesRemoved,
    symbols: counts.symbols,
    refs: counts.refs,
    headSha,
  };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @openfusion/engine typecheck && pnpm --filter @openfusion/engine test`
Expected: all green (4 new indexer tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): incremental wiki indexer with git head watermark and content hashing"
```

---

### Task 6: Wiki RPC methods + WikiService on Engine

**Files:**
- Create: `packages/engine/src/wiki/methods.ts`
- Modify: `packages/engine/src/engine.ts` (wiki service, close hook, re-exports)
- Test: `packages/engine/test/wiki-methods.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 (registerMethod, Engine, store, parser, indexer).
- Produces RPC surface (all params validated; non-git projectDir → `SERVER_ERROR` -32000):
  - `engine.wiki.build {projectDir}` → `IndexStats`
  - `engine.wiki.status {projectDir}` → `{ built: boolean; headSha: string | null; currentSha: string; stale: boolean; files: number; symbols: number; refs: number }`
  - `engine.wiki.query {projectDir, symbol}` → `{ definitions: SymbolHit[]; references: SymbolHit[] }`
  - `class WikiService { getStore(projectDir): WikiStore; getParser(): Promise<WikiParser>; close(): Promise<void> }`; `Engine` gains `readonly wiki: WikiService`, `close()` closes it.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/test/wiki-methods.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { createEngine, type Engine } from "../src/engine.js";

let dir: string;
let engine: Engine;
afterEach(async () => {
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): void {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-rpc-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(path.join(dir, "x.ts"), "export function xray() {}\nxray();\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
  engine = createEngine();
}

async function call(method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

describe("wiki RPC methods", () => {
  it("build → status → query round-trip", async () => {
    makeRepo();
    const build = await call("engine.wiki.build", { projectDir: dir });
    expect(build.error).toBeUndefined();
    expect(build.result.filesIndexed).toBe(1);

    const status = await call("engine.wiki.status", { projectDir: dir });
    expect(status.result.built).toBe(true);
    expect(status.result.stale).toBe(false);
    expect(status.result.symbols).toBeGreaterThanOrEqual(1);

    const query = await call("engine.wiki.query", { projectDir: dir, symbol: "xray" });
    expect(query.result.definitions[0].file).toBe("x.ts");
    expect(query.result.references.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("status reports stale after a new commit without rebuild", async () => {
    makeRepo();
    await call("engine.wiki.build", { projectDir: dir });
    writeFileSync(path.join(dir, "y.ts"), "export function yolo() {}\n");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "more"]);
    const status = await call("engine.wiki.status", { projectDir: dir });
    expect(status.result.stale).toBe(true);
  }, 30_000);

  it("returns SERVER_ERROR for a non-git directory", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-nogit-"));
    engine = createEngine();
    const res = await call("engine.wiki.build", { projectDir: dir });
    expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
  });

  it("rejects missing params with INVALID_PARAMS", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-empty-"));
    engine = createEngine();
    const res = await call("engine.wiki.query", { projectDir: dir });
    expect(res.error?.code).toBe(RpcErrorCodes.INVALID_PARAMS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/engine test`
Expected: FAIL — `engine.wiki.build` → METHOD_NOT_FOUND (methods not registered yet).

- [ ] **Step 3: Implement**

Create `packages/engine/src/wiki/methods.ts`:

```ts
import path from "node:path";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { registerMethod } from "../rpc/register.js";
import { buildIndex, getHeadSha } from "./indexer.js";
import { WikiParser } from "./parser.js";
import { openWikiStore, type WikiStore } from "./store.js";

const ProjectParamsSchema = z.object({ projectDir: z.string().min(1) });
const QueryParamsSchema = ProjectParamsSchema.extend({
  symbol: z.string().min(1),
});

export class WikiService {
  #stores = new Map<string, WikiStore>();
  #parserPromise: Promise<WikiParser> | undefined;

  getStore(projectDir: string): WikiStore {
    const key = path.resolve(projectDir);
    let store = this.#stores.get(key);
    if (store === undefined) {
      store = openWikiStore(key);
      this.#stores.set(key, store);
    }
    return store;
  }

  getParser(): Promise<WikiParser> {
    this.#parserPromise ??= WikiParser.create();
    return this.#parserPromise;
  }

  async close(): Promise<void> {
    for (const store of this.#stores.values()) store.close();
    this.#stores.clear();
    if (this.#parserPromise !== undefined) {
      (await this.#parserPromise).dispose();
      this.#parserPromise = undefined;
    }
  }
}

function requireHeadSha(projectDir: string): string {
  try {
    return getHeadSha(projectDir);
  } catch {
    throw new RpcMethodError(
      RpcErrorCodes.SERVER_ERROR,
      `not a git repository: ${projectDir}`,
    );
  }
}

export function registerWikiMethods(engine: Engine): void {
  registerMethod(
    engine.dispatcher,
    "engine.wiki.build",
    ProjectParamsSchema,
    async ({ projectDir }) => {
      requireHeadSha(projectDir);
      const store = engine.wiki.getStore(projectDir);
      const parser = await engine.wiki.getParser();
      const stats = await buildIndex(path.resolve(projectDir), store, parser);
      engine.log(
        `wiki.build ${projectDir}: ${stats.filesIndexed} indexed, ${stats.filesSkipped} skipped`,
      );
      return stats;
    },
  );

  registerMethod(
    engine.dispatcher,
    "engine.wiki.status",
    ProjectParamsSchema,
    ({ projectDir }) => {
      const currentSha = requireHeadSha(projectDir);
      const store = engine.wiki.getStore(projectDir);
      const headSha = store.getMeta("head_sha");
      const counts = store.counts();
      return {
        built: headSha !== null,
        headSha,
        currentSha,
        stale: headSha !== null && headSha !== currentSha,
        ...counts,
      };
    },
  );

  registerMethod(
    engine.dispatcher,
    "engine.wiki.query",
    QueryParamsSchema,
    ({ projectDir, symbol }) => {
      const store = engine.wiki.getStore(projectDir);
      return {
        definitions: store.symbolsByName(symbol),
        references: store.refsByName(symbol),
      };
    },
  );
}
```

In `packages/engine/src/engine.ts`: import and wire the service —

```ts
import { WikiService, registerWikiMethods } from "./wiki/methods.js";
```

In the `Engine` class add the field and constructor/close wiring:

```ts
  readonly wiki = new WikiService();
```

```ts
  constructor(options: EngineOptions = {}) {
    this.log = options.log ?? (() => {});
    registerCoreMethods(this.dispatcher);
    registerWikiMethods(this);
  }

  async close(): Promise<void> {
    await this.wiki.close();
  }
```

Add to the re-export block:

```ts
export { WikiService } from "./wiki/methods.js";
export { WikiStore, openWikiStore } from "./wiki/store.js";
export { WikiParser } from "./wiki/parser.js";
export { buildIndex, getHeadSha } from "./wiki/indexer.js";
```

- [ ] **Step 4: Run tests + typecheck + build**

Run: `pnpm build && pnpm typecheck && pnpm test`
Expected: all green (4 new wiki-methods tests; stdio tests still pass).

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): wiki RPC methods (build/status/query) via WikiService on Engine"
```

---

### Task 7: Self-index smoke test + CI hardening

**Files:**
- Test: `packages/engine/test/wiki-self.test.ts`
- Modify: `.github/workflows/ci.yml` (permissions, concurrency)

**Interfaces:**
- Consumes: everything; proves the milestone exit criterion end-to-end on this very repository (via a local clone in tmp — never writes `.openfusion/` into the checkout).

- [ ] **Step 1: Write the smoke test (this is the milestone's proof — write it, watch it pass)**

Create `packages/engine/test/wiki-self.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
let cloneDir: string;
afterAll(() => rmSync(cloneDir, { recursive: true, force: true }));

describe("self-index smoke", () => {
  it("indexes a clone of this repository and finds createEngine", async () => {
    cloneDir = mkdtempSync(path.join(os.tmpdir(), "of-self-"));
    execFileSync("git", ["clone", "-q", "--local", repoRoot, path.join(cloneDir, "repo")]);
    const projectDir = path.join(cloneDir, "repo");
    const engine = createEngine();
    try {
      const build = await engine.dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "engine.wiki.build",
        params: { projectDir },
      });
      expect(build?.error).toBeUndefined();
      const stats = build?.result as { filesIndexed: number; symbols: number };
      expect(stats.filesIndexed).toBeGreaterThanOrEqual(10);
      expect(stats.symbols).toBeGreaterThanOrEqual(30);

      const query = await engine.dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 2,
        method: "engine.wiki.query",
        params: { projectDir, symbol: "createEngine" },
      });
      const defs = (query?.result as { definitions: { file: string }[] }).definitions;
      expect(defs.some((d) => d.file === "packages/engine/src/engine.ts")).toBe(true);
    } finally {
      await engine.close();
    }
  }, 60_000);
});
```

Run: `pnpm --filter @openfusion/engine test`
Expected: PASS (everything already implemented — this is a proof, not a RED step).

- [ ] **Step 2: CI hardening**

In `.github/workflows/ci.yml`, add directly under `name: CI`:

```yaml
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
```

Run: `pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm test`
Expected: all four green.

- [ ] **Step 3: Commit**

```bash
git add packages/engine .github/workflows/ci.yml
git commit -m "test(engine): self-index smoke on repo clone; ci: restrict token, cancel superseded runs"
```

---

## Milestone exit checklist

- [ ] `pnpm install && pnpm build && pnpm typecheck && pnpm test` green from a clean checkout
- [ ] Manual smoke: `printf '{"jsonrpc":"2.0","id":1,"method":"engine.wiki.build","params":{"projectDir":"'$PWD'"}}\n' | node packages/engine/dist/main.js 2>/dev/null` prints an IndexStats JSON line (note: running this in the real checkout creates `.openfusion/` here — inspect it, then `rm -rf .openfusion` before committing anything, or run against a scratch clone)
- [ ] `engine.wiki.query` for `createEngine` returns its definition site
- [ ] Next: write M1b plan (multi-language grammars, repo-map PageRank, MCP server per verified API cheat-sheet in `docs/research/2026-07-03-m1-api-verification.md`)
