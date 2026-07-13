import { describe, expect, it } from "vitest";
import {
  CheckEvidenceSchema,
  computeStageVerdict,
  StageReportSchema,
  type CheckResult,
} from "../src/index.js";

const PASSED_REQUIRED: CheckResult = {
  id: "wiki.head-current",
  required: true,
  status: "passed",
  summary: "Wiki HEAD matches the project snapshot.",
};

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    stageId: "setup.wiki.index",
    policyVersion: 1,
    attempt: 1,
    inputRef: { id: "project-snapshot", digest: `sha256:${"a".repeat(64)}` },
    outputRef: { id: "wiki-index", digest: `sha256:${"b".repeat(64)}` },
    execution: "completed",
    verdict: "passed",
    checks: [PASSED_REQUIRED],
    startedAt: "2026-07-10T00:00:00.000Z",
    durationMs: 25,
    ...overrides,
  };
}

describe("computeStageVerdict", () => {
  it.each([
    ["completed", [{ ...PASSED_REQUIRED, status: "passed" }], "passed"],
    ["completed", [{ ...PASSED_REQUIRED, status: "failed" }], "failed"],
    ["completed", [{ ...PASSED_REQUIRED, status: "skipped" }], "inconclusive"],
    ["completed", [{ ...PASSED_REQUIRED, status: "inconclusive" }], "inconclusive"],
    ["failed", [{ ...PASSED_REQUIRED, status: "passed" }], "failed"],
    ["cancelled", [{ ...PASSED_REQUIRED, status: "failed" }], "cancelled"],
  ] as const)("maps %s execution and checks to %s", (execution, checks, expected) => {
    expect(computeStageVerdict(checks, execution)).toBe(expected);
  });

  it("does not let an advisory failure fail the stage", () => {
    expect(
      computeStageVerdict(
        [{ ...PASSED_REQUIRED }, { ...PASSED_REQUIRED, id: "wiki.quality", required: false, status: "failed" }],
        "completed",
      ),
    ).toBe("passed");
  });
});

describe("StageReportSchema", () => {
  it("accepts a verdict consistent with execution and required checks", () => {
    expect(StageReportSchema.safeParse(report()).success).toBe(true);
  });

  it("rejects a caller-authored verdict that hides a required failure", () => {
    expect(
      StageReportSchema.safeParse(
        report({ checks: [{ ...PASSED_REQUIRED, status: "failed" }], verdict: "passed" }),
      ).success,
    ).toBe(false);
  });

  it("rejects duplicate check IDs", () => {
    expect(
      StageReportSchema.safeParse(report({ checks: [PASSED_REQUIRED, PASSED_REQUIRED] })).success,
    ).toBe(false);
  });

  it("fails closed on unknown content-bearing fields", () => {
    const marker = "UNIQUE-TASK-PROMPT-DIFF-MODEL-OUTPUT-MARKER";
    expect(StageReportSchema.safeParse({ ...report(), prompt: marker }).success).toBe(false);
    expect(
      StageReportSchema.safeParse({
        ...report(),
        checks: [{ ...PASSED_REQUIRED, source: marker }],
      }).success,
    ).toBe(false);
    expect(CheckEvidenceSchema.safeParse({ reasonCode: "ok", stdout: marker }).success).toBe(false);
  });

  it("bounds evidence metadata", () => {
    expect(CheckEvidenceSchema.safeParse({ exitCode: -1, durationMs: 0 }).success).toBe(true);
    expect(CheckEvidenceSchema.safeParse({ exitCode: 256 }).success).toBe(false);
    expect(CheckEvidenceSchema.safeParse({ durationMs: -1 }).success).toBe(false);
    expect(CheckEvidenceSchema.safeParse({ artifactDigest: "not-a-digest" }).success).toBe(false);
  });
});
