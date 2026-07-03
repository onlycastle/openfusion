import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  lookupPricing,
  normalizeUsage,
  type ModelPricing,
} from "../src/models/pricing.js";

describe("PRICING / lookupPricing", () => {
  it("returns a verified entry for deepseek/deepseek-v4-flash", () => {
    const entry = lookupPricing("deepseek", "deepseek-v4-flash");
    expect(entry).not.toBeNull();
    expect(entry?.confidence).toBe("verified");
  });

  it("returns null for an unknown provider kind / model id", () => {
    expect(lookupPricing("nope", "x")).toBeNull();
  });
});

describe("normalizeUsage", () => {
  it("reads the v7 result.usage shape", () => {
    expect(
      normalizeUsage({
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: { cacheReadTokens: 40 },
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 40 });
  });

  it("defaults missing fields to zero", () => {
    expect(normalizeUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    });
  });
});

describe("estimateCostUsd", () => {
  it("bills cache-read tokens at the cache rate when one is configured", () => {
    const pricing: ModelPricing = {
      inputPerMtok: 1.0,
      outputPerMtok: 2.0,
      cacheReadPerMtok: 0.1,
      source: "test",
      verifiedAt: "2026-07-03",
      confidence: "verified",
    };
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 400_000 };
    expect(estimateCostUsd(pricing, usage)).toBeCloseTo(1.64, 10);
  });

  it("falls back to the input rate when cacheReadPerMtok is absent", () => {
    const pricing: ModelPricing = {
      inputPerMtok: 1.0,
      outputPerMtok: 2.0,
      source: "test",
      verifiedAt: "2026-07-03",
      confidence: "verified",
    };
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 400_000 };
    expect(estimateCostUsd(pricing, usage)).toBeCloseTo(2.0, 10);
  });
});
