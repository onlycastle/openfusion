import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { createEngine, type Engine } from "../src/engine.js";
import { ProviderRegistry } from "../src/models/providers.js";
import { RpcMethodError } from "../src/rpc/errors.js";

// Fixture literal only — must never appear outside test files (see task
// self-review grep).
const TEST_API_KEY = "sk-test-fixture-never-real-1234567890";

describe("ProviderRegistry", () => {
  it("rejects an openai-compatible config with no baseURL at configure time", () => {
    const registry = new ProviderRegistry();
    let caught: unknown;
    try {
      registry.configure({ id: "custom", kind: "openai-compatible", apiKey: TEST_API_KEY });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcMethodError);
    expect((caught as RpcMethodError).code).toBe(RpcErrorCodes.INVALID_PARAMS);
  });

  it("list() reflects a configured provider without ever exposing the apiKey", () => {
    const registry = new ProviderRegistry();
    registry.configure({ id: "z1", kind: "zai", apiKey: TEST_API_KEY });
    const list = registry.list();
    expect(list).toEqual([{ id: "z1", kind: "zai", baseURL: undefined }]);
    expect(JSON.stringify(list)).not.toContain(TEST_API_KEY);
  });

  it("resolve() throws SERVER_ERROR for an unconfigured provider id", () => {
    const registry = new ProviderRegistry();
    let caught: unknown;
    try {
      registry.resolve("ghost", "some-model");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcMethodError);
    expect((caught as RpcMethodError).code).toBe(-32000);
    expect((caught as RpcMethodError).code).toBe(RpcErrorCodes.SERVER_ERROR);
  });

  it("setTestModel() bypasses the SDK factories and resolve() returns the injected model", () => {
    const registry = new ProviderRegistry();
    registry.configure({ id: "z1", kind: "zai", apiKey: TEST_API_KEY });
    const mock = new MockLanguageModelV4();
    registry.setTestModel("z1", mock);
    expect(registry.resolve("z1", "glm-5.2")).toBe(mock);
  });
});

describe("engine.models RPC", () => {
  async function call(engine: Engine, method: string, params: unknown): Promise<any> {
    return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
  }

  it("configure → list round-trip never leaks the apiKey", async () => {
    const engine = createEngine();
    try {
      const configure = await call(engine, "engine.models.configure", {
        id: "z1",
        kind: "zai",
        apiKey: TEST_API_KEY,
      });
      expect(configure.error).toBeUndefined();
      expect(configure.result).toEqual({ configured: true });

      const list = await call(engine, "engine.models.list", {});
      expect(list.error).toBeUndefined();
      expect(list.result).toEqual({ providers: [{ id: "z1", kind: "zai", baseURL: undefined }] });
      expect(JSON.stringify(list.result)).not.toContain(TEST_API_KEY);
    } finally {
      await engine.close();
    }
  });

  it("rejects openai-compatible configure without baseURL as INVALID_PARAMS", async () => {
    const engine = createEngine();
    try {
      const res = await call(engine, "engine.models.configure", {
        id: "custom",
        kind: "openai-compatible",
        apiKey: TEST_API_KEY,
      });
      expect(res.error?.code).toBe(RpcErrorCodes.INVALID_PARAMS);
    } finally {
      await engine.close();
    }
  });
});
