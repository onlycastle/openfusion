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
