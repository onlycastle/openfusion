import { describe, expect, it } from "vitest";
import {
  DIALECT_PACK_CATALOG_VERSION,
  DIALECT_PACKS,
  FAMILY_CATALOG_VERSION,
  MODEL_FAMILIES,
  getDialectPack,
  resolveDialectPackId,
  resolveFamily,
} from "../src/models/catalog.js";

describe("model family catalog", () => {
  it("ships a non-empty versioned family + pack catalog", () => {
    expect(FAMILY_CATALOG_VERSION).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
    expect(DIALECT_PACK_CATALOG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(MODEL_FAMILIES.length).toBeGreaterThan(0);
    expect(DIALECT_PACKS.length).toBeGreaterThan(0);
  });

  it("resolves moonshot/kimi models to the kimi family", () => {
    const f = resolveFamily("moonshot", "kimi-k2.7-code");
    expect(f.id).toBe("kimi");
    expect(f.defaultDialectPack).toBe("string-edit-default");
  });

  it("resolves zai/glm models to glm", () => {
    expect(resolveFamily("zai", "glm-5.2").id).toBe("glm");
  });

  it("resolves deepseek models to deepseek", () => {
    expect(resolveFamily("deepseek", "deepseek-v4-flash").id).toBe("deepseek");
  });

  it("prefers qwen matchers over generic openai-compatible *", () => {
    expect(resolveFamily("openai-compatible", "qwen3-coder-next").id).toBe("qwen");
    expect(resolveFamily("openai-compatible", "minimax-m2.5").id).toBe("minimax");
    expect(resolveFamily("openai-compatible", "some-other-model").id).toBe("generic-openai");
  });

  it("falls back to generic-openai for unknown provider kinds", () => {
    expect(resolveFamily("totally-unknown", "x").id).toBe("generic-openai");
  });

  it("resolveDialectPackId prefers explicit pack", () => {
    expect(
      resolveDialectPackId({
        explicit: "whole-file-prefer",
        providerKind: "moonshot",
        modelId: "kimi-k2.7-code",
      }),
    ).toBe("whole-file-prefer");
  });

  it("every family defaultDialectPack exists", () => {
    for (const family of MODEL_FAMILIES) {
      expect(getDialectPack(family.defaultDialectPack)).toBeDefined();
    }
  });
});
