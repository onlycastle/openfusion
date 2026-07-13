import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import { verifyWiki } from "../src/wiki/verify.js";

let dir = "";
let engine: Engine | undefined;
afterEach(async () => {
  await engine?.close();
  engine = undefined;
  if (dir.length > 0) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function makeRepo(source = "export function mercury() {}\nmercury();\n"): void {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-wiki-verify-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(path.join(dir, "main.ts"), source);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
  engine = createEngine();
}

async function rpc(method: string, params: unknown): Promise<any> {
  return engine!.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

const passingDeliveryProbe = async () => ({
  started: true,
  toolsListed: true,
  roundtrip: true,
});

describe("wiki operational verification", () => {
  it("passes index, retrieval, and delivery for a current built wiki", async () => {
    makeRepo();
    await engine!.wiki.build(dir);
    const result = await verifyWiki(engine!, dir, { deliveryProbe: passingDeliveryProbe });
    expect(result.operational).toBe("passed");
    expect(result.quality).toBe("inconclusive");
    expect(result.stages.index.verdict).toBe("passed");
    expect(result.stages.retrieval.verdict).toBe("passed");
    expect(result.stages.delivery.verdict).toBe("passed");
  }, 30_000);

  it("performs a real official-client MCP round-trip through the RPC", async () => {
    makeRepo();
    await rpc("engine.wiki.build", { projectDir: dir });
    const response = await rpc("engine.wiki.verify", { projectDir: dir });
    expect(response.error).toBeUndefined();
    expect(response.result.operational, JSON.stringify(response.result.stages.delivery)).toBe("passed");
    expect(response.result.stages.delivery.verdict).toBe("passed");
  }, 30_000);

  it("continues to verify the committed snapshot when the working tree is dirty", async () => {
    makeRepo();
    await engine!.wiki.build(dir);
    writeFileSync(path.join(dir, "main.ts"), "export function changed() {}\n");
    const result = await verifyWiki(engine!, dir, { deliveryProbe: passingDeliveryProbe });
    expect(result.operational).toBe("passed");
    expect(
      result.stages.index.checks.find((check) => check.id === "wiki.source-current")?.status,
    ).toBe("passed");
    expect(result.stages.retrieval.verdict).toBe("passed");
  }, 30_000);

  it("fails without creating a database when the wiki was never built", async () => {
    makeRepo();
    const response = await rpc("engine.wiki.verify", { projectDir: dir });
    expect(response.error).toBeUndefined();
    expect(response.result.operational).toBe("failed");
    expect(existsSync(path.join(dir, ".openfusion", "cache", "wiki.db"))).toBe(false);
  }, 30_000);

  it("returns inconclusive for a repository with no supported source files", async () => {
    makeRepo("# markdown only\n");
    execFileSync("git", ["-C", dir, "mv", "main.ts", "README.md"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "docs only"]);
    await engine!.wiki.build(dir);
    const result = await verifyWiki(engine!, dir, { deliveryProbe: passingDeliveryProbe });
    expect(result.operational).toBe("inconclusive");
    expect(result.stages.index.verdict).toBe("inconclusive");
  }, 30_000);

  it("fails closed when stored coverage evidence is missing or corrupt", async () => {
    makeRepo();
    await engine!.wiki.build(dir);
    engine!.wiki.getStore(dir).setMeta("coverage", "not-json");
    const result = await verifyWiki(engine!, dir, { deliveryProbe: passingDeliveryProbe });
    expect(result.operational).toBe("failed");
    expect(
      result.stages.index.checks.find((check) => check.id === "wiki.coverage-complete")?.status,
    ).toBe("failed");
  }, 30_000);

  it("fails delivery when the required MCP tools are not available", async () => {
    makeRepo();
    await engine!.wiki.build(dir);
    const result = await verifyWiki(engine!, dir, {
      deliveryProbe: async () => ({
        started: true,
        toolsListed: false,
        roundtrip: false,
        reasonCode: "mcp-tools-missing",
      }),
    });
    expect(result.operational).toBe("failed");
    expect(result.stages.delivery.verdict).toBe("failed");
  }, 30_000);

  it("removes stale entries for newly oversized source files", async () => {
    makeRepo();
    await engine!.wiki.build(dir);
    writeFileSync(
      path.join(dir, "main.ts"),
      `export function mercury() {}\n// ${"x".repeat(1024 * 1024)}\n`,
    );
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "oversized"]);
    await engine!.wiki.build(dir);
    const result = await verifyWiki(engine!, dir, { deliveryProbe: passingDeliveryProbe });
    expect(result.operational).toBe("inconclusive");
    expect(
      result.stages.index.checks.find((check) => check.id === "wiki.coverage-complete")?.status,
    ).toBe("passed");
    expect(engine!.wiki.getStore(dir).symbolsByName("mercury")).toEqual([]);
  }, 30_000);
});
