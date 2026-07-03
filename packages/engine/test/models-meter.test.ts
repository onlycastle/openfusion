import { describe, expect, it } from "vitest";
import { CostMeter, type UsageRecord } from "../src/models/meter.js";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    providerId: "p1",
    kind: "deepseek",
    model: "deepseek-v4-flash",
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0 },
    costUsd: 0.01,
    at: Date.now(),
    source: "complete",
    ...overrides,
  };
}

describe("CostMeter — per-surface source tagging", () => {
  it("totals().bySource splits calls tagged with different sources into separate buckets", () => {
    const meter = new CostMeter();
    meter.record(record({ source: "complete", costUsd: 0.01, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0 } }));
    meter.record(record({ source: "worker", costUsd: 0.02, usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 } }));
    meter.record(record({ source: "worker", costUsd: 0.03, usage: { inputTokens: 200, outputTokens: 60, cacheReadTokens: 0 } }));
    meter.record(record({ source: "frontier-review", costUsd: 0.04, usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300 } }));

    const totals = meter.totals();

    expect(totals.calls).toBe(4);
    expect(Object.keys(totals.bySource).sort()).toEqual(["complete", "frontier-review", "worker"]);

    expect(totals.bySource["complete"]).toEqual({
      calls: 1,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0.01,
    });
    expect(totals.bySource["worker"]).toEqual({
      calls: 2,
      inputTokens: 300,
      outputTokens: 110,
      costUsd: 0.05,
    });
    expect(totals.bySource["frontier-review"]).toEqual({
      calls: 1,
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.04,
    });
  });

  it("bySource omits null costUsd from the source bucket's costUsd total (unpriced call)", () => {
    const meter = new CostMeter();
    meter.record(record({ source: "worker", costUsd: null }));

    const totals = meter.totals();
    expect(totals.bySource["worker"]).toEqual({
      calls: 1,
      inputTokens: 10,
      outputTokens: 20,
      costUsd: 0,
    });
    expect(totals.unpricedCalls).toBe(1);
  });

  // Final review Fix 2: two new sources were added — "frontier-generate"
  // (harness generation, an hour-long one-time run) and
  // "frontier-interactive" (engine.frontier.start's interactive sessions) —
  // so this ledger can distinguish them from per-task "frontier-review" cost
  // for M6's amortization math. Before the fix, UsageSource only had four
  // members and this test (with the two new ones added) fails TYPECHECKING
  // (`source` not assignable to `UsageSource`), which is this test's RED
  // signal — CostMeter itself is otherwise source-agnostic (just a keyed
  // bucket), so there is no runtime behavior to separately assert.
  it("supports all six documented sources: complete, worker, frontier-review, frontier-escalate, frontier-generate, frontier-interactive", () => {
    const meter = new CostMeter();
    const sources = [
      "complete",
      "worker",
      "frontier-review",
      "frontier-escalate",
      "frontier-generate",
      "frontier-interactive",
    ] as const;
    for (const source of sources) {
      meter.record(record({ source }));
    }
    const totals = meter.totals();
    expect(Object.keys(totals.bySource).sort()).toEqual([...sources].sort());
    for (const source of sources) {
      expect(totals.bySource[source]?.calls).toBe(1);
    }
  });

  it("an empty meter has an empty bySource map", () => {
    const meter = new CostMeter();
    expect(meter.totals().bySource).toEqual({});
  });
});
