import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { registerMethod } from "../rpc/register.js";
import { buildIndex, getHeadSha, type IndexStats } from "./indexer.js";
import { McpWikiServer } from "./mcp.js";
import { WikiParser } from "./parser.js";
import { rankFiles, renderRepoMap } from "./rank.js";
import { openWikiStore, type WikiStore } from "./store.js";

const ProjectParamsSchema = z.object({ projectDir: z.string().min(1) });
const QueryParamsSchema = ProjectParamsSchema.extend({
  symbol: z.string().min(1),
});
const MapParamsSchema = ProjectParamsSchema.extend({
  budgetTokens: z.number().int().min(64).max(32768).optional(),
});
const EmptyParamsSchema = z.object({});

// Resolve to the canonical, symlink-free path so distinct spellings of the
// same directory (or a symlinked one) share one store and one in-flight
// build. If the directory doesn't exist yet, fall back to the resolved
// (non-canonicalized) path — the git guard in requireHeadSha rejects it anyway.
function keyFor(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export class WikiService {
  #stores = new Map<string, WikiStore>();
  #parserPromise: Promise<WikiParser> | undefined;
  #building = new Map<string, Promise<IndexStats>>();
  #mcpServers = new Map<string, McpWikiServer>();

  getStore(projectDir: string): WikiStore {
    const key = keyFor(projectDir);
    let store = this.#stores.get(key);
    if (store === undefined) {
      store = openWikiStore(key);
      this.#stores.set(key, store);
    }
    return store;
  }

  getMcpServers(): McpWikiServer[] {
    return [...this.#mcpServers.values()];
  }

  // Idempotent per resolved root: a second start() for the same project
  // returns the already-running server instead of binding a second port.
  async startMcpServer(engine: Engine, projectDir: string): Promise<McpWikiServer> {
    const key = keyFor(projectDir);
    const existing = this.#mcpServers.get(key);
    if (existing !== undefined) return existing;
    const server = await McpWikiServer.start(engine, key);
    this.#mcpServers.set(key, server);
    return server;
  }

  async stopMcpServer(projectDir: string): Promise<boolean> {
    const key = keyFor(projectDir);
    const server = this.#mcpServers.get(key);
    if (server === undefined) return false;
    this.#mcpServers.delete(key);
    await server.stop();
    return true;
  }

  getParser(): Promise<WikiParser> {
    this.#parserPromise ??= WikiParser.create();
    return this.#parserPromise;
  }

  // Concurrent build() calls for the same project coalesce onto one in-flight
  // promise instead of racing two builds against the same sqlite file.
  build(projectDir: string): Promise<IndexStats> {
    const key = keyFor(projectDir);
    const inFlight = this.#building.get(key);
    if (inFlight !== undefined) return inFlight;

    const promise = (async () => {
      const store = this.getStore(projectDir);
      const parser = await this.getParser();
      return buildIndex(key, store, parser);
    })().finally(() => {
      this.#building.delete(key);
    });
    this.#building.set(key, promise);
    return promise;
  }

  async close(): Promise<void> {
    for (const server of this.#mcpServers.values()) {
      try {
        await server.stop();
      } catch {
        // Best-effort: one server failing to stop must not block the rest
        // of shutdown (store/parser disposal below).
      }
    }
    this.#mcpServers.clear();
    for (const store of this.#stores.values()) {
      try {
        store.close();
      } catch {
        // Best-effort: one store failing to close must not stop the rest
        // from closing or block parser disposal below.
      }
    }
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
      const stats = await engine.wiki.build(projectDir);
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
      requireHeadSha(projectDir);
      const store = engine.wiki.getStore(projectDir);
      return {
        definitions: store.symbolsByName(symbol),
        references: store.refsByName(symbol),
      };
    },
  );

  registerMethod(
    engine.dispatcher,
    "engine.wiki.map",
    MapParamsSchema,
    ({ projectDir, budgetTokens }) => {
      requireHeadSha(projectDir);
      const store = engine.wiki.getStore(projectDir);
      if (store.getMeta("head_sha") === null) {
        throw new RpcMethodError(
          RpcErrorCodes.SERVER_ERROR,
          "wiki not built — run engine.wiki.build first",
        );
      }
      const ranked = rankFiles(store.allSymbols(), store.allRefs());
      const map = renderRepoMap(ranked, budgetTokens ?? 1024);
      // each rendered block is exactly two lines (file + symbols)
      const rendered = map.length === 0 ? 0 : map.trimEnd().split("\n").length / 2;
      return { map, files: ranked.length, truncated: rendered < ranked.length };
    },
  );

  registerMethod(
    engine.dispatcher,
    "engine.mcp.start",
    ProjectParamsSchema,
    async ({ projectDir }) => {
      requireHeadSha(projectDir);
      const server = await engine.wiki.startMcpServer(engine, projectDir);
      return { url: server.url };
    },
  );

  registerMethod(
    engine.dispatcher,
    "engine.mcp.stop",
    ProjectParamsSchema,
    async ({ projectDir }) => {
      const stopped = await engine.wiki.stopMcpServer(projectDir);
      return { stopped };
    },
  );

  registerMethod(engine.dispatcher, "engine.mcp.status", EmptyParamsSchema, () => {
    const servers = engine.wiki
      .getMcpServers()
      .map((s) => ({ projectDir: s.projectDir, url: s.url }));
    return { servers };
  });
}
