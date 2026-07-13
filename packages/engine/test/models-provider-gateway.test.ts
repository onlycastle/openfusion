import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FrontierAdapter, FrontierEvent, FrontierSession } from "../src/engines/types.js";
import { ProviderGateway } from "../src/models/gateway.js";
import { CostMeter } from "../src/models/meter.js";
import { RpcMethodError } from "../src/rpc/errors.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ProviderGateway", () => {
  it("bounds active and queued calls and returns a stable BUSY error", async () => {
    const gateway = new ProviderGateway({ meter: new CostMeter(), maxActive: 1, maxActivePerProvider: 1, maxQueued: 1 });
    const first = deferred<string>();
    const started: string[] = [];
    const call1 = gateway.execute({ providerId: "p1" }, async () => {
      started.push("first");
      return first.promise;
    });
    const call2 = gateway.execute({ providerId: "p1" }, async () => {
      started.push("second");
      return "two";
    });

    await expect(gateway.execute({ providerId: "p2" }, async () => "three")).rejects.toMatchObject({
      code: -32001,
      message: "provider gateway busy; retry later",
    } satisfies Partial<RpcMethodError>);
    expect(gateway.stats()).toMatchObject({ active: 1, queued: 1 });

    first.resolve("one");
    await expect(call1).resolves.toBe("one");
    await expect(call2).resolves.toBe("two");
    expect(started).toEqual(["first", "second"]);
    expect(gateway.stats()).toMatchObject({ active: 0, queued: 0, logicalCalls: 3, attempts: 2 });
  });

  it("cancels a queued call without consuming a permit", async () => {
    const gateway = new ProviderGateway({ meter: new CostMeter(), maxActive: 1, maxActivePerProvider: 1 });
    const first = deferred<void>();
    const active = gateway.execute({ providerId: "p1" }, () => first.promise);
    const controller = new AbortController();
    const queued = gateway.execute({ providerId: "p1", signal: controller.signal }, async () => "never");
    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(gateway.stats()).toMatchObject({ active: 1, queued: 0 });
    first.resolve();
    await active;
  });

  it("stops new admission while draining work that was already queued", async () => {
    const gateway = new ProviderGateway({ meter: new CostMeter(), maxActive: 1, maxActivePerProvider: 1 });
    const first = deferred<void>();
    const active = gateway.execute({ providerId: "p1" }, () => first.promise);
    const queued = gateway.execute({ providerId: "p1" }, async () => "drained");
    gateway.stopAdmission();
    await expect(gateway.execute({ providerId: "p2" }, async () => "late")).rejects.toMatchObject({
      name: "AbortError",
    });
    first.resolve();
    await active;
    await expect(queued).resolves.toBe("drained");
  });

  it("propagates gateway shutdown into active model operations", async () => {
    const gateway = new ProviderGateway({ meter: new CostMeter() });
    const active = gateway.execute({ providerId: "p1" }, (signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), {
        once: true,
      });
    }));
    gateway.abortAll();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    expect(gateway.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("owns bounded transport retry admission and telemetry", async () => {
    const gateway = new ProviderGateway({ meter: new CostMeter() });
    let attempts = 0;
    const result = await gateway.execute(
      {
        providerId: "p1",
        maxRetries: 2,
        retryDelayMs: 1,
        shouldRetry: () => true,
        cacheStatus: "miss",
      },
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("rate limited");
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(gateway.stats()).toMatchObject({
      logicalCalls: 1,
      attempts: 2,
      retries: 1,
      cacheMisses: 1,
    });
  });

  it("routes usage accounting through the shared meter", () => {
    const meter = new CostMeter();
    const gateway = new ProviderGateway({ meter });
    gateway.recordUsage({
      providerId: "p1",
      kind: "test",
      model: "m1",
      usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1 },
      costUsd: 0.01,
      at: Date.now(),
      source: "worker",
      pricingConfidence: "verified",
    });
    expect(meter.totals()).toMatchObject({ calls: 1, inputTokens: 2, outputTokens: 3, costUsd: 0.01 });
  });

  it("admits frontier turns synchronously when capacity exists and preserves streaming events", async () => {
    let promptCalls = 0;
    const session: FrontierSession = {
      id: randomUUID(),
      projectDir: "/tmp/project",
      prompt() {
        promptCalls += 1;
        async function* events(): AsyncGenerator<FrontierEvent> {
          yield { type: "text", text: "hello" };
          yield {
            type: "result",
            resultText: "done",
            costUsd: 0,
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
            numTurns: 1,
            durationMs: 1,
            engineSessionId: null,
          };
        }
        return { events: events(), abort() {} };
      },
      async close() {},
    };
    const adapter: FrontierAdapter = {
      kind: "test-frontier",
      async createSession() {
        return session;
      },
    };
    const gateway = new ProviderGateway({ meter: new CostMeter() });
    const wrapped = await gateway.createFrontierSession(adapter, {
      projectDir: session.projectDir,
      wikiMcpUrl: null,
      log() {},
    });
    const handle = wrapped.prompt("hello");
    expect(promptCalls).toBe(1);

    const events: FrontierEvent[] = [];
    for await (const event of handle.events) events.push(event);
    expect(promptCalls).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["text", "result"]);
    expect(gateway.stats()).toMatchObject({ logicalCalls: 1, attempts: 1, active: 0 });
  });
});
