// engine.worker.run + engine.worker.cleanup: the RPC surface that composes
// WorktreeManager (isolation), createWorkerTools (path-scoped bash/read/
// write/edit), and runWorkerLoop (the AI SDK v7 multi-step tool loop) into
// one metered, reviewable worker run. Mirrors the WikiService/HarnessService
// sibling-service pattern on Engine: WorkerService itself holds only the
// per-project WorktreeManager cache (keyed by the base repo's realpath, like
// WikiService/HarnessService's own keyFor) — everything else (the models
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
import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { estimateCostUsd, lookupPricing } from "../models/pricing.js";
import { RpcMethodError } from "../rpc/errors.js";
import { registerMethod } from "../rpc/register.js";
import { getHeadSha } from "../wiki/indexer.js";
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
});

const CleanupParamsSchema = z.object({
  projectDir: z.string().min(1),
  worktreePath: z.string().min(1),
  deleteBranch: z.boolean().optional(),
});

// Mirrors wiki/methods.ts's own (unexported) keyFor: resolve to the
// canonical, symlink-free path so distinct spellings of the same base repo
// share one WorktreeManager (and thus one prune() / one worktreesDir()).
function keyFor(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// Mirrors wiki/methods.ts's and engines/methods.ts's own (unexported)
// requireHeadSha guard, including its error shape — engine.worker.* rejects
// a non-git projectDir the same way engine.wiki.* and engine.frontier.* do.
function requireHeadSha(projectDir: string): void {
  try {
    getHeadSha(projectDir);
  } catch {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `not a git repository: ${projectDir}`);
  }
}

// Looks up the provider kind recorded at engine.models.configure() time —
// pricing.ts's table is keyed "<providerKind>/<modelId>", not by providerId,
// so metering a worker run needs the SAME lookup engine.models.complete's
// runComplete() does internally (models/methods.ts's own kindOf helper,
// unexported — duplicated here rather than widening that module's surface
// for one three-line helper, matching how frontier duplicates
// requireHeadSha above). Falls back to the providerId itself for the
// unsupported case of a resolve()-able-but-never-configured provider.
function kindOf(engine: Engine, providerId: string): string {
  const registered = engine.models.registry.list().find((p) => p.id === providerId);
  return registered?.kind ?? providerId;
}

// Holds one WorktreeManager per base repo, cached by realpath so distinct
// spellings of the same project share one manager (and its prune()).
// Deliberately holds NOTHING else — see the module doc comment above.
export class WorkerService {
  #managers = new Map<string, WorktreeManager>();
  #pruned = new Set<string>();

  // Lazily creates (and caches) the WorktreeManager for a project, running
  // WorktreeManager.prune() once per manager the first time it's needed —
  // the task brief's "startup WorktreeManager.prune-on-first-use is fine" —
  // rather than at Engine construction time, since Engine has no project
  // path to prune against until the first worker.run/cleanup call arrives.
  async getManager(projectDir: string): Promise<WorktreeManager> {
    const key = keyFor(projectDir);
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
}

export function registerWorkerMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.worker.run", RunParamsSchema, async (params) => {
    // Flow: git guard -> resolve model -> worktree -> tools -> loop -> diff
    // -> meter -> return.
    //
    // The git guard, model resolution, and worktree creation are wrapped in
    // their own try/catch below: `requireHeadSha`/`registry.resolve`
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
      requireHeadSha(params.projectDir);

      // Resolved BEFORE the worktree is created: an unconfigured provider
      // (or any other resolve()-time failure) must never leave an orphaned
      // worktree behind.
      languageModel = engine.models.registry.resolve(params.providerId, params.model);
      kind = kindOf(engine, params.providerId);

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

    try {
      const loopResult = await runWorkerLoop({
        model: languageModel,
        task: params.task,
        wikiDigest: params.wikiDigest,
        tools,
        maxSteps: params.maxSteps,
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
      // so totals stay comparable across call sites. UsageRecord (meter.ts)
      // has no spare field to tag "this record came from a worker run"
      // without a schema change touching every existing record shape, so
      // worker vs engine.models.complete vs engine.frontier.* records are NOT
      // distinguishable in the ledger today — see the task report for the
      // considered alternatives.
      engine.models.meter.record({
        providerId: params.providerId,
        kind,
        model: params.model,
        usage: loopResult.usage,
        costUsd,
        at: Date.now(),
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
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `worker run failed: ${message}`, {
        worktree: { path: worktree.path, branch: worktree.branch },
      });
    }
  });

  registerMethod(engine.dispatcher, "engine.worker.cleanup", CleanupParamsSchema, async (params) => {
    // Same git guard as engine.worker.run: without it, a non-git
    // projectDir reaches `getManager` -> `WorktreeManager.prune()` -> a
    // failing `git worktree prune` call, whose raw `Error` falls through to
    // the dispatcher's generic INTERNAL_ERROR (-32603) instead of this
    // method's SERVER_ERROR (-32000) contract.
    requireHeadSha(params.projectDir);

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
