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
// (100ms..1h) — reviewTimeoutMs is reused for both the review turn's and the
// escalation turn's own per-attempt timeoutMs (see orchestrate.ts).
const REVIEW_TIMEOUT_MIN_MS = 100;
const REVIEW_TIMEOUT_MAX_MS = 3_600_000;

const OrchestrateParamsSchema = z.object({
  projectDir: z.string().min(1),
  task: z.string().min(1),
  maxWorkerAttempts: z.number().int().min(1).max(3).optional(),
  workerTimeoutMs: z.number().int().min(WORKER_TIMEOUT_MIN_MS).max(WORKER_TIMEOUT_MAX_MS).optional(),
  reviewTimeoutMs: z.number().int().min(REVIEW_TIMEOUT_MIN_MS).max(REVIEW_TIMEOUT_MAX_MS).optional(),
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
    const result: OrchestrateResult = await orchestrate(engine, params as OrchestrateParams);
    engine.log(
      `orchestrate ${params.projectDir}: outcome=${result.outcome} attempts=${result.attempts.length}`,
    );
    return result;
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
