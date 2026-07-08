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
import { HarnessValidationError } from "../harness/store.js";
import { RpcMethodError } from "../rpc/errors.js";
import { requireGitRepo } from "../rpc/guards.js";
import { registerMethod } from "../rpc/register.js";
import { recordRun, type RunRecord } from "../runs/ledger.js";
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

// Task 3: derived from RunRecordSchema's own "orchestrate" variant
// (runs/ledger.ts) rather than a hand-written union, so this can never drift
// from what the ledger actually accepts.
type OrchestrateErrorCategory = NonNullable<Extract<RunRecord, { kind: "orchestrate" }>["errorCategory"]>;

// Task 3: maps a thrown engine.orchestrate error to a coarse, CONTENT-FREE
// category for the ledger's error record — the error's own MESSAGE never
// reaches the ledger (runs/ledger.ts's own content-line rule), only this
// enum. Checked in the brief's own priority order:
//   1. "no harness" is the literal, never-changing message orchestrate.ts's
//      own guard throws when no harness has been generated yet.
//   2. A harness that IS present but corrupt/hand-edited surfaces either as
//      a HarnessValidationError orchestrate.ts re-wraps into a plain
//      RpcMethodError (carrying the original `issues` array in `data` — by
//      the time it reaches here there is no `cause` chain to walk, so that
//      carried `issues` array is the practical "this wraps a
//      HarnessValidationError" signal) or as orchestrate.ts's own literal
//      "harness failed structural validation" message for a bundle that
//      parses but fails schema validation.
//   3. A cancellation carries `cancelled: true` in `data` (both of
//      orchestrate.ts's own cancellation throws set it) or, defensively, the
//      word "cancelled" in the message (RunCancelledError's own "run
//      cancelled").
//   4. Anything else is "unknown" — a real, unclassified infra failure
//      (unconfigured provider, adapter throw, etc.).
function categorizeOrchestrateError(err: unknown): OrchestrateErrorCategory {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("no harness")) return "no-harness";

  const data = err instanceof RpcMethodError ? err.data : undefined;
  const hasIssues = typeof data === "object" && data !== null && "issues" in data;
  if (err instanceof HarnessValidationError || hasIssues || message.includes("structural validation")) {
    return "load-failed";
  }

  const dataCancelled =
    typeof data === "object" &&
    data !== null &&
    "cancelled" in data &&
    (data as { cancelled?: unknown }).cancelled === true;
  if (dataCancelled || message.includes("cancelled")) return "cancelled";

  return "unknown";
}

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
    const runId = params.runId;
    if (runId !== undefined) engine.cancelRegistry.register(runId);
    // Task 3 (run ledger write point): THIS handler is the run ledger's ONLY
    // coupling to engine.orchestrate — evals/run.ts's runHarnessTask calls
    // orchestrate() DIRECTLY (see that call site's own doc comment,
    // evals/run.ts ~line 634), bypassing this RPC handler entirely, so
    // eval-internal harness runs are deliberately NEVER written to the
    // ledger; only a real, user (or client)-initiated engine.orchestrate call
    // is. `startedAt` is captured before the pipeline runs so `durationMs` on
    // both the success and error records below measures this WHOLE call, not
    // just the part orchestrate()'s own internals might track.
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
        // Content-line rule (runs/ledger.ts's own header comment): only the
        // verdict decision + reasons ever reach the ledger — `a.summary`
        // (this attempt's own worker/frontier prose) is deliberately never
        // read here.
        reviews: result.attempts.flatMap((a) =>
          a.verdict ? [{ decision: a.verdict.decision, reasons: a.verdict.reasons }] : [],
        ),
        contextBranch: result.contextBranch,
        ...(result.toolCallCounts !== undefined ? { toolCallCounts: result.toolCallCounts } : {}),
        cost: result.cost,
        durationMs: Date.now() - startedAt,
        ...(params.runId !== undefined ? { runId: params.runId } : {}),
      });
      return result;
    } catch (err) {
      // Error records deliberately carry NO task/agent/model detail this
      // handler doesn't actually know (orchestrate() threw before — or
      // without ever — resolving routing) — the "unknown" sentinels below
      // mirror the brief's own contract rather than guessing.
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
        errorCategory: categorizeOrchestrateError(err),
        ...(params.runId !== undefined ? { runId: params.runId } : {}),
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
