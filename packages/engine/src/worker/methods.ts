// engine.worker.run + engine.worker.cleanup: the RPC surface that composes
// WorktreeManager (isolation), createWorkerTools (path-scoped bash/read/
// write/edit), and runWorkerLoop (the AI SDK v7 multi-step tool loop) into
// one metered, reviewable worker run. Mirrors the WikiService/HarnessService
// sibling-service pattern on Engine: WorkerService itself holds only the
// per-project WorktreeManager cache (keyed by the base repo's realpath via
// rpc/guards.js's shared resolveProjectKey) — everything else (the models
// registry, the cost meter, the notify sink) is read directly off `engine`
// by the RPC handlers below, the same way engine.frontier.* reads
// engine.models.meter without owning it.
//
// Concurrency (documented, not enforced here): engine.worker.run does NOT
// coalesce and is NOT capped at the engine layer — unlike
// WikiService.build/HarnessService.generate (which dedupe concurrent calls
// for the SAME project onto one in-flight promise), every worker.run call
// creates its OWN new worktree (a fresh randomUUID() taskId), so there is
// nothing to coalesce. Nothing here bounds how many worker.run calls can run
// at once for one project or across the whole engine — per the M2 decision,
// the CLIENT owns bounding fan-out (M5b's orchestrator is the intended
// bounding layer).
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { estimateCostUsd, lookupPricing } from "../models/pricing.js";
import { RpcMethodError } from "../rpc/errors.js";
import { providerKindOf, requireGitRepo, resolveProjectKey } from "../rpc/guards.js";
import { registerMethod } from "../rpc/register.js";
import { runWorkerLoop } from "./loop.js";
import { createWorkerTools } from "./tools.js";
import { WorktreeManager, type Worktree } from "./worktree.js";

const RunParamsSchema = z.object({
  projectDir: z.string().min(1),
  task: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  wikiDigest: z.string().optional(),
  maxSteps: z.number().int().min(1).max(100).optional(),
  bashTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  // Whole-run deadline for the model loop (NOT a per-tool-call budget --
  // that's bashTimeoutMs above). Ceiling is 30 minutes, well above
  // engine.models.complete's own 10-minute timeoutMs ceiling: a worker run
  // is a full multi-step tool loop (up to maxSteps model calls), not one
  // completion, so it legitimately needs more room. Mirrors the M3 pattern
  // (models/methods.ts's own timeoutMs -> AbortSignal.timeout()).
  timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
});

const DEFAULT_RUN_TIMEOUT_MS = 600_000;

const CleanupParamsSchema = z.object({
  projectDir: z.string().min(1),
  worktreePath: z.string().min(1),
  deleteBranch: z.boolean().optional(),
});

// Holds one WorktreeManager per base repo, cached by realpath so distinct
// spellings of the same project share one manager (and its prune()), PLUS
// the set of in-flight worker-run AbortControllers (see beginRun/endRun/
// close below) — the one piece of run-lifecycle state that has to live
// somewhere Engine.close() can reach without engine.worker.run's handler
// needing to expose anything beyond the RPC surface itself.
export class WorkerService {
  #managers = new Map<string, WorktreeManager>();
  #pruned = new Set<string>();
  #inFlight = new Set<AbortController>();

  // Lazily creates (and caches) the WorktreeManager for a project, running
  // WorktreeManager.prune() once per manager the first time it's needed —
  // the task brief's "startup WorktreeManager.prune-on-first-use is fine" —
  // rather than at Engine construction time, since Engine has no project
  // path to prune against until the first worker.run/cleanup call arrives.
  async getManager(projectDir: string): Promise<WorktreeManager> {
    const key = resolveProjectKey(projectDir);
    let manager = this.#managers.get(key);
    if (manager === undefined) {
      manager = new WorktreeManager(projectDir);
      this.#managers.set(key, manager);
    }
    if (!this.#pruned.has(key)) {
      this.#pruned.add(key);
      await manager.prune();
    }
    return manager;
  }

  // Registers a run's own AbortController as in-flight, right before
  // engine.worker.run starts its runWorkerLoop() call, so close() below has
  // something to abort if the engine shuts down mid-run. Paired with
  // endRun() in that handler's `finally` — every beginRun() MUST have a
  // matching endRun(), successful run or not, or this set would leak
  // controllers for the life of the process.
  beginRun(controller: AbortController): void {
    this.#inFlight.add(controller);
  }

  endRun(controller: AbortController): void {
    this.#inFlight.delete(controller);
  }

  // Aborts every in-flight worker run so Engine.close() can never hang
  // behind a wedged one (a stuck model call has no other way to be
  // interrupted). Deliberately does NOT wait for those runs to actually
  // settle — each run's own try/finally in engine.worker.run reacts to the
  // abort and does its own cleanup (including calling endRun above); this
  // method's only job is to fire the signal.
  async close(): Promise<void> {
    for (const controller of this.#inFlight) {
      controller.abort(new Error("worker run aborted"));
    }
  }
}

export function registerWorkerMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.worker.run", RunParamsSchema, async (params) => {
    // Flow: git guard -> resolve model -> worktree -> tools -> loop -> diff
    // -> meter -> return.
    //
    // The git guard, model resolution, and worktree creation are wrapped in
    // their own try/catch below: `requireGitRepo`/`registry.resolve`
    // already throw a properly-coded `RpcMethodError` (SERVER_ERROR /
    // INVALID_PARAMS) and pass through unchanged, but `getManager`/
    // `manager.create` can fail with a raw `Error` (e.g. a `git worktree
    // add` failure) that would otherwise fall through to the dispatcher's
    // generic INTERNAL_ERROR (-32603) -- inconsistent with every other
    // failure mode of this method, which is SERVER_ERROR (-32000). No
    // worktree data is attached on this path (unlike the main try/catch
    // below): by construction nothing here can fail after a worktree
    // exists.
    let languageModel: ReturnType<typeof engine.models.registry.resolve>;
    let kind: string;
    let manager: WorktreeManager;
    let taskId: string;
    let worktree: Worktree;
    try {
      requireGitRepo(params.projectDir);

      // Resolved BEFORE the worktree is created: an unconfigured provider
      // (or any other resolve()-time failure) must never leave an orphaned
      // worktree behind.
      languageModel = engine.models.registry.resolve(params.providerId, params.model);
      kind = providerKindOf(engine.models.registry, params.providerId);

      manager = await engine.worker.getManager(params.projectDir);
      taskId = randomUUID();
      worktree = await manager.create(taskId);
    } catch (err) {
      if (err instanceof RpcMethodError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `worker setup failed: ${message}`);
    }

    const tools = createWorkerTools({
      root: worktree.path,
      bashTimeoutMs: params.bashTimeoutMs,
      // Tool events are structured, already-truncated observability
      // metadata (see tools.ts's own `detail()`) — never prompt/file/
      // command content.
      onToolEvent: (e) => {
        engine.notify("worker.progress", { taskId, kind: "tool", tool: e.tool, detail: e.detail });
      },
    });

    // Two independent abort sources, combined into the ONE signal
    // runWorkerLoop actually gets: `timeoutSignal` fires on its own after
    // timeoutMs (a wedged model call that never errors on its own),
    // `controller` is fired by WorkerService.close() (Engine.close() mid-run
    // — see WorkerService.beginRun/endRun/close). AbortSignal.any is stable
    // since Node 20.3 (this repo's floor is >=22) and confirmed to typecheck
    // against this repo's tsconfig (no DOM lib override needed) — no manual
    // fallback combinator is carried here.
    //
    // Kept as separate named signals (rather than only ever consulting the
    // combined one) so the catch block below can ask "was it timeoutSignal
    // or controller that actually fired?" by checking each source's OWN
    // `.aborted` flag directly — deterministic regardless of how the AI SDK
    // or a given provider adapter happens to wrap/rewrap the thrown error
    // (mirrors models/methods.ts's isTimeoutError doc comment on why that
    // module has to parse error shape instead: it only has ONE signal to
    // reason about, we have two known sources here).
    const timeoutMs = params.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const controller = new AbortController();
    engine.worker.beginRun(controller);

    try {
      const loopResult = await runWorkerLoop({
        model: languageModel,
        task: params.task,
        wikiDigest: params.wikiDigest,
        tools,
        maxSteps: params.maxSteps,
        abortSignal: AbortSignal.any([timeoutSignal, controller.signal]),
        // Step progress is likewise structured + truncated (loop.ts's own
        // ON_STEP_TEXT_TRUNCATE_CHARS) — never the model's full raw output.
        onStep: (s) => {
          engine.notify("worker.progress", {
            taskId,
            kind: "step",
            step: s.step,
            toolCalls: s.toolCalls,
            text: s.text,
          });
        },
      });

      const diff = await manager.diff(worktree);
      const diffStat = await manager.diffStat(worktree);

      const pricing = lookupPricing(kind, params.model);
      const costUsd = pricing !== null ? estimateCostUsd(pricing, loopResult.usage) : null;

      // Metered under the PROVIDER kind (e.g. "deepseek", "zai"), NOT a
      // synthetic "worker/..." kind — pricing.ts's table is keyed by provider
      // kind, and engine.models.usage's byModel breakdown needs to line up
      // with engine.models.complete's own records for the same provider/model
      // so totals stay comparable across call sites. `source: "worker"`
      // (M5b Task 1) is what makes worker vs engine.models.complete vs
      // engine.frontier.* records distinguishable in the ledger — see
      // engine.models.usage's bySource breakdown.
      engine.models.meter.record({
        providerId: params.providerId,
        kind,
        model: params.model,
        usage: loopResult.usage,
        costUsd,
        at: Date.now(),
        source: "worker",
      });

      engine.log(
        `worker.run ${taskId} ${kind}/${params.model}: ${loopResult.steps} steps, ${loopResult.toolCallCount} tool calls`,
      );

      return {
        diff,
        diffStat,
        summary: loopResult.summary,
        steps: loopResult.steps,
        toolCallCount: loopResult.toolCallCount,
        usage: loopResult.usage,
        costUsd,
        worktree: { path: worktree.path, branch: worktree.branch },
      };
    } catch (err) {
      // The worktree (and any partial edits already on disk) is
      // DELIBERATELY left in place on failure — see worktree.ts's own
      // class-level doc comment ("never call remove() from a failure
      // path"). The path is carried in `data` so the caller can inspect, or
      // manually clean up the partial work via engine.worker.cleanup.
      const rawMessage = err instanceof Error ? err.message : String(err);
      // Distinguishes WHY the run was cut short, checking each abort
      // source's own `.aborted` flag (set the instant that signal fires,
      // independent of whatever the AI SDK/provider adapter did to the
      // thrown error) rather than parsing `err`'s shape — see the abort
      // signal setup above for why that's safe to do here. `timeoutSignal`
      // is checked first: if BOTH happened to be aborted (a close raced a
      // timeout), "timed out" is the more informative half of that story.
      const message = timeoutSignal.aborted
        ? `worker run timed out after ${timeoutMs}ms: ${rawMessage}`
        : controller.signal.aborted
          ? `worker run aborted: ${rawMessage}`
          : rawMessage;
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `worker run failed: ${message}`, {
        worktree: { path: worktree.path, branch: worktree.branch },
      });
    } finally {
      // Matches beginRun() above — every registered controller must be
      // unregistered once this run is done, success or failure, or
      // WorkerService's in-flight set would leak controllers for the life
      // of the process (and re-abort an already-finished run's controller
      // on the next engine.close()).
      engine.worker.endRun(controller);
    }
  });

  registerMethod(engine.dispatcher, "engine.worker.cleanup", CleanupParamsSchema, async (params) => {
    // Same git guard as engine.worker.run: without it, a non-git
    // projectDir reaches `getManager` -> `WorktreeManager.prune()` -> a
    // failing `git worktree prune` call, whose raw `Error` falls through to
    // the dispatcher's generic INTERNAL_ERROR (-32603) instead of this
    // method's SERVER_ERROR (-32000) contract.
    requireGitRepo(params.projectDir);

    const manager = await engine.worker.getManager(params.projectDir);
    const resolvedTarget = path.resolve(params.worktreePath);
    const worktrees = await manager.list();
    const found = worktrees.find((w) => path.resolve(w.path) === resolvedTarget);
    if (found === undefined) {
      return { removed: false };
    }
    await manager.remove(found, { deleteBranch: params.deleteBranch });
    engine.log(`worker.cleanup ${found.id} removed`);
    return { removed: true };
  });
}
