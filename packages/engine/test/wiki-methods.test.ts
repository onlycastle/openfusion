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
});
