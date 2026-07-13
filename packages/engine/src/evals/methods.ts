// engine.evals.run — the RPC surface for occasional controlled
// baseline-vs-harness system benchmarks (./run.ts). Mirrors the
// harness/methods.ts + harness/generate.ts /
// orchestrate/methods.ts + orchestrate/orchestrate.ts split: the pipeline
// (runEvals) stays a plain, re-entrant, engine-parametrized function; this
// file is only the thin RPC registration + params validation layer over it.
//
// WIRE-SAFETY CONSTRAINT: `EvalTask` (evals/tasks.ts) carries a `setup`
// FUNCTION — it can never cross a real JSON-RPC wire (main.ts's stdio
// transport serializes params as JSON). `runEvals()` is the real
// engine-internal API and takes fully-constructed `EvalTask[]` objects
// directly (used by this package's own tests, which pass synthEvalTask()
// fixtures). This RPC method's own `tasks` param is therefore restricted, in
// v1, to GOLDEN task descriptors — a commit sha + testCommand, both fully
// JSON-safe — reconstructed server-side via goldenTaskFromCommit.
// `synthEvalTask` (tasks.ts's own doc comment: "used both by this module's
// own tests and by Task 4's report-card tests") is a fixture helper, not a
// product feature, and is deliberately never reachable over this wire.
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { registerMethod } from "../rpc/register.js";
import { goldenTaskFromCommit, type EvalTask } from "./tasks.js";
import { recordRun } from "../runs/ledger.js";
import { runEvals, type EvalsReportCard } from "./run.js";
import { EvalsFrontierSelectionsSchema } from "../engines/selection.js";
import { HARNESS_EXPERIMENT_VARIANTS } from "../runtime/evidence.js";
import { runEvalsExperiment } from "./experiment.js";

const TaskDescriptorSchema = z.object({
  commitSha: z.string().min(1),
  testCommand: z.array(z.string().min(1)).min(1),
});

const RunParamsSchema = z.object({
  projectDir: z.string().min(1),
  tasks: z.array(TaskDescriptorSchema).min(1),
  sampleNote: z.string().optional(),
  frontier: EvalsFrontierSelectionsSchema.optional(),
  experiment: z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
    variant: z.enum(HARNESS_EXPERIMENT_VARIANTS),
    repeatIndex: z.number().int().nonnegative(),
    seed: z.number().int().safe(),
  }).strict().optional(),
  // M7b Task 2: THIS handler is the outermost owner of this runId's
  // lifecycle (register()/deregister() below) -- runEvals's own per-task
  // loop, and any nested engine.orchestrate call it drives per task, only
  // ever get() the SAME runId, so engine.cancel({runId}) reaches whichever
  // task/sub-operation is currently in flight, however deep. See
  // cancel-registry.ts's header comment for the full ownership split.
  runId: z.string().min(1).optional(),
});

const ExperimentParamsSchema = z.object({
  projectDir: z.string().min(1),
  tasks: z.array(TaskDescriptorSchema).min(1),
  trials: z.number().int().min(1).max(100),
  seed: z.string().min(1).max(128),
  experimentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).optional(),
  variant: z.enum(HARNESS_EXPERIMENT_VARIANTS).optional(),
  variants: z.array(z.enum(HARNESS_EXPERIMENT_VARIANTS)).min(1).max(HARNESS_EXPERIMENT_VARIANTS.length).optional(),
  frontier: EvalsFrontierSelectionsSchema.optional(),
  runId: z.string().min(1).optional(),
}).strict();

async function constructTasks(projectDir: string, descriptors: z.infer<typeof TaskDescriptorSchema>[]): Promise<EvalTask[]> {
  try {
    return await Promise.all(
      descriptors.map((descriptor) =>
        goldenTaskFromCommit(projectDir, descriptor.commitSha, descriptor.testCommand)
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `failed to construct golden task: ${message}`);
  }
}

// Sibling-pattern marker class (mirrors OrchestrateService/HarnessService on
// Engine) — holds no state of its own today.
export class EvalsService {}

export function registerEvalsMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.evals.run", RunParamsSchema, async (params) => {
    const runId = params.runId ?? randomUUID();
    const startedAt = Date.now();
    return engine.runKernel.run(
      { runId, projectDir: params.projectDir, kind: "eval", writer: false },
      async (supervisor) => {
      const tasks = await constructTasks(params.projectDir, params.tasks);

      const report: EvalsReportCard = await runEvals(engine, {
        projectDir: params.projectDir,
        tasks,
        sampleNote: params.sampleNote,
        frontier: params.frontier,
        experiment: params.experiment,
        runId,
        supervisor,
      });
      engine.log(
        `evals.run ${params.projectDir}: verdict=${report.verdict} taskCount=${report.taskCount} ` +
          `savingsPct=${report.savingsPct ?? "null"}`,
      );
      recordRun(engine, params.projectDir, {
        v: 1,
        kind: "evals",
        at: new Date().toISOString(),
        taskCount: report.taskCount,
        verdict: report.verdict,
        savingsPct: report.savingsPct,
        cleanSavingsPct: report.cleanSavingsPct,
        qualityHeld: report.qualityHeld,
        qualityGapWithinNoise: report.qualityGapWithinNoise,
        pricingConfidence: report.pricingConfidence,
        measurementFailureCount: report.measurementFailureCount,
        policyViolationCount: report.policyViolationCount,
        perTask: report.perTask.map((t) => ({
          id: t.id,
          baselinePassed: t.baselinePassed,
          harnessPassed: t.harnessPassed,
          harnessOutcome: t.harnessOutcome,
          baselineOutcome: t.baselineOutcome,
        })),
        note: report.note,
        durationMs: Date.now() - startedAt,
        runId,
      });
      return report;
      },
    );
  });

  registerMethod(engine.dispatcher, "engine.evals.experiment", ExperimentParamsSchema, async (params) => {
    const runId = params.runId ?? randomUUID();
    return engine.runKernel.run(
      {
        runId,
        projectDir: params.projectDir,
        kind: "experiment",
        writer: false,
        budget: {
          maxModelCalls: 10_000,
          maxToolCalls: 20_000,
          deadlineAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        },
      },
      async (supervisor) => {
        const tasks = await constructTasks(params.projectDir, params.tasks);
        return runEvalsExperiment(engine, {
          projectDir: params.projectDir,
          tasks,
          trials: params.trials,
          seed: params.seed,
          experimentId: params.experimentId,
          variant: params.variant,
          variants: params.variants,
          frontier: params.frontier,
          runId,
          supervisor,
        });
      },
    );
  });
}
