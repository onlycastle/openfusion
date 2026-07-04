import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { RpcDispatcher } from "../src/rpc/dispatcher.js";
import { StdioPipeline } from "../src/rpc/stdio.js";
import { createNdjsonWriter } from "../src/rpc/writer.js";

function setup() {
  const dispatcher = new RpcDispatcher();
  dispatcher.register("slow", async () => {
    await new Promise((r) => setTimeout(r, 50));
    return "slow-done";
  });
  dispatcher.register("fast", () => "fast-done");
  const lines: string[] = [];
  const pipeline = new StdioPipeline(dispatcher, (l) => lines.push(l));
  return { pipeline, lines };
}

describe("StdioPipeline", () => {
  it("does not serialize dispatches: fast response overtakes slow", async () => {
    const { pipeline, lines } = setup();
    pipeline.handleDecoded({ ok: true, value: { jsonrpc: "2.0", id: 1, method: "slow" } });
    pipeline.handleDecoded({ ok: true, value: { jsonrpc: "2.0", id: 2, method: "fast" } });
    await pipeline.drain();
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { id: number };
    const second = JSON.parse(lines[1]!) as { id: number };
    expect(first.id).toBe(2);
    expect(second.id).toBe(1);
  });

  it("answers parse errors and suppresses notification responses", async () => {
    const { pipeline, lines } = setup();
    pipeline.handleDecoded({ ok: false, oversized: false, raw: "garbage" });
    pipeline.handleDecoded({ ok: true, value: { jsonrpc: "2.0", method: "fast" } });
    await pipeline.drain();
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { error: { code: number } }).error.code).toBe(-32700);
  });

  it("drain resolves when nothing is in flight", async () => {
    const { pipeline } = setup();
    await expect(pipeline.drain()).resolves.toBeUndefined();
  });

  it("concurrent dispatch: N in-flight requests completing out of order never cross-talk", async () => {
    const dispatcher = new RpcDispatcher();
    // Each handler's delay is inversely related to its tag so completion
    // order is scrambled relative to dispatch order — and each handler
    // echoes back its OWN params, so any accidental sharing of state between
    // concurrently-settling promises would show up as a mismatched tag.
    dispatcher.register("echo", async (params) => {
      const { tag, delayMs } = params as { tag: string; delayMs: number };
      await new Promise((r) => setTimeout(r, delayMs));
      return { tag };
    });
    const lines: string[] = [];
    const pipeline = new StdioPipeline(dispatcher, (l) => lines.push(l));

    const n = 25;
    const requests = Array.from({ length: n }, (_, i) => ({
      id: i,
      tag: `req-${i}`,
      // scramble completion order: reverse-ish delay pattern
      delayMs: (n - i) % 7,
    }));
    for (const req of requests) {
      pipeline.handleDecoded({
        ok: true,
        value: {
          jsonrpc: "2.0",
          id: req.id,
          method: "echo",
          params: { tag: req.tag, delayMs: req.delayMs },
        },
      });
    }
    await pipeline.drain();

    expect(lines).toHaveLength(n);
    const responses = lines.map(
      (l) => JSON.parse(l) as { id: number; result: { tag: string } },
    );
    // Every response's id must correspond to a request that asked for
    // exactly that id's own tag — no cross-talk between concurrently
    // resolving handlers.
    const byId = new Map(responses.map((r) => [r.id, r.result.tag]));
    expect(byId.size).toBe(n); // no duplicate/missing ids
    for (const req of requests) {
      expect(byId.get(req.id)).toBe(req.tag);
    }
  });

  it("an oversized decoded line is reported to the transport-error sink, not written to stdout, and the reader keeps going", async () => {
    const lines: string[] = [];
    const errors: unknown[] = [];
    const dispatcher = new RpcDispatcher();
    dispatcher.register("fast", () => "fast-done");
    const pipeline = new StdioPipeline(
      dispatcher,
      (l) => lines.push(l),
      (err) => errors.push(err),
    );

    pipeline.handleDecoded({
      ok: false,
      oversized: true,
      discardedBytes: 999,
    });
    pipeline.handleDecoded({
      ok: true,
      value: { jsonrpc: "2.0", id: 1, method: "fast" },
    });
    await pipeline.drain();

    // No stdout line for the oversized event (no id to correlate to), but
    // the reader survived and handled the next request normally.
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { id: number }).id).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it("backpressure: a slow stdout consumer still receives every response, in order, uncorrupted", async () => {
    const dispatcher = new RpcDispatcher();
    dispatcher.register("echo", (params) => params);
    const received: string[] = [];
    const pendingCallbacks: Array<() => void> = [];
    const slowStream = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _enc, callback) {
        received.push(chunk.toString("utf8"));
        pendingCallbacks.push(callback);
      },
    });
    const write = createNdjsonWriter(slowStream);
    const pipeline = new StdioPipeline(dispatcher, write);

    const n = 8;
    for (let i = 0; i < n; i++) {
      pipeline.handleDecoded({
        ok: true,
        value: { jsonrpc: "2.0", id: i, method: "echo", params: { i } },
      });
    }
    await pipeline.drain();

    // Drain the slow consumer's backlog one ack at a time.
    while (received.length < n || pendingCallbacks.length > 0) {
      const cb = pendingCallbacks.shift();
      if (cb === undefined) {
        await new Promise((r) => setImmediate(r));
        continue;
      }
      cb();
      await new Promise((r) => setImmediate(r));
    }

    expect(received).toHaveLength(n);
    const ids = received.map((l) => (JSON.parse(l) as { id: number }).id);
    expect(ids).toEqual(Array.from({ length: n }, (_, i) => i));
  });
});
