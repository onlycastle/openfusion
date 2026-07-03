import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { registerMethod } from "../rpc/register.js";
import { buildIndex, getHeadSha, type IndexStats } from "./indexer.js";
import { WikiParser } from "./parser.js";
import { openWikiStore, type WikiStore } from "./store.js";

const ProjectParamsSchema = z.object({ projectDir: z.string().min(1) });
const QueryParamsSchema = ProjectParamsSchema.extend({
  symbol: z.string().min(1),
});

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

  getStore(projectDir: string): WikiStore {
    const key = keyFor(projectDir);
    let store = this.#stores.get(key);
    if (store === undefined) {
      store = openWikiStore(key);
      this.#stores.set(key, store);
    }
    return store;
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
}
