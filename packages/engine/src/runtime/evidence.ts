import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { RuntimeStore } from "./store.js";
import { canonicalRuntimeJson, runtimeFingerprint } from "./context.js";

export const EXPERIMENT_VARIANTS = [
  "direct-lead",
  "generic-worker",
  "dialect-pack",
  "full-history",
  "compaction",
  "extensions-off",
  "extensions-on",
  "single-worker",
  "children",
] as const;
export type ExperimentVariant = (typeof EXPERIMENT_VARIANTS)[number];
export const HARNESS_EXPERIMENT_VARIANTS = [
  "generic-worker",
  "dialect-pack",
  "full-history",
  "compaction",
  "extensions-off",
  "extensions-on",
  "single-worker",
  "children",
] as const;
export type HarnessExperimentVariant = (typeof HARNESS_EXPERIMENT_VARIANTS)[number];
export type ExperimentTrialStatus = "pending" | "running" | "completed" | "measurement-failure";

export interface TrialFeatures {
  taskClass: string;
  difficulty: "low" | "mid" | "high" | "unknown";
  harnessFingerprint: string;
  projectFingerprint: string;
  routeId: string;
  family: string;
  dialectPack: string;
  contextPolicy: "full-history" | "compaction" | "unknown";
}

export interface TrialMetrics {
  qualityScore: number;
  costUsd: number | null;
  latencyMs: number;
  retryCount: number;
  escalationCount: number;
  interventionCount: number;
  toolErrorCount: number;
  safetyViolation: boolean;
  measurementFailure: boolean;
  fullyPriced: boolean;
}

export interface ExperimentTrial {
  id: string;
  experimentId: string;
  matchId: string;
  variant: ExperimentVariant;
  repeatIndex: number;
  seed: number;
  status: ExperimentTrialStatus;
  features: TrialFeatures;
  metrics?: TrialMetrics;
  createdAt: string;
  updatedAt: string;
}

export interface ExperimentDefinition {
  taskCount: number;
  repeats: number;
  seedDigest: string;
  variants: HarnessExperimentVariant[];
  harnessDigest: string;
  evalPolicyVersion: string;
  frontierFingerprint: string;
}

export interface BootstrapInterval {
  mean: number;
  lower95: number;
  upper95: number;
}

export interface RoutingV3Override {
  when: Pick<TrialFeatures, "taskClass" | "difficulty" | "harnessFingerprint" | "projectFingerprint">;
  routeId: string;
  family: string;
  dialectPack: string;
  contextPolicy: TrialFeatures["contextPolicy"];
}

export interface RoutingV3Table {
  version: 3;
  evidenceDigest: string;
  fallback: "configured-route";
  overrides: RoutingV3Override[];
}

export interface RoutingPromotionGate {
  cleanMatchedTasks: number;
  noSafetyViolation: boolean;
  fullyPriced: boolean;
  qualityDelta: BootstrapInterval;
  pairedSavings: BootstrapInterval;
  eligible: boolean;
  reasons: string[];
}

export interface RoutingCandidate {
  id: string;
  harnessDigest: string;
  evidenceDigest: string;
  table: RoutingV3Table;
  gate: RoutingPromotionGate;
  status: "proposed" | "shadowed" | "promoted" | "rejected" | "rolled-back";
  shadowCompleted: boolean;
  previousCandidateId?: string;
  createdAt: string;
  updatedAt: string;
  promotedAt?: string;
}

const FEEDBACK_REASONS = new Set([
  "quality",
  "cost",
  "latency",
  "safety",
  "tool-error",
  "irrelevant",
  "conflict",
  "user-choice",
]);

function now(): string {
  return new Date().toISOString();
}

function open(store: RuntimeStore): Database.Database {
  const db = new Database(store.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertDigest(value: string, label: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a sha256 digest`);
  return value;
}

function validateFeatures(features: TrialFeatures): TrialFeatures {
  for (const [name, value] of Object.entries(features)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw new Error(`trial feature ${name} is invalid`);
    }
  }
  assertDigest(features.harnessFingerprint, "harness fingerprint");
  assertDigest(features.projectFingerprint, "project fingerprint");
  return structuredClone(features);
}

function validateMetrics(metrics: TrialMetrics): TrialMetrics {
  if (!Number.isFinite(metrics.qualityScore) || metrics.qualityScore < 0 || metrics.qualityScore > 1) {
    throw new Error("qualityScore must be between zero and one");
  }
  if (metrics.costUsd !== null && (!Number.isFinite(metrics.costUsd) || metrics.costUsd < 0)) {
    throw new Error("costUsd must be null or non-negative");
  }
  for (const field of ["latencyMs", "retryCount", "escalationCount", "interventionCount", "toolErrorCount"] as const) {
    if (!Number.isFinite(metrics[field]) || metrics[field] < 0) throw new Error(`${field} is invalid`);
  }
  if (metrics.fullyPriced && metrics.costUsd === null) {
    throw new Error("fully priced trial metrics require a cost");
  }
  return structuredClone(metrics);
}

interface TrialRow {
  id: string;
  experiment_id: string;
  match_id: string;
  variant: ExperimentVariant;
  repeat_index: number;
  seed: number;
  status: ExperimentTrialStatus;
  features_json: string;
  metrics_json: string | null;
  created_at: string;
  updated_at: string;
}

function trialFromRow(row: TrialRow): ExperimentTrial {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    matchId: row.match_id,
    variant: row.variant,
    repeatIndex: row.repeat_index,
    seed: row.seed,
    status: row.status,
    features: JSON.parse(row.features_json) as TrialFeatures,
    ...(row.metrics_json === null ? {} : { metrics: JSON.parse(row.metrics_json) as TrialMetrics }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface CandidateRow {
  id: string;
  harness_digest: string;
  evidence_digest: string;
  table_json: string;
  gate_json: string;
  status: RoutingCandidate["status"];
  shadow_completed: number;
  previous_candidate_id: string | null;
  created_at: string;
  updated_at: string;
  promoted_at: string | null;
}

function candidateFromRow(row: CandidateRow): RoutingCandidate {
  return {
    id: row.id,
    harnessDigest: row.harness_digest,
    evidenceDigest: row.evidence_digest,
    table: JSON.parse(row.table_json) as RoutingV3Table,
    gate: JSON.parse(row.gate_json) as RoutingPromotionGate,
    status: row.status,
    shadowCompleted: row.shadow_completed === 1,
    ...(row.previous_candidate_id === null ? {} : { previousCandidateId: row.previous_candidate_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.promoted_at === null ? {} : { promotedAt: row.promoted_at }),
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function quantile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))]!;
}

export function deterministicBootstrap(values: readonly number[], seed: number, samples = 2_000): BootstrapInterval {
  if (values.length === 0) return { mean: Number.NaN, lower95: Number.NaN, upper95: Number.NaN };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const random = mulberry32(seed);
  const estimates: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(random() * values.length)]!;
    }
    estimates.push(sum / values.length);
  }
  return { mean, lower95: quantile(estimates, 0.025), upper95: quantile(estimates, 0.975) };
}

export function classifyWeakness(trials: readonly ExperimentTrial[]): string[] {
  const completed = trials.filter((trial) => trial.metrics !== undefined);
  const weaknesses = new Set<string>();
  if (completed.some((trial) => trial.metrics!.safetyViolation)) weaknesses.add("safety");
  if (completed.some((trial) => trial.metrics!.measurementFailure)) weaknesses.add("measurement");
  if (completed.some((trial) => trial.metrics!.toolErrorCount > 0)) weaknesses.add("tool-reliability");
  if (completed.some((trial) => trial.metrics!.interventionCount > 0)) weaknesses.add("intervention");
  if (completed.some((trial) => trial.metrics!.retryCount > 0 || trial.metrics!.escalationCount > 0)) {
    weaknesses.add("routing-or-retry");
  }
  return [...weaknesses].sort();
}

export class EvidenceService {
  pinExperiment(
    store: RuntimeStore,
    experimentId: string,
    definition: ExperimentDefinition,
  ): { experimentId: string; configurationDigest: string } {
    safeId(experimentId, "experiment id");
    if (!Number.isInteger(definition.taskCount) || definition.taskCount < 1) {
      throw new Error("experiment task count is invalid");
    }
    if (!Number.isInteger(definition.repeats) || definition.repeats < 1) {
      throw new Error("experiment repeat count is invalid");
    }
    assertDigest(definition.seedDigest, "experiment seed digest");
    assertDigest(definition.harnessDigest, "experiment harness digest");
    assertDigest(definition.frontierFingerprint, "experiment frontier fingerprint");
    if (
      definition.variants.length === 0 ||
      definition.variants.some((variant) => !HARNESS_EXPERIMENT_VARIANTS.includes(variant))
    ) {
      throw new Error("experiment variants are invalid");
    }
    const normalized: ExperimentDefinition = {
      ...definition,
      variants: [...new Set(definition.variants)].sort() as HarnessExperimentVariant[],
    };
    const configurationJson = canonicalRuntimeJson(normalized);
    if (Buffer.byteLength(configurationJson, "utf8") > 64 * 1024) {
      throw new Error("experiment configuration is too large");
    }
    const configurationDigest = runtimeFingerprint(normalized);
    const db = open(store);
    try {
      const timestamp = now();
      db.prepare(
        `INSERT OR IGNORE INTO experiment_definitions (
           id, configuration_digest, configuration_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run(experimentId, configurationDigest, configurationJson, timestamp, timestamp);
      const existing = db.prepare(
        "SELECT configuration_digest, configuration_json FROM experiment_definitions WHERE id = ?",
      ).get(experimentId) as { configuration_digest: string; configuration_json: string };
      if (
        existing.configuration_digest !== configurationDigest ||
        existing.configuration_json !== configurationJson
      ) {
        throw new Error("experiment configuration does not match its pinned definition");
      }
      return { experimentId, configurationDigest };
    } finally {
      db.close();
    }
  }

  planTrials(
    store: RuntimeStore,
    trials: Array<{
      experimentId: string;
      matchId: string;
      variant: ExperimentVariant;
      repeatIndex: number;
      seed: number;
      features: TrialFeatures;
    }>,
  ): ExperimentTrial[] {
    if (trials.length === 0) throw new Error("an experiment plan requires at least one trial");
    const experimentIds = [...new Set(trials.map((trial) => safeId(trial.experimentId, "experiment id")))];
    if (experimentIds.length !== 1) throw new Error("one plan call must target one experiment");
    const planned = trials.map((trial) => {
      safeId(trial.matchId, "match id");
      if (!EXPERIMENT_VARIANTS.includes(trial.variant)) throw new Error("experiment variant is invalid");
      if (!Number.isInteger(trial.repeatIndex) || trial.repeatIndex < 0) throw new Error("repeat index is invalid");
      if (!Number.isInteger(trial.seed)) throw new Error("trial seed is invalid");
      const features = validateFeatures(trial.features);
      return {
        ...trial,
        features,
        id: runtimeFingerprint({
          experimentId: trial.experimentId,
          matchId: trial.matchId,
          variant: trial.variant,
          repeatIndex: trial.repeatIndex,
          seed: trial.seed,
        }),
      };
    });
    const db = open(store);
    try {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO experiment_trials (
           id, experiment_id, match_id, variant, repeat_index, seed, status,
           features_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      );
      const timestamp = now();
      db.transaction(() => {
        for (const trial of planned) {
          const result = insert.run(
            trial.id,
            trial.experimentId,
            trial.matchId,
            trial.variant,
            trial.repeatIndex,
            trial.seed,
            canonicalRuntimeJson(trial.features),
            timestamp,
            timestamp,
          );
          if (result.changes === 0) {
            const existing = db.prepare(
              `SELECT id, seed, features_json FROM experiment_trials
               WHERE experiment_id = ? AND match_id = ? AND variant = ? AND repeat_index = ?`,
            ).get(
              trial.experimentId,
              trial.matchId,
              trial.variant,
              trial.repeatIndex,
            ) as { id: string; seed: number; features_json: string } | undefined;
            if (
              existing?.id !== trial.id ||
              existing.seed !== trial.seed ||
              existing.features_json !== canonicalRuntimeJson(trial.features)
            ) {
              throw new Error("an existing experiment trial has different pinned inputs");
            }
          }
        }
      })();
      return this.listTrials(store, experimentIds[0]!);
    } finally {
      db.close();
    }
  }

  claimTrial(store: RuntimeStore, experimentId: string): ExperimentTrial | null {
    const db = open(store);
    try {
      return db.transaction(() => {
        const row = db.prepare(
          `SELECT * FROM experiment_trials WHERE experiment_id = ? AND status = 'pending'
           ORDER BY repeat_index, match_id, variant LIMIT 1`,
        ).get(experimentId) as TrialRow | undefined;
        if (row === undefined) return null;
        const timestamp = now();
        const updated = db.prepare(
          "UPDATE experiment_trials SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'",
        ).run(timestamp, row.id);
        if (updated.changes !== 1) return null;
        return trialFromRow({ ...row, status: "running", updated_at: timestamp });
      })();
    } finally {
      db.close();
    }
  }

  claimTrialById(store: RuntimeStore, trialId: string): ExperimentTrial {
    const db = open(store);
    try {
      return db.transaction(() => {
        const row = db.prepare("SELECT * FROM experiment_trials WHERE id = ?").get(trialId) as TrialRow | undefined;
        if (row === undefined) throw new Error(`experiment trial not found: ${trialId}`);
        if (row.status === "completed" || row.status === "measurement-failure") return trialFromRow(row);
        if (row.status === "running") throw new Error(`experiment trial is already running: ${trialId}`);
        const timestamp = now();
        const updated = db.prepare(
          "UPDATE experiment_trials SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'",
        ).run(timestamp, trialId);
        if (updated.changes !== 1) throw new Error(`experiment trial changed while claiming: ${trialId}`);
        return trialFromRow({ ...row, status: "running", updated_at: timestamp });
      })();
    } finally {
      db.close();
    }
  }

  releaseTrial(store: RuntimeStore, trialId: string): void {
    const db = open(store);
    try {
      db.prepare(
        "UPDATE experiment_trials SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'running'",
      ).run(now(), trialId);
    } finally {
      db.close();
    }
  }

  completeTrial(store: RuntimeStore, trialId: string, metrics: TrialMetrics): ExperimentTrial {
    const validated = validateMetrics(metrics);
    const status: ExperimentTrialStatus = validated.measurementFailure ? "measurement-failure" : "completed";
    const db = open(store);
    try {
      const timestamp = now();
      const result = db.prepare(
        `UPDATE experiment_trials SET status = ?, metrics_json = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending','running')`,
      ).run(status, canonicalRuntimeJson(validated), timestamp, trialId);
      if (result.changes !== 1) throw new Error(`trial is missing or already completed: ${trialId}`);
      const row = db.prepare("SELECT * FROM experiment_trials WHERE id = ?").get(trialId) as TrialRow;
      return trialFromRow(row);
    } finally {
      db.close();
    }
  }

  listTrials(store: RuntimeStore, experimentId?: string): ExperimentTrial[] {
    const db = open(store);
    try {
      const rows = db.prepare(
        experimentId === undefined
          ? "SELECT * FROM experiment_trials ORDER BY experiment_id, repeat_index, match_id, variant"
          : "SELECT * FROM experiment_trials WHERE experiment_id = ? ORDER BY repeat_index, match_id, variant",
      ).all(...(experimentId === undefined ? [] : [experimentId])) as TrialRow[];
      return rows.map(trialFromRow);
    } finally {
      db.close();
    }
  }

  compileCandidate(store: RuntimeStore, harnessDigest: string): RoutingCandidate {
    assertDigest(harnessDigest, "harness digest");
    const trials = this.listTrials(store).filter((trial) =>
      trial.metrics !== undefined &&
      !trial.metrics.measurementFailure &&
      trial.features.harnessFingerprint === harnessDigest);
    const baselines = new Map<string, ExperimentTrial>();
    for (const trial of trials.filter((entry) => entry.variant === "direct-lead")) {
      baselines.set(`${trial.experimentId}:${trial.matchId}:${trial.repeatIndex}`, trial);
    }
    const groups = new Map<string, Array<{ route: ExperimentTrial; baseline: ExperimentTrial }>>();
    for (const route of trials.filter((entry) => entry.variant !== "direct-lead")) {
      const baseline = baselines.get(`${route.experimentId}:${route.matchId}:${route.repeatIndex}`);
      if (baseline?.metrics === undefined || route.metrics === undefined) continue;
      const groupKey = canonicalRuntimeJson({
        taskClass: route.features.taskClass,
        difficulty: route.features.difficulty,
        harnessFingerprint: route.features.harnessFingerprint,
        projectFingerprint: route.features.projectFingerprint,
        routeId: route.features.routeId,
        family: route.features.family,
        dialectPack: route.features.dialectPack,
        contextPolicy: route.features.contextPolicy,
      });
      const group = groups.get(groupKey) ?? [];
      group.push({ route, baseline });
      groups.set(groupKey, group);
    }
    if (groups.size === 0) throw new Error("no clean matched routing evidence is available");

    const evaluated = [...groups.entries()].map(([key, pairs]) => {
      const seed = Number.parseInt(createHash("sha256").update(key).digest("hex").slice(0, 8), 16);
      const qualityClusters = new Map<string, number[]>();
      const savingsClusters = new Map<string, number[]>();
      for (const { route, baseline } of pairs) {
        const quality = qualityClusters.get(route.matchId) ?? [];
        quality.push(route.metrics!.qualityScore - baseline.metrics!.qualityScore);
        qualityClusters.set(route.matchId, quality);
        if (
          route.metrics!.costUsd !== null &&
          baseline.metrics!.costUsd !== null &&
          baseline.metrics!.costUsd! > 0
        ) {
          const savings = savingsClusters.get(route.matchId) ?? [];
          savings.push((baseline.metrics!.costUsd! - route.metrics!.costUsd!) / baseline.metrics!.costUsd!);
          savingsClusters.set(route.matchId, savings);
        }
      }
      const means = (clusters: Map<string, number[]>): number[] => [...clusters.values()].map((values) =>
        values.reduce((sum, value) => sum + value, 0) / values.length);
      const qualityValues = means(qualityClusters);
      const savingsValues = means(savingsClusters);
      const qualityDelta = deterministicBootstrap(qualityValues, seed);
      const pairedSavings = deterministicBootstrap(savingsValues, seed ^ 0xa5a5a5a5);
      const noSafetyViolation = pairs.every(({ route, baseline }) =>
        !route.metrics!.safetyViolation && !baseline.metrics!.safetyViolation);
      const fullyPriced = pairs.every(({ route, baseline }) =>
        route.metrics!.fullyPriced && baseline.metrics!.fullyPriced &&
        route.metrics!.costUsd !== null && baseline.metrics!.costUsd !== null);
      const reasons: string[] = [];
      const cleanMatchedTasks = new Set(pairs.map(({ route }) => route.matchId)).size;
      if (cleanMatchedTasks < 20) reasons.push("fewer-than-20-clean-matched-tasks");
      if (!noSafetyViolation) reasons.push("safety-violation");
      if (!fullyPriced) reasons.push("unpriced-calls");
      if (!(qualityDelta.lower95 > -0.05)) reasons.push("quality-lower-bound");
      if (!(pairedSavings.lower95 > 0)) reasons.push("savings-lower-bound");
      const route = pairs[0]!.route;
      return {
        pairs,
        route,
        gate: {
          cleanMatchedTasks,
          noSafetyViolation,
          fullyPriced,
          qualityDelta,
          pairedSavings,
          eligible: reasons.length === 0,
          reasons,
        } satisfies RoutingPromotionGate,
      };
    }).sort((a, b) =>
      Number(b.gate.eligible) - Number(a.gate.eligible) ||
      (Number.isFinite(b.gate.pairedSavings.lower95) ? b.gate.pairedSavings.lower95 : Number.NEGATIVE_INFINITY) -
        (Number.isFinite(a.gate.pairedSavings.lower95) ? a.gate.pairedSavings.lower95 : Number.NEGATIVE_INFINITY) ||
      b.pairs.length - a.pairs.length ||
      (a.route.id < b.route.id ? -1 : a.route.id > b.route.id ? 1 : 0));
    const selected = evaluated[0]!;
    const evidenceRows = selected.pairs.flatMap(({ route, baseline }) => [route, baseline])
      .map((trial) => ({ id: trial.id, features: trial.features, metrics: trial.metrics }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const evidenceDigest = runtimeFingerprint(evidenceRows);
    const table: RoutingV3Table = {
      version: 3,
      evidenceDigest,
      fallback: "configured-route",
      overrides: [{
        when: {
          taskClass: selected.route.features.taskClass,
          difficulty: selected.route.features.difficulty,
          harnessFingerprint: selected.route.features.harnessFingerprint,
          projectFingerprint: selected.route.features.projectFingerprint,
        },
        routeId: selected.route.features.routeId,
        family: selected.route.features.family,
        dialectPack: selected.route.features.dialectPack,
        contextPolicy: selected.route.features.contextPolicy,
      }],
    };
    const id = `routing-${evidenceDigest.slice("sha256:".length, "sha256:".length + 24)}`;
    const db = open(store);
    try {
      const timestamp = now();
      db.prepare(
        `INSERT OR IGNORE INTO routing_candidates (
           id, harness_digest, evidence_digest, table_json, gate_json, status,
           shadow_completed, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'proposed', 0, ?, ?)`,
      ).run(
        id,
        harnessDigest,
        evidenceDigest,
        canonicalRuntimeJson(table),
        canonicalRuntimeJson(selected.gate),
        timestamp,
        timestamp,
      );
      return this.requireCandidate(store, id);
    } finally {
      db.close();
    }
  }

  listCandidates(store: RuntimeStore): RoutingCandidate[] {
    const db = open(store);
    try {
      return (db.prepare("SELECT * FROM routing_candidates ORDER BY created_at, id").all() as CandidateRow[])
        .map(candidateFromRow);
    } finally {
      db.close();
    }
  }

  requireCandidate(store: RuntimeStore, id: string): RoutingCandidate {
    const db = open(store);
    try {
      const row = db.prepare("SELECT * FROM routing_candidates WHERE id = ?").get(id) as CandidateRow | undefined;
      if (row === undefined) throw new Error(`routing candidate not found: ${id}`);
      return candidateFromRow(row);
    } finally {
      db.close();
    }
  }

  completeShadow(store: RuntimeStore, id: string, evidenceDigest: string): RoutingCandidate {
    const candidate = this.requireCandidate(store, id);
    if (candidate.evidenceDigest !== evidenceDigest) throw new Error("shadow evidence is stale");
    const override = candidate.table.overrides[0];
    if (override === undefined) throw new Error("routing candidate has no shadowable override");
    const trials = this.listTrials(store).filter((trial) =>
      trial.metrics !== undefined &&
      !trial.metrics.measurementFailure &&
      trial.features.harnessFingerprint === candidate.harnessDigest);
    const baselines = new Map(trials
      .filter((trial) => trial.variant === "direct-lead")
      .map((trial) => [`${trial.experimentId}:${trial.matchId}:${trial.repeatIndex}`, trial]));
    const pairs = trials
      .filter((trial) =>
        trial.variant !== "direct-lead" &&
        trial.features.taskClass === override.when.taskClass &&
        trial.features.difficulty === override.when.difficulty &&
        trial.features.harnessFingerprint === override.when.harnessFingerprint &&
        trial.features.projectFingerprint === override.when.projectFingerprint &&
        trial.features.routeId === override.routeId &&
        trial.features.family === override.family &&
        trial.features.dialectPack === override.dialectPack &&
        trial.features.contextPolicy === override.contextPolicy)
      .flatMap((route) => {
        const baseline = baselines.get(`${route.experimentId}:${route.matchId}:${route.repeatIndex}`);
        return baseline === undefined ? [] : [{ route, baseline }];
      });
    const shadowRows = pairs.flatMap(({ route, baseline }) => [route, baseline])
      .map((trial) => ({ id: trial.id, features: trial.features, metrics: trial.metrics }))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (runtimeFingerprint(shadowRows) !== candidate.evidenceDigest) {
      throw new Error("shadow comparison evidence changed after proposal compilation");
    }
    const matchedTasks = new Set(pairs.map(({ route }) => route.matchId)).size;
    if (matchedTasks !== candidate.gate.cleanMatchedTasks) {
      throw new Error("shadow comparison did not reproduce the proposal sample");
    }
    const db = open(store);
    try {
      db.prepare(
        `UPDATE routing_candidates SET status = 'shadowed', shadow_completed = 1, updated_at = ?
         WHERE id = ? AND status IN ('proposed','shadowed')`,
      ).run(now(), id);
    } finally {
      db.close();
    }
    return this.requireCandidate(store, id);
  }

  promote(
    store: RuntimeStore,
    id: string,
    currentHarnessDigest: string,
    humanApproved: boolean,
  ): RoutingCandidate {
    const candidate = this.requireCandidate(store, id);
    if (!humanApproved) throw new Error("routing promotion requires explicit human approval");
    if (candidate.harnessDigest !== currentHarnessDigest) throw new Error("routing candidate is stale for the current harness");
    if (!candidate.gate.eligible) throw new Error(`routing promotion gate failed: ${candidate.gate.reasons.join(",")}`);
    if (!candidate.shadowCompleted || candidate.status !== "shadowed") throw new Error("shadow comparison is incomplete");
    const db = open(store);
    try {
      db.transaction(() => {
        const active = db.prepare("SELECT candidate_id FROM routing_active WHERE singleton = 1")
          .get() as { candidate_id: string | null } | undefined;
        const timestamp = now();
        const promoted = db.prepare(
          `UPDATE routing_candidates SET status = 'promoted', previous_candidate_id = ?,
             promoted_at = ?, updated_at = ? WHERE id = ? AND status = 'shadowed'`,
        ).run(active?.candidate_id ?? null, timestamp, timestamp, id);
        if (promoted.changes !== 1) throw new Error("routing candidate changed during promotion");
        if (active?.candidate_id !== null && active?.candidate_id !== undefined) {
          db.prepare(
            "UPDATE routing_candidates SET status = 'rolled-back', updated_at = ? WHERE id = ? AND status = 'promoted'",
          ).run(timestamp, active.candidate_id);
        }
        db.prepare(
          `INSERT INTO routing_active (singleton, candidate_id, updated_at) VALUES (1, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET candidate_id = excluded.candidate_id,
             updated_at = excluded.updated_at`,
        ).run(id, timestamp);
      })();
    } finally {
      db.close();
    }
    return this.requireCandidate(store, id);
  }

  rollback(store: RuntimeStore, id: string): { activeCandidateId?: string } {
    const candidate = this.requireCandidate(store, id);
    if (candidate.status !== "promoted") throw new Error("only the promoted routing candidate can be rolled back");
    const db = open(store);
    try {
      db.transaction(() => {
        const active = db.prepare("SELECT candidate_id FROM routing_active WHERE singleton = 1")
          .get() as { candidate_id: string | null } | undefined;
        if (active?.candidate_id !== id) throw new Error("only the active routing candidate can be rolled back");
        const timestamp = now();
        db.prepare(
          "UPDATE routing_candidates SET status = 'rolled-back', updated_at = ? WHERE id = ?",
        ).run(timestamp, id);
        db.prepare(
          `INSERT INTO routing_active (singleton, candidate_id, updated_at) VALUES (1, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET candidate_id = excluded.candidate_id,
             updated_at = excluded.updated_at`,
        ).run(candidate.previousCandidateId ?? null, timestamp);
        if (candidate.previousCandidateId !== undefined) {
          db.prepare("UPDATE routing_candidates SET status = 'promoted', updated_at = ? WHERE id = ?")
            .run(timestamp, candidate.previousCandidateId);
        }
      })();
    } finally {
      db.close();
    }
    return candidate.previousCandidateId === undefined ? {} : { activeCandidateId: candidate.previousCandidateId };
  }

  activeCandidate(store: RuntimeStore): RoutingCandidate | null {
    const db = open(store);
    try {
      const active = db.prepare("SELECT candidate_id FROM routing_active WHERE singleton = 1")
        .get() as { candidate_id: string | null } | undefined;
      if (active?.candidate_id === null || active?.candidate_id === undefined) return null;
      const row = db.prepare("SELECT * FROM routing_candidates WHERE id = ?").get(active.candidate_id) as CandidateRow;
      return candidateFromRow(row);
    } finally {
      db.close();
    }
  }

  resolve(
    store: RuntimeStore,
    currentHarnessDigest: string,
    features: Pick<TrialFeatures, "taskClass" | "difficulty" | "harnessFingerprint" | "projectFingerprint">,
  ): RoutingV3Override | null {
    const candidate = this.activeCandidate(store);
    if (
      candidate === null ||
      candidate.status !== "promoted" ||
      candidate.harnessDigest !== currentHarnessDigest
    ) return null;
    return candidate.table.overrides.find((override) =>
      Object.entries(override.when).every(([key, value]) =>
        features[key as keyof typeof features] === value)) ?? null;
  }

  recordFeedback(store: RuntimeStore, input: {
    subjectType: "session" | "candidate" | "routing";
    subjectId: string;
    decision: "accepted" | "rejected" | "abandoned";
    reasonCode?: string;
  }): { id: string } {
    safeId(input.subjectId, "feedback subject id");
    if (!["session", "candidate", "routing"].includes(input.subjectType)) {
      throw new Error("feedback subject type is invalid");
    }
    if (!["accepted", "rejected", "abandoned"].includes(input.decision)) {
      throw new Error("feedback decision is invalid");
    }
    if (input.reasonCode !== undefined && !FEEDBACK_REASONS.has(input.reasonCode)) {
      throw new Error("feedback reason code is not allowed");
    }
    const db = open(store);
    try {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO human_feedback (
           id, subject_type, subject_id, decision, reason_code, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.subjectType, input.subjectId, input.decision, input.reasonCode ?? null, now());
      return { id };
    } finally {
      db.close();
    }
  }
}
