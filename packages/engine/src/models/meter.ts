import type { NormalizedUsage } from "./pricing.js";

// Which engine.* surface produced this record. Lets engine.models.usage
// break totals down by call site (Task 4's orchestrator wants to see
// frontier-review vs frontier-escalate cost separately from plain worker
// runs) without having to re-derive it from `kind`/`model` after the fact.
// All four "frontier-*" sources are produced by the same frontier-claude
// adapter path (engines/methods.ts's onResult hook) — which one a given call
// used is decided by the RESULT LABEL its createSession call passed
// (engines/types.ts's `resultLabel`):
//   - "frontier-review": engine.orchestrate's read-only review-the-diff
//     session (per-task quality-gate overhead).
//   - "frontier-escalate": engine.orchestrate's write-scoped
//     do-the-task-directly session (a worker-attempt substitute, not review
//     overhead).
//   - "frontier-generate": engine.harness.generate's session — an hour-long,
//     ONE-TIME run, never per-task review overhead. Final review Fix 2:
//     before this label existed, generation cost was folded into
//     "frontier-review" and broke M6's per-task amortization math.
//   - "frontier-interactive": engine.frontier.start's own interactive
//     sessions (the raw RPC surface, no orchestrator/generator involved) —
//     likewise never per-task review overhead.
// "frontier-review" remains the fallback for a createSession call that omits
// resultLabel entirely, but every real call site now sets one of the four
// explicitly (see harness/generate.ts, engines/methods.ts's frontier.start
// handler, and orchestrate.ts's review/escalate sessions).
export type UsageSource =
  | "complete"
  | "worker"
  | "frontier-review"
  | "frontier-escalate"
  | "frontier-generate"
  | "frontier-interactive";

// How much to trust `costUsd` for this record. Set at record() call time
// from the looked-up ModelPricing's own `confidence` field, or "unpriced"
// when no pricing entry was found at all (costUsd is null in that case).
// "provider-reported" is used when the cost comes directly from the provider's
// own reported figure (e.g., frontier CLI's total_cost_usd), not derived from
// our verified PRICING table — ranks equal to "verified" as trustworthy since
// it's the literal amount billed, but the label is distinct for provenance.
// Surfaced so a consumer (the M6 savings report card) can flag a cost
// figure that rests on a secondary/unverified/absent price rather than
// trusting every costUsd number equally.
export type PricingConfidence = "verified" | "provider-reported" | "secondary" | "unverified" | "unpriced";

// One successful `engine.models.complete` attempt. Failed attempts are never
// recorded here — only what actually consumed tokens (see methods.ts).
export interface UsageRecord {
  providerId: string;
  kind: string;
  model: string;
  usage: NormalizedUsage;
  costUsd: number | null;
  at: number;
  source: UsageSource;
  pricingConfidence: PricingConfidence;
}

export interface ModelTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface MeterTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  unpricedCalls: number;
  byModel: Record<string, ModelTotals>;
  // Same per-bucket shape as byModel, keyed by UsageRecord.source instead of
  // "<kind>/<model>" — a per-surface cost breakdown alongside the existing
  // per-model one.
  bySource: Record<string, ModelTotals>;
  // The WORST (least-trustworthy) pricingConfidence across every record seen
  // — see CONFIDENCE_RANK below for the ordering. An empty meter reports
  // "verified" (the vacuous best case: nothing has been observed to distrust
  // yet). engine.models.usage exposes this verbatim so the M6 report card
  // can flag a savings figure that rests on any less-than-verified cost.
  pricingConfidence: PricingConfidence;
}

// Worst-to-best. Higher rank = more trustworthy. "unpriced" (no pricing
// entry found at all, costUsd null) is worse than "unverified" (a priced
// entry we simply haven't confirmed against an official source yet) is
// worse than "secondary" (soft-documented / endpoint-pinned) is worse than
// "verified" and "provider-reported" (equal rank 3).
// "provider-reported" (e.g., frontier CLI's own reported cost) ranks equal
// to "verified" since both are authoritative — it's the literal amount billed
// or our sourced verified table. The label is distinct for provenance display.
const CONFIDENCE_RANK: Record<PricingConfidence, number> = {
  unpriced: 0,
  unverified: 1,
  secondary: 2,
  verified: 3,
  "provider-reported": 3,
};

// In-memory cost/usage ledger for the engine process's lifetime. Never
// persisted — a fresh engine starts at zero.
export class CostMeter {
  #records: UsageRecord[] = [];

  record(r: UsageRecord): void {
    this.#records.push(r);
  }

  // Number of records in the ledger right now. Lets a caller snapshot a
  // starting index BEFORE some window of work (e.g. engine.evals.run's own
  // task loop — see evals/run.ts) and later call `totals(sinceIndex)` to
  // scope every aggregate (including `unpricedCalls` and
  // `pricingConfidence`) to just the records produced during that window,
  // rather than the engine's whole lifetime ledger. Exists specifically for
  // M6 final review I2 (run-scoped pricingConfidence) and C1 (the
  // unpriced-calls gate) — under M7's long-lived engine, unrelated prior
  // records must not taint a single run's own report card.
  recordCount(): number {
    return this.#records.length;
  }

  // `sinceIndex` (default 0 — the whole ledger, this class's original
  // behavior) scopes every aggregate to records at that index or later, per
  // `recordCount()`'s own doc comment above.
  totals(sinceIndex = 0): MeterTotals {
    const totals: MeterTotals = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      unpricedCalls: 0,
      byModel: {},
      bySource: {},
      // Vacuous best case for an empty ledger (or an empty since-index
      // slice) — see CONFIDENCE_RANK's doc comment. Downgraded below as
      // records are folded in.
      pricingConfidence: "verified",
    };
    let worstRank = CONFIDENCE_RANK.verified;
    let hasVerified = false;
    let hasProviderReported = false;

    const records = sinceIndex > 0 ? this.#records.slice(sinceIndex) : this.#records;
    for (const r of records) {
      totals.calls += 1;
      totals.inputTokens += r.usage.inputTokens;
      totals.outputTokens += r.usage.outputTokens;
      totals.cacheReadTokens += r.usage.cacheReadTokens;

      if (r.costUsd === null) {
        totals.unpricedCalls += 1;
      } else {
        totals.costUsd += r.costUsd;
      }

      if (r.pricingConfidence === "verified") {
        hasVerified = true;
      }
      if (r.pricingConfidence === "provider-reported") {
        hasProviderReported = true;
      }

      const rank = CONFIDENCE_RANK[r.pricingConfidence];
      if (rank < worstRank) {
        worstRank = rank;
        totals.pricingConfidence = r.pricingConfidence;
      } else if (rank === worstRank && rank === CONFIDENCE_RANK.verified && totals.pricingConfidence === "verified" && r.pricingConfidence === "provider-reported") {
        // First provider-reported record at rank 3: update the label, but
        // prefer "verified" at the end if any verified record exists
        totals.pricingConfidence = "provider-reported";
      }

      const key = `${r.kind}/${r.model}`;
      const entry = totals.byModel[key] ?? {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      entry.calls += 1;
      entry.inputTokens += r.usage.inputTokens;
      entry.outputTokens += r.usage.outputTokens;
      if (r.costUsd !== null) entry.costUsd += r.costUsd;
      totals.byModel[key] = entry;

      const sourceEntry = totals.bySource[r.source] ?? {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      sourceEntry.calls += 1;
      sourceEntry.inputTokens += r.usage.inputTokens;
      sourceEntry.outputTokens += r.usage.outputTokens;
      if (r.costUsd !== null) sourceEntry.costUsd += r.costUsd;
      totals.bySource[r.source] = sourceEntry;
    }

    // When worst rank is 3 (both "verified" and "provider-reported" share this rank),
    // prefer the "verified" label if any verified record exists, for determinism.
    // This ensures a meter mixing frontier provider-reported + table-verified costs
    // reports "verified" (same highest rank, preferred label). A meter with ONLY
    // provider-reported reports "provider-reported" (its own distinct label).
    if (worstRank === CONFIDENCE_RANK.verified && hasVerified && hasProviderReported && totals.pricingConfidence === "provider-reported") {
      totals.pricingConfidence = "verified";
    }

    return totals;
  }
}
