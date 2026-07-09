// engine.orchestrate + engine.orchestrate.apply: the RPC surface for the
// M5b Task 4 pipeline (./orchestrate.ts). Mirrors the harness/methods.ts +
// harness/generate.ts split: the pipeline function stays a plain,
// re-entrant, engine-parametrized function; this file is only the thin RPC
// registration + params validation layer over it.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { requireGitRepo } from "../rpc/guards.js";
import { registerMethod } from "../rpc/register.js";
import { recordRun } from "../runs/ledger.js";
import { orchestrate, type OrchestrateParams, type OrchestrateResult } from "./orchestrate.js";

const execFileAsync = promisify(execFile);

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
  // M7b Task 2: client-supplied (or evals.run-forwarded) run identifier —
  // OPTIONAL, so an omitted runId keeps this run entirely un-cancellable
  // (no engine.cancel({runId}) call could ever reach it) without changing
  // any other behavior. THIS handler is the ONLY place that ever
  // register()s/deregister()s the AbortController this runId maps to (see
  // cancel-registry.ts's header comment) — every nested call
  // (orchestrate()'s own pipeline, engine.worker.run) only ever get()s it.
  runId: z.string().min(1).optional(),
});

const ApplyParamsSchema = z.object({
  projectDir: z.string().min(1),
  diff: z.string(),
});

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
    const runId = params.runId;
    if (runId !== undefined) engine.cancelRegistry.register(runId);
    const startedAt = Date.now();
    try {
      const result: OrchestrateResult = await orchestrate(engine, params as OrchestrateParams);
      engine.log(
        `orchestrate ${params.projectDir}: outcome=${result.outcome} attempts=${result.attempts.length}`,
      );
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
          a.verdict ? [{ decision: a.verdict.decision, reasons: a.verdict.reasons }] : [],
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
        ...(runId !== undefined ? { runId } : {}),
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
        ...(runId !== undefined ? { runId } : {}),
      });
      throw err;
    } finally {
      if (runId !== undefined) engine.cancelRegistry.deregister(runId);
    }
  });

  registerMethod(engine.dispatcher, "engine.orchestrate.apply", ApplyParamsSchema, async ({ projectDir, diff }) => {
    requireGitRepo(projectDir);

    if (diff.trim().length === 0) {
      // Nothing to apply — a no-op success rather than handing `git apply`
      // an empty patch file (behavior across git versions for a truly empty
      // patch is not worth relying on).
      return { applied: true };
    }

    // Written to a real tmp file (not piped over stdin) so this stays a
    // plain execFile call with no child-process stdin-stream handling to
    // get right — the diff can be arbitrarily large (worker diffs already
    // use a 64MB execFile buffer elsewhere, worktree.ts), and a file avoids
    // any pipe-backpressure edge case entirely.
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "of-orchestrate-apply-"));
    const patchPath = path.join(tmpDir, "change.patch");
    try {
      await writeFile(patchPath, diff, "utf8");
      // --3way is more robust to drift than a plain apply (falls back to a
      // three-way merge using the blobs already in the repo's object store
      // when a plain context-based apply would fail) — this call NEVER
      // commits and NEVER touches the index beyond what --3way itself does
      // to resolve conflicts; the working tree is left for the caller to
      // review/commit (M7's approval gate lives above this method, per the
      // task brief).
      await execFileAsync("git", ["-C", projectDir, "apply", "--3way", patchPath]);
      engine.log(`orchestrate.apply ${projectDir}: applied`);
      return { applied: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `git apply failed: ${message}`);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
}
