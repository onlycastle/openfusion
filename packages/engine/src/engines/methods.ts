import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { registerMethod } from "../rpc/register.js";
import { getHeadSha } from "../wiki/indexer.js";
import { wikiDbPath } from "../wiki/store.js";
import type { FrontierAdapter, FrontierEvent, FrontierSession } from "./types.js";

const StartParamsSchema = z.object({
  projectDir: z.string().min(1),
  engine: z.string().min(1).optional(),
  attachWiki: z.boolean().optional(),
});

const SessionParamsSchema = z.object({ sessionId: z.string().min(1) });

const PromptParamsSchema = SessionParamsSchema.extend({
  text: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
});

const EmptyParamsSchema = z.object({});

interface SessionEntry {
  session: FrontierSession;
  adapter: FrontierAdapter;
}

// Mirrors wiki/methods.ts's own (unexported) requireHeadSha guard, including
// its error shape — engine.frontier.* operates against a project checkout
// the same way engine.wiki.* does, so "not a git repository" should read
// identically from either surface. Not imported from wiki/methods.ts because
// that helper isn't exported there; kept as a narrow, intentional
// duplication rather than widening wiki's public surface for one shared
// three-line guard.
function requireHeadSha(projectDir: string): void {
  try {
    getHeadSha(projectDir);
  } catch {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `not a git repository: ${projectDir}`);
  }
}

// Mirrors engine.wiki.status's own built-check: gate on existsSync(wikiDbPath)
// before ever calling WikiService.getStore, so merely asking "is the wiki
// built" never has the side effect of creating a fresh, empty wiki.db for a
// project nobody has indexed yet.
function isWikiBuilt(engine: Engine, projectDir: string): boolean {
  if (!existsSync(wikiDbPath(path.resolve(projectDir)))) return false;
  return engine.wiki.getStore(projectDir).getMeta("head_sha") !== null;
}

// Holds registered adapters (one per engine "kind") and the live sessions
// created through them. Mirrors the shape of WikiService/ModelsService:
// instantiated once per Engine, methods.ts's RPC handlers are the only
// callers. Task 3 registers the Claude adapter by default; this task
// registers none — tests inject fakes via registerAdapter().
export class FrontierService {
  #adapters = new Map<string, FrontierAdapter>();
  #sessions = new Map<string, SessionEntry>();
  #inFlight = new Set<string>();

  registerAdapter(adapter: FrontierAdapter): void {
    this.#adapters.set(adapter.kind, adapter);
  }

  getAdapter(kind: string): FrontierAdapter | undefined {
    return this.#adapters.get(kind);
  }

  addSession(sessionId: string, entry: SessionEntry): void {
    this.#sessions.set(sessionId, entry);
  }

  getSession(sessionId: string): SessionEntry | undefined {
    return this.#sessions.get(sessionId);
  }

  listSessions(): Array<{ sessionId: string; engine: string; projectDir: string }> {
    return [...this.#sessions.entries()].map(([sessionId, entry]) => ({
      sessionId,
      engine: entry.adapter.kind,
      projectDir: entry.session.projectDir,
    }));
  }

  // Concurrency guard for engine.frontier.prompt. Returns false (without
  // mutating state) if a prompt is already running for this session, so the
  // RPC handler can reject the second caller with SERVER_ERROR instead of
  // interleaving two prompt() calls against one adapter session. Must be
  // called synchronously before any await in the handler so two prompt
  // calls racing in the same tick can't both observe "not in flight".
  tryBeginPrompt(sessionId: string): boolean {
    if (this.#inFlight.has(sessionId)) return false;
    this.#inFlight.add(sessionId);
    return true;
  }

  endPrompt(sessionId: string): void {
    this.#inFlight.delete(sessionId);
  }

  async removeSession(sessionId: string): Promise<boolean> {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return false;
    this.#sessions.delete(sessionId);
    this.#inFlight.delete(sessionId);
    await entry.session.close();
    return true;
  }

  async close(): Promise<void> {
    for (const sessionId of [...this.#sessions.keys()]) {
      await this.removeSession(sessionId);
    }
  }
}

export function registerFrontierMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.frontier.start", StartParamsSchema, async (params) => {
    const { projectDir } = params;
    requireHeadSha(projectDir);

    const kind = params.engine ?? "claude-code";
    const adapter = engine.frontier.getAdapter(kind);
    if (adapter === undefined) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown frontier engine: ${kind}`);
    }

    const attachWiki = params.attachWiki ?? true;
    let wikiMcpUrl: string | null = null;
    let wikiAttached = false;
    if (attachWiki && isWikiBuilt(engine, projectDir)) {
      const server = await engine.wiki.startMcpServer(engine, projectDir);
      wikiMcpUrl = server.url;
      wikiAttached = true;
    }

    const session = await adapter.createSession({ projectDir, wikiMcpUrl, log: engine.log });
    const sessionId = randomUUID();
    engine.frontier.addSession(sessionId, { session, adapter });
    engine.log(`frontier.start ${sessionId} engine=${kind} wikiAttached=${wikiAttached}`);
    return { sessionId, engine: kind, wikiAttached };
  });

  registerMethod(engine.dispatcher, "engine.frontier.prompt", PromptParamsSchema, async (params) => {
    const entry = engine.frontier.getSession(params.sessionId);
    if (entry === undefined) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown session: ${params.sessionId}`);
    }
    if (!engine.frontier.tryBeginPrompt(params.sessionId)) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "prompt already in flight");
    }
    try {
      // Prompt text and streamed event payloads are user/model content and
      // must never reach engine.log (stderr diagnostics) — only the
      // lifecycle line above (frontier.start) and below (frontier.prompt
      // done) are logged, and neither includes prompt text or event bodies.
      const handle = entry.session.prompt(
        params.text,
        params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : undefined,
      );
      let seq = 0;
      let events = 0;
      let resultEvent: Extract<FrontierEvent, { type: "result" }> | undefined;
      for await (const event of handle.events) {
        engine.notify("frontier.event", { sessionId: params.sessionId, seq, event });
        seq += 1;
        events += 1;
        if (event.type === "result") {
          resultEvent = event;
        }
      }
      if (resultEvent === undefined) {
        throw new RpcMethodError(
          RpcErrorCodes.SERVER_ERROR,
          "session ended without a result event",
        );
      }
      const { type: _type, ...result } = resultEvent;
      engine.log(`frontier.prompt ${params.sessionId} done: ${events} events`);
      return { result, events };
    } finally {
      engine.frontier.endPrompt(params.sessionId);
    }
  });

  registerMethod(engine.dispatcher, "engine.frontier.stop", SessionParamsSchema, async (params) => {
    const stopped = await engine.frontier.removeSession(params.sessionId);
    return { stopped };
  });

  registerMethod(engine.dispatcher, "engine.frontier.list", EmptyParamsSchema, () => {
    return { sessions: engine.frontier.listSessions() };
  });
}
