import path from "node:path";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { registerMethod } from "../rpc/register.js";
import { buildIndex, getHeadSha } from "./indexer.js";
import { WikiParser } from "./parser.js";
import { openWikiStore, type WikiStore } from "./store.js";

const ProjectParamsSchema = z.object({ projectDir: z.string().min(1) });
const QueryParamsSchema = ProjectParamsSchema.extend({
  symbol: z.string().min(1),
});

export class WikiService {
  #stores = new Map<string, WikiStore>();
  #parserPromise: Promise<WikiParser> | undefined;

  getStore(projectDir: string): WikiStore {
    const key = path.resolve(projectDir);
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

  async close(): Promise<void> {
    for (const store of this.#stores.values()) store.close();
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
      const store = engine.wiki.getStore(projectDir);
      const parser = await engine.wiki.getParser();
      const stats = await buildIndex(path.resolve(projectDir), store, parser);
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
      const store = engine.wiki.getStore(projectDir);
      return {
        definitions: store.symbolsByName(symbol),
        references: store.refsByName(symbol),
      };
    },
  );
}
