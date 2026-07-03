import { describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { RpcDispatcher } from "../src/rpc/dispatcher.js";

function makeDispatcher(): RpcDispatcher {
  const dispatcher = new RpcDispatcher();
  dispatcher.register("echo", (params) => ({ echoed: params }));
  dispatcher.register("boom", () => {
    throw new Error("kaboom");
  });
  dispatcher.register("nothing", () => undefined);
  return dispatcher;
}

describe("RpcDispatcher", () => {
  it("dispatches a request to its handler and wraps the result", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 7,
      method: "echo",
      params: { x: 1 },
    });
    expect(res).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { echoed: { x: 1 } },
    });
  });

  it("normalizes an undefined handler result to null", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "nothing",
    });
    expect(res).toEqual({ jsonrpc: "2.0", id: 1, result: null });
  });

  it("returns METHOD_NOT_FOUND for unknown methods, preserving id", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: "abc",
      method: "nope",
    });
    expect(res?.id).toBe("abc");
    expect(res?.error?.code).toBe(RpcErrorCodes.METHOD_NOT_FOUND);
  });

  it("returns INVALID_REQUEST with null id for a malformed envelope", async () => {
    const res = await makeDispatcher().dispatch({ method: 42 });
    expect(res?.id).toBeNull();
    expect(res?.error?.code).toBe(RpcErrorCodes.INVALID_REQUEST);
  });

  it("converts a handler throw into INTERNAL_ERROR with the message", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "boom",
    });
    expect(res?.error?.code).toBe(RpcErrorCodes.INTERNAL_ERROR);
    expect(res?.error?.message).toBe("kaboom");
  });

  it("returns null for notifications (no id), even on error", async () => {
    const dispatcher = makeDispatcher();
    expect(
      await dispatcher.dispatch({ jsonrpc: "2.0", method: "echo", params: 1 }),
    ).toBeNull();
    expect(
      await dispatcher.dispatch({ jsonrpc: "2.0", method: "boom" }),
    ).toBeNull();
  });

  it("throws when registering a duplicate method name", () => {
    const dispatcher = makeDispatcher();
    expect(() => dispatcher.register("echo", () => null)).toThrow(
      /already registered/,
    );
  });

  it("produces a PARSE_ERROR response helper", () => {
    const res = makeDispatcher().parseError();
    expect(res.id).toBeNull();
    expect(res.error?.code).toBe(RpcErrorCodes.PARSE_ERROR);
  });
});
