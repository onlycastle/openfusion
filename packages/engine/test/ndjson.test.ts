import { describe, expect, it } from "vitest";
import {
  MAX_NDJSON_LINE_BYTES,
  NdjsonDecoder,
  encodeNdjson,
} from "../src/rpc/ndjson.js";

describe("NdjsonDecoder", () => {
  it("decodes a single complete line", () => {
    const decoder = new NdjsonDecoder();
    const out = decoder.push('{"a":1}\n');
    expect(out).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it("decodes two messages arriving in one chunk", () => {
    const decoder = new NdjsonDecoder();
    const out = decoder.push('{"a":1}\n{"b":2}\n');
    expect(out).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
    ]);
  });

  it("buffers a message split across chunks", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push('{"a"')).toEqual([]);
    expect(decoder.push(":1}\n")).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it("reports invalid JSON lines without throwing", () => {
    const decoder = new NdjsonDecoder();
    const out = decoder.push("not json\n");
    expect(out).toEqual([{ ok: false, oversized: false, raw: "not json" }]);
  });

  it("skips blank lines", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push("\n\n")).toEqual([]);
  });

  it("survives a malformed line and keeps decoding subsequent valid lines", () => {
    const decoder = new NdjsonDecoder();
    const out = decoder.push('garbage\n{"ok":true}\n');
    expect(out).toEqual([
      { ok: false, oversized: false, raw: "garbage" },
      { ok: true, value: { ok: true } },
    ]);
  });

  describe("CRLF tolerance", () => {
    it("parses a \\r\\n-terminated line identically to \\n", () => {
      const decoder = new NdjsonDecoder();
      const out = decoder.push('{"a":1}\r\n');
      expect(out).toEqual([{ ok: true, value: { a: 1 } }]);
    });

    it("handles CRLF across a chunk split (CR at end of first chunk)", () => {
      const decoder = new NdjsonDecoder();
      expect(decoder.push('{"a":1}\r')).toEqual([]);
      expect(decoder.push("\n")).toEqual([{ ok: true, value: { a: 1 } }]);
    });
  });

  describe("multibyte UTF-8 split across chunk boundary", () => {
    it("reassembles a 2-byte UTF-8 char (é) split mid-character", () => {
      const line = '{"msg":"héllo"}\n';
      const buf = Buffer.from(line, "utf8");
      // "é" ("é") encodes as bytes 0xC3 0xA9. Find that lead byte and
      // split the raw byte stream between the two bytes of the character —
      // if the reader decoded per-chunk (chunk.toString()) instead of
      // buffering bytes, each half would decode independently into a
      // replacement character (U+FFFD), corrupting the payload.
      const leadIndex = buf.indexOf(0xc3);
      expect(leadIndex).toBeGreaterThan(-1);
      const chunk1 = buf.subarray(0, leadIndex + 1);
      const chunk2 = buf.subarray(leadIndex + 1);

      const decoder = new NdjsonDecoder();
      expect(decoder.push(chunk1)).toEqual([]);
      expect(decoder.push(chunk2)).toEqual([
        { ok: true, value: { msg: "héllo" } },
      ]);
    });

    it("reassembles a 4-byte UTF-8 char (emoji) split mid-character", () => {
      const line = '{"msg":"hi 😀 bye"}\n';
      const buf = Buffer.from(line, "utf8");
      // The emoji is 4 bytes (0xF0 0x9F 0x98 0x80); split after its second byte.
      const leadIndex = buf.indexOf(0xf0);
      expect(leadIndex).toBeGreaterThan(-1);
      const chunk1 = buf.subarray(0, leadIndex + 2);
      const chunk2 = buf.subarray(leadIndex + 2);

      const decoder = new NdjsonDecoder();
      expect(decoder.push(chunk1)).toEqual([]);
      expect(decoder.push(chunk2)).toEqual([
        { ok: true, value: { msg: "hi 😀 bye" } },
      ]);
    });
  });

  describe("oversized-line cap", () => {
    it("exports a documented default cap of 32 MiB", () => {
      expect(MAX_NDJSON_LINE_BYTES).toBe(32 * 1024 * 1024);
    });

    it("rejects a partial line that grows past the cap before a newline arrives, and resets the buffer", () => {
      const decoder = new NdjsonDecoder({ maxLineBytes: 16 });
      const out = decoder.push("x".repeat(20)); // no newline yet — still "partial"
      expect(out).toEqual([{ ok: false, oversized: true, discardedBytes: 20 }]);
    });

    it("does not unbounded-buffer: after rejection the decoder starts clean for the next line", () => {
      const decoder = new NdjsonDecoder({ maxLineBytes: 16 });
      decoder.push("x".repeat(20)); // triggers reset, enters resync/skip mode
      // The rejected message's own terminating newline (leading \n here) must
      // arrive before the decoder can safely resume clean framing — see the
      // "resync after an oversized rejection" tests below for why: bytes
      // arriving before that terminator are the rejected message's tail, not
      // a fresh line.
      const out = decoder.push('\n{"a":1}\n');
      expect(out).toEqual([{ ok: true, value: { a: 1 } }]);
    });

    it("rejects a single oversized chunk spread across multiple pushes without ever growing unbounded", () => {
      const decoder = new NdjsonDecoder({ maxLineBytes: 16 });
      expect(decoder.push("x".repeat(10))).toEqual([]);
      expect(decoder.push("x".repeat(10))).toEqual([
        { ok: false, oversized: true, discardedBytes: 20 },
      ]);
    });

    it("rejects a complete (newline-terminated) line whose body exceeds the cap", () => {
      const decoder = new NdjsonDecoder({ maxLineBytes: 16 });
      const out = decoder.push(`${"x".repeat(20)}\n{"a":1}\n`);
      expect(out).toEqual([
        { ok: false, oversized: true, discardedBytes: 20 },
        { ok: true, value: { a: 1 } },
      ]);
    });

    it("accepts a line exactly at the cap", () => {
      const decoder = new NdjsonDecoder({ maxLineBytes: 16 });
      const body = `{"a":"${"x".repeat(8)}"}`; // exactly 16 bytes
      expect(Buffer.byteLength(body, "utf8")).toBe(16);
      const out = decoder.push(`${body}\n`);
      expect(out).toEqual([{ ok: true, value: { a: "x".repeat(8) } }]);
    });
  });

  describe("resync after an oversized rejection", () => {
    // The line cap protects against unbounded buffering, but a legitimate
    // (just oversized) single message — e.g. a big diff in a worker.progress
    // notification — doesn't stop sending once its prefix trips the cap; its
    // remaining bytes keep arriving as the "tail" of the SAME rejected
    // message, not as fresh input. The decoder must discard that whole tail
    // (through its real terminating newline) as one unit, rather than
    // re-framing it as new lines — otherwise every subsequent push sees
    // meaningless partial JSON and either re-trips the cap (spurious
    // additional oversized diagnostics) or, once a newline finally lands
    // inside the garbage, mis-parses it as a malformed new line
    // (a spurious `{ok:false, oversized:false, raw:...}` — the PARSE_ERROR
    // the Rust host would otherwise see, attributed to a message the engine
    // already rejected).

    it("discards a rejected message's tail across several pushes (each still over cap) with exactly one oversized diagnostic, then parses the next real line", () => {
      const decoder = new NdjsonDecoder({ maxLineBytes: 16 });

      const breach = decoder.push("x".repeat(20)); // no newline yet — breach on the growing buffer
      expect(breach).toEqual([{ ok: false, oversized: true, discardedBytes: 20 }]);

      // The SAME oversized message keeps streaming in — still no newline,
      // and each chunk individually still exceeds the (tiny, test-only) cap.
      // None of this should surface anything: it's the tail of an
      // already-rejected message, not new input to judge against the cap.
      expect(decoder.push("y".repeat(50))).toEqual([]);
      expect(decoder.push("z".repeat(50))).toEqual([]);
      expect(decoder.push('"still no newline here"')).toEqual([]);

      // The tail's real terminating newline finally arrives, immediately
      // followed by a genuinely new, valid line — both parse correctly with
      // no leftover noise from the discarded tail.
      const out = decoder.push('\n{"ok":true}\n');
      expect(out).toEqual([{ ok: true, value: { ok: true } }]);
    });

    it("discards a rejected message's tail that trickles in under-cap, avoiding a spurious parse-error line", () => {
      const decoder = new NdjsonDecoder({ maxLineBytes: 16 });

      expect(decoder.push("x".repeat(20))).toEqual([
        { ok: false, oversized: true, discardedBytes: 20 },
      ]);

      // Small tail fragments that never individually re-trip the cap — under
      // the old "resume clean framing immediately" behavior these would
      // silently reassemble into a fake 16-byte "line" the instant a
      // terminating newline shows up, and fail to JSON.parse.
      expect(decoder.push("aaaa")).toEqual([]);
      expect(decoder.push("bbbb")).toEqual([]);
      expect(decoder.push("cccc")).toEqual([]);
      // This newline is the rejected message's own terminator, not a fresh
      // line's — it must produce nothing (no oversized, no parse-error raw).
      expect(decoder.push("dddd\n")).toEqual([]);

      const out = decoder.push('{"next":1}\n');
      expect(out).toEqual([{ ok: true, value: { next: 1 } }]);
    });

    it("stays memory-bounded while skipping a long no-newline tail (never retains the discarded bytes)", () => {
      const decoder = new NdjsonDecoder({ maxLineBytes: 16 });
      decoder.push("x".repeat(20)); // breach; enters resync/skip mode

      const chunk = "y".repeat(4_000_000); // 4 MiB, far over the tiny test cap
      const start = Date.now();
      for (let i = 0; i < 40; i++) {
        // If the decoder were retaining skipped bytes instead of discarding
        // them as they arrive, this would both balloon memory (~160 MiB) and
        // take substantially longer (repeated concat-and-rescan of an
        // ever-growing buffer) — a bounded implementation handles each
        // push in isolation and stays fast.
        expect(decoder.push(chunk)).toEqual([]);
      }
      expect(Date.now() - start).toBeLessThan(1000);

      const out = decoder.push('\n{"done":true}\n');
      expect(out).toEqual([{ ok: true, value: { done: true } }]);
    });
  });
});

describe("encodeNdjson", () => {
  it("appends a newline to serialized JSON", () => {
    expect(encodeNdjson({ a: 1 })).toBe('{"a":1}\n');
  });
});
