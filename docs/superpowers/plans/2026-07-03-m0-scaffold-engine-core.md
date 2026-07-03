# M0: Scaffold + Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pnpm monorepo whose `@openfusion/engine` package boots as a standalone process and answers `engine.ping` / `engine.info` over newline-delimited JSON-RPC 2.0 on stdio, with CI green.

**Architecture:** Two workspace packages: `@openfusion/shared` (zod schemas for the JSON-RPC envelope — the contract every future module speaks) and `@openfusion/engine` (ndjson codec → dispatcher → core methods → stdio entry). The Tauri shell (M7) will spawn this exact process; until then tests are the only client.

**Tech Stack:** Node ≥22, pnpm workspaces (via corepack), TypeScript strict ESM (NodeNext), zod, vitest, GitHub Actions.

## Global Constraints

- Node `>=22`; pnpm managed by corepack (`packageManager` field in root package.json).
- All packages: `"type": "module"`, TypeScript `strict`, `module`/`moduleResolution` `NodeNext` — **relative imports in src must use `.js` extensions**.
- Engine stdout carries JSON-RPC protocol ONLY; all diagnostics/logging go to stderr (spec §4.1 — the shell owns stdout).
- Package scope `@openfusion/*` (working name; public rename happens in M8).
- License Apache-2.0; no secrets in code, config, or logs; unit tests make no network calls.
- Commit messages: conventional commits (`feat:`, `test:`, `chore:`, `ci:`, `docs:`), ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `LICENSE`, `README.md`

**Interfaces:**
- Produces: workspace root every later task installs into; `tsconfig.base.json` that every package `extends`; root scripts `build`/`typecheck`/`test` that fan out via `pnpm -r`.

- [ ] **Step 1: Write root package.json**

```json
{
  "name": "openfusion-monorepo",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test"
  }
}
```

- [ ] **Step 2: Write pnpm-workspace.yaml**

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

- [ ] **Step 3: Write tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: Write .gitignore**

```
node_modules/
dist/
coverage/
*.log
.DS_Store
```

- [ ] **Step 5: Pin pnpm via corepack and fetch the license**

Run: `corepack enable && corepack use pnpm@latest`
Expected: adds a `"packageManager": "pnpm@<version>+sha512..."` field to package.json.

Run: `curl -fsSL -o LICENSE https://www.apache.org/licenses/LICENSE-2.0.txt`
Expected: `LICENSE` exists; `head -1 LICENSE` prints "                                 Apache License".

- [ ] **Step 6: Write README.md**

```markdown
# OpenFusion (working name)

Open-source macOS app that analyzes your repo with a frontier model and
generates a dedicated multi-model harness: an LLM wiki, specialist agents,
and a cost-optimizing routing policy — frontier orchestration, open-model
workers.

- Design spec: `docs/superpowers/specs/2026-07-03-harness-fusion-app-design.md`
- Roadmap: `docs/superpowers/plans/2026-07-03-roadmap.md`
- Landscape research: `docs/research/2026-07-03-oss-landscape.md`

## Development

Requires Node >= 22 and pnpm (via corepack).

    corepack enable
    pnpm install
    pnpm build
    pnpm test

## License

Apache-2.0
```

- [ ] **Step 7: Verify install works**

Run: `pnpm install`
Expected: completes without error (no packages yet — that's fine).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo (workspaces, base tsconfig, Apache-2.0)"
```

---

### Task 2: `@openfusion/shared` — JSON-RPC envelope schemas

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/rpc.ts`
- Test: `packages/shared/test/rpc.test.ts`

**Interfaces:**
- Produces (imported by every engine task via `@openfusion/shared`):
  - `JSONRPC_VERSION: "2.0"`
  - `RpcErrorCodes: { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL_ERROR: -32603 }`
  - `RpcRequestSchema` / `RpcResponseSchema` / `RpcErrorSchema` / `RpcIdSchema` (zod) and inferred types `RpcRequest`, `RpcResponse`, `RpcError`, `RpcId`
  - A request without `id` is a notification.

- [ ] **Step 1: Create the package manifest and tsconfig**

`packages/shared/package.json`:

```json
{
  "name": "@openfusion/shared",
  "version": "0.0.1",
  "type": "module",
  "license": "Apache-2.0",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 2: Install dependencies**

Run: `pnpm add zod --filter @openfusion/shared && pnpm add -D typescript vitest @types/node --filter @openfusion/shared`
Expected: dependencies appear in `packages/shared/package.json`.

- [ ] **Step 3: Write the failing test**

`packages/shared/test/rpc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RpcRequestSchema, RpcResponseSchema } from "../src/index.js";

describe("RpcRequestSchema", () => {
  it("accepts a valid request", () => {
    const parsed = RpcRequestSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      method: "engine.ping",
    });
    expect(parsed.method).toBe("engine.ping");
    expect(parsed.id).toBe(1);
  });

  it("accepts a notification (no id)", () => {
    const parsed = RpcRequestSchema.parse({ jsonrpc: "2.0", method: "log" });
    expect(parsed.id).toBeUndefined();
  });

  it("rejects a missing jsonrpc field", () => {
    expect(RpcRequestSchema.safeParse({ id: 1, method: "x" }).success).toBe(false);
  });

  it("rejects an empty method", () => {
    expect(
      RpcRequestSchema.safeParse({ jsonrpc: "2.0", id: 1, method: "" }).success,
    ).toBe(false);
  });
});

describe("RpcResponseSchema", () => {
  it("accepts a result-only response", () => {
    const ok = RpcResponseSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      result: { pong: true },
    });
    expect(ok.success).toBe(true);
  });

  it("accepts an error-only response", () => {
    const ok = RpcResponseSchema.safeParse({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a response with both result and error", () => {
    const bad = RpcResponseSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: { code: -32603, message: "boom" },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a response with neither result nor error", () => {
    expect(
      RpcResponseSchema.safeParse({ jsonrpc: "2.0", id: 1 }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @openfusion/shared test`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 5: Write the schemas**

`packages/shared/src/rpc.ts`:

```ts
import { z } from "zod";

export const JSONRPC_VERSION = "2.0" as const;

export const RpcErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export const RpcIdSchema = z.union([z.string(), z.number()]);

export const RpcRequestSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RpcIdSchema.optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const RpcResponseSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: RpcIdSchema.nullable(),
    result: z.unknown().optional(),
    error: RpcErrorSchema.optional(),
  })
  .refine((r) => (r.result === undefined) !== (r.error === undefined), {
    message: "response must have exactly one of result or error",
  });

export type RpcId = z.infer<typeof RpcIdSchema>;
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type RpcError = z.infer<typeof RpcErrorSchema>;
export type RpcResponse = z.infer<typeof RpcResponseSchema>;
```

`packages/shared/src/index.ts`:

```ts
export * from "./rpc.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @openfusion/shared test`
Expected: PASS (8 tests).

- [ ] **Step 7: Verify the package builds**

Run: `pnpm --filter @openfusion/shared build`
Expected: `packages/shared/dist/index.js` and `index.d.ts` exist.

- [ ] **Step 8: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat(shared): JSON-RPC 2.0 envelope schemas and error codes"
```

---

### Task 3: Engine package + ndjson codec

**Files:**
- Create: `packages/engine/package.json`, `packages/engine/tsconfig.json`, `packages/engine/src/rpc/ndjson.ts`
- Test: `packages/engine/test/ndjson.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure string handling).
- Produces:
  - `class NdjsonDecoder { push(chunk: string): DecodedLine[] }` where `type DecodedLine = { ok: true; value: unknown } | { ok: false; raw: string }` — buffers partial lines across chunks; blank lines skipped; invalid JSON surfaces as `ok: false`.
  - `function encodeNdjson(message: unknown): string` — `JSON.stringify` + trailing `"\n"`.

- [ ] **Step 1: Create the package manifest and tsconfig**

`packages/engine/package.json`:

```json
{
  "name": "@openfusion/engine",
  "version": "0.0.1",
  "type": "module",
  "license": "Apache-2.0",
  "bin": { "openfusion-engine": "./dist/main.js" },
  "exports": {
    ".": { "types": "./dist/engine.d.ts", "import": "./dist/engine.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  }
}
```

`packages/engine/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 2: Install dependencies**

Run: `pnpm add '@openfusion/shared@workspace:*' --filter @openfusion/engine && pnpm add -D typescript vitest @types/node --filter @openfusion/engine`
Expected: engine package.json gains the workspace dependency and dev tools.

- [ ] **Step 3: Write the failing test**

`packages/engine/test/ndjson.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NdjsonDecoder, encodeNdjson } from "../src/rpc/ndjson.js";

describe("NdjsonDecoder", () => {
  it("decodes a single complete line", () => {
    const decoder = new NdjsonDecoder();
    const out = decoder.push('{"a":1}\n');
    expect(out).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it("decodes two messages arriving in one chunk", () => {
    const decoder = new NdjsonDecoder();
    const out = decoder.push('{"a":1}\n{"b":2}\n');
    expect(out).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
    ]);
  });

  it("buffers a message split across chunks", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push('{"a"')).toEqual([]);
    expect(decoder.push(":1}\n")).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it("reports invalid JSON lines without throwing", () => {
    const decoder = new NdjsonDecoder();
    const out = decoder.push("not json\n");
    expect(out).toEqual([{ ok: false, raw: "not json" }]);
  });

  it("skips blank lines", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push("\n\n")).toEqual([]);
  });
});

describe("encodeNdjson", () => {
  it("appends a newline to serialized JSON", () => {
    expect(encodeNdjson({ a: 1 })).toBe('{"a":1}\n');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @openfusion/engine test`
Expected: FAIL — cannot resolve `../src/rpc/ndjson.js`.

- [ ] **Step 5: Write the codec**

`packages/engine/src/rpc/ndjson.ts`:

```ts
export type DecodedLine =
  | { ok: true; value: unknown }
  | { ok: false; raw: string };

export class NdjsonDecoder {
  #buffer = "";

  push(chunk: string): DecodedLine[] {
    this.#buffer += chunk;
    const out: DecodedLine[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).trim();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          out.push({ ok: true, value: JSON.parse(line) });
        } catch {
          out.push({ ok: false, raw: line });
        }
      }
      newlineIndex = this.#buffer.indexOf("\n");
    }
    return out;
  }
}

export function encodeNdjson(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @openfusion/engine test`
Expected: PASS (6 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/engine pnpm-lock.yaml
git commit -m "feat(engine): ndjson codec for stdio JSON-RPC framing"
```

---

### Task 4: RPC dispatcher

**Files:**
- Create: `packages/engine/src/rpc/dispatcher.ts`
- Test: `packages/engine/test/dispatcher.test.ts`

**Interfaces:**
- Consumes: `RpcRequestSchema`, `RpcErrorCodes`, `JSONRPC_VERSION`, type `RpcResponse` from `@openfusion/shared` (Task 2).
- Produces:
  - `type RpcHandler = (params: unknown) => Promise<unknown> | unknown`
  - `class RpcDispatcher { register(method: string, handler: RpcHandler): void; dispatch(message: unknown): Promise<RpcResponse | null>; parseError(): RpcResponse }`
  - Semantics: invalid envelope → `INVALID_REQUEST` (id null); unknown method → `METHOD_NOT_FOUND`; handler throw → `INTERNAL_ERROR` with the error message; notifications (no id) always return `null`; duplicate `register` throws.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/dispatcher.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { RpcDispatcher } from "../src/rpc/dispatcher.js";

function makeDispatcher(): RpcDispatcher {
  const dispatcher = new RpcDispatcher();
  dispatcher.register("echo", (params) => ({ echoed: params }));
  dispatcher.register("boom", () => {
    throw new Error("kaboom");
  });
  dispatcher.register("nothing", () => undefined);
  return dispatcher;
}

describe("RpcDispatcher", () => {
  it("dispatches a request to its handler and wraps the result", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 7,
      method: "echo",
      params: { x: 1 },
    });
    expect(res).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { echoed: { x: 1 } },
    });
  });

  it("normalizes an undefined handler result to null", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "nothing",
    });
    expect(res).toEqual({ jsonrpc: "2.0", id: 1, result: null });
  });

  it("returns METHOD_NOT_FOUND for unknown methods, preserving id", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: "abc",
      method: "nope",
    });
    expect(res?.id).toBe("abc");
    expect(res?.error?.code).toBe(RpcErrorCodes.METHOD_NOT_FOUND);
  });

  it("returns INVALID_REQUEST with null id for a malformed envelope", async () => {
    const res = await makeDispatcher().dispatch({ method: 42 });
    expect(res?.id).toBeNull();
    expect(res?.error?.code).toBe(RpcErrorCodes.INVALID_REQUEST);
  });

  it("converts a handler throw into INTERNAL_ERROR with the message", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "boom",
    });
    expect(res?.error?.code).toBe(RpcErrorCodes.INTERNAL_ERROR);
    expect(res?.error?.message).toBe("kaboom");
  });

  it("returns null for notifications (no id), even on error", async () => {
    const dispatcher = makeDispatcher();
    expect(
      await dispatcher.dispatch({ jsonrpc: "2.0", method: "echo", params: 1 }),
    ).toBeNull();
    expect(
      await dispatcher.dispatch({ jsonrpc: "2.0", method: "boom" }),
    ).toBeNull();
  });

  it("throws when registering a duplicate method name", () => {
    const dispatcher = makeDispatcher();
    expect(() => dispatcher.register("echo", () => null)).toThrow(
      /already registered/,
    );
  });

  it("produces a PARSE_ERROR response helper", () => {
    const res = makeDispatcher().parseError();
    expect(res.id).toBeNull();
    expect(res.error?.code).toBe(RpcErrorCodes.PARSE_ERROR);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/shared build && pnpm --filter @openfusion/engine test`
(shared must be built once so the engine can resolve `@openfusion/shared`)
Expected: dispatcher tests FAIL — cannot resolve `../src/rpc/dispatcher.js`; ndjson tests still PASS.

- [ ] **Step 3: Write the dispatcher**

`packages/engine/src/rpc/dispatcher.ts`:

```ts
import {
  JSONRPC_VERSION,
  RpcErrorCodes,
  RpcRequestSchema,
  type RpcResponse,
} from "@openfusion/shared";

export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

export class RpcDispatcher {
  #handlers = new Map<string, RpcHandler>();

  register(method: string, handler: RpcHandler): void {
    if (this.#handlers.has(method)) {
      throw new Error(`method already registered: ${method}`);
    }
    this.#handlers.set(method, handler);
  }

  parseError(): RpcResponse {
    return {
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: { code: RpcErrorCodes.PARSE_ERROR, message: "parse error" },
    };
  }

  async dispatch(message: unknown): Promise<RpcResponse | null> {
    const parsed = RpcRequestSchema.safeParse(message);
    if (!parsed.success) {
      return {
        jsonrpc: JSONRPC_VERSION,
        id: null,
        error: {
          code: RpcErrorCodes.INVALID_REQUEST,
          message: "invalid request",
        },
      };
    }
    const { id, method, params } = parsed.data;
    const handler = this.#handlers.get(method);
    if (handler === undefined) {
      if (id === undefined) return null;
      return {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: {
          code: RpcErrorCodes.METHOD_NOT_FOUND,
          message: `method not found: ${method}`,
        },
      };
    }
    try {
      const result = await handler(params);
      if (id === undefined) return null;
      // JSON-RPC requires a result member; undefined would serialize to nothing.
      return { jsonrpc: JSONRPC_VERSION, id, result: result ?? null };
    } catch (err) {
      if (id === undefined) return null;
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: { code: RpcErrorCodes.INTERNAL_ERROR, message },
      };
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @openfusion/engine test`
Expected: PASS (14 tests across ndjson + dispatcher).

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): JSON-RPC dispatcher with notification and error semantics"
```

---

### Task 5: Core engine methods (`engine.ping`, `engine.info`)

**Files:**
- Create: `packages/engine/src/version.ts`, `packages/engine/src/methods.ts`, `packages/engine/src/engine.ts`
- Test: `packages/engine/test/methods.test.ts`

**Interfaces:**
- Consumes: `RpcDispatcher` (Task 4).
- Produces:
  - `ENGINE_VERSION: string` (starts `"0.0.1"`)
  - `registerCoreMethods(dispatcher: RpcDispatcher): void` — registers `engine.ping` → `{ pong: true, version: string }` and `engine.info` → `{ version, nodeVersion, pid, cwd }`
  - `createEngine(): RpcDispatcher` — dispatcher with all core methods registered; the stdio entry (Task 6) and all future modules (wiki, models, …) hang their methods off this factory.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/methods.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { ENGINE_VERSION } from "../src/version.js";

describe("core methods", () => {
  it("engine.ping returns pong and the engine version", async () => {
    const res = await createEngine().dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "engine.ping",
    });
    expect(res?.result).toEqual({ pong: true, version: ENGINE_VERSION });
  });

  it("engine.info reports process facts", async () => {
    const res = await createEngine().dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "engine.info",
    });
    const info = res?.result as {
      version: string;
      nodeVersion: string;
      pid: number;
      cwd: string;
    };
    expect(info.version).toBe(ENGINE_VERSION);
    expect(info.nodeVersion).toBe(process.version);
    expect(info.pid).toBe(process.pid);
    expect(typeof info.cwd).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/engine test`
Expected: methods tests FAIL — cannot resolve `../src/engine.js`.

- [ ] **Step 3: Write version, methods, and the engine factory**

`packages/engine/src/version.ts`:

```ts
export const ENGINE_VERSION = "0.0.1";
```

`packages/engine/src/methods.ts`:

```ts
import type { RpcDispatcher } from "./rpc/dispatcher.js";
import { ENGINE_VERSION } from "./version.js";

export function registerCoreMethods(dispatcher: RpcDispatcher): void {
  dispatcher.register("engine.ping", () => ({
    pong: true,
    version: ENGINE_VERSION,
  }));
  dispatcher.register("engine.info", () => ({
    version: ENGINE_VERSION,
    nodeVersion: process.version,
    pid: process.pid,
    cwd: process.cwd(),
  }));
}
```

`packages/engine/src/engine.ts`:

```ts
import { RpcDispatcher } from "./rpc/dispatcher.js";
import { registerCoreMethods } from "./methods.js";

export function createEngine(): RpcDispatcher {
  const dispatcher = new RpcDispatcher();
  registerCoreMethods(dispatcher);
  return dispatcher;
}

export { RpcDispatcher } from "./rpc/dispatcher.js";
export type { RpcHandler } from "./rpc/dispatcher.js";
export { NdjsonDecoder, encodeNdjson } from "./rpc/ndjson.js";
export type { DecodedLine } from "./rpc/ndjson.js";
export { ENGINE_VERSION } from "./version.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @openfusion/engine test`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): core methods engine.ping and engine.info behind createEngine factory"
```

---

### Task 6: Stdio transport + process entry

**Files:**
- Create: `packages/engine/src/main.ts`
- Test: `packages/engine/test/stdio.test.ts`

**Interfaces:**
- Consumes: `createEngine` (Task 5), `NdjsonDecoder`/`encodeNdjson` (Task 3), `parseError` (Task 4).
- Produces: the executable process contract the Tauri shell (M7) relies on — spawn `node dist/main.js`, write ndjson requests to stdin, read ndjson responses from stdout, diagnostics on stderr, exit 0 when stdin closes.

- [ ] **Step 1: Write the failing integration test**

`packages/engine/test/stdio.test.ts`:

```ts
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/main.js",
);

function requestOnce(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout waiting for response; stdout so far: ${out}`));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("\n")) {
        clearTimeout(timer);
        child.stdin.end();
        resolve(out.slice(0, out.indexOf("\n")));
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.write(payload);
  });
}

describe("stdio transport", () => {
  it("answers engine.ping over ndjson", async () => {
    const line = await requestOnce(
      '{"jsonrpc":"2.0","id":1,"method":"engine.ping"}\n',
    );
    const response = JSON.parse(line) as {
      id: number;
      result: { pong: boolean; version: string };
    };
    expect(response.id).toBe(1);
    expect(response.result.pong).toBe(true);
  }, 15_000);

  it("answers a parse error for garbage input", async () => {
    const line = await requestOnce("this is not json\n");
    const response = JSON.parse(line) as {
      id: null;
      error: { code: number };
    };
    expect(response.id).toBeNull();
    expect(response.error.code).toBe(-32700);
  }, 15_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/engine build && pnpm --filter @openfusion/engine test`
Expected: stdio tests FAIL (timeout or spawn error — `dist/main.js` does not exist yet because `main.ts` hasn't been written).

- [ ] **Step 3: Write the entry point**

`packages/engine/src/main.ts`:

```ts
#!/usr/bin/env node
import process from "node:process";
import { createEngine } from "./engine.js";
import { NdjsonDecoder, encodeNdjson } from "./rpc/ndjson.js";

// stdout carries JSON-RPC only; all diagnostics go to stderr (spec §4.1).
async function main(): Promise<void> {
  const dispatcher = createEngine();
  const decoder = new NdjsonDecoder();
  process.stdin.setEncoding("utf8");
  process.stderr.write(`openfusion-engine started (pid ${process.pid})\n`);
  for await (const chunk of process.stdin) {
    for (const line of decoder.push(chunk as string)) {
      const response = line.ok
        ? await dispatcher.dispatch(line.value)
        : dispatcher.parseError();
      if (response !== null) {
        process.stdout.write(encodeNdjson(response));
      }
    }
  }
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`fatal: ${detail}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Rebuild and run tests to verify they pass**

Run: `pnpm --filter @openfusion/engine build && pnpm --filter @openfusion/engine test`
Expected: PASS (18 tests, including both stdio integration tests).

- [ ] **Step 5: Smoke it by hand**

Run: `printf '{"jsonrpc":"2.0","id":1,"method":"engine.info"}\n' | node packages/engine/dist/main.js 2>/dev/null`
Expected: one JSON line containing `"version":"0.0.1"` and this machine's node version.

- [ ] **Step 6: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): stdio ndjson transport and process entry point"
```

---

### Task 7: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root scripts `build`/`typecheck`/`test` (Task 1) and both packages' scripts.
- Produces: the gate every future milestone runs under. Build MUST precede test (stdio integration test executes `dist/main.js`; engine imports resolve `@openfusion/shared` from its `dist`).

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm typecheck
      - run: pnpm test
```

(ubuntu runner is sufficient and cheap for the headless engine; macOS runners arrive with the Tauri shell in M7.)

- [ ] **Step 2: Verify the same sequence locally**

Run: `pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm test`
Expected: all four commands succeed; final line reports all test files passed.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build, typecheck, and test on push and pull request"
```

---

## Milestone exit checklist

- [ ] `pnpm install && pnpm build && pnpm typecheck && pnpm test` green from a clean checkout
- [ ] `printf '{"jsonrpc":"2.0","id":1,"method":"engine.ping"}\n' | node packages/engine/dist/main.js 2>/dev/null` prints a pong line
- [ ] CI workflow file present (goes green on first push once a GitHub remote exists)
- [ ] Next action: write `docs/superpowers/plans/<date>-m1-wiki-symbol-layer.md` per the roadmap
