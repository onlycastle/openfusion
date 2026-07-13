import { existsSync } from "node:fs";
import { z } from "zod";
import { RpcErrorCodes, type WikiBuildProgress } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { requireGitRepo, resolveProjectKey } from "../rpc/guards.js";
import { registerMethod } from "../rpc/register.js";
import { buildIndex, type BuildIndexProgress, type IndexStats } from "./indexer.js";
import { McpWikiServer } from "./mcp.js";
import { WikiParser } from "./parser.js";
import { buildRepositoryMap } from "./query.js";
import { openWikiStore, wikiDbPath, type WikiStore } from "./store.js";
import { verifyWiki } from "./verify.js";

const ProjectParamsSchema = z.object({ projectDir: z.string().min(1) });
const QueryParamsSchema = ProjectParamsSchema.extend({
  symbol: z.string().min(1),
});
const MapParamsSchema = ProjectParamsSchema.extend({
  query: z.string().min(1).max(2_000).optional(),
  budgetTokens: z.number().int().min(64).max(32768).optional(),
});
const EmptyParamsSchema = z.object({});

export class WikiService {
  #stores = new Map<string, WikiStore>();
  #parserPromise: Promise<WikiParser> | undefined;
  #building = new Map<string, Promise<IndexStats>>();
  #mcpServers = new Map<string, McpWikiServer>();
  #mcpStarting = new Map<string, Promise<McpWikiServer>>();

  getStore(projectDir: string): WikiStore {
    const key = resolveProjectKey(projectDir);
    let store = this.#stores.get(key);
    if (store !== undefined && !existsSync(wikiDbPath(key))) {
      // The cached handle's backing file is gone — an external `rm -rf
      // .openfusion` (user clean, another process's schema-recreate)
      // unlinked the inode out from under us. The open fd still reads fine
      // from the unlinked inode, so without this check every subsequent
      // read would silently serve stale data forever despite
      // engine.wiki.status correctly reporting built:false. Drop the stale
      // handle and fall through to open fresh.
      try {
        store.close();
      } catch {
        // Best-effort: closing an already-broken handle must not block
        // opening a fresh one.
      }
      this.#stores.delete(key);
      store = undefined;
    }
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
  // Concurrent calls that arrive before the first start() has resolved
  // coalesce onto the same in-flight promise (mirrors build()'s #building
  // map below) — otherwise both would pass the "no existing server" check,
  // each start its own server, and leak the first one.
  async startMcpServer(engine: Engine, projectDir: string): Promise<McpWikiServer> {
    const key = resolveProjectKey(projectDir);
    const existing = this.#mcpServers.get(key);
    if (existing !== undefined) return existing;

    const inFlight = this.#mcpStarting.get(key);
    if (inFlight !== undefined) return inFlight;

    const promise = McpWikiServer.start(engine, key)
      .then((server) => {
        this.#mcpServers.set(key, server);
        return server;
      })
      .finally(() => {
        // Clear on both success and failure so a rejected start doesn't
        // poison the map — the next call gets a fresh attempt.
        this.#mcpStarting.delete(key);
      });
    this.#mcpStarting.set(key, promise);
    return promise;
  }

  async stopMcpServer(projectDir: string): Promise<boolean> {
    const key = resolveProjectKey(projectDir);
    const server = this.#mcpServers.get(key);
    if (server === undefined) return false;
    this.#mcpServers.delete(key);
    await server.stop();
    return true;
  }

  /** Releases transient project state such as an evaluation scratch arm. */
  async releaseProject(projectDir: string): Promise<void> {
    const key = resolveProjectKey(projectDir);
    const server = this.#mcpServers.get(key);
    if (server !== undefined) {
      this.#mcpServers.delete(key);
      await server.stop().catch(() => {});
    }
    const store = this.#stores.get(key);
    if (store !== undefined) {
      this.#stores.delete(key);
      try {
        store.close();
      } catch {
        // The scratch directory may already be partially removed.
      }
    }
  }

  getParser(): Promise<WikiParser> {
    this.#parserPromise ??= WikiParser.create();
    return this.#parserPromise;
  }

  // Concurrent build() calls for the same project coalesce onto one in-flight
  // promise instead of racing two builds against the same sqlite file.
  //
  // `onProgress` (M7c Task 1) is threaded straight through to buildIndex —
  // see indexer.ts's own doc comment for the emit cadence. NOTE: because
  // concurrent calls for the same project key coalesce onto ONE in-flight
  // promise, only the FIRST caller's `onProgress` is ever wired to the
  // actual buildIndex() run; a second, coalesced caller gets the shared
  // result but no progress callbacks of its own. This is the same
  // known trade-off the coalescing itself already accepts (one real build,
  // shared by every waiter) — acceptable here since progress is a
  // best-effort UI signal, not something correctness depends on.
  build(projectDir: string, onProgress?: BuildIndexProgress): Promise<IndexStats> {
    const key = resolveProjectKey(projectDir);
    const inFlight = this.#building.get(key);
    if (inFlight !== undefined) return inFlight;

    const promise = (async () => {
      const store = this.getStore(projectDir);
      const parser = await this.getParser();
      return buildIndex(key, store, parser, onProgress);
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

export function registerWikiMethods(engine: Engine): void {
  registerMethod(
    engine.dispatcher,
    "engine.wiki.build",
    ProjectParamsSchema,
    async ({ projectDir }) => {
      requireGitRepo(projectDir);
      // M7c Task 1: `projectDir` here is deliberately the RAW string this
      // handler was invoked with — never resolveProjectKey(projectDir)'s
      // canonicalized form. A subscriber (the desktop ProjectScreen) filters
      // notifications by comparing `params.projectDir` against whatever IT
      // itself passed to engine.wiki.build, which is the raw path from its
      // own directory picker — echoing back the resolved key here would
      // silently break that comparison whenever the raw path and its
      // realpath differ (e.g. a symlinked project directory).
      const stats = await engine.wiki.build(projectDir, (detail) => {
        const payload: WikiBuildProgress = { projectDir, detail };
        engine.notify("wiki.build.progress", payload);
      });
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
      const currentSha = requireGitRepo(projectDir);
      const resolvedDir = resolveProjectKey(projectDir);

      // If wiki.db doesn't exist, the wiki hasn't been built yet. Consult
      // the same wikiDbPath() the store itself opens (and getStore's cache
      // revalidation checks) rather than an inline join, so this gate can't
      // drift from what's actually on disk.
      if (!existsSync(wikiDbPath(resolvedDir))) {
        return {
          built: false,
          headSha: null,
          currentSha,
          stale: false,
          files: 0,
          symbols: 0,
          refs: 0,
        };
      }

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
    "engine.wiki.verify",
    ProjectParamsSchema,
    async ({ projectDir }) => {
      requireGitRepo(projectDir);
      return verifyWiki(engine, projectDir);
    },
  );

  registerMethod(
    engine.dispatcher,
    "engine.wiki.query",
    QueryParamsSchema,
    ({ projectDir, symbol }) => {
      requireGitRepo(projectDir);
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
    ({ projectDir, query, budgetTokens }) => {
      requireGitRepo(projectDir);
      const store = engine.wiki.getStore(projectDir);
      if (store.getMeta("head_sha") === null) {
        throw new RpcMethodError(
          RpcErrorCodes.SERVER_ERROR,
          "wiki not built — run engine.wiki.build first",
        );
      }
      const result = buildRepositoryMap(store, {
        budgetTokens: budgetTokens ?? 1024,
        ...(query === undefined ? {} : { query }),
      });
      return {
        map: result.map,
        files: result.files,
        matchedFiles: result.matchedFiles,
        truncated: result.rendered < result.renderable,
      };
    },
  );

  registerMethod(
    engine.dispatcher,
    "engine.mcp.start",
    ProjectParamsSchema,
    async ({ projectDir }) => {
      requireGitRepo(projectDir);
      const server = await engine.wiki.startMcpServer(engine, projectDir);
      return { url: server.url, bearerToken: server.bearerToken };
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
