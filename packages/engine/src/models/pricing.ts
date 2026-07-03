// Sourced pricing table for the models layer. Entries are keyed
// "<providerKind>/<modelId>" and copied verbatim (values + confidence) from
// docs/research/2026-07-03-m2-api-verification.md — see that doc for the
// re-check list before this table is trusted for real billing.

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

const SOURCE = "docs/research/2026-07-03-m2-api-verification.md";
const VERIFIED_AT = "2026-07-03";

export const PRICING: Record<string, ModelPricing> = {
  // Official Moonshot price. Conflicting secondary source quotes 0.60/2.50
  // for the same model — re-verify against Moonshot's own price page before
  // this leaves "unverified" (see re-check list item 1 in the source doc).
  "moonshot/kimi-k2.6": {
    inputPerMtok: 0.95,
    outputPerMtok: 4.0,
    cacheReadPerMtok: 0.16,
    source: SOURCE,
    verifiedAt: VERIFIED_AT,
    confidence: "unverified",
  },
  "moonshot/kimi-k2.7-code": {
    inputPerMtok: 0.95,
    outputPerMtok: 4.0,
    cacheReadPerMtok: 0.19,
    source: SOURCE,
    verifiedAt: VERIFIED_AT,
    confidence: "secondary",
  },
  "zai/glm-5.2": {
    inputPerMtok: 1.4,
    outputPerMtok: 4.4,
    source: SOURCE,
    verifiedAt: VERIFIED_AT,
    confidence: "secondary",
  },
  // DeepSeek chat/reasoner aliases retire 2026-07-24 in favor of the v4
  // model ids — both are carried here so lookups keep working through the
  // migration window (re-check list item 4).
  "deepseek/deepseek-chat": {
    inputPerMtok: 0.14,
    outputPerMtok: 0.28,
    cacheReadPerMtok: 0.0028,
    source: SOURCE,
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
    source: SOURCE,
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
  "openai-compatible/qwen3-coder-next": {
    inputPerMtok: 0.11,
    outputPerMtok: 0.8,
    source: SOURCE,
    verifiedAt: VERIFIED_AT,
    confidence: "secondary",
  },
  // Reference rows for counterfactual cost comparisons — not callable
  // provider/model presets (no "reference" ProviderConfig kind exists).
  "reference/claude-sonnet-5": {
    inputPerMtok: 3.0,
    outputPerMtok: 15.0,
    cacheReadPerMtok: 0.3,
    source: SOURCE,
    verifiedAt: VERIFIED_AT,
    confidence: "secondary",
  },
  "reference/claude-opus-4-8": {
    inputPerMtok: 5.0,
    outputPerMtok: 25.0,
    cacheReadPerMtok: 0.5,
    source: SOURCE,
    verifiedAt: VERIFIED_AT,
    confidence: "secondary",
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
