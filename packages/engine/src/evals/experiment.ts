import { createHash, randomUUID } from "node:crypto";
import type { Engine } from "../engine.js";
import type { EvalsFrontierSelections } from "../engines/selection.js";
import { fingerprintHarness } from "../harness/fingerprint.js";
import { loadHarness } from "../harness/store.js";
import { runtimeFingerprint } from "../runtime/context.js";
import {
  classifyWeakness,
  deterministicBootstrap,
  type ExperimentTrial,
  type HarnessExperimentVariant,
} from "../runtime/evidence.js";
import type { RunSupervisor } from "../runtime/supervisor.js";
import {
  EVAL_POLICY_VERSION,
  runEvals,
  type EvalsReportCard,
} from "./run.js";
import type { EvalTask } from "./tasks.js";

function seedNumber(seed: string): number {
  return createHash("sha256").update(seed).digest().readInt32BE(0);
}

function chooseArmOrder(seed: string, repeatIndex: number, variant: string): "baseline-first" | "harness-first" {
  return ((seedNumber(`${seed}:arm-order:${variant}`) + repeatIndex) & 1) === 0
    ? "baseline-first"
    : "harness-first";
}

function quantile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function combination(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const effective = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= effective; index += 1) {
    result = result * (n - effective + index) / index;
  }
  return result;
}

function passMetrics(
  observations: Map<string, boolean[]>,
  k: number,
): { passAtK: number | null; passPowerK: number | null } {
  const atLeastOne: number[] = [];
  const all: number[] = [];
  for (const results of observations.values()) {
    const n = results.length;
    if (n < k) continue;
    const passed = results.filter(Boolean).length;
    const denominator = combination(n, k);
    atLeastOne.push(1 - combination(n - passed, k) / denominator);
    all.push(combination(passed, k) / denominator);
  }
  return {
    passAtK: atLeastOne.length === 0
      ? null
      : atLeastOne.reduce((sum, value) => sum + value, 0) / atLeastOne.length,
    passPowerK: all.length === 0
      ? null
      : all.reduce((sum, value) => sum + value, 0) / all.length,
  };
}

function nullableInterval(interval: ReturnType<typeof deterministicBootstrap>): {
  estimate: number | null;
  lower95: number | null;
  upper95: number | null;
} {
  return {
    estimate: Number.isFinite(interval.mean) ? interval.mean : null,
    lower95: Number.isFinite(interval.lower95) ? interval.lower95 : null,
    upper95: Number.isFinite(interval.upper95) ? interval.upper95 : null,
  };
}

export interface EvalsExperimentParams {
  projectDir: string;
  tasks: EvalTask[];
  trials: number;
  seed: string;
  experimentId?: string;
  variant?: HarnessExperimentVariant;
  variants?: HarnessExperimentVariant[];
  frontier?: EvalsFrontierSelections;
  runId?: string;
  supervisor?: RunSupervisor;
}

export interface EvalsExperimentReport {
  schemaVersion: 2;
  experimentId: string;
  seed: string;
  variants: ["baseline", "harness"];
  testedVariants: HarnessExperimentVariant[];
  evidenceDigest: string;
  taskCount: number;
  completedTrials: number;
  resumedTrials: number;
  passK: number;
  baseline: { passAtK: number | null; passPowerK: number | null };
  harness: { passAtK: number | null; passPowerK: number | null };
  qualityDelta: { estimate: number | null; lower95: number | null; upper95: number | null };
  pairedSavings: { estimate: number | null; lower95: number | null; upper95: number | null };
  latencyMs: { p50: number | null; p95: number | null };
  costUsd: {
    complete: boolean;
    unpricedCalls: number;
    baseline: { lower95: number | null; upper95: number | null };
    harness: { lower95: number | null; upper95: number | null };
  };
  retryRate: number | null;
  escalationRate: number | null;
  interventionRate: number | null;
  toolErrorRate: number | null;
  measurementFailureCount: number;
  safetyViolations: number;
  weaknesses: string[];
  promotion: { eligible: boolean; reasons: string[] };
}

export type EvalsTrialRunner = (
  engine: Engine,
  params: Parameters<typeof runEvals>[1],
) => Promise<EvalsReportCard>;

function trialComplete(trial: ExperimentTrial): boolean {
  return trial.status === "completed" || trial.status === "measurement-failure";
}

function completedCombination(
  trials: readonly ExperimentTrial[],
  variant: HarnessExperimentVariant,
  repeatIndex: number,
  taskCount: number,
): boolean {
  const rows = trials.filter((trial) =>
    trial.repeatIndex === repeatIndex &&
    (trial.variant === "direct-lead" || trial.variant === variant));
  return rows.length === taskCount * 2 && rows.every(trialComplete);
}

export async function runEvalsExperiment(
  engine: Engine,
  params: EvalsExperimentParams,
  trialRunner: EvalsTrialRunner = runEvals,
): Promise<EvalsExperimentReport> {
  if (!Number.isInteger(params.trials) || params.trials < 1 || params.trials > 100) {
    throw new Error("experiment trials must be an integer between 1 and 100");
  }
  if (params.tasks.length === 0) throw new Error("experiment requires at least one task");
  const testedVariants = [...new Set(
    params.variants ?? [params.variant ?? "dialect-pack"],
  )].sort() as HarnessExperimentVariant[];
  if (testedVariants.length === 0) throw new Error("experiment requires at least one harness variant");
  const experimentId = params.experimentId ?? randomUUID();
  const harness = loadHarness(params.projectDir);
  if (harness === null) throw new Error("no harness; build it before running an experiment");
  const harnessDigest = fingerprintHarness(harness).digest;
  const store = engine.runtime.getStore(params.projectDir);
  engine.runtime.evidence.pinExperiment(store, experimentId, {
    taskCount: params.tasks.length,
    repeats: params.trials,
    seedDigest: runtimeFingerprint({ seed: params.seed }),
    variants: testedVariants,
    harnessDigest,
    evalPolicyVersion: EVAL_POLICY_VERSION,
    frontierFingerprint: runtimeFingerprint(params.frontier ?? {}),
  });

  const before = engine.runtime.evidence.listTrials(store, experimentId);
  let resumedTrials = 0;
  for (const variant of testedVariants) {
    for (let repeatIndex = 0; repeatIndex < params.trials; repeatIndex += 1) {
      if (completedCombination(before, variant, repeatIndex, params.tasks.length)) {
        resumedTrials += 1;
        continue;
      }
      params.supervisor?.throwIfAborted();
      const armOrder = chooseArmOrder(params.seed, repeatIndex, variant);
      const spanId = randomUUID();
      params.supervisor?.record({
        spanId,
        parentSpanId: params.supervisor.rootSpanId,
        attemptId: `${variant}-${repeatIndex + 1}`,
        type: "experiment.trial.started",
        terminal: false,
        metadata: { repeat: repeatIndex + 1, variant, armOrder },
      });
      try {
        await trialRunner(engine, {
          projectDir: params.projectDir,
          tasks: params.tasks,
          frontier: params.frontier,
          runId: params.runId,
          supervisor: params.supervisor,
          armOrder,
          experiment: {
            id: experimentId,
            variant,
            repeatIndex,
            seed: seedNumber(`${params.seed}:repeat:${repeatIndex}`),
          },
        });
        const current = engine.runtime.evidence.listTrials(store, experimentId);
        if (!completedCombination(current, variant, repeatIndex, params.tasks.length)) {
          throw new Error("experiment runner returned without transactionally completing its trial rows");
        }
        params.supervisor?.record({
          spanId,
          parentSpanId: params.supervisor.rootSpanId,
          attemptId: `${variant}-${repeatIndex + 1}`,
          type: "experiment.trial.completed",
          terminal: true,
          metadata: { repeat: repeatIndex + 1, variant },
        });
      } catch (error) {
        params.supervisor?.record({
          spanId,
          parentSpanId: params.supervisor.rootSpanId,
          attemptId: `${variant}-${repeatIndex + 1}`,
          type: "experiment.trial.failed",
          terminal: true,
          reasonCode: "run-failed",
          metadata: { repeat: repeatIndex + 1, variant },
        });
        throw error;
      }
    }
  }

  const selected = engine.runtime.evidence.listTrials(store, experimentId).filter((trial) =>
    trial.repeatIndex < params.trials &&
    (trial.variant === "direct-lead" || testedVariants.includes(trial.variant as HarnessExperimentVariant)));
  const baselines = new Map(selected
    .filter((trial) => trial.variant === "direct-lead")
    .map((trial) => [`${trial.repeatIndex}:${trial.matchId}`, trial]));
  const pairs = selected
    .filter((trial) => trial.variant !== "direct-lead")
    .flatMap((route) => {
      const baseline = baselines.get(`${route.repeatIndex}:${route.matchId}`);
      return baseline === undefined ? [] : [{ baseline, route }];
    });
  const cleanPairs = pairs.filter(({ baseline, route }) =>
    baseline.metrics !== undefined &&
    route.metrics !== undefined &&
    !baseline.metrics.measurementFailure &&
    !route.metrics.measurementFailure);
  const baselineObservations = new Map<string, boolean[]>();
  for (const baseline of baselines.values()) {
    if (baseline.metrics === undefined || baseline.metrics.measurementFailure) continue;
    const values = baselineObservations.get(baseline.matchId) ?? [];
    values.push(baseline.metrics.qualityScore >= 0.5);
    baselineObservations.set(baseline.matchId, values);
  }
  const harnessObservations = new Map<string, boolean[]>();
  for (const { route } of cleanPairs) {
    const key = `${route.variant}:${route.matchId}`;
    const values = harnessObservations.get(key) ?? [];
    values.push(route.metrics!.qualityScore >= 0.5);
    harnessObservations.set(key, values);
  }
  const qualityClusters = new Map<string, number[]>();
  const savingsClusters = new Map<string, number[]>();
  for (const { baseline, route } of cleanPairs) {
    const key = `${route.variant}:${route.matchId}`;
    const quality = qualityClusters.get(key) ?? [];
    quality.push(route.metrics!.qualityScore - baseline.metrics!.qualityScore);
    qualityClusters.set(key, quality);
    if (
      baseline.metrics!.costUsd !== null &&
      route.metrics!.costUsd !== null &&
      baseline.metrics!.costUsd! > 0
    ) {
      const savings = savingsClusters.get(key) ?? [];
      savings.push((baseline.metrics!.costUsd! - route.metrics!.costUsd!) / baseline.metrics!.costUsd!);
      savingsClusters.set(key, savings);
    }
  }
  const clusterMeans = (clusters: Map<string, number[]>): number[] => [...clusters.values()].map((values) =>
    values.reduce((sum, value) => sum + value, 0) / values.length);
  const qualityValues = clusterMeans(qualityClusters);
  const savingsValues = clusterMeans(savingsClusters);
  const quality = nullableInterval(deterministicBootstrap(qualityValues, seedNumber(`${params.seed}:quality`)));
  const savings = nullableInterval(deterministicBootstrap(savingsValues, seedNumber(`${params.seed}:savings`)));
  const completedRows = selected.filter((trial) => trial.metrics !== undefined);
  const routeRows = completedRows.filter((trial) => trial.variant !== "direct-lead");
  const baselineCosts = [...baselines.values()].flatMap((trial) => trial.metrics?.costUsd ?? []);
  const harnessCosts = routeRows.flatMap((trial) => trial.metrics?.costUsd ?? []);
  const unpricedCalls = completedRows.filter((trial) =>
    trial.metrics === undefined || !trial.metrics.fullyPriced || trial.metrics.costUsd === null).length;
  const measurementFailureCount = completedRows.filter((trial) => trial.metrics!.measurementFailure).length;
  const safetyViolations = completedRows.filter((trial) => trial.metrics!.safetyViolation).length;
  const cleanMatchedTasks = new Set(cleanPairs.map(({ route }) => route.matchId)).size;
  const reasons: string[] = [];
  if (cleanMatchedTasks < 20) reasons.push("fewer-than-20-clean-matched-tasks");
  if (safetyViolations > 0) reasons.push("safety-violation");
  if (unpricedCalls > 0) reasons.push("incomplete-pricing");
  if (measurementFailureCount > 0) reasons.push("measurement-failures");
  if (quality.lower95 === null || quality.lower95 <= -0.05) reasons.push("quality-lower-bound-not-above-minus-5pp");
  if (savings.lower95 === null || savings.lower95 <= 0) reasons.push("paired-savings-lower-bound-not-positive");
  const routeCount = routeRows.length;
  const rate = (field: "retryCount" | "escalationCount" | "interventionCount" | "toolErrorCount"): number | null =>
    routeCount === 0
      ? null
      : routeRows.reduce((sum, trial) => sum + trial.metrics![field], 0) / routeCount;
  const evidenceDigest = runtimeFingerprint(completedRows
    .map((trial) => ({ id: trial.id, status: trial.status, metrics: trial.metrics }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  return {
    schemaVersion: 2,
    experimentId,
    seed: params.seed,
    variants: ["baseline", "harness"],
    testedVariants,
    evidenceDigest,
    taskCount: params.tasks.length,
    completedTrials: testedVariants.length * params.trials,
    resumedTrials,
    passK: Math.min(params.trials, 5),
    baseline: passMetrics(baselineObservations, Math.min(params.trials, 5)),
    harness: passMetrics(harnessObservations, Math.min(params.trials, 5)),
    qualityDelta: quality,
    pairedSavings: savings,
    latencyMs: {
      p50: quantile(routeRows.map((trial) => trial.metrics!.latencyMs), 0.5),
      p95: quantile(routeRows.map((trial) => trial.metrics!.latencyMs), 0.95),
    },
    costUsd: {
      complete: unpricedCalls === 0,
      unpricedCalls,
      baseline: { lower95: quantile(baselineCosts, 0.025), upper95: quantile(baselineCosts, 0.975) },
      harness: { lower95: quantile(harnessCosts, 0.025), upper95: quantile(harnessCosts, 0.975) },
    },
    retryRate: rate("retryCount"),
    escalationRate: rate("escalationCount"),
    interventionRate: rate("interventionCount"),
    toolErrorRate: rate("toolErrorCount"),
    measurementFailureCount,
    safetyViolations,
    weaknesses: classifyWeakness(completedRows),
    promotion: { eligible: reasons.length === 0, reasons },
  };
}
