import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import { evaluateHarnessHealth, summarizeOperationalHealth } from "../src/harness/health.js";
import type { RunRecord } from "../src/runs/ledger.js";

let dir = "";
let engine: Engine | undefined;

afterEach(async () => {
  await engine?.close();
  engine = undefined;
  if (dir.length > 0) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function makeRepo(): string {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-harness-health-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "health@test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "health-test"]);
  writeFileSync(path.join(dir, "README.md"), "health fixture\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "fixture"]);
  return dir;
}

function orchestrateRecord(
  overrides: Partial<Extract<RunRecord, { kind: "orchestrate" }>> = {},
): Extract<RunRecord, { kind: "orchestrate" }> {
  return {
    v: 1,
    kind: "orchestrate",
    at: "2026-07-10T00:00:00.000Z",
    taskClass: "codegen",
    agent: "coder",
    workerModel: "worker-model",
    attempts: 1,
    outcome: "worker-approved",
    escalated: false,
    reviews: [{ decision: "approve", reasonCount: 0 }],
    contextBranch: "approved-card",
    cost: { workerUsd: 0.01, reviewUsd: 0.01, escalateUsd: null, totalUsd: 0.02 },
    durationMs: 100,
    ...overrides,
  };
}

describe("project harness health", () => {
  it("requires production evidence before calling operations healthy", () => {
    const summary = summarizeOperationalHealth([]);
    expect(summary.evidence.status).toBe("insufficient-evidence");
    expect(summary.issues).toContainEqual({ code: "insufficient-production-evidence", severity: "info" });
  });

  it("marks five clean recent runs healthy without treating escalations as failures", () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      orchestrateRecord(index === 0 ? { outcome: "escalated", escalated: true } : {}),
    );
    const summary = summarizeOperationalHealth(records);
    expect(summary.evidence).toMatchObject({
      status: "healthy",
      sampleSize: 5,
      successfulRuns: 5,
      escalatedRuns: 1,
      errorRuns: 0,
    });
  });

  it("degrades immediately on runtime or apply infrastructure failures", () => {
    const summary = summarizeOperationalHealth([
      orchestrateRecord({ outcome: "error", errorCategory: "unknown" }),
      {
        v: 1,
        kind: "apply",
        at: "2026-07-10T00:01:00.000Z",
        outcome: "failed",
        errorCategory: "git-apply-failed",
        durationMs: 15,
      },
    ]);
    expect(summary.evidence.status).toBe("degraded");
    expect(summary.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["runtime-errors-observed", "apply-failures-observed"]),
    );
  });

  it("reports a missing generated harness without running a model benchmark", async () => {
    makeRepo();
    engine = createEngine();
    const report = await evaluateHarnessHealth(engine, dir);
    expect(report.overall).toBe("failed");
    expect(report.harness).toMatchObject({ present: false, structural: "not-run" });
    expect(report.wiki.operational).toBe("not-run");
    expect(report.issues.map((issue) => issue.code)).toContain("harness-missing");
  });
});
