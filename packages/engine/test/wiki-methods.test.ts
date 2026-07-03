import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("query returns SERVER_ERROR for a non-git directory (no cache side effect)", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-nogit-q-"));
    engine = createEngine();
    const res = await call("engine.wiki.query", { projectDir: dir, symbol: "x" });
    expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(existsSync(path.join(dir, ".openfusion"))).toBe(false);
  });

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

  it("status on a never-built project reports built:false without creating .openfusion", async () => {
    makeRepo();
    const res = await call("engine.wiki.status", { projectDir: dir });
    expect(res.result.built).toBe(false);
    expect(existsSync(path.join(dir, ".openfusion"))).toBe(false);
  });

  // Fix 2: after external deletion of .openfusion/cache (user `rm -rf`,
  // another process's schema-recreate), a cached WikiStore handle would
  // keep serving reads from its now-unlinked inode while engine.wiki.status
  // reported built:false — a live-vs-cache split brain. getStore must
  // revalidate the cache entry against the filesystem on every hit.
  it("query does not serve stale data after external deletion of .openfusion", async () => {
    makeRepo();
    await call("engine.wiki.build", { projectDir: dir });
    const before = await call("engine.wiki.query", { projectDir: dir, symbol: "xray" });
    expect(before.result.definitions.length).toBeGreaterThanOrEqual(1);

    rmSync(path.join(dir, ".openfusion"), { recursive: true, force: true });

    const stale = await call("engine.wiki.query", { projectDir: dir, symbol: "xray" });
    expect(stale.error).toBeUndefined();
    expect(stale.result.definitions.length).toBe(0);

    const rebuild = await call("engine.wiki.build", { projectDir: dir });
    expect(rebuild.error).toBeUndefined();
    expect(existsSync(path.join(dir, ".openfusion/cache/wiki.db"))).toBe(true);
  }, 30_000);

  it("map with low budget truncates and reports truncated:true", async () => {
    makeRepo();
    // Create 8+ .ts files with enough content to exceed 64-token budget when ranked
    for (let i = 0; i < 10; i++) {
      writeFileSync(
        path.join(dir, `f${i}.ts`),
        `// File ${i}: extensive content\n` +
        `export function functionNameA${i}() { return ${i}; }\n` +
        `export function functionNameB${i}() { return ${i * 2}; }\n` +
        `export function functionNameC${i}() { return ${i * 3}; }\n` +
        `export interface InterfaceType${i} { value: number; key: string; }\n`,
      );
    }
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "add files"]);

    await call("engine.wiki.build", { projectDir: dir });
    const res = await call("engine.wiki.map", { projectDir: dir, budgetTokens: 64 });
    expect(res.error).toBeUndefined();
    expect(res.result.truncated).toBe(true);
    expect(res.result.files).toBeGreaterThanOrEqual(8);
  }, 30_000);
});
