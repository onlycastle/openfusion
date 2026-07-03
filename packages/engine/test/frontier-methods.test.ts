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
  // When true, the FIRST prompt() call on a session returns a generator
  // that blocks (mid-stream, like a real adapter sitting on an in-flight
  // tool call) until abort() fires, then ends its iteration without a
  // result event — abort-aware, mirroring the real Claude adapter's
  // query() ending once its AbortController fires. Subsequent prompt()
  // calls on the same session behave normally, so tests can assert a
  // session stays usable after its first prompt is aborted.
  blockUntilAbort?: boolean;
  abortSpy?: { count: number };
  // Captures the `opts` argument each prompt() call receives, so tests can
  // assert what the RPC handler forwards (or, post-fix, deliberately does
  // NOT forward) to the adapter — see the timeoutMs single-authority test.
  capturedOpts?: Array<{ timeoutMs?: number } | undefined>;
  // Captures the `toolPolicy` argument each createSession() call receives —
  // M4 task-1: proves engine.frontier.start resolves writeScope entries
  // against projectDir (RESOLVED absolute paths) before handing them to the
  // adapter, and that omitting writeScope leaves toolPolicy undefined
  // (today's deny-all default, unchanged).
  capturedToolPolicy?: Array<{ writeScope?: string[] } | undefined>;
  // When set, prompt()'s events generator throws this value (via `throw`,
  // not `yield`) on its very first iteration instead of yielding any events.
  // Mirrors a real adapter surfacing an operational failure mid-stream (a
  // no-auth error, an aborted subprocess, ...) — accepts `unknown` rather
  // than `Error` so the fake can also exercise a plain non-Error throw (e.g.
  // `throw "string-boom"`), which JS permits and the M0-deferred gap never
  // covered.
  throwInEvents?: unknown;
  // Only meaningful together with blockUntilAbort: after the aborted signal
  // resolves, the generator yields this ONE extra event before ending,
  // instead of ending immediately. Used to prove the RPC handler's
  // post-timeout `timedOut` guard suppresses a frontier.event notification
  // for an event the adapter manages to emit after abort() has already
  // fired.
  postAbortEvent?: FrontierEvent;
}

function makeFakeAdapter(opts: FakeAdapterOptions = {}): FrontierAdapter {
  const kind = opts.kind ?? "claude-code";
  return {
    kind,
    async createSession({ projectDir, wikiMcpUrl, toolPolicy }): Promise<FrontierSession> {
      opts.wikiMcpUrls?.push(wikiMcpUrl);
      opts.capturedToolPolicy?.push(toolPolicy);
      let promptCalls = 0;
      return {
        id: "fake-inner-id",
        projectDir,
        prompt(_text, promptOpts): FrontierPromptHandle {
          opts.capturedOpts?.push(promptOpts);
          const callIndex = promptCalls;
          promptCalls += 1;
          if (opts.throwInEvents !== undefined) {
            async function* gen(): AsyncGenerator<FrontierEvent> {
              throw opts.throwInEvents;
            }
            return { events: gen(), abort: () => {} };
          }
          if (opts.blockUntilAbort === true && callIndex === 0) {
            let resolveAborted: () => void = () => {};
            const aborted = new Promise<void>((resolve) => {
              resolveAborted = resolve;
            });
            async function* gen(): AsyncGenerator<FrontierEvent> {
              await aborted;
              if (opts.postAbortEvent !== undefined) yield opts.postAbortEvent;
            }
            return {
              events: gen(),
              abort: () => {
                if (opts.abortSpy !== undefined) opts.abortSpy.count += 1;
                resolveAborted();
              },
            };
          }
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

  // Carried Important from Task 2 review: FrontierService.close() used to
  // await each session's close() unguarded, so one throwing session both
  // aborted the shutdown loop (leaving later sessions' subprocesses
  // dangling) AND — since Engine.close awaits frontier.close() before
  // wiki.close() — skipped wiki shutdown entirely. Mirrors
  // WikiService.close()'s per-resource try/catch isolation.
  it("close() isolates a throwing session's close() so other sessions still close and close() resolves", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.frontier.registerAdapter(makeFakeAdapter());
    const adapter = engine.frontier.getAdapter("claude-code")!;

    const okClose = { closed: false };
    const throwingSession: FrontierSession = {
      id: "throwing-inner-id",
      projectDir: dir,
      prompt(): FrontierPromptHandle {
        throw new Error("not used in this test");
      },
      close: async () => {
        throw new Error("boom");
      },
    };
    const okSession: FrontierSession = {
      id: "ok-inner-id",
      projectDir: dir,
      prompt(): FrontierPromptHandle {
        throw new Error("not used in this test");
      },
      close: async () => {
        okClose.closed = true;
      },
    };
    engine.frontier.addSession("throwing-session", { session: throwingSession, adapter });
    engine.frontier.addSession("ok-session", { session: okSession, adapter });

    await expect(engine.frontier.close()).resolves.toBeUndefined();
    expect(okClose.closed).toBe(true);
  });

  it("prompt timeoutMs schema accepts up to 3_600_000 and rejects below the 100ms floor", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.frontier.registerAdapter(makeFakeAdapter());
    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    const { sessionId } = start.result;

    const tooLow = await call("engine.frontier.prompt", { sessionId, text: "hi", timeoutMs: 50 });
    expect(tooLow.error?.code).toBe(RpcErrorCodes.INVALID_PARAMS);

    const tooHigh = await call("engine.frontier.prompt", {
      sessionId,
      text: "hi",
      timeoutMs: 3_600_001,
    });
    expect(tooHigh.error?.code).toBe(RpcErrorCodes.INVALID_PARAMS);

    // Above models/methods.ts's old 600_000 cap (which this schema used to
    // reuse) but within the widened 3_600_000 frontier max — must not be
    // rejected as INVALID_PARAMS. The fake's events resolve immediately, so
    // this never actually waits out the timeout.
    const widened = await call("engine.frontier.prompt", {
      sessionId,
      text: "hi",
      timeoutMs: 601_000,
    });
    expect(widened.error).toBeUndefined();
  });

  it("prompt timeoutMs aborts the handle, emits a final frontier.event error, and errors SERVER_ERROR — session stays usable for the next prompt", async () => {
    dir = makeRepo();
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    const abortSpy = { count: 0 };
    // M3 final review, Minor 4: give the fake ONE post-abort event attempt
    // (yielded right after abort() resolves) to prove the loop's `timedOut`
    // guard suppresses it — before this fix, the loop kept running in the
    // background after the timeout RPC error had already been returned, and
    // would still call engine.notify() for any event the adapter emitted
    // after abort().
    engine.frontier.registerAdapter(
      makeFakeAdapter({
        blockUntilAbort: true,
        abortSpy,
        postAbortEvent: { type: "text", text: "should-not-notify" },
      }),
    );

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    const { sessionId } = start.result;

    const timedOut = await call("engine.frontier.prompt", { sessionId, text: "hi", timeoutMs: 150 });
    expect(timedOut.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(timedOut.error?.message).toBe("frontier prompt timed out");
    expect(abortSpy.count).toBe(1);

    expect(notifications.length).toBeGreaterThan(0);
    const last = notifications.at(-1)!;
    expect(last.method).toBe("frontier.event");
    expect((last.params as { event: FrontierEvent }).event).toEqual({
      type: "error",
      message: "frontier prompt timed out",
    });

    // The timeout error notification must be terminal: no further
    // frontier.event notifications may arrive, even though the fake's
    // generator yields one more event after abort() resolves. Give the
    // background loop promise a chance to run (it's not awaited by the RPC
    // handler once the timeout race is settled) before asserting.
    const countAfterTimeout = notifications.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notifications.length).toBe(countAfterTimeout);

    // Session must still be usable for the next prompt — not torn down.
    const list = await call("engine.frontier.list", {});
    expect(list.result.sessions).toEqual([{ sessionId, engine: "claude-code", projectDir: dir }]);

    const second = await call("engine.frontier.prompt", { sessionId, text: "again" });
    expect(second.error).toBeUndefined();
    expect(second.result.events).toBe(3);
  }, 5_000);

  it("stop during an in-flight prompt aborts the handle before closing, so the prompt RPC errors instead of hanging", async () => {
    dir = makeRepo();
    engine = createEngine();
    const closeSpy = { closed: false };
    const abortSpy = { count: 0 };
    engine.frontier.registerAdapter(makeFakeAdapter({ blockUntilAbort: true, closeSpy, abortSpy }));

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    const { sessionId } = start.result;

    const promptPromise = call("engine.frontier.prompt", { sessionId, text: "hi" });

    const stop = await call("engine.frontier.stop", { sessionId });
    expect(stop.error).toBeUndefined();
    expect(stop.result.stopped).toBe(true);
    expect(abortSpy.count).toBe(1);
    expect(closeSpy.closed).toBe(true);

    const promptResult = await promptPromise;
    expect(promptResult.error).toBeDefined();

    // Double-stop stays idempotent even when the first stop happened
    // mid-prompt.
    const stopAgain = await call("engine.frontier.stop", { sessionId });
    expect(stopAgain.result.stopped).toBe(false);
  }, 5_000);

  it("Engine.close() with an in-flight prompt resolves within a bounded time (abort-then-close)", async () => {
    dir = makeRepo();
    engine = createEngine();
    const closeSpy = { closed: false };
    const abortSpy = { count: 0 };
    engine.frontier.registerAdapter(makeFakeAdapter({ blockUntilAbort: true, closeSpy, abortSpy }));

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    const { sessionId } = start.result;

    const promptPromise = call("engine.frontier.prompt", { sessionId, text: "hi" });

    const startedAt = Date.now();
    await engine.close();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(abortSpy.count).toBe(1);
    expect(closeSpy.closed).toBe(true);

    const promptResult = await promptPromise;
    expect(promptResult.error).toBeDefined();
  }, 5_000);

  // Review finding 1 (Important): the Claude adapter (claude.ts) already
  // arms its own setTimeout from opts.timeoutMs, and the RPC handler used to
  // ALSO forward params.timeoutMs into entry.session.prompt(text, { timeoutMs
  // }) — two competing timers racing the same deadline. If the adapter's
  // timer fired first, the RPC-level timeoutPromise (which is the only path
  // that emits the mandated "frontier prompt timed out" frontier.event +
  // RpcMethodError) could be skipped entirely. Fix: the RPC layer is the
  // single timeout authority — it must call prompt() with no timeoutMs at
  // all, regardless of what the caller passed.
  it("prompt does not forward timeoutMs to the adapter — the RPC timer is the single authority", async () => {
    dir = makeRepo();
    engine = createEngine();
    const capturedOpts: Array<{ timeoutMs?: number } | undefined> = [];
    engine.frontier.registerAdapter(makeFakeAdapter({ capturedOpts }));

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    const { sessionId } = start.result;

    const res = await call("engine.frontier.prompt", { sessionId, text: "hi", timeoutMs: 5000 });
    expect(res.error).toBeUndefined();

    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0]?.timeoutMs).toBeUndefined();
  });

  // Review finding 2 (Important): main.ts used to await pipeline.drain()
  // before engine.close() with no way to bound an in-flight frontier
  // prompt's own (up to 1h) timer once the client (stdin) is already gone.
  // FrontierService.abortAll() aborts every active prompt handle WITHOUT
  // closing sessions — full teardown remains close()'s job, called
  // separately right after drain() resolves in main.ts.
  it("abortAll() aborts in-flight prompts without closing sessions, so drain() stays bounded", async () => {
    dir = makeRepo();
    engine = createEngine();
    const abortSpy = { count: 0 };
    const closeSpy = { closed: false };
    engine.frontier.registerAdapter(makeFakeAdapter({ blockUntilAbort: true, abortSpy, closeSpy }));

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    const { sessionId } = start.result;

    const promptPromise = call("engine.frontier.prompt", { sessionId, text: "hi" });

    engine.frontier.abortAll();

    const promptResult = await promptPromise;
    expect(promptResult.error).toBeDefined();
    expect(abortSpy.count).toBe(1);

    // abortAll() must not close the session — only stop()/close() do that.
    expect(closeSpy.closed).toBe(false);
    const list = await call("engine.frontier.list", {});
    expect(list.result.sessions).toEqual([{ sessionId, engine: "claude-code", projectDir: dir }]);
  }, 5_000);

  // Review finding 4 (Minor): removeSession()'s `await entry.session.close()`
  // was unguarded (unlike close()'s per-session try/catch over the same
  // call), so a throwing adapter close() turned engine.frontier.stop into an
  // RPC error even though the session entry was already deleted from our
  // bookkeeping. stop() should stay tolerant of a throwing close(), exactly
  // like close() already is.
  // M3 final review, Important 1: the prompt handler's event-loop iteration
  // (`for await (const event of handle.events)`) let any adapter throw
  // (no-auth errors, aborts, ...) propagate straight past the RPC handler
  // into the dispatcher's generic catch, which maps it to INTERNAL_ERROR
  // (-32603) — indistinguishable from an actual engine bug in this codebase.
  // These are operational frontier failures, not engine bugs, so they must
  // surface as SERVER_ERROR (-32000) instead. Fix: wrap the loop so a
  // non-RpcMethodError throw is rethrown as
  // RpcMethodError(SERVER_ERROR, message); an RpcMethodError thrown by the
  // adapter (none currently do, but the contract should hold) passes through
  // untouched rather than being double-wrapped.
  it("adapter events iterator throwing a plain Error surfaces as SERVER_ERROR, not INTERNAL_ERROR", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.frontier.registerAdapter(makeFakeAdapter({ throwInEvents: new Error("engine exploded") }));

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    const { sessionId } = start.result;

    const res = await call("engine.frontier.prompt", { sessionId, text: "hi" });
    expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error?.message).toBe("engine exploded");
  });

  // Closes the M0-deferred non-Error-throw gap: JS permits `throw` with any
  // value, not just Error instances. Before this fix, EVERY throw from the
  // loop (Error or not) fell through to the dispatcher's generic catch,
  // which already does `err instanceof Error ? err.message : String(err)` —
  // but the loop itself did no SERVER_ERROR wrapping at all, so this path
  // was untested end-to-end for frontier.prompt specifically. Verifies the
  // non-Error throw explicitly, with String coercion of the thrown value.
  it("adapter events iterator throwing a non-Error value surfaces as SERVER_ERROR with String coercion", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.frontier.registerAdapter(makeFakeAdapter({ throwInEvents: "string-boom" }));

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    const { sessionId } = start.result;

    const res = await call("engine.frontier.prompt", { sessionId, text: "hi" });
    expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error?.message).toBe("string-boom");
  });

  it("stop tolerates a throwing session close() — returns {stopped: true}, no RPC error", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.frontier.registerAdapter(makeFakeAdapter());
    const adapter = engine.frontier.getAdapter("claude-code")!;

    const throwingSession: FrontierSession = {
      id: "throwing-inner-id",
      projectDir: dir,
      prompt(): FrontierPromptHandle {
        throw new Error("not used in this test");
      },
      close: async () => {
        throw new Error("boom");
      },
    };
    engine.frontier.addSession("throwing-session", { session: throwingSession, adapter });

    const stop = await call("engine.frontier.stop", { sessionId: "throwing-session" });
    expect(stop.error).toBeUndefined();
    expect(stop.result.stopped).toBe(true);
  });

  // M4 task-1: engine.frontier.start gains an optional writeScope param.
  // Entries must be relative (resolved against projectDir before reaching
  // the adapter) — an absolute entry is rejected as INVALID_PARAMS by the
  // schema, matching every other malformed-params case in this file.
  it("start rejects an absolute writeScope entry with INVALID_PARAMS", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.frontier.registerAdapter(makeFakeAdapter());

    const res = await call("engine.frontier.start", {
      projectDir: dir,
      attachWiki: false,
      writeScope: ["/etc"],
    });
    expect(res.error?.code).toBe(RpcErrorCodes.INVALID_PARAMS);
  });

  it("start resolves relative writeScope entries against projectDir before passing them to the adapter", async () => {
    dir = makeRepo();
    engine = createEngine();
    const capturedToolPolicy: Array<{ writeScope?: string[] } | undefined> = [];
    engine.frontier.registerAdapter(makeFakeAdapter({ capturedToolPolicy }));

    const start = await call("engine.frontier.start", {
      projectDir: dir,
      attachWiki: false,
      writeScope: ["scratch", "nested/dir"],
    });
    expect(start.error).toBeUndefined();

    expect(capturedToolPolicy).toHaveLength(1);
    expect(capturedToolPolicy[0]?.writeScope).toEqual([
      path.resolve(dir, "scratch"),
      path.resolve(dir, "nested/dir"),
    ]);
  });

  it("start with no writeScope leaves toolPolicy undefined for the adapter (deny-all default unchanged)", async () => {
    dir = makeRepo();
    engine = createEngine();
    const capturedToolPolicy: Array<{ writeScope?: string[] } | undefined> = [];
    engine.frontier.registerAdapter(makeFakeAdapter({ capturedToolPolicy }));

    const start = await call("engine.frontier.start", { projectDir: dir, attachWiki: false });
    expect(start.error).toBeUndefined();
    expect(capturedToolPolicy).toEqual([undefined]);
  });
});
