import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { createEngine, type Engine } from "../src/engine.js";
import { estimateCostUsd, lookupPricing } from "../src/models/pricing.js";

// Fixture literal only — must never appear outside test files (see task
// self-review grep).
const TEST_API_KEY = "sk-test-fixture-never-real-1234567890";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixtureBody = readFileSync(
  path.join(fixtureDir, "openai-compatible-completion.json"),
  "utf8",
);

async function call(engine: Engine, method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

describe("engine.models.complete", () => {
  it("happy path: records usage + cost from a priced model", async () => {
    const engine = createEngine();
    try {
      engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
      engine.models.registry.setTestModel(
        "p1",
        new MockLanguageModelV4({
          doGenerate: async () => ({
            content: [{ type: "text", text: "hi" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 20, text: 20, reasoning: undefined },
            },
            warnings: [],
          }),
        }),
      );

      const res = await call(engine, "engine.models.complete", {
        providerId: "p1",
        model: "deepseek-v4-flash",
        prompt: "hello",
      });

      expect(res.error).toBeUndefined();
      expect(res.result.text).toBe("hi");
      expect(res.result.usage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 0 });
      expect(res.result.costUsd).toBeCloseTo((10 * 0.14 + 20 * 0.28) / 1e6, 10);
      expect(res.result.providerId).toBe("p1");
      expect(res.result.attempts).toEqual([{ providerId: "p1", model: "deepseek-v4-flash" }]);
    } finally {
      await engine.close();
    }
  });

  it("unpriced model: costUsd is null but usage totals still recorded", async () => {
    const engine = createEngine();
    try {
      engine.models.registry.configure({ id: "p1", kind: "zai", apiKey: TEST_API_KEY });
      engine.models.registry.setTestModel(
        "p1",
        new MockLanguageModelV4({
          doGenerate: async () => ({
            content: [{ type: "text", text: "hi" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            },
            warnings: [],
          }),
        }),
      );

      const res = await call(engine, "engine.models.complete", {
        providerId: "p1",
        model: "totally-unpriced-model",
        prompt: "hello",
      });

      expect(res.error).toBeUndefined();
      expect(res.result.costUsd).toBeNull();

      const usage = await call(engine, "engine.models.usage", {});
      expect(usage.error).toBeUndefined();
      expect(usage.result.unpricedCalls).toBe(1);
      expect(usage.result.calls).toBe(1);
      expect(usage.result.inputTokens).toBe(5);
      expect(usage.result.outputTokens).toBe(5);
    } finally {
      await engine.close();
    }
  });

  it("fallback: a retryable primary failure falls through to a successful fallback", async () => {
    const engine = createEngine();
    try {
      engine.models.registry.configure({ id: "p1", kind: "moonshot", apiKey: TEST_API_KEY });
      engine.models.registry.setTestModel(
        "p1",
        new MockLanguageModelV4({
          doGenerate: async () => {
            throw Object.assign(new Error("boom"), { isRetryable: true });
          },
        }),
      );

      engine.models.registry.configure({ id: "p2", kind: "moonshot", apiKey: TEST_API_KEY });
      engine.models.registry.setTestModel(
        "p2",
        new MockLanguageModelV4({
          doGenerate: async () => ({
            content: [{ type: "text", text: "fallback ok" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
            warnings: [],
          }),
        }),
      );

      const res = await call(engine, "engine.models.complete", {
        providerId: "p1",
        model: "kimi-k2.6",
        prompt: "hello",
        fallbacks: [{ providerId: "p2", model: "kimi-k2.6" }],
      });

      expect(res.error).toBeUndefined();
      expect(res.result.providerId).toBe("p2");
      expect(res.result.text).toBe("fallback ok");
      expect(res.result.attempts).toHaveLength(2);
      expect(res.result.attempts[0].providerId).toBe("p1");
      expect(res.result.attempts[0].error).toBeDefined();
      expect(res.result.attempts[1].providerId).toBe("p2");
      expect(res.result.attempts[1].error).toBeUndefined();
    } finally {
      await engine.close();
    }
  });

  it("non-retryable failure throws immediately with a single attempt recorded", async () => {
    const engine = createEngine();
    try {
      engine.models.registry.configure({ id: "p1", kind: "zai", apiKey: TEST_API_KEY });
      engine.models.registry.setTestModel(
        "p1",
        new MockLanguageModelV4({
          doGenerate: async () => {
            throw new Error("nope, not retryable");
          },
        }),
      );

      const res = await call(engine, "engine.models.complete", {
        providerId: "p1",
        model: "glm-5.2",
        prompt: "hello",
      });

      expect(res.result).toBeUndefined();
      expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
      const data = res.error?.data as { attempts: Array<{ providerId: string; error?: string }> };
      expect(data.attempts).toHaveLength(1);
      expect(data.attempts[0]?.providerId).toBe("p1");
      expect(data.attempts[0]?.error).toBeDefined();
    } finally {
      await engine.close();
    }
  });

  it("rejects params with both prompt and messages as INVALID_PARAMS", async () => {
    const engine = createEngine();
    try {
      const res = await call(engine, "engine.models.complete", {
        providerId: "p1",
        model: "some-model",
        prompt: "hello",
        messages: [{ role: "user", content: "hi" }],
      });

      expect(res.result).toBeUndefined();
      expect(res.error?.code).toBe(RpcErrorCodes.INVALID_PARAMS);
    } finally {
      await engine.close();
    }
  });

  it("fixture integration: real openai-compatible adapter path with injected fetch", async () => {
    const engine = createEngine();
    try {
      const fetchImpl = (async () =>
        new Response(fixtureBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;

      engine.models.registry.configure(
        {
          id: "fixture-provider",
          kind: "openai-compatible",
          apiKey: TEST_API_KEY,
          baseURL: "http://fixture.local/v1",
        },
        fetchImpl,
      );

      const res = await call(engine, "engine.models.complete", {
        providerId: "fixture-provider",
        model: "qwen3-coder-next",
        prompt: "hello",
      });

      expect(res.error).toBeUndefined();
      expect(res.result.text).toBe("fixture reply");
      expect(res.result.usage).toEqual({
        inputTokens: 12,
        outputTokens: 7,
        cacheReadTokens: 4,
      });

      const pricing = lookupPricing("openai-compatible", "qwen3-coder-next");
      expect(pricing).not.toBeNull();
      const expectedCost = estimateCostUsd(pricing!, res.result.usage);
      expect(res.result.costUsd).toBeCloseTo(expectedCost, 10);
    } finally {
      await engine.close();
    }
  });
});
