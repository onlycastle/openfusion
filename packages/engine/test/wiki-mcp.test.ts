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
