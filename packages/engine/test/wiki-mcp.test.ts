import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import { WIKI_QUERY_TOOL_SPEC } from "../src/tools/registry.js";
import { renderToolDescription } from "../src/tools/spec.js";

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

// Opens a raw TCP connection to the MCP server's port and writes a POST
// /mcp request whose body never completes (Content-Length: 999 but the
// socket is never ended) — simulates a client that stalls mid-request.
function authenticatedTransport(url: string, bearerToken: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
}

async function openStalledConnection(url: string, bearerToken: string): Promise<net.Socket> {
  const parsed = new URL(url);
  const socket = net.createConnection({
    host: parsed.hostname,
    port: Number(parsed.port),
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    `POST ${parsed.pathname} HTTP/1.1\r\nHost: ${parsed.host}\r\nAuthorization: Bearer ${bearerToken}\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{"partial":`,
  );
  return socket;
}

describe("MCP wiki server", () => {
  it("serves wiki_query over streamable HTTP to the official client", async () => {
    makeRepo();
    await rpc("engine.wiki.build", { projectDir: dir });
    const started = await rpc("engine.mcp.start", { projectDir: dir });
    expect(started.error).toBeUndefined();
    const url = started.result.url as string;
    const bearerToken = started.result.bearerToken as string;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(authenticatedTransport(url, bearerToken));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["wiki_map", "wiki_query"]);
    const queryTool = tools.tools.find((tool) => tool.name === "wiki_query");
    expect(queryTool?.description).toBe(renderToolDescription(WIKI_QUERY_TOOL_SPEC));
    expect(queryTool?.inputSchema).toMatchObject({
      type: "object",
      required: ["symbol"],
      properties: { symbol: { type: "string", minLength: 1 } },
      additionalProperties: false,
    });
    expect(queryTool?.inputSchema).not.toHaveProperty("properties.query");
    const result = await client.callTool({
      name: "wiki_query",
      arguments: { symbol: "mercury" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    const payload = JSON.parse(text);
    expect(payload.definitions[0].file).toBe("m.ts");
    expect(payload.pages).toEqual([]);
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
    expect(JSON.stringify(status.result)).not.toContain(a.result.bearerToken);
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

  it("requires its ephemeral bearer token and rejects oversized requests", async () => {
    makeRepo();
    const started = await rpc("engine.mcp.start", { projectDir: dir });
    const url = started.result.url as string;
    const bearerToken = started.result.bearerToken as string;

    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unauthorized.status).toBe(401);

    const oversized = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      body: Buffer.alloc(1024 * 1024 + 1, 32),
    });
    expect(oversized.status).toBe(413);
  });

  // Finding 1: a stalled client used to wedge the shared McpServer — every
  // later request would 500 forever once a prior transport was left
  // attached. A fresh McpServer per request must keep later requests
  // working even while an earlier one is stuck mid-body.
  it("a stalled request does not wedge the server for later requests", async () => {
    makeRepo();
    await rpc("engine.wiki.build", { projectDir: dir });
    const started = await rpc("engine.mcp.start", { projectDir: dir });
    expect(started.error).toBeUndefined();
    const url = started.result.url as string;
    const bearerToken = started.result.bearerToken as string;

    const socket = await openStalledConnection(url, bearerToken);
    try {
      const client = new Client({ name: "test-client", version: "0.0.1" });
      await client.connect(authenticatedTransport(url, bearerToken));
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["wiki_map", "wiki_query"]);
      await client.close();
    } finally {
      socket.destroy();
    }
  }, 30_000);

  // Finding 2: http.Server.close() waits indefinitely for open sockets, so
  // a stalled connection could hang engine.mcp.stop (and Engine.close)
  // forever. stop() must win a race against a stalled connection.
  it("stop resolves even with a stalled connection open", async () => {
    makeRepo();
    await rpc("engine.wiki.build", { projectDir: dir });
    const started = await rpc("engine.mcp.start", { projectDir: dir });
    expect(started.error).toBeUndefined();
    const url = started.result.url as string;
    const bearerToken = started.result.bearerToken as string;

    const socket = await openStalledConnection(url, bearerToken);
    try {
      const TIMEOUT = Symbol("timeout");
      const winner = await Promise.race([
        rpc("engine.mcp.stop", { projectDir: dir }),
        new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 5_000)),
      ]);
      expect(winner).not.toBe(TIMEOUT);
      expect((winner as { result: { stopped: boolean } }).result.stopped).toBe(true);
    } finally {
      socket.destroy();
    }
  }, 10_000);

  // Variant: zero-byte idle socket (connect and write nothing)
  it("stop resolves even with a zero-byte idle socket open", async () => {
    makeRepo();
    await rpc("engine.wiki.build", { projectDir: dir });
    const started = await rpc("engine.mcp.start", { projectDir: dir });
    expect(started.error).toBeUndefined();
    const url = started.result.url as string;

    const parsed = new URL(url);
    const socket = net.createConnection({
      host: parsed.hostname,
      port: Number(parsed.port),
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    // Write nothing — just an idle connection
    try {
      const TIMEOUT = Symbol("timeout");
      const winner = await Promise.race([
        rpc("engine.mcp.stop", { projectDir: dir }),
        new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 5_000)),
      ]);
      expect(winner).not.toBe(TIMEOUT);
      expect((winner as { result: { stopped: boolean } }).result.stopped).toBe(true);
    } finally {
      socket.destroy();
    }
  }, 10_000);

  // Fix 3: the tool handlers used to query the store directly and would
  // silently return empty definitions/refs (or an empty map) when the wiki
  // was never built, giving callers no signal to distinguish "nothing
  // found" from "nothing indexed yet". Both tools must guard on
  // getMeta("head_sha") and surface isError instead.
  it("wiki_query on a never-built wiki returns isError", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-mcp-unbuilt-"));
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    writeFileSync(path.join(dir, "u.ts"), "export function unbuilt() {}\n");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
    engine = createEngine();

    // No engine.wiki.build call — the git guard passes but the wiki is
    // never indexed.
    const started = await rpc("engine.mcp.start", { projectDir: dir });
    expect(started.error).toBeUndefined();
    const url = started.result.url as string;
    const bearerToken = started.result.bearerToken as string;

    const client = new Client({ name: "test-client", version: "0.0.1" });
    await client.connect(authenticatedTransport(url, bearerToken));
    const result = await client.callTool({
      name: "wiki_query",
      arguments: { symbol: "unbuilt" },
    });
    expect(result.isError).toBe(true);
    await client.close();
  }, 30_000);

  // Finding 3: startMcpServer's check-then-await-then-set was a TOCTOU race
  // — two concurrent engine.mcp.start calls for the same root could both
  // pass the "no existing server" check and start two servers, leaking the
  // first. Concurrent starts must coalesce onto one server.
  it("concurrent start calls for the same root coalesce onto one server", async () => {
    makeRepo();
    await rpc("engine.wiki.build", { projectDir: dir });
    const [a, b] = await Promise.all([
      rpc("engine.mcp.start", { projectDir: dir }),
      rpc("engine.mcp.start", { projectDir: dir }),
    ]);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(a.result.url).toBe(b.result.url);
    const status = await rpc("engine.mcp.status", {});
    expect(status.result.servers).toHaveLength(1);
  }, 30_000);
});
