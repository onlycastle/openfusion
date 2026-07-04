// Sourced pricing table for the models layer. Entries are keyed
// "<providerKind>/<modelId>" and copied verbatim (values + confidence) from
// docs/research/2026-07-04-m6-pricing-eval-verification.md — see that doc
// for the meter-shape notes and confidence flags behind each row.

export interface ModelPricing {
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok?: number;
  source: string;
  verifiedAt: string;
  confidence: "verified" | "secondary" | "unverified";
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

const SOURCE = "docs/research/2026-07-04-m6-pricing-eval-verification.md";
const VERIFIED_AT = "2026-07-04";

export const PRICING: Record<string, ModelPricing> = {
  // Moonshot's own cache-token field (`usage.cached_tokens`) is documented as
  // example-only in their API reference, not a load-bearing contract — kept
  // "secondary" until a live call confirms the field actually reports
  // cache-read tokens (see the doc's Flags section). If a live response
  // omits it, the cache-read price here is unusable and this entry must
  // drop to "unverified".
  "moonshot/kimi-k2.6": {
    inputPerMtok: 0.95,
    outputPerMtok: 4.0,
    cacheReadPerMtok: 0.16,
    source: `${SOURCE} — cache field (usage.cached_tokens) is example-only in Moonshot's API ref`,
    verifiedAt: VERIFIED_AT,
    confidence: "secondary",
  },
  "moonshot/kimi-k2.7-code": {
    inputPerMtok: 0.95,
    outputPerMtok: 4.0,
    cacheReadPerMtok: 0.19,
    source: `${SOURCE} — cache field (usage.cached_tokens) is example-only in Moonshot's API ref`,
    verifiedAt: VERIFIED_AT,
    confidence: "secondary",
  },
  "zai/glm-5.2": {
    inputPerMtok: 1.4,
    outputPerMtok: 4.4,
    cacheReadPerMtok: 0.26,
    source: SOURCE,
    verifiedAt: VERIFIED_AT,
    confidence: "verified",
  },
  // DeepSeek chat/reasoner aliases HARD-RETIRE 2026-07-24 in favor of the v4
  // model ids — both are carried here so lookups keep working through the
  // migration window, but every new caller should move to
  // deepseek-v4-flash/-v4-pro before then.
  "deepseek/deepseek-chat": {
    inputPerMtok: 0.14,
    outputPerMtok: 0.28,
    cacheReadPerMtok: 0.0028,
    source: `${SOURCE} — alias retires 2026-07-24; migrate to deepseek/deepseek-v4-flash`,
    verifiedAt: VERIFIED_AT,
    confidence: "verified",
  },
  "deepseek/deepseek-v4-flash": {
    inputPerMtok: 0.14,
    outputPerMtok: 0.28,
    cacheReadPerMtok: 0.0028,
    source: SOURCE,
    verifiedAt: VERIFIED_AT,
    confidence: "verified",
  },
  "deepseek/deepseek-reasoner": {
    inputPerMtok: 0.435,
    outputPerMtok: 0.87,
    cacheReadPerMtok: 0.003625,
    source: `${SOURCE} — alias retires 2026-07-24; migrate to deepseek/deepseek-v4-pro`,
    verifiedAt: VERIFIED_AT,
    confidence: "verified",
  },
  "deepseek/deepseek-v4-pro": {
    inputPerMtok: 0.435,
    outputPerMtok: 0.87,
    cacheReadPerMtok: 0.003625,
    source: SOURCE,
    verifiedAt: VERIFIED_AT,
    confidence: "verified",
  },
  // OpenRouter multi-endpoint spread (doc's meter-shape notes): qwen/minimax
  // route through 4-16 differently-priced endpoints, so "the OpenRouter
  // price" is not a single number — these three rows pin the specific
  // endpoint the doc verified rather than downgrading confidence; re-verify
  // per-endpoint before relying on this for high-precision billing.
  "openai-compatible/qwen3-coder-next": {
    inputPerMtok: 0.11,
    outputPerMtok: 0.8,
    cacheReadPerMtok: 0.07,
    source: `${SOURCE} — OpenRouter multi-endpoint spread; price pinned to the doc's verified endpoint`,
    verifiedAt: VERIFIED_AT,
    confidence: "verified",
  },
  "openai-compatible/qwen3-coder": {
    inputPerMtok: 0.22,
    outputPerMtok: 1.8,
    cacheReadPerMtok: 0.1,
    source: `${SOURCE} — OpenRouter multi-endpoint spread; price pinned to the doc's verified endpoint`,
    verifiedAt: VERIFIED_AT,
    confidence: "verified",
  },
  "openai-compatible/minimax-m2.5": {
    inputPerMtok: 0.15,
    outputPerMtok: 1.0,
    cacheReadPerMtok: 0.03,
    source: `${SOURCE} — OpenRouter multi-endpoint spread; price pinned to the doc's verified endpoint (promo 0.12/0.48 also observed)`,
    verifiedAt: VERIFIED_AT,
    confidence: "verified",
  },
  // Reference rows for counterfactual cost comparisons — not callable
  // provider/model presets (no "reference" ProviderConfig kind exists).
  "reference/claude-sonnet-5": {
    inputPerMtok: 2.0,
    outputPerMtok: 10.0,
    cacheReadPerMtok: 0.2,
    source: `${SOURCE} — intro rate; flips to 3.00/15.00 on 2026-09-01 (re-verify post-flip)`,
    verifiedAt: VERIFIED_AT,
    confidence: "verified",
  },
  "reference/claude-opus-4-8": {
    inputPerMtok: 5.0,
    outputPerMtok: 25.0,
    cacheReadPerMtok: 0.5,
    source: SOURCE,
    verifiedAt: VERIFIED_AT,
    confidence: "verified",
  },
  "reference/gpt-5.5": {
    inputPerMtok: 5.0,
    outputPerMtok: 30.0,
    cacheReadPerMtok: 0.5,
    source: SOURCE,
    verifiedAt: VERIFIED_AT,
    confidence: "verified",
  },
  "reference/gpt-5.4": {
    inputPerMtok: 2.5,
    outputPerMtok: 15.0,
    cacheReadPerMtok: 0.25,
    source: SOURCE,
    verifiedAt: VERIFIED_AT,
    confidence: "verified",
  },
};

export function lookupPricing(kind: string, modelId: string): ModelPricing | null {
  return PRICING[`${kind}/${modelId}`] ?? null;
}

export function estimateCostUsd(pricing: ModelPricing, usage: NormalizedUsage): number {
  const cacheRead = Math.min(Math.max(usage.cacheReadTokens, 0), usage.inputTokens);
  const cacheRate = pricing.cacheReadPerMtok ?? pricing.inputPerMtok;
  return (
    ((usage.inputTokens - cacheRead) * pricing.inputPerMtok +
      cacheRead * cacheRate +
      usage.outputTokens * pricing.outputPerMtok) /
    1e6
  );
}

// Non-finite (NaN, +/-Infinity) collapses to 0 alongside the existing
// missing-field default — a provider adapter that hands back a malformed
// usage number must not poison cost estimation (NaN propagates through
// arithmetic silently) or the cost meter's running totals.
function finiteOr0(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

// Reads the Vercel AI SDK v7 result.usage shape:
// { inputTokens?, outputTokens?, inputTokenDetails?: { cacheReadTokens? } }.
// Any missing field (including a wholly missing/undefined usage object)
// normalizes to 0.
export function normalizeUsage(raw: unknown): NormalizedUsage {
  const usage = (raw ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
  };
  return {
    inputTokens: finiteOr0(usage.inputTokens),
    outputTokens: finiteOr0(usage.outputTokens),
    cacheReadTokens: finiteOr0(usage.inputTokenDetails?.cacheReadTokens),
  };
}
