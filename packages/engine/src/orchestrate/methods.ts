// engine.orchestrate + engine.orchestrate.apply: the RPC surface for the
// M5b Task 4 pipeline (./orchestrate.ts). Mirrors the harness/methods.ts +
// harness/generate.ts split: the pipeline function stays a plain,
// re-entrant, engine-parametrized function; this file is only the thin RPC
// registration + params validation layer over it.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ApprovalGrantSchema,
  RpcErrorCodes,
  TaskContractSchema,
} from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { requireGitRepo } from "../rpc/guards.js";
import { registerMethod } from "../rpc/register.js";
import { recordRun } from "../runs/ledger.js";
import type { OrchestrateParams, OrchestrateResult } from "./orchestrate.js";
import { OrchestrateFrontierSelectionsSchema } from "../engines/selection.js";
import { applyGitPatchFromMemory } from "../worker/worktree.js";

// Bounds mirror worker/methods.ts's own RunParamsSchema.timeoutMs (1s..30m)
// — workerTimeoutMs is forwarded straight through to engine.worker.run's own
// `timeoutMs` param, so validating it here with the SAME bounds fails fast
// with a clear engine.orchestrate-scoped error instead of surfacing as a
// nested engine.worker.run INVALID_PARAMS a caller has to dig for.
const WORKER_TIMEOUT_MIN_MS = 1_000;
const WORKER_TIMEOUT_MAX_MS = 1_800_000;
// Bounds mirror engines/methods.ts's own frontier prompt timeout ceiling
// (100ms..1h) — an EXPLICIT reviewTimeoutMs is reused for both the review
// turn's and the escalation turn's own per-attempt timeoutMs (see
// orchestrate.ts). Both workerTimeoutMs and reviewTimeoutMs stay OPTIONAL
// here — a caller may omit either — because M6 Task 1 review round 1 (Fix
// 1) moved the actual DEFAULTING into orchestrate.ts itself
// (DEFAULT_REVIEW_TIMEOUT_MS / DEFAULT_ESCALATE_TIMEOUT_MS, applied via
// `params.reviewTimeoutMs ?? DEFAULT_...`): this schema's bounds only ever
// constrain an EXPLICIT value's range, never fill in an omitted one, so an
// omitted param is never left unbounded once it reaches orchestrate().
const REVIEW_TIMEOUT_MIN_MS = 100;
const REVIEW_TIMEOUT_MAX_MS = 3_600_000;

const OrchestrateParamsSchema = z.object({
  projectDir: z.string().min(1),
  task: z.string().min(1),
  maxWorkerAttempts: z.number().int().min(1).max(3).optional(),
  workerTimeoutMs: z.number().int().min(WORKER_TIMEOUT_MIN_MS).max(WORKER_TIMEOUT_MAX_MS).optional(),
  reviewTimeoutMs: z.number().int().min(REVIEW_TIMEOUT_MIN_MS).max(REVIEW_TIMEOUT_MAX_MS).optional(),
  frontier: OrchestrateFrontierSelectionsSchema.optional(),
  taskContract: TaskContractSchema.optional(),
  // M7b Task 2: client-supplied (or evals.run-forwarded) run identifier —
  // OPTIONAL, so an omitted runId keeps this run entirely un-cancellable
  // (no engine.cancel({runId}) call could ever reach it) without changing
  // any other behavior. THIS handler is the ONLY place that ever
  // register()s/deregister()s the AbortController this runId maps to (see
  // cancel-registry.ts's header comment) — every nested call
  // (orchestrate()'s own pipeline, engine.worker.run) only ever get()s it.
  runId: z.string().min(1).optional(),
});

const CandidateApplyParamsSchema = z.object({
  projectDir: z.string().min(1),
  candidateId: z.string().min(1),
  approvalGrant: ApprovalGrantSchema,
  runId: z.string().min(1).optional(),
}).strict();

const UnsafeLegacyApplyParamsSchema = z.object({
  projectDir: z.string().min(1),
  diff: z.string(),
  // Links the apply observation to the originating orchestration run without
  // storing the task or diff in the metadata ledger.
  runId: z.string().min(1).optional(),
}).strict();

const ApplyParamsSchema = z.union([CandidateApplyParamsSchema, UnsafeLegacyApplyParamsSchema]);

// Sibling-pattern marker class (mirrors ModelsService/HarnessService on
// Engine) — holds no state of its own today. engine.orchestrate does not
// coalesce concurrent calls for the same project the way
// engine.harness.generate does (two different tasks running concurrently
// against the same project are legitimate and independent, each with its
// own worktree — matching engine.worker.run's own non-coalescing stance);
// this class exists purely so the pipeline has a documented home on Engine
// for any future run-lifecycle state (e.g. cancellation) to live in.
export class OrchestrateService {}

export function registerOrchestrateMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.orchestrate", OrchestrateParamsSchema, async (params) => {
    requireGitRepo(params.projectDir);
    // M7b Task 2: THIS handler is the outermost owner of `runId`'s
    // lifecycle — register() right before the run starts, deregister() in
    // `finally` regardless of outcome (success, failure, or cancellation),
    // so CancelRegistry never leaks an entry for a run that has already
    // ended. orchestrate() itself (and, for a nested evals.run-driven call,
    // engine.worker.run's own handler) only ever get()s this SAME runId —
    // see cancel-registry.ts's header comment for the full ownership split.
    //
    // Run-ledger write point (spec 2026-07-08): records only RPC-layer
    // orchestrate calls — evals/run.ts's direct orchestrate() calls bypass
    // this handler and are captured under kind:"evals" instead.
    const runId = params.runId ?? randomUUID();
    const startedAt = Date.now();
    return engine.runKernel.run(
      { runId, projectDir: params.projectDir, kind: "orchestrate", writer: true },
      async (supervisor) => {
      try {
      const runtimeOutcome = await engine.runtime.runOrchestrate(
        engine,
        { ...(params as OrchestrateParams), runId },
        supervisor,
      );
      if (!("result" in runtimeOutcome)) {
        throw new Error("blocking orchestration unexpectedly paused for approval");
      }
      const result: OrchestrateResult = runtimeOutcome.result;
      engine.log(`orchestrate: outcome=${result.outcome} attempts=${result.attempts.length}`);
      recordRun(engine, params.projectDir, {
        v: 1,
        kind: "orchestrate",
        at: new Date().toISOString(),
        taskClass: result.taskClass,
        agent: result.agent,
        workerModel: result.resolution === "frontier" ? "frontier" : result.resolution.model,
        attempts: result.attempts.length,
        outcome: result.outcome,
        escalated: result.outcome === "escalated",
        reviews: result.attempts.flatMap((a) =>
          a.verdict ? [{ decision: a.verdict.decision, reasonCount: a.verdict.reasons.length }] : [],
        ),
        contextBranch: result.contextBranch,
        ...(result.toolCallCounts !== undefined ? { toolCallCounts: result.toolCallCounts } : {}),
        ...(result.toolErrorCounts !== undefined ? { toolErrorCounts: result.toolErrorCounts } : {}),
        ...(result.editFailCount !== undefined ? { editFailCount: result.editFailCount } : {}),
        ...(result.family !== undefined ? { family: result.family } : {}),
        ...(result.dialectPack !== undefined ? { dialectPack: result.dialectPack } : {}),
        ...(result.routeId !== undefined ? { routeId: result.routeId } : {}),
        cost: {
          workerUsd: result.cost.workerUsd,
          reviewUsd: result.cost.reviewUsd,
          escalateUsd: result.cost.escalateUsd,
          totalUsd: result.cost.totalUsd,
        },
        durationMs: Date.now() - startedAt,
        runId,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const data =
        err instanceof Error && "data" in err
          ? (err as { data?: { cancelled?: boolean } }).data
          : undefined;
      const errorCategory =
        data?.cancelled === true || /cancelled/i.test(message)
          ? ("cancelled" as const)
          : /no harness/i.test(message)
            ? ("no-harness" as const)
            : /structural validation|load-failed|HarnessValidation/i.test(message)
              ? ("load-failed" as const)
              : ("unknown" as const);
      recordRun(engine, params.projectDir, {
        v: 1,
        kind: "orchestrate",
        at: new Date().toISOString(),
        taskClass: "unknown",
        agent: "unknown",
        workerModel: "unknown",
        attempts: 0,
        outcome: "error",
        escalated: false,
        reviews: [],
        contextBranch: "none",
        cost: { workerUsd: null, reviewUsd: null, escalateUsd: null, totalUsd: null },
        durationMs: Date.now() - startedAt,
        errorCategory,
        runId,
      });
      throw err;
      }
    });
  });

  registerMethod(engine.dispatcher, "engine.orchestrate.apply", ApplyParamsSchema, async (params) => {
    const { projectDir, runId } = params;
    requireGitRepo(projectDir);
    const startedAt = Date.now();
    const effectiveRunId = runId ?? randomUUID();
    return engine.runKernel.run(
      { runId: effectiveRunId, projectDir, kind: "apply", writer: true },
      async () => {
    if ("candidateId" in params) {
      try {
        await engine.candidates.apply(
          params.candidateId,
          params.approvalGrant,
          projectDir,
        );
        recordRun(engine, projectDir, {
          v: 1,
          kind: "apply",
          at: new Date().toISOString(),
          outcome: "succeeded",
          durationMs: Date.now() - startedAt,
          runId: effectiveRunId,
        });
        return { applied: true, candidateId: params.candidateId };
      } catch (err) {
        recordRun(engine, projectDir, {
          v: 1,
          kind: "apply",
          at: new Date().toISOString(),
          outcome: "failed",
          errorCategory: "git-apply-failed",
          durationMs: Date.now() - startedAt,
          runId: effectiveRunId,
        });
        const message = err instanceof Error ? err.message : String(err);
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `candidate apply failed: ${message}`);
      }
    }

    const unsafeLegacyEnabled =
      process.env.OPENFUSION_UNSAFE_RAW_DIFF_APPLY === "1" &&
      process.env.NODE_ENV !== "production" &&
      process.env.OPENFUSION_PACKAGED_BUILD !== "1";
    if (!unsafeLegacyEnabled) {
      throw new RpcMethodError(
        RpcErrorCodes.INVALID_PARAMS,
        "raw-diff Apply is disabled; use candidateId plus approvalGrant",
      );
    }
    const diff = params.diff;

    if (diff.trim().length === 0) {
      // Nothing to apply — a no-op success rather than handing `git apply`
      // an empty patch file (behavior across git versions for a truly empty
      // patch is not worth relying on).
      recordRun(engine, projectDir, {
        v: 1,
        kind: "apply",
        at: new Date().toISOString(),
        outcome: "succeeded",
        errorCategory: "empty-diff",
        durationMs: Date.now() - startedAt,
        runId: effectiveRunId,
      });
      return { applied: true };
    }

    try {
      // --3way is more robust to drift than a plain apply (falls back to a
      // three-way merge using the blobs already in the repo's object store
      // when a plain context-based apply would fail) — this call NEVER
      // commits and NEVER touches the index beyond what --3way itself does
      // to resolve conflicts; the working tree is left for the caller to
      // review/commit (M7's approval gate lives above this method, per the
      // task brief).
      await applyGitPatchFromMemory(projectDir, Buffer.from(diff, "utf8"), ["--3way"]);
      engine.log("orchestrate.apply: applied");
      recordRun(engine, projectDir, {
        v: 1,
        kind: "apply",
        at: new Date().toISOString(),
        outcome: "succeeded",
        durationMs: Date.now() - startedAt,
        runId: effectiveRunId,
      });
      return { applied: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordRun(engine, projectDir, {
        v: 1,
        kind: "apply",
        at: new Date().toISOString(),
        outcome: "failed",
        errorCategory: "git-apply-failed",
        durationMs: Date.now() - startedAt,
        runId: effectiveRunId,
      });
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `git apply failed: ${message}`);
    }
    });
  });
}
