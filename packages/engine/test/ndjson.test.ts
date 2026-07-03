import { describe, expect, it } from "vitest";
import { NdjsonDecoder, encodeNdjson } from "../src/rpc/ndjson.js";

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
    expect(out).toEqual([{ ok: false, raw: "not json" }]);
  });

  it("skips blank lines", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push("\n\n")).toEqual([]);
  });
});

describe("encodeNdjson", () => {
  it("appends a newline to serialized JSON", () => {
    expect(encodeNdjson({ a: 1 })).toBe('{"a":1}\n');
  });
});
