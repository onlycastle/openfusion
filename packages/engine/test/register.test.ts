import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import { RpcDispatcher } from "../src/rpc/dispatcher.js";
import { RpcMethodError } from "../src/rpc/errors.js";
import { registerMethod } from "../src/rpc/register.js";

const ParamsSchema = z.object({ who: z.string().min(1) });

function makeDispatcher(): RpcDispatcher {
  const dispatcher = new RpcDispatcher();
  registerMethod(dispatcher, "greet", ParamsSchema, ({ who }) => `hi ${who}`);
  registerMethod(dispatcher, "fail.custom", ParamsSchema, () => {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "app broke", { detail: 1 });
  });
  return dispatcher;
}

describe("registerMethod", () => {
  it("passes validated params to the handler", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "greet",
      params: { who: "ada" },
    });
    expect(res?.result).toBe("hi ada");
  });

  it("rejects invalid params with INVALID_PARAMS", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "greet",
      params: { who: 42 },
    });
    expect(res?.error?.code).toBe(RpcErrorCodes.INVALID_PARAMS);
    expect(res?.error?.message).toContain("greet");
  });

  it("lets RpcMethodError carry its own code and data", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 3,
      method: "fail.custom",
      params: { who: "x" },
    });
    expect(res?.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res?.error?.message).toBe("app broke");
    expect(res?.error?.data).toEqual({ detail: 1 });
  });

  it("still maps plain throws to INTERNAL_ERROR", async () => {
    const dispatcher = new RpcDispatcher();
    registerMethod(dispatcher, "boom", z.object({}), () => {
      throw new Error("plain");
    });
    const res = await dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 4,
      method: "boom",
      params: {},
    });
    expect(res?.error?.code).toBe(RpcErrorCodes.INTERNAL_ERROR);
  });

  it("includes structured zod issues in error.data", async () => {
    const res = await makeDispatcher().dispatch({
      jsonrpc: "2.0",
      id: 9,
      method: "greet",
      params: { who: 42 },
    });
    const data = res?.error?.data as { issues: Array<{ path: string[]; message: string }> };
    expect(data.issues[0]?.path).toEqual(["who"]);
    expect(typeof data.issues[0]?.message).toBe("string");
  });
});
