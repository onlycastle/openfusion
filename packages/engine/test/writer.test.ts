import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { encodeNdjson } from "../src/rpc/ndjson.js";
import { createNdjsonWriter } from "../src/rpc/writer.js";

/**
 * A Writable with a tiny highWaterMark whose _write never completes until the
 * test explicitly calls flushOne() — simulates a slow/blocked consumer (the
 * Rust EngineBridge's reader falling behind) so we can observe whether the
 * writer respects backpressure instead of blasting stream.write() regardless
 * of its return value.
 */
function makeSlowWritable() {
  const received: string[] = [];
  const pendingCallbacks: Array<() => void> = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _enc, callback) {
      received.push(chunk.toString("utf8"));
      pendingCallbacks.push(callback);
    },
  });
  return {
    stream,
    received,
    flushOne(): void {
      const cb = pendingCallbacks.shift();
      if (cb === undefined) throw new Error("no pending write to flush");
      cb();
    },
    pendingCount: () => pendingCallbacks.length,
  };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("createNdjsonWriter", () => {
  it("applies backpressure: does not call stream.write for queued lines until drain fires", async () => {
    const { stream, received, flushOne } = makeSlowWritable();
    const write = createNdjsonWriter(stream);
    const lines = Array.from({ length: 10 }, (_, i) => encodeNdjson({ i }));

    for (const line of lines) write(line);

    // Only the first line should have reached the underlying stream so far —
    // the rest must be queued in-process waiting for 'drain', not blasted at
    // stream.write() regardless of backpressure.
    expect(received).toHaveLength(1);

    for (let i = 0; i < lines.length; i++) {
      await tick();
      expect(received).toHaveLength(i + 1);
      flushOne();
    }
    await tick();

    expect(received).toEqual(lines);
  });

  it("delivers all lines in order and uncorrupted end-to-end through a slow consumer", async () => {
    const { stream, received, flushOne } = makeSlowWritable();
    const write = createNdjsonWriter(stream);
    const payloads = Array.from({ length: 25 }, (_, i) => ({ id: i, tag: `msg-${i}` }));
    for (const p of payloads) write(encodeNdjson(p));

    for (let i = 0; i < payloads.length - 1; i++) {
      await tick();
      flushOne();
    }
    await tick();
    flushOne();
    await tick();

    const decoded = received.map((line) => JSON.parse(line) as { id: number; tag: string });
    expect(decoded).toEqual(payloads);
  });

  it("writes immediately (no artificial delay) against a fast-draining consumer", async () => {
    const received: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, callback) {
        received.push(chunk.toString("utf8"));
        callback();
      },
    });
    const write = createNdjsonWriter(stream);
    const lines = Array.from({ length: 5 }, (_, i) => encodeNdjson({ i }));
    for (const line of lines) write(line);
    await tick();
    expect(received).toEqual(lines);
  });

  describe("whenIdle", () => {
    it("resolves immediately when the writer is already idle (never written, or fully flushed)", async () => {
      const stream = new Writable({
        write(_chunk, _enc, callback) {
          callback();
        },
      });
      const write = createNdjsonWriter(stream);
      await expect(write.whenIdle()).resolves.toBeUndefined();

      write(encodeNdjson({ a: 1 }));
      await tick();
      await expect(write.whenIdle()).resolves.toBeUndefined();
    });

    it("resolves only once a slow consumer's queue fully drains AND the last write's callback has fired, preserving order", async () => {
      const { stream, received, flushOne } = makeSlowWritable();
      const write = createNdjsonWriter(stream);
      const lines = Array.from({ length: 5 }, (_, i) => encodeNdjson({ i }));
      for (const line of lines) write(line);

      let resolved = false;
      const idle = write.whenIdle().then(() => {
        resolved = true;
      });

      for (let i = 0; i < lines.length; i++) {
        await tick();
        expect(resolved).toBe(false);
        flushOne();
      }
      await idle;

      expect(resolved).toBe(true);
      expect(received).toEqual(lines);
    });
  });

  describe("broken-stdout safety (EPIPE / stream errors)", () => {
    it("handles stream.write() throwing synchronously (EPIPE) without an uncaught exception, settles whenIdle, and stops trying to write", async () => {
      const stream = new Writable({
        write(_chunk, _enc, callback) {
          callback();
        },
      });
      // Simulate a broken pipe: the underlying fd is already gone, so the
      // very next write() throws synchronously, as Node can do in that case.
      (stream as unknown as { write: (chunk: unknown) => boolean }).write = () => {
        throw new Error("EPIPE: write EPIPE");
      };
      const errors: unknown[] = [];
      const write = createNdjsonWriter(stream, { onError: (err) => errors.push(err) });

      expect(() => write(encodeNdjson({ a: 1 }))).not.toThrow();
      await write.whenIdle();
      expect(errors).toHaveLength(1);

      // Further writes must be no-ops, not repeated throws (no crash-loop).
      expect(() => write(encodeNdjson({ b: 2 }))).not.toThrow();
      await write.whenIdle();
      expect(errors).toHaveLength(1);
    });

    it("treats an async 'error' event on the stream the same as a broken pipe", async () => {
      const { stream } = makeSlowWritable();
      const errors: unknown[] = [];
      const write = createNdjsonWriter(stream, { onError: (err) => errors.push(err) });

      write(encodeNdjson({ a: 1 })); // reaches the stream, stays pending (slow consumer)
      stream.emit("error", new Error("EPIPE: write EPIPE"));

      await write.whenIdle();
      expect(errors).toHaveLength(1);
      expect(() => write(encodeNdjson({ b: 2 }))).not.toThrow();
    });
  });

  describe("queue-length warning", () => {
    it("fires onQueueWarning exactly once when the pending queue crosses the configured threshold", () => {
      const { stream } = makeSlowWritable();
      const warnings: number[] = [];
      const write = createNdjsonWriter(stream, {
        queueWarnThreshold: 3,
        onQueueWarning: (len) => warnings.push(len),
      });

      for (let i = 0; i < 10; i++) write(encodeNdjson({ i }));

      expect(warnings).toEqual([3]);
    });
  });
});
