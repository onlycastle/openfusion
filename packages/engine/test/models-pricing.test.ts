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

// 2026-07-04 refresh (docs/research/2026-07-04-m6-pricing-eval-verification.md)
// — every entry moves to this verifiedAt, with confidence assigned per the
// doc: deepseek/glm/qwen/minimax/gpt/claude "verified"; kimi "secondary"
// (Moonshot's cache-token field is example-only, not load-bearing).
describe("PRICING — 2026-07-04 refresh", () => {
  const REFRESH_DATE = "2026-07-04";

  it("deepseek-v4-flash: verified rates + cache-hit rate, 2026-07-04", () => {
    const entry = lookupPricing("deepseek", "deepseek-v4-flash");
    expect(entry).toMatchObject({
      inputPerMtok: 0.14,
      outputPerMtok: 0.28,
      cacheReadPerMtok: 0.0028,
      confidence: "verified",
      verifiedAt: REFRESH_DATE,
    });
  });

  it("deepseek-v4-pro: verified rates + cache-hit rate, 2026-07-04", () => {
    const entry = lookupPricing("deepseek", "deepseek-v4-pro");
    expect(entry).toMatchObject({
      inputPerMtok: 0.435,
      outputPerMtok: 0.87,
      cacheReadPerMtok: 0.003625,
      confidence: "verified",
      verifiedAt: REFRESH_DATE,
    });
  });

  it("legacy deepseek-chat/deepseek-reasoner aliases keep the v4 rates and note the 2026-07-24 retirement in source", () => {
    const chat = lookupPricing("deepseek", "deepseek-chat");
    const flash = lookupPricing("deepseek", "deepseek-v4-flash");
    expect(chat).toMatchObject({
      inputPerMtok: flash!.inputPerMtok,
      outputPerMtok: flash!.outputPerMtok,
      cacheReadPerMtok: flash!.cacheReadPerMtok,
      confidence: "verified",
      verifiedAt: REFRESH_DATE,
    });
    expect(chat?.source).toContain("alias retires 2026-07-24");

    const reasoner = lookupPricing("deepseek", "deepseek-reasoner");
    const pro = lookupPricing("deepseek", "deepseek-v4-pro");
    expect(reasoner).toMatchObject({
      inputPerMtok: pro!.inputPerMtok,
      outputPerMtok: pro!.outputPerMtok,
      cacheReadPerMtok: pro!.cacheReadPerMtok,
      confidence: "verified",
      verifiedAt: REFRESH_DATE,
    });
    expect(reasoner?.source).toContain("alias retires 2026-07-24");
  });

  it("kimi entries are secondary confidence (Moonshot cache field is example-only)", () => {
    expect(lookupPricing("moonshot", "kimi-k2.6")).toMatchObject({
      inputPerMtok: 0.95,
      outputPerMtok: 4.0,
      cacheReadPerMtok: 0.16,
      confidence: "secondary",
      verifiedAt: REFRESH_DATE,
    });
    expect(lookupPricing("moonshot", "kimi-k2.7-code")).toMatchObject({
      inputPerMtok: 0.95,
      outputPerMtok: 4.0,
      cacheReadPerMtok: 0.19,
      confidence: "secondary",
      verifiedAt: REFRESH_DATE,
    });
  });

  it("glm-5.2 gains a verified cache-read rate (0.26)", () => {
    expect(lookupPricing("zai", "glm-5.2")).toMatchObject({
      inputPerMtok: 1.4,
      outputPerMtok: 4.4,
      cacheReadPerMtok: 0.26,
      confidence: "verified",
      verifiedAt: REFRESH_DATE,
    });
  });

  // Finding 2: OpenRouter qwen/minimax have multi-endpoint price spread, so
  // confidence is downgraded to "secondary" — we can't know which endpoint
  // served a call, so the price is genuinely uncertain (same caveat as kimi).
  it("qwen3-coder-next: secondary confidence due to multi-endpoint spread", () => {
    expect(lookupPricing("openai-compatible", "qwen3-coder-next")).toMatchObject({
      inputPerMtok: 0.11,
      outputPerMtok: 0.8,
      cacheReadPerMtok: 0.07,
      confidence: "secondary",
      verifiedAt: REFRESH_DATE,
    });
  });

  it("qwen3-coder: secondary confidence due to multi-endpoint spread", () => {
    expect(lookupPricing("openai-compatible", "qwen3-coder")).toMatchObject({
      inputPerMtok: 0.22,
      outputPerMtok: 1.8,
      cacheReadPerMtok: 0.1,
      confidence: "secondary",
      verifiedAt: REFRESH_DATE,
    });
  });

  it("minimax-m2.5: secondary confidence due to multi-endpoint spread", () => {
    expect(lookupPricing("openai-compatible", "minimax-m2.5")).toMatchObject({
      inputPerMtok: 0.15,
      outputPerMtok: 1.0,
      cacheReadPerMtok: 0.03,
      confidence: "secondary",
      verifiedAt: REFRESH_DATE,
    });
  });

  it("reference/claude-sonnet-5 prices the current intro rate and notes the 2026-09-01 flip", () => {
    const entry = lookupPricing("reference", "claude-sonnet-5");
    expect(entry).toMatchObject({
      inputPerMtok: 2.0,
      outputPerMtok: 10.0,
      cacheReadPerMtok: 0.2,
      confidence: "verified",
      verifiedAt: REFRESH_DATE,
    });
    expect(entry?.source).toContain("2026-09-01");
  });

  it("reference rows: claude-opus-4-8, gpt-5.5, gpt-5.4", () => {
    expect(lookupPricing("reference", "claude-opus-4-8")).toMatchObject({
      inputPerMtok: 5.0,
      outputPerMtok: 25.0,
      cacheReadPerMtok: 0.5,
      confidence: "verified",
      verifiedAt: REFRESH_DATE,
    });
    expect(lookupPricing("reference", "gpt-5.5")).toMatchObject({
      inputPerMtok: 5.0,
      outputPerMtok: 30.0,
      cacheReadPerMtok: 0.5,
      confidence: "verified",
      verifiedAt: REFRESH_DATE,
    });
    expect(lookupPricing("reference", "gpt-5.4")).toMatchObject({
      inputPerMtok: 2.5,
      outputPerMtok: 15.0,
      cacheReadPerMtok: 0.25,
      confidence: "verified",
      verifiedAt: REFRESH_DATE,
    });
  });
});

describe("estimateCostUsd — DeepSeek cache-hit meter shape", () => {
  // DeepSeek's inputPerMtok IS the cache-MISS rate (not a base rate with a
  // discount folded in) and cacheReadPerMtok is the cache-HIT rate, so the
  // existing formula — (input - cacheRead)*inputPerMtok +
  // cacheRead*cacheReadPerMtok + output*outputPerMtok — prices a mixed
  // hit/miss call correctly with no meter changes: miss tokens = input -
  // cacheRead, priced at the miss rate.
  it("prices a deepseek-v4-flash cache-hit call correctly (900k hit + 100k miss of 1M input)", () => {
    const pricing = lookupPricing("deepseek", "deepseek-v4-flash")!;
    const usage = { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 900_000 };

    // miss = 1,000,000 - 900,000 = 100,000 tokens @ 0.14/Mtok (miss rate)
    // hit  =                       900,000 tokens @ 0.0028/Mtok (hit rate)
    // out  =                       200,000 tokens @ 0.28/Mtok
    const expected = (100_000 * 0.14 + 900_000 * 0.0028 + 200_000 * 0.28) / 1e6;
    expect(expected).toBeCloseTo(0.07252, 10);
    expect(estimateCostUsd(pricing, usage)).toBeCloseTo(expected, 10);
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

  it("guards non-finite numbers (NaN) to zero without dropping finite siblings", () => {
    expect(normalizeUsage({ inputTokens: NaN, outputTokens: 5 })).toEqual({
      inputTokens: 0,
      outputTokens: 5,
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
