import { describe, expect, it } from "vitest";
import type { PerTaskResult } from "../src/evals/run.js";
import {
  computeEvalsVerdict,
  MIN_TASK_COUNT_FOR_SAVINGS_PASS,
  MIN_TASK_COUNT_FOR_VERDICT,
} from "../src/evals/verdict.js";

function row(
  id: string,
  opts: {
    baselinePassed: boolean;
    harnessPassed: boolean;
    baselineUsd?: number | null;
    harnessUsd?: number | null;
    baselineOutcome?: PerTaskResult["baselineOutcome"];
    harnessOutcome?: PerTaskResult["harnessOutcome"];
  },
): PerTaskResult {
  return {
    id,
    baselinePassed: opts.baselinePassed,
    harnessPassed: opts.harnessPassed,
    baselineUsd: opts.baselineUsd === undefined ? 1 : opts.baselineUsd,
    harnessUsd: opts.harnessUsd === undefined ? 0.2 : opts.harnessUsd,
    baselineOutcome: opts.baselineOutcome ?? "completed",
    harnessOutcome: opts.harnessOutcome ?? "worker-approved",
  };
}

function many(
  n: number,
  factory: (i: number) => PerTaskResult,
): PerTaskResult[] {
  return Array.from({ length: n }, (_, i) => factory(i));
}

describe("computeEvalsVerdict", () => {
  it("passes when quality held, savings positive, enough samples, priced", () => {
    const perTask = many(MIN_TASK_COUNT_FOR_SAVINGS_PASS, (i) =>
      row(`t${i}`, { baselinePassed: true, harnessPassed: true, baselineUsd: 1, harnessUsd: 0.4 }),
    );
    const r = computeEvalsVerdict({
      perTask,
      unpricedCalls: 0,
      pricingConfidence: "verified",
      escalations: 0,
    });
    expect(r.verdict).toBe("pass");
    expect(r.cleanSavingsPct).toBeGreaterThan(0);
  });

  it("blocks savings PASS when unpricedCalls > 0 (C1 false-pass gate)", () => {
    const perTask = many(MIN_TASK_COUNT_FOR_SAVINGS_PASS, (i) =>
      row(`t${i}`, { baselinePassed: true, harnessPassed: true, baselineUsd: 1, harnessUsd: 0.4 }),
    );
    const r = computeEvalsVerdict({
      perTask,
      unpricedCalls: 2,
      pricingConfidence: "verified",
      escalations: 0,
    });
    expect(r.verdict).toBe("inconclusive");
    expect(r.note).toMatch(/unpriced/);
  });

  it("fails on quality regression beyond noise band", () => {
    // 20 tasks: baseline all pass, harness all fail → 100% gap
    const perTask = many(MIN_TASK_COUNT_FOR_SAVINGS_PASS, (i) =>
      row(`t${i}`, { baselinePassed: true, harnessPassed: false, baselineUsd: 1, harnessUsd: 0.1 }),
    );
    const r = computeEvalsVerdict({
      perTask,
      unpricedCalls: 0,
      pricingConfidence: "verified",
      escalations: 0,
    });
    expect(r.verdict).toBe("fail");
  });

  it("fails on cost regression at hazard floor", () => {
    const perTask = many(MIN_TASK_COUNT_FOR_VERDICT, (i) =>
      row(`t${i}`, {
        baselinePassed: true,
        harnessPassed: true,
        baselineUsd: 1,
        harnessUsd: 1.2, // +20% cost
      }),
    );
    const r = computeEvalsVerdict({
      perTask,
      unpricedCalls: 0,
      pricingConfidence: "verified",
      escalations: 0,
    });
    expect(r.verdict).toBe("fail");
    expect(r.note).toMatch(/cost/i);
  });

  it("is inconclusive below savings-pass floor even with savings", () => {
    const perTask = many(5, (i) =>
      row(`t${i}`, { baselinePassed: true, harnessPassed: true, baselineUsd: 1, harnessUsd: 0.2 }),
    );
    const r = computeEvalsVerdict({
      perTask,
      unpricedCalls: 0,
      pricingConfidence: "verified",
      escalations: 0,
    });
    expect(r.verdict).toBe("inconclusive");
  });

  it("treats measurement failures as not quality evidence (material → inconclusive)", () => {
    // 5 tasks, 2 measurement failures (40% >= 20%)
    const perTask: PerTaskResult[] = [
      row("a", { baselinePassed: true, harnessPassed: false }),
      row("b", { baselinePassed: true, harnessPassed: false }),
      row("c", { baselinePassed: true, harnessPassed: true }),
      row("d", {
        baselinePassed: false,
        harnessPassed: false,
        harnessOutcome: "error",
        baselineUsd: null,
        harnessUsd: null,
      }),
      row("e", {
        baselinePassed: false,
        harnessPassed: false,
        baselineOutcome: "error",
        baselineUsd: null,
        harnessUsd: null,
      }),
    ];
    const r = computeEvalsVerdict({
      perTask,
      unpricedCalls: 0,
      pricingConfidence: "verified",
      escalations: 0,
    });
    expect(r.measurementFailureCount).toBe(2);
    expect(r.verdict).toBe("inconclusive");
  });
});
