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
    pricingConfidence: "verified",
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

describe("CostMeter — totals().pricingConfidence (worst across all records)", () => {
  it("an empty meter reports the vacuous best case: verified", () => {
    const meter = new CostMeter();
    expect(meter.totals().pricingConfidence).toBe("verified");
  });

  it("a single verified record reports verified", () => {
    const meter = new CostMeter();
    meter.record(record({ pricingConfidence: "verified" }));
    expect(meter.totals().pricingConfidence).toBe("verified");
  });

  it("a verified record plus a secondary record reports secondary (worst wins)", () => {
    const meter = new CostMeter();
    meter.record(record({ pricingConfidence: "verified" }));
    meter.record(record({ pricingConfidence: "secondary" }));
    expect(meter.totals().pricingConfidence).toBe("secondary");
  });

  it("adding an unpriced record on top of verified + secondary drags totals to unpriced (worst wins)", () => {
    const meter = new CostMeter();
    meter.record(record({ pricingConfidence: "verified" }));
    meter.record(record({ pricingConfidence: "secondary" }));
    meter.record(record({ pricingConfidence: "unpriced", costUsd: null }));
    expect(meter.totals().pricingConfidence).toBe("unpriced");
  });

  it("unverified ranks worse than secondary/verified but better than unpriced", () => {
    const verifiedPlusUnverified = new CostMeter();
    verifiedPlusUnverified.record(record({ pricingConfidence: "verified" }));
    verifiedPlusUnverified.record(record({ pricingConfidence: "unverified" }));
    expect(verifiedPlusUnverified.totals().pricingConfidence).toBe("unverified");

    const unverifiedPlusUnpriced = new CostMeter();
    unverifiedPlusUnpriced.record(record({ pricingConfidence: "unverified" }));
    unverifiedPlusUnpriced.record(record({ pricingConfidence: "unpriced", costUsd: null }));
    expect(unverifiedPlusUnpriced.totals().pricingConfidence).toBe("unpriced");
  });

  it("record order does not matter — worst-of is order-independent", () => {
    const meter = new CostMeter();
    meter.record(record({ pricingConfidence: "unpriced", costUsd: null }));
    meter.record(record({ pricingConfidence: "verified" }));
    meter.record(record({ pricingConfidence: "secondary" }));
    expect(meter.totals().pricingConfidence).toBe("unpriced");
  });

  // Finding 1: provider-reported confidence (from frontier CLI cost) ranks
  // EQUAL to verified (both rank 3) so a meter mixing frontier provider-reported
  // + verified-table costs stays at the top confidence. Label is still distinct
  // for the report card to display provenance. When worst rank is shared,
  // prefer "verified" if any verified record exists.
  it("provider-reported ranks equal to verified (both rank 3)", () => {
    const meter = new CostMeter();
    meter.record(record({ pricingConfidence: "provider-reported" }));
    meter.record(record({ pricingConfidence: "secondary" }));
    expect(meter.totals().pricingConfidence).toBe("secondary");
  });

  it("a single provider-reported record reports provider-reported", () => {
    const meter = new CostMeter();
    meter.record(record({ pricingConfidence: "provider-reported" }));
    expect(meter.totals().pricingConfidence).toBe("provider-reported");
  });

  it("verified + provider-reported (rank tie): prefers verified label", () => {
    const meter = new CostMeter();
    meter.record(record({ pricingConfidence: "verified" }));
    meter.record(record({ pricingConfidence: "provider-reported" }));
    expect(meter.totals().pricingConfidence).toBe("verified");
  });

  it("provider-reported alone (no verified): reports provider-reported label", () => {
    const meter = new CostMeter();
    meter.record(record({ pricingConfidence: "provider-reported" }));
    meter.record(record({ pricingConfidence: "provider-reported" }));
    expect(meter.totals().pricingConfidence).toBe("provider-reported");
  });

  it("provider-reported + unpriced: unpriced wins (rank 0 < 3)", () => {
    const meter = new CostMeter();
    meter.record(record({ pricingConfidence: "provider-reported" }));
    meter.record(record({ pricingConfidence: "unpriced", costUsd: null }));
    expect(meter.totals().pricingConfidence).toBe("unpriced");
  });
});

// M6 final review (C1 / I2): recordCount() + totals(sinceIndex) let a caller
// (engine.evals.run) scope every aggregate to a window of records added
// during ITS OWN run, not the engine's whole-lifetime ledger — see run.ts's
// own runMeterStartIndex.
describe("CostMeter — recordCount() + totals(sinceIndex) run-scoping", () => {
  it("recordCount() reflects the number of records seen so far", () => {
    const meter = new CostMeter();
    expect(meter.recordCount()).toBe(0);
    meter.record(record());
    expect(meter.recordCount()).toBe(1);
    meter.record(record());
    expect(meter.recordCount()).toBe(2);
  });

  it("totals(sinceIndex) excludes records recorded before sinceIndex from every aggregate", () => {
    const meter = new CostMeter();
    // Prior "unrelated" records — verified, priced — as if left over from an
    // earlier run against the same long-lived engine.
    meter.record(record({ pricingConfidence: "verified", costUsd: 1 }));
    meter.record(record({ pricingConfidence: "verified", costUsd: 1 }));
    const sinceIndex = meter.recordCount();

    // "This run"'s own records: one unpriced call alongside a priced one.
    meter.record(record({ pricingConfidence: "unpriced", costUsd: null }));
    meter.record(record({ pricingConfidence: "verified", costUsd: 2 }));

    const wholeLedger = meter.totals();
    expect(wholeLedger.calls).toBe(4);
    expect(wholeLedger.unpricedCalls).toBe(1);

    const thisRunOnly = meter.totals(sinceIndex);
    expect(thisRunOnly.calls).toBe(2);
    expect(thisRunOnly.unpricedCalls).toBe(1);
    expect(thisRunOnly.pricingConfidence).toBe("unpriced");
    expect(thisRunOnly.costUsd).toBe(2);
  });

  it("totals(sinceIndex) at the CURRENT recordCount() (nothing added yet) reports the vacuous empty case", () => {
    const meter = new CostMeter();
    meter.record(record({ pricingConfidence: "unpriced", costUsd: null }));
    const sinceIndex = meter.recordCount();

    const emptySlice = meter.totals(sinceIndex);
    expect(emptySlice.calls).toBe(0);
    expect(emptySlice.unpricedCalls).toBe(0);
    expect(emptySlice.pricingConfidence).toBe("verified");
  });

  it("totals() with no argument is unchanged: the whole ledger, default sinceIndex 0", () => {
    const meter = new CostMeter();
    meter.record(record({ pricingConfidence: "secondary" }));
    expect(meter.totals()).toEqual(meter.totals(0));
  });
});
