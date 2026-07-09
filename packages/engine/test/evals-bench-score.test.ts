import { describe, expect, it } from "vitest";
import {
  buildSbCliSubmitArgs,
  parseScoreReport,
} from "../src/evals/bench/score.js";

describe("bench score", () => {
  it("builds sb-cli argv for swe-bench_verified + instance_ids", () => {
    const args = buildSbCliSubmitArgs({
      predictionsPath: "/tmp/preds.json",
      instanceIds: ["django__django-1", "django__django-2"],
      runId: "run-1",
      outputDir: "/tmp/out",
    });
    expect(args[0]).toBe("submit");
    expect(args).toContain("swe-bench_verified");
    expect(args).toContain("test");
    expect(args).toContain("--instance_ids");
    const idx = args.indexOf("--instance_ids");
    expect(args[idx + 1]).toBe("django__django-1,django__django-2");
    expect(args).toContain("--predictions_path");
    expect(args).not.toContain("jsonl");
  });

  it("parseScoreReport uses denominator N not 500", () => {
    const ids = ["a", "b", "c"];
    const resolved = parseScoreReport(
      { resolved_ids: ["a", "c"] },
      ids,
    );
    expect(resolved).toHaveLength(3);
    expect(resolved.filter((r) => r.resolved)).toHaveLength(2);
    const rate = resolved.filter((r) => r.resolved).length / ids.length;
    expect(rate).toBeCloseTo(2 / 3);
    expect(rate).not.toBeCloseTo(2 / 500);
  });

  it("parseScoreReport handles results array shape", () => {
    const ids = ["x", "y"];
    const resolved = parseScoreReport(
      {
        results: [
          { instance_id: "x", resolved: true },
          { instance_id: "y", resolved: false },
        ],
      },
      ids,
    );
    expect(resolved.find((r) => r.instance_id === "x")!.resolved).toBe(true);
    expect(resolved.find((r) => r.instance_id === "y")!.resolved).toBe(false);
  });
});
