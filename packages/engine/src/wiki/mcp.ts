import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Engine } from "../engine.js";
import { projectMcpTool } from "../tools/projections.js";
import { WIKI_MAP_TOOL_SPEC, WIKI_QUERY_TOOL_SPEC } from "../tools/registry.js";
import { querySymbols, renderMap } from "./query.js";

const MAX_MCP_REQUEST_BYTES = 1024 * 1024;
const MAX_MCP_CONCURRENCY = 8;

class McpRequestTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const value = chunk as Buffer;
    bytes += value.length;
    if (bytes > MAX_MCP_REQUEST_BYTES) throw new McpRequestTooLargeError();
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined;
}

// Builds a fresh McpServer with the wiki tools registered. Called once per
// request (see the request handler below) rather than once per process:
// the SDK's Protocol.connect() throws "Already connected to a transport..."
// if a prior request's transport is still attached (e.g. a client that
// never completes its body), which would otherwise wedge the shared server
// and 500 every later request. A fresh McpServer per request is the SDK's
// documented stateless pattern for this transport.
function buildMcpServer(engine: Engine, projectDir: string): McpServer {
  const mcp = new McpServer({ name: "openfusion-wiki", version: "0.0.1" });

  mcp.registerTool(
    WIKI_QUERY_TOOL_SPEC.id,
    projectMcpTool(WIKI_QUERY_TOOL_SPEC),
    ({ symbol }) => {
      const store = engine.wiki.getStore(projectDir);
      if (store.getMeta("head_sha") === null) return notBuiltResult();
      const payload = { ...querySymbols(store, symbol), pages: [] };
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  );

  mcp.registerTool(
    WIKI_MAP_TOOL_SPEC.id,
    projectMcpTool(WIKI_MAP_TOOL_SPEC),
    ({ query, budgetTokens }) => {
      const store = engine.wiki.getStore(projectDir);
      if (store.getMeta("head_sha") === null) return notBuiltResult();
      const map = renderMap(store, budgetTokens ?? 1024, query);
      return { content: [{ type: "text", text: map }] };
    },
  );

  return mcp;
}

// Both tools used to read straight from the store and would silently
// return empty results when the wiki was never built (git guard passes,
// but no engine.wiki.build has run yet) — indistinguishable from "there's
// genuinely nothing here." Callers need an explicit signal instead.
function notBuiltResult(): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: "wiki not built — run engine.wiki.build first" }],
    isError: true,
  };
}

export class McpWikiServer {
  private constructor(
    readonly projectDir: string,
    readonly url: string,
    readonly bearerToken: string,
    private readonly http: Server,
  ) {}

  static async start(engine: Engine, projectDir: string): Promise<McpWikiServer> {
    const bearerToken = randomBytes(32).toString("base64url");
    const expectedAuthorization = Buffer.from(`Bearer ${bearerToken}`, "utf8");
    let activeRequests = 0;
    const http = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        if (req.method !== "POST" || req.url !== "/mcp") {
          res.writeHead(404).end();
          return;
        }
        const authorization = typeof req.headers.authorization === "string"
          ? Buffer.from(req.headers.authorization, "utf8")
          : Buffer.alloc(0);
        if (
          authorization.length !== expectedAuthorization.length
          || !timingSafeEqual(authorization, expectedAuthorization)
        ) {
          res.writeHead(401).end();
          return;
        }
        const contentLength = Number(req.headers["content-length"] ?? 0);
        if (Number.isFinite(contentLength) && contentLength > MAX_MCP_REQUEST_BYTES) {
          res.writeHead(413).end();
          return;
        }
        if (activeRequests >= MAX_MCP_CONCURRENCY) {
          res.writeHead(429, { "Retry-After": "1" }).end();
          return;
        }
        activeRequests += 1;
        try {
        const mcp = buildMcpServer(engine, projectDir);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on("close", () => void transport.close());
        await mcp.connect(transport);
        await transport.handleRequest(req, res, await readBody(req));
        } finally {
          activeRequests -= 1;
        }
      })().catch((err: unknown) => {
        engine.log(`mcp request error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) {
          res.writeHead(err instanceof McpRequestTooLargeError ? 413 : 500).end();
        }
      });
    });

    // Bound so a stalled client (headers sent, body never completes) can't
    // hold a connection — and this server's stop() — open indefinitely.
    http.requestTimeout = 30_000;
    http.headersTimeout = 15_000;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      http.once("error", onError);
      http.listen(0, "127.0.0.1", () => {
        http.off("error", onError);
        resolve();
      });
    });
    const address = http.address();
    if (address === null || typeof address === "string") {
      throw new Error("mcp server failed to bind a port");
    }
    const url = `http://127.0.0.1:${address.port}/mcp`;
    engine.log("mcp wiki server started");
    return new McpWikiServer(projectDir, url, bearerToken, http);
  }

  // http.Server.close() alone waits indefinitely for open sockets to end on
  // their own, so a stalled connection would hang this (and therefore
  // Engine.close()) forever. closeAllConnections() forces every open
  // socket closed immediately alongside the close() callback.
  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.close((err) => (err ? reject(err) : resolve()));
      this.http.closeAllConnections();
    });
  }
}
