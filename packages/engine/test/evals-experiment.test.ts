import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import {
  runEvalsExperiment,
  type EvalsTrialRunner,
} from "../src/evals/experiment.js";
import type { PerTaskResult } from "../src/evals/run.js";
import type { EvalTask } from "../src/evals/tasks.js";
import { computeEvalsVerdict } from "../src/evals/verdict.js";
import { runtimeFingerprint } from "../src/runtime/context.js";
import { fingerprintHarness } from "../src/harness/fingerprint.js";
import type { HarnessBundle } from "../src/harness/schema.js";
import { loadHarness, writeHarness } from "../src/harness/store.js";
import { runtimeDbPath } from "../src/runtime/store.js";

let root: string | undefined;
let engine: Engine | undefined;

afterEach(async () => {
  await engine?.close();
  engine = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function tasks(count: number): EvalTask[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index + 1}`,
    prompt: `PROMPT_SENTINEL_${index + 1}`,
    setup: async () => {},
    testCommand: ["TEST_COMMAND_SENTINEL", String(index + 1)],
  }));
}

function results(taskList: EvalTask[], options: { unpriced?: boolean; harnessPassed?: boolean } = {}): PerTaskResult[] {
  return taskList.map((task) => ({
    id: task.id,
    baselinePassed: true,
    baselineOutcome: "completed",
    harnessPassed: options.harnessPassed ?? true,
    harnessOutcome: "worker-approved",
    baselineUsd: options.unpriced === true ? null : 1,
    harnessUsd: options.unpriced === true ? null : 0.5,
  }));
}

function runner(
  orders: string[],
  options: { unpriced?: boolean; harnessPassed?: boolean } = {},
): EvalsTrialRunner {
  return async (testEngine, params) => {
    orders.push(params.armOrder ?? "baseline-first");
    const perTask = results(params.tasks, options);
    const experiment = params.experiment;
    if (experiment === undefined) throw new Error("experiment runner did not receive pinned trial metadata");
    const harness = loadHarness(params.projectDir)!;
    const harnessDigest = fingerprintHarness(harness).digest;
    const store = testEngine.runtime.getStore(params.projectDir);
    const planned = testEngine.runtime.evidence.planTrials(store, params.tasks.flatMap((_, index) => {
      const matchId = `sample-${String(index + 1).padStart(6, "0")}`;
      const common = {
        experimentId: experiment.id,
        matchId,
        repeatIndex: experiment.repeatIndex,
      };
      return [
        {
          ...common,
          variant: "direct-lead" as const,
          seed: experiment.seed + index * 2,
          features: {
            taskClass: "codegen",
            difficulty: "mid" as const,
            harnessFingerprint: harnessDigest,
            projectFingerprint: runtimeFingerprint({ project: "experiment-test" }),
            routeId: "route:direct-lead",
            family: "frontier",
            dialectPack: "none",
            contextPolicy: "full-history" as const,
          },
        },
        {
          ...common,
          variant: experiment.variant,
          seed: experiment.seed + index * 2 + 1,
          features: {
            taskClass: "codegen",
            difficulty: "mid" as const,
            harnessFingerprint: harnessDigest,
            projectFingerprint: runtimeFingerprint({ project: "experiment-test" }),
            routeId: "route:test-worker",
            family: "test-family",
            dialectPack: "string-edit-default",
            contextPolicy: "compaction" as const,
          },
        },
      ];
    }));
    for (const trial of planned.filter((candidate) => candidate.repeatIndex === experiment.repeatIndex)) {
      if (trial.metrics !== undefined) continue;
      const baseline = trial.variant === "direct-lead";
      const costUsd = options.unpriced === true ? null : baseline ? 1 : 0.5;
      testEngine.runtime.evidence.completeTrial(store, trial.id, {
        qualityScore: baseline || (options.harnessPassed ?? true) ? 1 : 0,
        costUsd,
        latencyMs: 10,
        retryCount: 0,
        escalationCount: 0,
        interventionCount: 0,
        toolErrorCount: 0,
        safetyViolation: false,
        measurementFailure: false,
        fullyPriced: costUsd !== null,
      });
    }
    return computeEvalsVerdict({
      perTask,
      unpricedCalls: options.unpriced === true ? perTask.length * 2 : 0,
      pricingConfidence: options.unpriced === true ? "unpriced" : "verified",
      escalations: 0,
    });
  };
}

async function prepareProject(projectDir: string): Promise<void> {
  mkdirSync(projectDir, { recursive: true });
  const bundle: HarnessBundle = {
    manifest: {
      schemaVersion: 1,
      generatorVersion: "test",
      engine: "claude-code",
      headSha: "a".repeat(40),
      generatedAt: new Date(0).toISOString(),
      verification: { structural: "pass", evals: "pending" },
      artifacts: [],
    },
    pages: [{
      slug: "architecture",
      title: "Architecture",
      digest: "Experiment fixture.",
      body: "# Architecture\n\nExperiment fixture.\n",
    }],
    agents: [{
      name: "frontier",
      role: "worker",
      description: "test",
      prompt: "test",
      taskClasses: ["codegen"],
      model: "frontier",
      escalation: { maxAttempts: 1 },
    }],
    routing: {
      version: 1,
      taskClasses: { codegen: { agent: "frontier" } },
      escalation: { failuresBeforeFrontier: 1 },
      defaults: { agent: "frontier" },
    },
  };
  await writeHarness(projectDir, bundle);
}

describe("runEvalsExperiment", () => {
  it("uses seeded arm order, computes promotion metrics, and resumes without duplicate trials", async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "of-experiment-"));
    const appStorageDir = path.join(root, "app-state");
    const projectDir = path.join(root, "project");
    await prepareProject(projectDir);
    engine = createEngine({ appStorageDir });
    const taskList = tasks(20);
    const orders: string[] = [];
    const first = await runEvalsExperiment(engine, {
      projectDir,
      tasks: taskList,
      trials: 3,
      seed: "fixed-seed",
      experimentId: "experiment-1",
    }, runner(orders));

    expect(orders).toHaveLength(3);
    expect(new Set(orders).size).toBeGreaterThan(1);
    expect(first).toMatchObject({
      completedTrials: 3,
      resumedTrials: 0,
      taskCount: 20,
      baseline: { passAtK: 1, passPowerK: 1 },
      harness: { passAtK: 1, passPowerK: 1 },
      qualityDelta: { estimate: 0, lower95: 0, upper95: 0 },
      costUsd: { complete: true, unpricedCalls: 0 },
      promotion: { eligible: true, reasons: [] },
    });

    const dbPath = runtimeDbPath(projectDir);
    const databaseBytes = Buffer.concat([
      readFileSync(dbPath),
      ...(existsSync(`${dbPath}-wal`) ? [readFileSync(`${dbPath}-wal`)] : []),
    ]).toString("utf8");
    expect(databaseBytes).not.toContain("PROMPT_SENTINEL");
    expect(databaseBytes).not.toContain("TEST_COMMAND_SENTINEL");

    const resumed = await runEvalsExperiment(engine, {
      projectDir,
      tasks: taskList,
      trials: 3,
      seed: "fixed-seed",
      experimentId: "experiment-1",
    }, async () => {
      throw new Error("completed trials must not be duplicated");
    });
    expect(resumed.completedTrials).toBe(3);
    expect(resumed.resumedTrials).toBe(3);
  });

  it("keeps incomplete pricing and undersized samples promotion-ineligible", async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "of-experiment-unpriced-"));
    engine = createEngine({ appStorageDir: path.join(root, "app-state") });
    const projectDir = path.join(root, "project");
    await prepareProject(projectDir);
    const report = await runEvalsExperiment(engine, {
      projectDir,
      tasks: tasks(2),
      trials: 1,
      seed: "unpriced-seed",
      experimentId: "experiment-unpriced",
    }, runner([], { unpriced: true }));

    expect(report.costUsd).toMatchObject({ complete: false, unpricedCalls: 4 });
    expect(report.promotion).toEqual({
      eligible: false,
      reasons: expect.arrayContaining(["fewer-than-20-clean-matched-tasks", "incomplete-pricing"]),
    });
  });

  it("refuses to resume an experiment under a different configuration", async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "of-experiment-mismatch-"));
    engine = createEngine({ appStorageDir: path.join(root, "app-state") });
    const projectDir = path.join(root, "project");
    await prepareProject(projectDir);
    await runEvalsExperiment(engine, {
      projectDir,
      tasks: tasks(2),
      trials: 1,
      seed: "seed-one",
      experimentId: "experiment-mismatch",
    }, runner([]));

    await expect(runEvalsExperiment(engine, {
      projectDir,
      tasks: tasks(2),
      trials: 1,
      seed: "seed-two",
      experimentId: "experiment-mismatch",
    }, runner([]))).rejects.toThrow("configuration does not match");
  });
});
