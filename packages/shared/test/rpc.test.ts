import { describe, expect, it } from "vitest";
import { RpcRequestSchema, RpcResponseSchema } from "../src/index.js";

describe("RpcRequestSchema", () => {
  it("accepts a valid request", () => {
    const parsed = RpcRequestSchema.parse({
      jsonrpc: "2.0",
      id: 1,
      method: "engine.ping",
    });
    expect(parsed.method).toBe("engine.ping");
    expect(parsed.id).toBe(1);
  });

  it("accepts a notification (no id)", () => {
    const parsed = RpcRequestSchema.parse({ jsonrpc: "2.0", method: "log" });
    expect(parsed.id).toBeUndefined();
  });

  it("rejects a missing jsonrpc field", () => {
    expect(RpcRequestSchema.safeParse({ id: 1, method: "x" }).success).toBe(false);
  });

  it("rejects an empty method", () => {
    expect(
      RpcRequestSchema.safeParse({ jsonrpc: "2.0", id: 1, method: "" }).success,
    ).toBe(false);
  });

  it("rejects a fractional numeric id", () => {
    expect(
      RpcRequestSchema.safeParse({ jsonrpc: "2.0", id: 1.5, method: "x" }).success,
    ).toBe(false);
  });

  it("accepts a string id", () => {
    expect(
      RpcRequestSchema.safeParse({ jsonrpc: "2.0", id: "req-1", method: "x" }).success,
    ).toBe(true);
  });
});

describe("RpcResponseSchema", () => {
  it("accepts a result-only response", () => {
    const ok = RpcResponseSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      result: { pong: true },
    });
    expect(ok.success).toBe(true);
  });

  it("accepts an error-only response", () => {
    const ok = RpcResponseSchema.safeParse({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects a response with both result and error", () => {
    const bad = RpcResponseSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: { code: -32603, message: "boom" },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a response with neither result nor error", () => {
    expect(
      RpcResponseSchema.safeParse({ jsonrpc: "2.0", id: 1 }).success,
    ).toBe(false);
  });
});
