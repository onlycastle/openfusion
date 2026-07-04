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

import { EngineClient, EngineError, setSecret, getSecret, deleteSecret, listSecretIds, loadPersistedSecrets } from "./engineClient";

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
