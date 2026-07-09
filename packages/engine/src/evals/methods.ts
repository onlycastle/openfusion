// engine.evals.run — the RPC surface for the M6 baseline-vs-harness report
// card (./run.ts). Mirrors the harness/methods.ts + harness/generate.ts /
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
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { registerMethod } from "../rpc/register.js";
import { recordRun } from "../runs/ledger.js";
import { goldenTaskFromCommit, type EvalTask } from "./tasks.js";
import { runEvals, type EvalsReportCard } from "./run.js";

const TaskDescriptorSchema = z.object({
  commitSha: z.string().min(1),
  testCommand: z.array(z.string().min(1)).min(1),
});

const RunParamsSchema = z.object({
  projectDir: z.string().min(1),
  tasks: z.array(TaskDescriptorSchema).min(1),
  sampleNote: z.string().optional(),
  // M7b Task 2: THIS handler is the outermost owner of this runId's
  // lifecycle (register()/deregister() below) -- runEvals's own per-task
  // loop, and any nested engine.orchestrate call it drives per task, only
  // ever get() the SAME runId, so engine.cancel({runId}) reaches whichever
  // task/sub-operation is currently in flight, however deep. See
  // cancel-registry.ts's header comment for the full ownership split.
  runId: z.string().min(1).optional(),
});

// Sibling-pattern marker class (mirrors OrchestrateService/HarnessService on
// Engine) — holds no state of its own today.
export class EvalsService {}

export function registerEvalsMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.evals.run", RunParamsSchema, async (params) => {
    const runId = params.runId;
    if (runId !== undefined) engine.cancelRegistry.register(runId);
    try {
      let tasks: EvalTask[];
      try {
        tasks = await Promise.all(
          params.tasks.map((d) => goldenTaskFromCommit(params.projectDir, d.commitSha, d.testCommand)),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `failed to construct golden task: ${message}`);
      }

      // Task 4 (run ledger write point): captured immediately before
      // runEvals itself runs (the brief's own placement) -- durationMs below
      // measures this WHOLE eval run, mirroring orchestrate/methods.ts's own
      // startedAt capture in front of its own pipeline call.
      const startedAt = Date.now();
      const report: EvalsReportCard = await runEvals(engine, {
        projectDir: params.projectDir,
        tasks,
        sampleNote: params.sampleNote,
        runId: params.runId,
      });
      engine.log(
        `evals.run ${params.projectDir}: verdict=${report.verdict} taskCount=${report.taskCount} ` +
          `savingsPct=${report.savingsPct ?? "null"}`,
      );

      // Recorded on SUCCESS only -- unlike engine.orchestrate's own write
      // point (orchestrate/methods.ts), this handler deliberately mirrors NO
      // error-path record. A thrown runEvals (a guard failure, a genuine
      // engine.cancel-driven cancellation — see run.ts's own cancelled-error
      // wrapping — or an unclassified infra crash) produced no report card
      // at all: there is no verdict, no taskCount, no perTask outcomes, no
      // pricingConfidence — nothing trustworthy this handler could summarize
      // the way engine.orchestrate's own error record summarizes a thrown
      // orchestrate() via a coarse, content-free errorCategory. AWAITED for
      // the same settled-before-response reason as every other ledger write
      // point (recordRun's own doc comment): a client calling
      // engine.runs.list right after this RPC must see the eval it just ran.
      await recordRun(engine, params.projectDir, {
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
        // Per-task USD deliberately dropped (spec §3) -- only the pass/fail
        // + outcome shape a weakness-mining pass would need, never the
        // dollar figures.
        perTask: report.perTask.map(({ id, baselinePassed, harnessPassed, harnessOutcome, baselineOutcome }) => ({
          id,
          baselinePassed,
          harnessPassed,
          harnessOutcome,
          baselineOutcome,
        })),
        note: report.note,
        durationMs: Date.now() - startedAt,
        ...(params.runId !== undefined ? { runId: params.runId } : {}),
      });

      return report;
    } finally {
      if (runId !== undefined) engine.cancelRegistry.deregister(runId);
    }
  });
}
