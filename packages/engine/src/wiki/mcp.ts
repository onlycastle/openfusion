import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Engine } from "../engine.js";
import { querySymbols, renderMap } from "./query.js";

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
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
    "wiki_query",
    {
      description:
        "Look up where a symbol is defined and referenced in this project's code index",
      inputSchema: { symbol: z.string().min(1) },
    },
    ({ symbol }) => {
      const store = engine.wiki.getStore(projectDir);
      if (store.getMeta("head_sha") === null) return notBuiltResult();
      const payload = querySymbols(store, symbol);
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
      if (store.getMeta("head_sha") === null) return notBuiltResult();
      const map = renderMap(store, budgetTokens ?? 1024);
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
    private readonly http: Server,
  ) {}

  static async start(engine: Engine, projectDir: string): Promise<McpWikiServer> {
    const http = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        if (req.method !== "POST" || req.url !== "/mcp") {
          res.writeHead(404).end();
          return;
        }
        const mcp = buildMcpServer(engine, projectDir);
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

    // Bound so a stalled client (headers sent, body never completes) can't
    // hold a connection — and this server's stop() — open indefinitely.
    http.requestTimeout = 30_000;
    http.headersTimeout = 15_000;

    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (address === null || typeof address === "string") {
      throw new Error("mcp server failed to bind a port");
    }
    const url = `http://127.0.0.1:${address.port}/mcp`;
    engine.log(`mcp wiki server for ${projectDir} at ${url}`);
    return new McpWikiServer(projectDir, url, http);
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
