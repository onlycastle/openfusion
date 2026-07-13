import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeFingerprint } from "../src/runtime/context.js";
import {
  deterministicBootstrap,
  EvidenceService,
  type ExperimentTrial,
  type ExperimentVariant,
  type TrialFeatures,
  type TrialMetrics,
} from "../src/runtime/evidence.js";
import { RuntimeStore } from "../src/runtime/store.js";

let projectDir: string | undefined;
let store: RuntimeStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
  projectDir = undefined;
});

function setup(): { evidence: EvidenceService; store: RuntimeStore } {
  projectDir = mkdtempSync(path.join(os.tmpdir(), "of-runtime-evidence-"));
  store = new RuntimeStore({ projectDir, key: Buffer.alloc(32, 31) });
  return { evidence: new EvidenceService(), store };
}

const HARNESS = runtimeFingerprint({ harness: "current" });
const STALE_HARNESS = runtimeFingerprint({ harness: "stale" });
const PROJECT = runtimeFingerprint({ project: "fixture" });

function features(input: Partial<TrialFeatures> = {}): TrialFeatures {
  return {
    taskClass: "codegen",
    difficulty: "mid",
    harnessFingerprint: HARNESS,
    projectFingerprint: PROJECT,
    routeId: "route:cheap-worker",
    family: "deepseek",
    dialectPack: "deepseek-v1",
    contextPolicy: "compaction",
    ...input,
  };
}

function metrics(input: Partial<TrialMetrics> = {}): TrialMetrics {
  return {
    qualityScore: 1,
    costUsd: 5,
    latencyMs: 100,
    retryCount: 0,
    escalationCount: 0,
    interventionCount: 0,
    toolErrorCount: 0,
    safetyViolation: false,
    measurementFailure: false,
    fullyPriced: true,
    ...input,
  };
}

function matchedPlan(
  experimentId: string,
  count: number,
  route: ExperimentVariant = "generic-worker",
  routeFeatures: Partial<TrialFeatures> = {},
) {
  return Array.from({ length: count }, (_, index) => {
    const shared = { experimentId, matchId: `task-${index}`, repeatIndex: 0, seed: 10_000 + index };
    return [
      {
        ...shared,
        variant: "direct-lead" as const,
        features: features({
          routeId: "route:direct-lead",
          family: "frontier",
          dialectPack: "none",
          contextPolicy: "full-history",
        }),
      },
      {
        ...shared,
        seed: shared.seed + 1,
        variant: route,
        features: features(routeFeatures),
      },
    ];
  }).flat();
}

function completeMatched(
  evidence: EvidenceService,
  runtimeStore: RuntimeStore,
  trials: ExperimentTrial[],
  options: {
    routeCost?: number | null;
    routeQuality?: number;
    safetyViolation?: boolean;
    fullyPriced?: boolean;
    measurementFailure?: boolean;
  } = {},
): void {
  for (const trial of trials) {
    const baseline = trial.variant === "direct-lead";
    const costUsd = baseline ? 10 : (options.routeCost === undefined ? 5 : options.routeCost);
    evidence.completeTrial(runtimeStore, trial.id, metrics({
      qualityScore: baseline ? 1 : (options.routeQuality ?? 1),
      costUsd,
      safetyViolation: !baseline && options.safetyViolation === true,
      fullyPriced: options.fullyPriced ?? costUsd !== null,
      measurementFailure: options.measurementFailure ?? false,
    }));
  }
}

describe("runtime evidence ledger", () => {
  it("plans idempotently, rejects drift atomically, and resumes claimed trials after restart", () => {
    const state = setup();
    const plan = matchedPlan("experiment-resume", 2);
    const first = state.evidence.planTrials(state.store, plan);
    const again = state.evidence.planTrials(state.store, plan);
    expect(again.map((trial) => trial.id)).toEqual(first.map((trial) => trial.id));

    const claimed = state.evidence.claimTrial(state.store, "experiment-resume");
    expect(claimed?.status).toBe("running");
    state.store.close();
    store = new RuntimeStore({ projectDir: projectDir!, key: Buffer.alloc(32, 31) });
    expect(state.evidence.listTrials(store, "experiment-resume").find((trial) => trial.id === claimed?.id)?.status)
      .toBe("pending");

    const before = state.evidence.listTrials(store).length;
    expect(() => state.evidence.planTrials(store!, [
      plan[0]!,
      { ...plan[1]!, experimentId: "different-experiment" },
    ])).toThrow("one experiment");
    expect(state.evidence.listTrials(store).length).toBe(before);

    expect(() => state.evidence.planTrials(store!, [
      { ...plan[0]!, seed: plan[0]!.seed + 99 },
    ])).toThrow("different pinned inputs");
    expect(state.evidence.listTrials(store).length).toBe(before);
  });

  it("computes reproducible bootstrap intervals", () => {
    const values = [0.1, 0.2, 0.3, 0.4];
    expect(deterministicBootstrap(values, 42)).toEqual(deterministicBootstrap(values, 42));
    expect(deterministicBootstrap(values, 42).mean).toBeCloseTo(0.25);
  });

  it("keeps sparse evidence out of promotion", () => {
    const state = setup();
    const sparse = state.evidence.planTrials(state.store, matchedPlan("experiment-sparse", 3));
    completeMatched(state.evidence, state.store, sparse);
    expect(state.evidence.compileCandidate(state.store, HARNESS).gate).toMatchObject({
      eligible: false,
      cleanMatchedTasks: 3,
      reasons: expect.arrayContaining(["fewer-than-20-clean-matched-tasks"]),
    });
  });

  it("keeps unpriced evidence out of promotion", () => {
    const state = setup();
    const unpriced = state.evidence.planTrials(
      state.store,
      matchedPlan("experiment-unpriced", 20, "extensions-on", { routeId: "route:unpriced" }),
    );
    completeMatched(state.evidence, state.store, unpriced, { routeCost: null, fullyPriced: false });
    const unpricedCandidate = state.evidence.compileCandidate(state.store, HARNESS);
    expect(unpricedCandidate.gate.reasons).toEqual(expect.arrayContaining(["unpriced-calls", "savings-lower-bound"]));
  });

  it("keeps unsafe evidence out of promotion", () => {
    const state = setup();
    const unsafe = state.evidence.planTrials(
      state.store,
      matchedPlan("experiment-unsafe", 20, "dialect-pack", { routeId: "route:unsafe" }),
    );
    completeMatched(state.evidence, state.store, unsafe, { routeCost: 1, safetyViolation: true });
    expect(state.evidence.compileCandidate(state.store, HARNESS).gate.reasons).toContain("safety-violation");
  });

  it("excludes measurement failures from routing evidence", () => {
    const state = setup();
    const failed = state.evidence.planTrials(
      state.store,
      matchedPlan("experiment-measurement", 20, "children", { routeId: "route:measurement" }),
    );
    completeMatched(state.evidence, state.store, failed, { measurementFailure: true });
    expect(state.evidence.listTrials(state.store, "experiment-measurement")
      .every((trial) => trial.status === "measurement-failure")).toBe(true);
    expect(() => state.evidence.compileCandidate(state.store, HARNESS)).toThrow("no clean matched");
  });

  it("derives, shadows, promotes, resolves, and exactly rolls back deterministic routing", () => {
    const state = setup();
    const firstTrials = state.evidence.planTrials(state.store, matchedPlan("experiment-one", 20));
    completeMatched(state.evidence, state.store, firstTrials);
    const first = state.evidence.compileCandidate(state.store, HARNESS);
    expect(first.gate).toMatchObject({ eligible: true, cleanMatchedTasks: 20 });
    expect(state.evidence.compileCandidate(state.store, HARNESS).id).toBe(first.id);
    expect(JSON.stringify(first.table)).not.toContain("task-0");

    expect(() => state.evidence.promote(state.store, first.id, HARNESS, true)).toThrow("shadow");
    expect(() => state.evidence.completeShadow(state.store, first.id, STALE_HARNESS)).toThrow("stale");
    state.evidence.completeShadow(state.store, first.id, first.evidenceDigest);
    expect(() => state.evidence.promote(state.store, first.id, STALE_HARNESS, true)).toThrow("stale");
    state.evidence.promote(state.store, first.id, HARNESS, true);

    const match = features();
    expect(state.evidence.resolve(state.store, HARNESS, match)?.routeId).toBe("route:cheap-worker");
    expect(state.evidence.resolve(state.store, STALE_HARNESS, match)).toBeNull();
    expect(state.evidence.resolve(state.store, HARNESS, { ...match, projectFingerprint: STALE_HARNESS })).toBeNull();

    const secondTrials = state.evidence.planTrials(
      state.store,
      matchedPlan("experiment-two", 20, "compaction", {
        routeId: "route:cheaper-worker",
        family: "qwen",
        dialectPack: "qwen-v1",
      }),
    );
    completeMatched(state.evidence, state.store, secondTrials, { routeCost: 2 });
    const second = state.evidence.compileCandidate(state.store, HARNESS);
    expect(second.id).not.toBe(first.id);
    state.evidence.completeShadow(state.store, second.id, second.evidenceDigest);
    state.evidence.promote(state.store, second.id, HARNESS, true);
    expect(state.evidence.activeCandidate(state.store)?.id).toBe(second.id);

    expect(state.evidence.rollback(state.store, second.id)).toEqual({ activeCandidateId: first.id });
    expect(state.evidence.activeCandidate(state.store)?.id).toBe(first.id);
    expect(() => state.evidence.rollback(state.store, second.id)).toThrow("promoted");
  });

  it("stores only bounded metadata-only human feedback", () => {
    const state = setup();
    const result = state.evidence.recordFeedback(state.store, {
      subjectType: "session",
      subjectId: "session-1",
      decision: "rejected",
      reasonCode: "quality",
    });
    expect(result.id).toBeTruthy();
    expect(() => state.evidence.recordFeedback(state.store, {
      subjectType: "session",
      subjectId: "session-2",
      decision: "rejected",
      reasonCode: "raw-task-text",
    })).toThrow("not allowed");

    const db = new Database(state.store.dbPath, { readonly: true });
    const row = db.prepare("SELECT subject_type, subject_id, decision, reason_code FROM human_feedback")
      .get() as Record<string, string>;
    db.close();
    expect(row).toEqual({
      subject_type: "session",
      subject_id: "session-1",
      decision: "rejected",
      reason_code: "quality",
    });
  });
});
