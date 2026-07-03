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
import { createClaudeAdapter } from "./claude.js";
import type {
  FrontierAdapter,
  FrontierEvent,
  FrontierPromptHandle,
  FrontierSession,
} from "./types.js";

const StartParamsSchema = z.object({
  projectDir: z.string().min(1),
  engine: z.string().min(1).optional(),
  attachWiki: z.boolean().optional(),
});

const SessionParamsSchema = z.object({ sessionId: z.string().min(1) });

// engine.frontier.prompt's timeoutMs used to reuse models/methods.ts's
// per-attempt schema verbatim (min 1000, max 600000) — a sensible bound for
// a single model call, but frontier prompts are long-running agentic turns
// (multiple tool calls / sub-agent loops), so the ceiling is widened to 1h.
// Default stays at the old max (600_000 / 10m) so unspecified timeoutMs
// behaves the same as before this task.
//
// The floor is dropped from models' 1000ms to 100ms deliberately: unlike
// models' per-network-call timeout, this fires the "frontier prompt timed
// out" abort path end-to-end (see engine.frontier.prompt below), and tests
// covering that path need to force it quickly without resorting to fake
// timers over an async-iterator-driven RPC. 100ms is still well above
// "effectively zero" for a real caller while keeping the test suite fast.
const DEFAULT_PROMPT_TIMEOUT_MS = 600_000;
const MIN_PROMPT_TIMEOUT_MS = 100;
const MAX_PROMPT_TIMEOUT_MS = 3_600_000;

const PromptParamsSchema = SessionParamsSchema.extend({
  text: z.string().min(1),
  timeoutMs: z.number().int().min(MIN_PROMPT_TIMEOUT_MS).max(MAX_PROMPT_TIMEOUT_MS).optional(),
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
// callers. registerFrontierMethods registers the Claude adapter by default
// (kind "claude-code"); tests can still override it (or register other
// kinds) via registerAdapter() — a same-kind call replaces the Map entry.
export class FrontierService {
  #adapters = new Map<string, FrontierAdapter>();
  #sessions = new Map<string, SessionEntry>();
  #inFlight = new Set<string>();
  #activeHandles = new Map<string, FrontierPromptHandle>();

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

  // Records the FrontierPromptHandle for the prompt currently running on a
  // session, so removeSession()/close() below can abort it before tearing
  // the session down — without this, stopping (or closing the Engine)
  // mid-prompt would leave the blocked engine.frontier.prompt call to hang
  // on a session that's already gone rather than erroring out. Companion to
  // tryBeginPrompt/endPrompt's #inFlight guard, which tracks occupancy only
  // (not the handle itself).
  setActiveHandle(sessionId: string, handle: FrontierPromptHandle): void {
    this.#activeHandles.set(sessionId, handle);
  }

  clearActiveHandle(sessionId: string): void {
    this.#activeHandles.delete(sessionId);
  }

  async removeSession(sessionId: string): Promise<boolean> {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined) return false;
    this.#sessions.delete(sessionId);
    this.#inFlight.delete(sessionId);
    const activeHandle = this.#activeHandles.get(sessionId);
    this.#activeHandles.delete(sessionId);
    activeHandle?.abort();
    await entry.session.close();
    return true;
  }

  async close(): Promise<void> {
    for (const [sessionId, entry] of [...this.#sessions.entries()]) {
      this.#sessions.delete(sessionId);
      this.#inFlight.delete(sessionId);
      const activeHandle = this.#activeHandles.get(sessionId);
      this.#activeHandles.delete(sessionId);
      activeHandle?.abort();
      try {
        await entry.session.close();
      } catch {
        // Best-effort: one session failing to close must not abort
        // shutdown of the rest, and — since Engine.close awaits
        // frontier.close() before wiki.close() — must not skip wiki
        // teardown either. Mirrors WikiService.close()'s per-resource
        // isolation.
      }
    }
  }
}

export function registerFrontierMethods(engine: Engine): void {
  // Default adapter, registered before any RPC handler so
  // engine.frontier.start's "unknown frontier engine" check never fires for
  // the un-overridden case. onResult wires the adapter's per-result hook to
  // the models layer's CostMeter here (rather than in claude.ts) so the
  // adapter itself never imports the models layer — see
  // CreateClaudeAdapterOptions.onResult's doc comment. This never touches
  // the meter during engine.frontier.prompt itself (that RPC handler stays
  // meter-blind, per frontier-methods.test.ts); recording happens inside
  // the adapter's own result-mapping, one record per `result` message.
  engine.frontier.registerAdapter(
    createClaudeAdapter({
      onResult: (result, model) => {
        engine.models.meter.record({
          providerId: "claude-code",
          kind: "frontier-claude",
          model,
          usage: result.usage,
          costUsd: result.costUsd,
          at: Date.now(),
        });
      },
    }),
  );

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
    const timeoutMs = params.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    try {
      // Prompt text and streamed event payloads are user/model content and
      // must never reach engine.log (stderr diagnostics) — only the
      // lifecycle line above (frontier.start) and below (frontier.prompt
      // done) are logged, and neither includes prompt text or event bodies.
      const handle = entry.session.prompt(
        params.text,
        params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : undefined,
      );
      // Tracked so engine.frontier.stop / Engine.close can abort THIS
      // prompt before tearing the session down (see
      // FrontierService.removeSession/close) — set as soon as the handle
      // exists, before the first event, so a stop() racing in immediately
      // after this RPC starts still finds it.
      engine.frontier.setActiveHandle(params.sessionId, handle);
      let seq = 0;
      let events = 0;
      let resultEvent: Extract<FrontierEvent, { type: "result" }> | undefined;

      // Races the streamed-events loop against timeoutMs. On timeout: abort
      // the handle, emit one final frontier.event error notification, and
      // reject with the exact RpcMethodError below — deliberately NOT
      // relying on the loop's own exit (which, depending on the adapter,
      // might complete quietly or throw something unrelated) to produce
      // this specific error message. Passing both promises to Promise.race
      // means the loop's eventual settlement (after abort() unblocks it)
      // still has a rejection handler attached even when this branch wins,
      // so it can never surface as an unhandled rejection.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          handle.abort();
          engine.notify("frontier.event", {
            sessionId: params.sessionId,
            seq,
            event: { type: "error", message: "frontier prompt timed out" },
          });
          reject(new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "frontier prompt timed out"));
        }, timeoutMs);
      });

      const loopPromise = (async () => {
        for await (const event of handle.events) {
          engine.notify("frontier.event", { sessionId: params.sessionId, seq, event });
          seq += 1;
          events += 1;
          if (event.type === "result") {
            resultEvent = event;
          }
        }
      })();

      try {
        await Promise.race([loopPromise, timeoutPromise]);
      } finally {
        clearTimeout(timer);
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
      engine.frontier.clearActiveHandle(params.sessionId);
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
