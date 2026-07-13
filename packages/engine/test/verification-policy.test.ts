import { describe, expect, it } from "vitest";
import type { StageReportV1 } from "@openfusion/shared";
import {
  enforceStagePolicy,
  getStagePolicy,
  STAGE_POLICIES,
} from "../src/verification/policy.js";

function report(overrides: Partial<StageReportV1> = {}): StageReportV1 {
  return {
    schemaVersion: 1,
    stageId: "setup.wiki.index",
    policyVersion: 1,
    attempt: 1,
    inputRef: { id: "project-snapshot", digest: `sha256:${"a".repeat(64)}` },
    execution: "completed",
    verdict: "passed",
    checks: [],
    startedAt: "2026-07-10T00:00:00.000Z",
    durationMs: 1,
    ...overrides,
  };
}

describe("stage verification policy registry", () => {
  it("has unique stage IDs and non-empty unique required-check sets", () => {
    expect(new Set(STAGE_POLICIES.map((policy) => policy.id)).size).toBe(STAGE_POLICIES.length);
    for (const policy of STAGE_POLICIES) {
      expect(policy.version).toBeGreaterThanOrEqual(1);
      expect(policy.requiredCheckIds.length).toBeGreaterThan(0);
      expect(new Set(policy.requiredCheckIds).size).toBe(policy.requiredCheckIds.length);
    }
  });

  it("looks up a stable policy by stage ID", () => {
    expect(getStagePolicy("task.review")?.requiredCheckIds).toContain("review.rubric-complete");
    expect(getStagePolicy("not-a-stage")).toBeUndefined();
  });

  it("fills omitted required checks and makes the report inconclusive", () => {
    const enforced = enforceStagePolicy(report());
    expect(enforced.verdict).toBe("inconclusive");
    expect(enforced.checks.map((check) => check.id)).toEqual(
      getStagePolicy("setup.wiki.index")?.requiredCheckIds,
    );
    expect(enforced.checks.every((check) => check.required)).toBe(true);
    expect(enforced.checks.every((check) => check.status === "inconclusive")).toBe(true);
  });

  it("upgrades a policy-required check that a caller marked advisory", () => {
    const enforced = enforceStagePolicy(
      report({
        checks: [
          {
            id: "wiki.db-present",
            required: false,
            status: "passed",
            summary: "Wiki database exists.",
          },
        ],
      }),
    );
    expect(enforced.checks.find((check) => check.id === "wiki.db-present")?.required).toBe(true);
    expect(enforced.verdict).toBe("inconclusive");
  });

  it("preserves a passing report when every required check passes", () => {
    const policy = getStagePolicy("task.coverage")!;
    const enforced = enforceStagePolicy(
      report({
        stageId: policy.id,
        checks: policy.requiredCheckIds.map((id) => ({
          id,
          required: true,
          status: "passed",
          summary: "Required evidence is present.",
        })),
      }),
    );
    expect(enforced.verdict).toBe("passed");
  });

  it("rejects unregistered stages", () => {
    expect(() => enforceStagePolicy(report({ stageId: "unknown.stage" }))).toThrow(
      "unknown stage policy",
    );
  });
});
