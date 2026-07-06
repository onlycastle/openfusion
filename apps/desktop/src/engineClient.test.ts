import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock `@tauri-apps/api/core` module-wide: `invoke` is a spy every test
// drives via `mockResolvedValueOnce`/`mockRejectedValueOnce`, `Channel` is a
// minimal fake that records every instance it constructs so tests can grab
// the one engineClient created and drive its `onmessage` callback directly
// (simulating the Rust side pushing a notification onto the real Channel).
//
// `vi.hoisted` (not plain module-scope `const`s referenced from the factory)
// is required here: Vitest hoists `vi.mock` calls above this file's
// imports, so a factory closing over an ordinary `const` declared below it
// would throw "Cannot access before initialization." `vi.hoisted` runs its
// initializer before that hoisted mock registration instead.
const { invokeMock, channelInstances } = vi.hoisted(() => {
  return {
    invokeMock: vi.fn(),
    channelInstances: [] as Array<{ onmessage?: (message: unknown) => void }>,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  // A plain `function` (not an arrow) so `new Channel()` in engineClient.ts
  // can actually construct it — arrow functions have no [[Construct]].
  Channel: vi.fn().mockImplementation(function FakeChannel() {
    const instance: { onmessage?: (message: unknown) => void } = {};
    channelInstances.push(instance);
    return instance;
  }),
}));

import {
  EngineClient,
  EngineError,
  RunCancelledError,
  setSecret,
  getSecret,
  deleteSecret,
  listSecretIds,
  loadPersistedSecrets,
  type OrchestrateResult,
  type EvalsReportCard,
} from "./engineClient";

beforeEach(() => {
  invokeMock.mockReset();
  channelInstances.length = 0;
});

describe("EngineClient.call", () => {
  it("returns the result on success", async () => {
    invokeMock.mockResolvedValueOnce({ providers: [] });
    const client = new EngineClient();

    const result = await client.call<{ providers: unknown[] }>("engine.models.list", {});

    expect(result).toEqual({ providers: [] });
    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.models.list",
      params: {},
      timeoutMs: undefined,
    });
  });

  it("passes timeoutMs through when given", async () => {
    invokeMock.mockResolvedValueOnce({});
    const client = new EngineClient();

    await client.call("engine.wiki.build", { projectDir: "/tmp/x" }, { timeoutMs: 5000 });

    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.wiki.build",
      params: { projectDir: "/tmp/x" },
      timeoutMs: 5000,
    });
  });

  it("maps a thrown EngineCallError to a typed EngineError carrying code/message/data", async () => {
    invokeMock.mockRejectedValueOnce({ code: -32601, message: "method not found", data: { method: "engine.bogus" } });
    const client = new EngineClient();

    let caught: unknown;
    try {
      await client.call("engine.bogus", {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EngineError);
    const engineErr = caught as InstanceType<typeof EngineError>;
    expect(engineErr.code).toBe(-32601);
    expect(engineErr.message).toBe("method not found");
    expect(engineErr.data).toEqual({ method: "engine.bogus" });
  });

  it("rethrows a rejection that isn't shaped like an EngineCallError as-is", async () => {
    const weirdError = new Error("ipc transport exploded");
    invokeMock.mockRejectedValueOnce(weirdError);
    const client = new EngineClient();

    await expect(client.call("engine.models.list", {})).rejects.toBe(weirdError);
  });
});

describe("onEngineEvent single-subscription invariant", () => {
  it("invokes engine_events exactly once no matter how many subscribers attach", () => {
    const client = new EngineClient();
    client.onEngineEvent(() => {});
    client.onEngineEvent(() => {});
    client.onEngineEvent(() => {});

    const engineEventsCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "engine_events");
    expect(engineEventsCalls).toHaveLength(1);
    expect(channelInstances).toHaveLength(1);
  });

  it("delivers a pushed notification to every subscriber", () => {
    const client = new EngineClient();
    const received1: unknown[] = [];
    const received2: unknown[] = [];
    client.onEngineEvent((n) => received1.push(n));
    client.onEngineEvent((n) => received2.push(n));

    const channel = channelInstances[0]!;
    channel.onmessage?.({ method: "orchestrate.progress", params: { pct: 50 } });

    expect(received1).toEqual([{ method: "orchestrate.progress", params: { pct: 50 } }]);
    expect(received2).toEqual([{ method: "orchestrate.progress", params: { pct: 50 } }]);
  });

  it("unsubscribing one handler keeps the other working, without a second engine_events invoke", () => {
    const client = new EngineClient();
    const received1: unknown[] = [];
    const received2: unknown[] = [];
    const unsubscribe1 = client.onEngineEvent((n) => received1.push(n));
    client.onEngineEvent((n) => received2.push(n));

    const channel = channelInstances[0]!;
    unsubscribe1();
    channel.onmessage?.({ method: "evals.progress", params: { pct: 10 } });

    expect(received1).toHaveLength(0);
    expect(received2).toHaveLength(1);

    const engineEventsCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "engine_events");
    expect(engineEventsCalls).toHaveLength(1);
  });

  it("wraps a raw notification with no recognizable method as 'unknown' rather than throwing", () => {
    const client = new EngineClient();
    const received: unknown[] = [];
    client.onEngineEvent((n) => received.push(n));

    const channel = channelInstances[0]!;
    channel.onmessage?.("not an object");

    expect(received).toEqual([{ method: "unknown", params: "not an object" }]);
  });
});

describe("typed method wrappers", () => {
  it("modelsList() calls engine_call with engine.models.list", async () => {
    invokeMock.mockResolvedValueOnce({ providers: [] });
    const client = new EngineClient();

    await client.modelsList();

    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.models.list",
      params: {},
      timeoutMs: undefined,
    });
  });

  it("wikiBuild(projectDir) calls engine_call with engine.wiki.build and the project dir", async () => {
    invokeMock.mockResolvedValueOnce({ filesIndexed: 3, filesSkipped: 0 });
    const client = new EngineClient();

    await client.wikiBuild("/home/me/project");

    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.wiki.build",
      params: { projectDir: "/home/me/project" },
      timeoutMs: undefined,
    });
  });

  it("modelsConfigure calls engine.models.configure with the provider config", async () => {
    invokeMock.mockResolvedValueOnce({ configured: true });
    const client = new EngineClient();
    const result = await client.modelsConfigure({
      id: "deepseek",
      kind: "deepseek",
      apiKey: "sk-test",
      baseURL: undefined,
    });
    expect(result).toEqual({ configured: true });
    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.models.configure",
      params: { id: "deepseek", kind: "deepseek", apiKey: "sk-test", baseURL: undefined },
      timeoutMs: undefined,
    });
  });
});

// A minimal but shape-accurate OrchestrateResult fixture (mirrors
// orchestrate.ts's own "worker-approved" finish() shape) — used wherever a
// test needs the main engine.orchestrate call to resolve successfully.
function orchestrateResultFixture(): OrchestrateResult {
  return {
    outcome: "worker-approved",
    agent: "generalist",
    taskClass: "default",
    resolution: { providerId: "deepseek", model: "deepseek-v4-flash" },
    attempts: [{ n: 1, kind: "worker", summary: "did the thing", verdict: { decision: "approve", reasons: [], severity: "none" } }],
    diff: "diff --git a/x b/x\n",
    diffStat: "1 file changed",
    worktree: { path: "/tmp/wt", branch: "of-worker-1" },
    cost: { workerUsd: 0.01, reviewUsd: 0.02, frontierUsd: 0.02, escalateUsd: null, totalUsd: 0.03, note: "estimate-class" },
  };
}

// A minimal but shape-accurate EvalsReportCard fixture (mirrors evals/run.ts's
// own returned object) — used wherever a test needs engine.evals.run to
// resolve successfully.
function evalsReportCardFixture(): EvalsReportCard {
  return {
    taskCount: 5,
    baseline: { passed: 4, costUsd: 1 },
    harness: { passed: 4, costUsd: 0.5, escalations: 1 },
    savingsPct: 0.5,
    qualityHeld: true,
    verdict: "pass",
    pricingConfidence: "verified",
    perTask: [],
    note: "ok",
    cleanTaskCount: 5,
    cleanBaselinePassed: 4,
    cleanHarnessPassed: 4,
    cleanSavingsPct: 0.5,
    measurementFailureCount: 0,
  };
}

describe("runOrchestrate/runEvals — cancellable-run helper", () => {
  it("runOrchestrate mints a UUID runId and passes it in the RPC params with NO timeoutMs", async () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe (first onEngineEvent call)
    invokeMock.mockResolvedValueOnce(orchestrateResultFixture());
    const client = new EngineClient();

    const run = client.runOrchestrate({ projectDir: "/proj", task: "fix the bug" });
    expect(run.runId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    await run.promise;

    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.orchestrate",
      params: { projectDir: "/proj", task: "fix the bug", runId: run.runId },
      timeoutMs: undefined,
    });
  });

  it("runEvals mints a UUID runId and passes it in the RPC params with NO timeoutMs", async () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe
    invokeMock.mockResolvedValueOnce(evalsReportCardFixture());
    const client = new EngineClient();

    const run = client.runEvals({ projectDir: "/proj", tasks: [{ commitSha: "abc123", testCommand: ["npm", "test"] }] });
    await run.promise;

    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.evals.run",
      params: {
        projectDir: "/proj",
        tasks: [{ commitSha: "abc123", testCommand: ["npm", "test"] }],
        runId: run.runId,
      },
      timeoutMs: undefined,
    });
  });

  it("two runOrchestrate calls mint two DIFFERENT runIds", async () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events (shared single subscription)
    invokeMock.mockImplementation(() => new Promise(() => {})); // both main calls stay pending
    const client = new EngineClient();

    const runA = client.runOrchestrate({ projectDir: "/proj", task: "a" });
    const runB = client.runOrchestrate({ projectDir: "/proj", task: "b" });

    expect(runA.runId).not.toEqual(runB.runId);
  });

  it("forwards orchestrate.progress notifications to onProgress while the run is in flight, ignoring other methods", () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe
    invokeMock.mockImplementationOnce(() => new Promise(() => {})); // main call stays pending
    const client = new EngineClient();
    const received: unknown[] = [];

    client.runOrchestrate({ projectDir: "/proj", task: "t" }, (event) => received.push(event));

    const channel = channelInstances[0]!;
    channel.onmessage?.({ method: "evals.progress", params: { stage: "should be filtered out" } });
    channel.onmessage?.({ method: "orchestrate.progress", params: { stage: "route", detail: "routing the task" } });

    expect(received).toEqual([{ stage: "route", detail: "routing the task" }]);
  });

  it("forwards evals.progress notifications to onProgress, ignoring other methods", () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe
    invokeMock.mockImplementationOnce(() => new Promise(() => {})); // main call stays pending
    const client = new EngineClient();
    const received: unknown[] = [];

    client.runEvals({ projectDir: "/proj", tasks: [{ commitSha: "abc", testCommand: ["t"] }] }, (event) => received.push(event));

    const channel = channelInstances[0]!;
    channel.onmessage?.({ method: "orchestrate.progress", params: { stage: "should be filtered out" } });
    channel.onmessage?.({ method: "evals.progress", params: { stage: "baseline", taskId: "task-1" } });

    expect(received).toEqual([{ stage: "baseline", taskId: "task-1" }]);
  });

  // M7c Task 5: the engine now tags orchestrate.progress/evals.progress with
  // the run's own runId — this closes the single-run-at-a-time assumption
  // #startCancellableRun's own doc comment used to document. Two concurrent
  // runOrchestrate calls (sharing the one Channel) must each only see their
  // OWN run's progress; a notification with no runId at all (hypothetically,
  // an older engine build) is still forwarded to both rather than dropped.
  it("filters orchestrate.progress by runId across two concurrent runs, forwarding a runId-less notification to both", () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe (shared)
    invokeMock.mockImplementation(() => new Promise(() => {})); // both main calls stay pending
    const client = new EngineClient();
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];

    const runA = client.runOrchestrate({ projectDir: "/proj", task: "a" }, (event) => receivedA.push(event));
    const runB = client.runOrchestrate({ projectDir: "/proj", task: "b" }, (event) => receivedB.push(event));

    const channel = channelInstances[0]!;
    channel.onmessage?.({ method: "orchestrate.progress", params: { stage: "route", runId: runA.runId } });
    channel.onmessage?.({ method: "orchestrate.progress", params: { stage: "worker:1", runId: runB.runId } });
    channel.onmessage?.({ method: "orchestrate.progress", params: { stage: "no-runid-stage" } });

    expect(receivedA).toEqual([
      { stage: "route", runId: runA.runId },
      { stage: "no-runid-stage" },
    ]);
    expect(receivedB).toEqual([
      { stage: "worker:1", runId: runB.runId },
      { stage: "no-runid-stage" },
    ]);
  });

  it("unsubscribes from onEngineEvent once the run settles successfully — no further progress delivered", async () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe
    invokeMock.mockResolvedValueOnce(orchestrateResultFixture());
    const client = new EngineClient();
    const received: unknown[] = [];

    const run = client.runOrchestrate({ projectDir: "/proj", task: "t" }, (event) => received.push(event));
    await run.promise;

    const channel = channelInstances[0]!;
    channel.onmessage?.({ method: "orchestrate.progress", params: { stage: "late", detail: "after settle" } });

    expect(received).toHaveLength(0);
  });

  it("unsubscribes from onEngineEvent once the run settles via a genuine failure", async () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe
    invokeMock.mockRejectedValueOnce({ code: -32000, message: "orchestrate failed: boom", data: { attempts: [], worktree: null } });
    const client = new EngineClient();
    const received: unknown[] = [];

    const run = client.runOrchestrate({ projectDir: "/proj", task: "t" }, (event) => received.push(event));
    await run.promise.catch(() => {});

    const channel = channelInstances[0]!;
    channel.onmessage?.({ method: "orchestrate.progress", params: { stage: "late", detail: "after settle" } });

    expect(received).toHaveLength(0);
  });

  it("a genuine failure (no cancelled marker) rejects the promise with a plain EngineError, not RunCancelledError", async () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe
    invokeMock.mockRejectedValueOnce({
      code: -32000,
      message: "orchestrate failed: worker crashed",
      data: { attempts: [], worktree: null },
    });
    const client = new EngineClient();

    const run = client.runOrchestrate({ projectDir: "/proj", task: "t" });
    let caught: unknown;
    try {
      await run.promise;
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EngineError);
    expect(caught).not.toBeInstanceOf(RunCancelledError);
    expect((caught as EngineError).message).toBe("orchestrate failed: worker crashed");
  });

  it("a cancelled run (data.cancelled === true) rejects the promise with a distinct RunCancelledError, not EngineError", async () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe
    invokeMock.mockRejectedValueOnce({
      code: -32000,
      message: "orchestrate cancelled",
      data: { cancelled: true, attempts: [], worktree: null },
    });
    const client = new EngineClient();

    const run = client.runOrchestrate({ projectDir: "/proj", task: "t" });
    let caught: unknown;
    try {
      await run.promise;
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RunCancelledError);
    expect(caught).not.toBeInstanceOf(EngineError);
    expect((caught as RunCancelledError).runId).toBe(run.runId);
    expect((caught as RunCancelledError).data).toEqual({ cancelled: true, attempts: [], worktree: null });
  });

  it("cancel() calls engine.cancel with this run's runId", async () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe
    invokeMock.mockImplementationOnce(() => new Promise(() => {})); // main call stays pending
    invokeMock.mockResolvedValueOnce({ cancelled: true });
    const client = new EngineClient();

    const run = client.runOrchestrate({ projectDir: "/proj", task: "t" });
    await run.cancel();

    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.cancel",
      params: { runId: run.runId },
      timeoutMs: undefined,
    });
  });

  it("stops after ONE cancel() call when the run has already settled naturally, even though the engine reports {cancelled:false}", async () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe
    invokeMock.mockResolvedValueOnce(orchestrateResultFixture()); // main call resolves right away
    invokeMock.mockResolvedValueOnce({ cancelled: false }); // engine.cancel: unknown/already-finished runId
    const client = new EngineClient();

    const run = client.runOrchestrate({ projectDir: "/proj", task: "t" });
    await run.promise; // let the run settle BEFORE cancelling
    await run.cancel();

    const cancelCalls = invokeMock.mock.calls.filter(
      ([cmd, args]) => cmd === "engine_call" && (args as { method?: string }).method === "engine.cancel",
    );
    expect(cancelCalls).toHaveLength(1);
  });

  it("retries a {cancelled:false} cancel-before-register race while the run stays pending, up to a bounded number of attempts", async () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe
      invokeMock.mockImplementationOnce(() => new Promise(() => {})); // main call NEVER settles
      invokeMock.mockResolvedValueOnce({ cancelled: false }); // attempt 1
      invokeMock.mockResolvedValueOnce({ cancelled: false }); // attempt 2
      invokeMock.mockResolvedValueOnce({ cancelled: false }); // attempt 3
      const client = new EngineClient();

      const run = client.runOrchestrate({ projectDir: "/proj", task: "t" });
      const cancelPromise = run.cancel();

      // Drive the retry loop's ~150ms-apart delays forward without relying
      // on real wall-clock time.
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(200);
      await cancelPromise;

      const cancelCalls = invokeMock.mock.calls.filter(
        ([cmd, args]) => cmd === "engine_call" && (args as { method?: string }).method === "engine.cancel",
      );
      expect(cancelCalls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() gives up (resolves) without throwing once engine.cancel itself rejects", async () => {
    invokeMock.mockResolvedValueOnce(undefined); // engine_events subscribe
    invokeMock.mockImplementationOnce(() => new Promise(() => {})); // main call stays pending
    invokeMock.mockRejectedValueOnce(new Error("ipc transport exploded"));
    const client = new EngineClient();

    const run = client.runOrchestrate({ projectDir: "/proj", task: "t" });
    await expect(run.cancel()).resolves.toBeUndefined();
  });
});

describe("secret command wrappers (Rust commands, not engine_call)", () => {
  it("setSecret calls invoke('set_secret', ...) with the persist flag", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await setSecret("anthropic", "sk-test-value", true);

    expect(invokeMock).toHaveBeenCalledWith("set_secret", { id: "anthropic", value: "sk-test-value", persist: true });
  });

  it("getSecret calls invoke('get_secret', {id})", async () => {
    invokeMock.mockResolvedValueOnce("sk-test-value");

    const value = await getSecret("anthropic");

    expect(value).toBe("sk-test-value");
    expect(invokeMock).toHaveBeenCalledWith("get_secret", { id: "anthropic" });
  });

  it("deleteSecret calls invoke('delete_secret', {id})", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await deleteSecret("anthropic");

    expect(invokeMock).toHaveBeenCalledWith("delete_secret", { id: "anthropic" });
  });

  it("listSecretIds returns ids", async () => {
    invokeMock.mockResolvedValueOnce(["anthropic", "openai"]);

    const ids = await listSecretIds();

    expect(ids).toEqual(["anthropic", "openai"]);
    expect(invokeMock).toHaveBeenCalledWith("list_secret_ids");
  });

  it("loadPersistedSecrets calls invoke('load_persisted_secrets')", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await loadPersistedSecrets();

    expect(invokeMock).toHaveBeenCalledWith("load_persisted_secrets");
  });
});
