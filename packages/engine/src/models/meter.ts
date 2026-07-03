import type { NormalizedUsage } from "./pricing.js";

// One successful `engine.models.complete` attempt. Failed attempts are never
// recorded here — only what actually consumed tokens (see methods.ts).
export interface UsageRecord {
  providerId: string;
  kind: string;
  model: string;
  usage: NormalizedUsage;
  costUsd: number | null;
  at: number;
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
    }

    return totals;
  }
}
