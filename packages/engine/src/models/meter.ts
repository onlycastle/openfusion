import type { NormalizedUsage } from "./pricing.js";

// Which engine.* surface produced this record. Lets engine.models.usage
// break totals down by call site (Task 4's orchestrator wants to see
// frontier-review vs frontier-escalate cost separately from plain worker
// runs) without having to re-derive it from `kind`/`model` after the fact.
// "frontier-review"/"frontier-escalate" are both produced by the same
// frontier-claude adapter path (engines/methods.ts's onResult hook) — which
// one a given call used is a Task 4 concern (the orchestrator decides review
// vs escalate); today every frontier record is tagged "frontier-review" as
// the default until that distinction is wired through.
export type UsageSource = "complete" | "worker" | "frontier-review" | "frontier-escalate";

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
}

// In-memory cost/usage ledger for the engine process's lifetime. Never
// persisted — a fresh engine starts at zero.
export class CostMeter {
  #records: UsageRecord[] = [];

  record(r: UsageRecord): void {
    this.#records.push(r);
  }

  totals(): MeterTotals {
    const totals: MeterTotals = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      unpricedCalls: 0,
      byModel: {},
      bySource: {},
    };

    for (const r of this.#records) {
      totals.calls += 1;
      totals.inputTokens += r.usage.inputTokens;
      totals.outputTokens += r.usage.outputTokens;
      totals.cacheReadTokens += r.usage.cacheReadTokens;

      if (r.costUsd === null) {
        totals.unpricedCalls += 1;
      } else {
        totals.costUsd += r.costUsd;
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

    return totals;
  }
}
