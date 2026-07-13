import { z } from "zod";
import type { Engine } from "../engine.js";
import { fingerprintHarness } from "../harness/fingerprint.js";
import { loadHarness } from "../harness/store.js";
import { requireGitRepo } from "../rpc/guards.js";
import { registerMethod } from "../rpc/register.js";
import {
  EXPERIMENT_VARIANTS,
  classifyWeakness,
  type ExperimentVariant,
  type TrialFeatures,
  type TrialMetrics,
} from "./evidence.js";
import { runtimeFingerprint } from "./context.js";

const ProjectSchema = z.object({ projectDir: z.string().min(1) });
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const FeaturesSchema = z.object({
  taskClass: z.string().min(1).max(256),
  difficulty: z.enum(["low", "mid", "high", "unknown"]),
  harnessFingerprint: DigestSchema,
  projectFingerprint: DigestSchema,
  routeId: z.string().min(1).max(256),
  family: z.string().min(1).max(256),
  dialectPack: z.string().min(1).max(256),
  contextPolicy: z.enum(["full-history", "compaction", "unknown"]),
}).strict();
const MetricsSchema = z.object({
  qualityScore: z.number().min(0).max(1),
  costUsd: z.number().nonnegative().nullable(),
  latencyMs: z.number().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  escalationCount: z.number().int().nonnegative(),
  interventionCount: z.number().int().nonnegative(),
  toolErrorCount: z.number().int().nonnegative(),
  safetyViolation: z.boolean(),
  measurementFailure: z.boolean(),
  fullyPriced: z.boolean(),
}).strict();
const PlanSchema = ProjectSchema.extend({
  experimentId: z.string().min(1).max(256),
  trials: z.array(z.object({
    matchId: z.string().min(1).max(256),
    variant: z.enum(EXPERIMENT_VARIANTS),
    repeatIndex: z.number().int().nonnegative(),
    seed: z.number().int(),
    features: FeaturesSchema,
  }).strict()).min(1),
});
const ExperimentSchema = ProjectSchema.extend({ experimentId: z.string().min(1).max(256) });
const CompleteTrialSchema = ProjectSchema.extend({
  trialId: z.string().min(1),
  metrics: MetricsSchema,
});
const CandidateSchema = ProjectSchema.extend({ candidateId: z.string().min(1) });

function currentHarnessDigest(projectDir: string): string {
  const harness = loadHarness(projectDir);
  if (harness === null) throw new Error("no harness; build it before compiling routing evidence");
  return fingerprintHarness(harness).digest;
}

export function registerEvidenceMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.experiments.variants", z.object({}), () => ({
    variants: EXPERIMENT_VARIANTS,
  }));

  registerMethod(engine.dispatcher, "engine.experiments.plan", PlanSchema, (params) => {
    requireGitRepo(params.projectDir);
    const store = engine.runtime.getStore(params.projectDir);
    return {
      trials: engine.runtime.evidence.planTrials(store, params.trials.map((trial) => ({
        experimentId: params.experimentId,
        matchId: trial.matchId,
        variant: trial.variant as ExperimentVariant,
        repeatIndex: trial.repeatIndex,
        seed: trial.seed,
        features: trial.features as TrialFeatures,
      }))),
    };
  });

  registerMethod(engine.dispatcher, "engine.experiments.claim", ExperimentSchema, (params) => {
    requireGitRepo(params.projectDir);
    return { trial: engine.runtime.evidence.claimTrial(
      engine.runtime.getStore(params.projectDir),
      params.experimentId,
    ) };
  });

  registerMethod(engine.dispatcher, "engine.experiments.complete", CompleteTrialSchema, (params) => {
    requireGitRepo(params.projectDir);
    return { trial: engine.runtime.evidence.completeTrial(
      engine.runtime.getStore(params.projectDir),
      params.trialId,
      params.metrics as TrialMetrics,
    ) };
  });

  registerMethod(engine.dispatcher, "engine.experiments.list", ExperimentSchema, (params) => {
    requireGitRepo(params.projectDir);
    return { trials: engine.runtime.evidence.listTrials(
      engine.runtime.getStore(params.projectDir),
      params.experimentId,
    ) };
  });

  registerMethod(engine.dispatcher, "engine.experiments.evidence", ExperimentSchema, (params) => {
    requireGitRepo(params.projectDir);
    const trials = engine.runtime.evidence.listTrials(
      engine.runtime.getStore(params.projectDir),
      params.experimentId,
    );
    return {
      experimentId: params.experimentId,
      completedTrials: trials.filter((trial) => trial.metrics !== undefined).length,
      weaknesses: classifyWeakness(trials),
      evidenceDigest: runtimeFingerprint(
        trials.map((trial) => ({ id: trial.id, status: trial.status, metrics: trial.metrics })),
      ),
    };
  });

  registerMethod(engine.dispatcher, "engine.routing.proposals.create", ProjectSchema, (params) => {
    requireGitRepo(params.projectDir);
    const store = engine.runtime.getStore(params.projectDir);
    return { candidate: engine.runtime.evidence.compileCandidate(store, currentHarnessDigest(params.projectDir)) };
  });

  registerMethod(engine.dispatcher, "engine.routing.proposals.list", ProjectSchema, (params) => {
    requireGitRepo(params.projectDir);
    return { candidates: engine.runtime.evidence.listCandidates(engine.runtime.getStore(params.projectDir)) };
  });

  registerMethod(engine.dispatcher, "engine.routing.proposals.get", CandidateSchema, (params) => {
    requireGitRepo(params.projectDir);
    return { candidate: engine.runtime.evidence.requireCandidate(
      engine.runtime.getStore(params.projectDir),
      params.candidateId,
    ) };
  });

  registerMethod(engine.dispatcher, "engine.routing.proposals.shadow", CandidateSchema.extend({
    evidenceDigest: DigestSchema,
  }), (params) => {
    requireGitRepo(params.projectDir);
    return { candidate: engine.runtime.evidence.completeShadow(
      engine.runtime.getStore(params.projectDir),
      params.candidateId,
      params.evidenceDigest,
    ) };
  });

  registerMethod(engine.dispatcher, "engine.routing.proposals.promote", CandidateSchema.extend({
    expectedHarnessDigest: DigestSchema,
    humanApproved: z.literal(true),
  }), (params) => {
    requireGitRepo(params.projectDir);
    const current = currentHarnessDigest(params.projectDir);
    if (current !== params.expectedHarnessDigest) throw new Error("harness changed before routing promotion");
    return { candidate: engine.runtime.evidence.promote(
      engine.runtime.getStore(params.projectDir),
      params.candidateId,
      current,
      params.humanApproved,
    ) };
  });

  registerMethod(engine.dispatcher, "engine.routing.rollback", CandidateSchema, (params) => {
    requireGitRepo(params.projectDir);
    return engine.runtime.evidence.rollback(engine.runtime.getStore(params.projectDir), params.candidateId);
  });

  registerMethod(engine.dispatcher, "engine.routing.status", ProjectSchema, (params) => {
    requireGitRepo(params.projectDir);
    return {
      active: engine.runtime.evidence.activeCandidate(engine.runtime.getStore(params.projectDir)),
      currentHarnessDigest: currentHarnessDigest(params.projectDir),
    };
  });

  registerMethod(engine.dispatcher, "engine.feedback.record", ProjectSchema.extend({
    subjectType: z.enum(["session", "candidate", "routing"]),
    subjectId: z.string().min(1).max(256),
    decision: z.enum(["accepted", "rejected", "abandoned"]),
    reasonCode: z.enum([
      "quality",
      "cost",
      "latency",
      "safety",
      "tool-error",
      "irrelevant",
      "conflict",
      "user-choice",
    ]).optional(),
  }), (params) => {
    requireGitRepo(params.projectDir);
    return engine.runtime.evidence.recordFeedback(engine.runtime.getStore(params.projectDir), params);
  });
}
