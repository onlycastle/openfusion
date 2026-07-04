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
});

// Sibling-pattern marker class (mirrors OrchestrateService/HarnessService on
// Engine) — holds no state of its own today.
export class EvalsService {}

export function registerEvalsMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.evals.run", RunParamsSchema, async (params) => {
    let tasks: EvalTask[];
    try {
      tasks = await Promise.all(
        params.tasks.map((d) => goldenTaskFromCommit(params.projectDir, d.commitSha, d.testCommand)),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `failed to construct golden task: ${message}`);
    }

    const report: EvalsReportCard = await runEvals(engine, {
      projectDir: params.projectDir,
      tasks,
      sampleNote: params.sampleNote,
    });
    engine.log(
      `evals.run ${params.projectDir}: verdict=${report.verdict} taskCount=${report.taskCount} ` +
        `savingsPct=${report.savingsPct ?? "null"}`,
    );
    return report;
  });
}
