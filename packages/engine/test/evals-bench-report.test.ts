import { describe, expect, it } from "vitest";
import { buildBenchReport } from "../src/evals/bench/report.js";
import type { BenchInstanceRow } from "../src/evals/bench/runner.js";
import type { ScoreResult } from "../src/evals/bench/score.js";

function score(
  arm: "baseline" | "harness",
  resolved: Record<string, boolean>,
): ScoreResult {
  const ids = Object.keys(resolved);
  return {
    arm,
    resolved: ids.map((instance_id) => ({
      instance_id,
      resolved: resolved[instance_id]!,
    })),
    resolvedCount: ids.filter((id) => resolved[id]).length,
    instanceCount: ids.length,
    resolvedRate: ids.filter((id) => resolved[id]).length / ids.length,
    reportPath: "/tmp/x",
    method: "fixture",
  };
}

describe("buildBenchReport", () => {
  it("wires official resolved flags into verdict with unpricedCalls", () => {
    const rows: BenchInstanceRow[] = Array.from({ length: 20 }, (_, i) => ({
      instance_id: `id-${i}`,
      baselineOutcome: "completed" as const,
      harnessOutcome: "worker-approved" as const,
      baselineUsd: 1,
      harnessUsd: 0.3,
      routeId: "tc:codegen",
      family: "deepseek",
      dialectPack: "string-edit-default",
      workerModel: "deepseek-v4-flash",
      baselinePatch: "diff",
      harnessPatch: "diff",
      measurementFailure: false,
    }));
    const resolvedMap: Record<string, boolean> = {};
    for (const r of rows) resolvedMap[r.instance_id] = true;

    const report = buildBenchReport({
      runId: "test-run",
      rows,
      baselineScore: score("baseline", resolvedMap),
      harnessScore: score("harness", resolvedMap),
      unpricedCalls: 0,
      pricingConfidence: "verified",
      escalations: 0,
      datasetSnapshotHash: "abc",
    });
    expect(report.verdict.verdict).toBe("pass");
    expect(report.baselineResolvedRate).toBe(1);
    expect(report.harnessResolvedRate).toBe(1);

    const blocked = buildBenchReport({
      runId: "test-run",
      rows,
      baselineScore: score("baseline", resolvedMap),
      harnessScore: score("harness", resolvedMap),
      unpricedCalls: 3,
      pricingConfidence: "verified",
      escalations: 0,
      datasetSnapshotHash: "abc",
    });
    expect(blocked.verdict.verdict).toBe("inconclusive");
  });
});
