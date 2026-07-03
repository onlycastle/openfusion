import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { createEngine, type Engine } from "../src/engine.js";
import type {
  FrontierAdapter,
  FrontierEvent,
  FrontierPromptHandle,
  FrontierSession,
} from "../src/engines/types.js";

let dir: string;
let engine: Engine;

afterEach(async () => {
  await engine.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(prefix = "of-frontier-"): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", d]);
  execFileSync("git", ["-C", d, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", d, "config", "user.name", "t"]);
  execFileSync("git", ["-C", d, "commit", "--allow-empty", "-qm", "init"]);
  return d;
}

async function call(method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

const FAKE_EVENTS: FrontierEvent[] = [
  { type: "text", text: "hello" },
  { type: "tool_use", name: "grep", summary: "searched for foo" },
  {
    type: "result",
    resultText: "done",
    costUsd: 0.01,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    numTurns: 1,
    durationMs: 42,
    engineSessionId: "engine-session-1",
  },
];

interface FakeAdapterOptions {
  kind?: string;
  closeSpy?: { closed: boolean };
  gate?: Promise<void>;
  wikiMcpUrls?: (string | null)[];
}

function makeFakeAdapter(opts: FakeAdapterOptions = {}): FrontierAdapter {
  const kind = opts.kind ?? "claude-code";
  return {
    kind,
    async createSession({ projectDir, wikiMcpUrl }): Promise<FrontierSession> {
      opts.wikiMcpUrls?.push(wikiMcpUrl);
      return {
        id: "fake-inner-id",
        projectDir,
        prompt(): FrontierPromptHandle {
          async function* gen(): AsyncGenerator<FrontierEvent> {
            if (opts.gate !== undefined) await opts.gate;
            for (const e of FAKE_EVENTS) yield e;
          }
          return { events: gen(), abort: () => {} };
        },
        async close(): Promise<void> {
          if (opts.closeSpy !== undefined) opts.closeSpy.closed = true;
        },
      };
    },
  };
}

describe("frontier RPC methods", () => {
  it("start -> prompt streams ordered notifications then responds with the result (meter-independent)", async () => {
    dir = makeRepo();
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    engine.frontier.registerAdapter(makeFakeAdapter());

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    expect(start.error).toBeUndefined();
    expect(start.result.engine).toBe("claude-code");
    expect(start.result.wikiAttached).toBe(false);
    const { sessionId } = start.result;
    expect(typeof sessionId).toBe("string");

    const prompt = await call("engine.frontier.prompt", { sessionId, text: "hi" });
    expect(prompt.error).toBeUndefined();
    expect(prompt.result.events).toBe(3);
    expect(prompt.result.result).toEqual({
      resultText: "done",
      costUsd: 0.01,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
      numTurns: 1,
      durationMs: 42,
      engineSessionId: "engine-session-1",
    });

    expect(notifications).toHaveLength(3);
    expect(notifications.map((n) => n.method)).toEqual([
      "frontier.event",
      "frontier.event",
      "frontier.event",
    ]);
    expect(notifications.map((n) => (n.params as { seq: number }).seq)).toEqual([0, 1, 2]);
    for (const n of notifications) {
      expect((n.params as { sessionId: string }).sessionId).toBe(sessionId);
    }
    expect((notifications[2]!.params as { event: FrontierEvent }).event).toEqual(FAKE_EVENTS[2]);

    // frontier.prompt must never touch the models cost meter, even though
    // the result event carries its own costUsd.
    expect(engine.models.meter.totals().calls).toBe(0);
  }, 30_000);

  it("start on a non-git directory returns SERVER_ERROR", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-frontier-nogit-"));
    engine = createEngine();
    engine.frontier.registerAdapter(makeFakeAdapter());
    const res = await call("engine.frontier.start", { projectDir: dir });
    expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
  });

  it("start with an unregistered adapter kind returns SERVER_ERROR", async () => {
    dir = makeRepo();
    engine = createEngine();
    const res = await call("engine.frontier.start", {
      projectDir: dir,
      engine: "does-not-exist",
    });
    expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
  });

  it("prompt on an unknown session returns SERVER_ERROR", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.frontier.registerAdapter(makeFakeAdapter());
    const res = await call("engine.frontier.prompt", { sessionId: "nope", text: "hi" });
    expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
  });

  it("rejects a concurrent prompt on the same session", async () => {
    dir = makeRepo();
    engine = createEngine();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    engine.frontier.registerAdapter(makeFakeAdapter({ gate }));

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    const { sessionId } = start.result;

    const first = call("engine.frontier.prompt", { sessionId, text: "one" });
    const second = await call("engine.frontier.prompt", { sessionId, text: "two" });
    expect(second.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(second.error?.message).toContain("prompt already in flight");

    release();
    const firstResult = await first;
    expect(firstResult.error).toBeUndefined();
    expect(firstResult.result.events).toBe(3);
  }, 30_000);

  it("stop closes the session and reports {stopped: true}", async () => {
    dir = makeRepo();
    engine = createEngine();
    const closeSpy = { closed: false };
    engine.frontier.registerAdapter(makeFakeAdapter({ closeSpy }));

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    const { sessionId } = start.result;

    const stop = await call("engine.frontier.stop", { sessionId });
    expect(stop.error).toBeUndefined();
    expect(stop.result.stopped).toBe(true);
    expect(closeSpy.closed).toBe(true);

    const stopAgain = await call("engine.frontier.stop", { sessionId });
    expect(stopAgain.result.stopped).toBe(false);
  });

  it("list reflects live sessions and drops them after stop", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.frontier.registerAdapter(makeFakeAdapter());

    const empty = await call("engine.frontier.list", {});
    expect(empty.result.sessions).toEqual([]);

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    const { sessionId } = start.result;

    const listed = await call("engine.frontier.list", {});
    expect(listed.result.sessions).toEqual([{ sessionId, engine: "claude-code", projectDir: dir }]);

    await call("engine.frontier.stop", { sessionId });
    const after = await call("engine.frontier.list", {});
    expect(after.result.sessions).toEqual([]);
  });

  it("attachWiki:false never starts an MCP server and passes a null wikiMcpUrl", async () => {
    dir = makeRepo();
    engine = createEngine();
    const wikiMcpUrls: (string | null)[] = [];
    engine.frontier.registerAdapter(makeFakeAdapter({ wikiMcpUrls }));

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    expect(start.result.wikiAttached).toBe(false);
    expect(wikiMcpUrls).toEqual([null]);
    expect(engine.wiki.getMcpServers()).toEqual([]);
  });

  it("attachWiki:true attaches the wiki MCP server once the wiki is built", async () => {
    dir = makeRepo();
    engine = createEngine();
    const wikiMcpUrls: (string | null)[] = [];
    engine.frontier.registerAdapter(makeFakeAdapter({ wikiMcpUrls }));

    // Wiki not built yet: no error, just wikiAttached:false.
    const before = await call("engine.frontier.start", { projectDir: dir, attachWiki: true });
    expect(before.error).toBeUndefined();
    expect(before.result.wikiAttached).toBe(false);
    expect(engine.wiki.getMcpServers()).toEqual([]);

    await call("engine.wiki.build", { projectDir: dir });
    const after = await call("engine.frontier.start", { projectDir: dir, attachWiki: true });
    expect(after.error).toBeUndefined();
    expect(after.result.wikiAttached).toBe(true);
    const servers = engine.wiki.getMcpServers();
    expect(servers).toHaveLength(1);
    expect(wikiMcpUrls.at(-1)).toBe(servers[0]!.url);
  }, 30_000);

  it("Engine.close closes all outstanding frontier sessions", async () => {
    dir = makeRepo();
    engine = createEngine();
    const closeSpy = { closed: false };
    engine.frontier.registerAdapter(makeFakeAdapter({ closeSpy }));

    await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    expect(closeSpy.closed).toBe(false);

    await engine.close();
    expect(closeSpy.closed).toBe(true);
  });
});
