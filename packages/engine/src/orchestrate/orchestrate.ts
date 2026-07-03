// engine.orchestrate — the end-to-end harness-fusion loop (M5b Task 4, the
// M5 EXIT CRITERION): classify -> route -> open-model worker -> frontier
// review -> retry-once-then-escalate. Composes everything M5a/M5b built:
// routeTask (./routing.ts) picks an agent + model resolution off the loaded
// harness; engine.worker.run (worker/methods.ts) drives the open-model
// worker inside its own isolated worktree; reviewDiff (./review.ts) puts a
// READ-ONLY frontier session in the loop as the quality gate; and — after
// maxWorkerAttempts worker failures, or immediately if routing resolves
// straight to "frontier" — a WRITE-SCOPED frontier session (M4's canUseTool
// write policy, exercised here for the first time "in anger") does the task
// itself.
//
// COMPOSITION CHOICE (worker vs frontier): worker runs go through
// engine.worker.run's OWN RPC handler (via engine.dispatcher.dispatch — see
// callEngineMethod below) rather than a duplicated pipeline, because that
// handler already owns a lot of correctness-critical plumbing this task must
// not re-implement or drift from: worktree creation, tool wiring, the
// timeout/abort signal combination, pricing/metering under source "worker",
// and worker.progress notifications. Frontier sessions, by contrast, are
// opened DIRECTLY off the registered adapter (engine.frontier.getAdapter —
// exactly generateHarness's own pattern, harness/generate.ts) because
// reviewDiff/promptForJson need the raw FrontierSession object itself
// (session.prompt(), not a sessionId) — engine.frontier.prompt's RPC surface
// only ever returns a flattened result, never the session, and layers its
// OWN single-timeout-authority semantics on top, which would fight
// promptForJson's own per-attempt timeoutMs threading (driver.ts, this same
// task's CRITICAL sub-item).
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import type { FrontierSession } from "../engines/types.js";
import type { AgentDef } from "../harness/schema.js";
import { validateHarness } from "../harness/schema.js";
import { HarnessValidationError, loadHarness } from "../harness/store.js";
import { RpcMethodError } from "../rpc/errors.js";
import { requireGitRepo } from "../rpc/guards.js";
import { wikiDbPath } from "../wiki/store.js";
import { reviewDiff, type ReviewVerdict } from "./review.js";
import { routeTask } from "./routing.js";

// The only frontier engine kind orchestration drives today — mirrors
// engines/methods.ts's own `params.engine ?? "claude-code"` default and
// harness/generate.ts's FRONTIER_KIND.
const FRONTIER_KIND = "claude-code";
const DEFAULT_MAX_WORKER_ATTEMPTS = 2;

export interface OrchestrateParams {
  projectDir: string;
  task: string;
  maxWorkerAttempts?: number;
  workerTimeoutMs?: number;
  reviewTimeoutMs?: number;
}

export interface OrchestrateAttempt {
  n: number;
  kind: "worker" | "frontier";
  summary: string;
  verdict?: ReviewVerdict;
  empty?: boolean;
}

export interface OrchestrateResult {
  outcome: "worker-approved" | "escalated" | "failed";
  agent: string;
  resolution: { providerId: string; model: string } | "frontier";
  attempts: OrchestrateAttempt[];
  diff: string;
  diffStat: string;
  worktree: { path: string; branch: string } | null;
  cost: {
    workerUsd: number | null;
    frontierUsd: number | null;
    totalUsd: number | null;
    note: "estimate-class";
  };
}

// Null-safe running total — same shape as harness/driver.ts's own addCost
// (and harness/generate.ts's local copy): null contributes nothing; the
// running total only becomes (and then stays) a number once ANY addend is
// one.
function addCost(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}

// Mirrors engines/methods.ts's own private isWikiBuilt predicate exactly
// (existsSync gate before ever opening a store, so asking "is it built"
// never has the side effect of creating an empty wiki.db) — duplicated
// locally rather than exported since it's three lines and this is the only
// other call site (matches harness/generate.ts's own precedent of a small
// local duplicate over a one-caller export).
function isWikiBuilt(engine: Engine, projectDir: string): boolean {
  if (!existsSync(wikiDbPath(path.resolve(projectDir)))) return false;
  return engine.wiki.getStore(projectDir).getMeta("head_sha") !== null;
}

async function attachedWikiMcpUrl(engine: Engine, projectDir: string): Promise<string | null> {
  if (!isWikiBuilt(engine, projectDir)) return null;
  const server = await engine.wiki.startMcpServer(engine, projectDir);
  return server.url;
}

// Invokes an already-registered engine.worker.* RPC method through the SAME
// in-process dispatcher engine.orchestrate itself is registered on — see
// this module's header comment for why worker runs are composed this way
// (reusing worker/methods.ts's own handler) rather than frontier sessions
// (opened directly off the adapter, below). Unwraps the JSON-RPC envelope
// into a plain return value or a proper RpcMethodError throw, so callers
// below never see the {jsonrpc,id,result|error} shape.
async function callEngineMethod<T>(engine: Engine, method: string, params: unknown): Promise<T> {
  const response = await engine.dispatcher.dispatch({
    jsonrpc: "2.0",
    id: randomUUID(),
    method,
    params,
  });
  if (response === null) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `${method} produced no response`);
  }
  if (response.error !== undefined) {
    throw new RpcMethodError(response.error.code, response.error.message, response.error.data);
  }
  return response.result as T;
}

interface WorkerRunResponse {
  diff: string;
  diffStat: string;
  summary: string;
  costUsd: number | null;
  worktree: { path: string; branch: string };
}

// Builds the single `task` string handed to engine.worker.run: the routed
// agent's own specialist prompt, then the user's task — "keep simple: pass
// task + agent.prompt as the worker task framing" per the task brief (a
// fuller wiki-digest-aware framing is left to later work).
function buildWorkerTask(agent: AgentDef, task: string): string {
  return `${agent.prompt}\n\n${task}`;
}

// Drains a frontier turn WITHOUT any JSON-schema expectation (unlike
// promptForJson, harness/driver.ts) — used for the escalation turn below,
// whose whole point is to make TOOL CALLS (Write/Edit, allowed via this
// session's write-scoped canUseTool policy) and finish with a short prose
// summary, not a structured verdict. Mirrors promptForJson's own
// event-draining loop (text/result/notice/error handling) minus the JSON
// extraction/retry.
async function runFrontierTurn(
  session: FrontierSession,
  prompt: string,
  timeoutMs: number | undefined,
): Promise<{ text: string; costUsd: number | null }> {
  const handle = session.prompt(prompt, { timeoutMs });
  let text = "";
  let costUsd: number | null = null;
  try {
    for await (const event of handle.events) {
      switch (event.type) {
        case "text":
          text += event.text;
          break;
        case "result":
          costUsd = addCost(costUsd, event.costUsd);
          break;
        case "error":
          throw new Error(`frontier session error: ${event.message}`);
        case "tool_use":
        case "notice":
          break;
      }
    }
  } catch (err) {
    handle.abort();
    throw err;
  }
  return { text, costUsd };
}

// Best-effort cleanup for a worktree that did NOT survive (a rejected or
// empty-diff worker attempt) — reuses engine.worker.cleanup's own
// find-by-path-then-remove logic (worker/methods.ts) through the same
// dispatcher composition as the worker run itself. Swallows its own failure
// (logged, not thrown): losing track of one stale worktree must never abort
// the whole orchestrate run or mask its real outcome.
async function cleanupWorktree(engine: Engine, projectDir: string, worktreePath: string): Promise<void> {
  try {
    await callEngineMethod(engine, "engine.worker.cleanup", { projectDir, worktreePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    engine.log(`orchestrate: failed to clean up worktree ${worktreePath}: ${message}`);
  }
}

function progress(engine: Engine, stage: string, detail: string): void {
  engine.notify("orchestrate.progress", { stage, detail });
}

interface EscalationResult {
  worktree: { path: string; branch: string };
  diff: string;
  diffStat: string;
  text: string;
  costUsd: number | null;
}

// Runs the task on the frontier DIRECTLY, in a fresh worktree, with write
// access scoped to that worktree's root (toolPolicy.writeScope) — the first
// use of the M4 write-policy path in anger. Reached either because routing
// resolved straight to "frontier", or because every worker attempt above
// was rejected/empty.
async function runEscalation(engine: Engine, params: OrchestrateParams, agent: AgentDef): Promise<EscalationResult> {
  const manager = await engine.worker.getManager(params.projectDir);
  const worktree = await manager.create(randomUUID());

  try {
    const adapter = engine.frontier.getAdapter(FRONTIER_KIND);
    if (adapter === undefined) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown frontier engine: ${FRONTIER_KIND}`);
    }
    const wikiMcpUrl = await attachedWikiMcpUrl(engine, params.projectDir);
    const session = await adapter.createSession({
      projectDir: params.projectDir,
      wikiMcpUrl,
      log: engine.log,
      toolPolicy: { writeScope: [worktree.path] },
      resultLabel: "frontier-escalate",
    });
    try {
      const turn = await runFrontierTurn(
        session,
        `Complete this task by editing files: ${params.task}`,
        params.reviewTimeoutMs,
      );
      const diff = await manager.diff(worktree);
      const diffStat = await manager.diffStat(worktree);
      return {
        worktree: { path: worktree.path, branch: worktree.branch },
        diff,
        diffStat,
        text: turn.text,
        costUsd: turn.costUsd,
      };
    } finally {
      await session.close().catch(() => {
        // Best-effort — mirrors FrontierService's own per-session close()
        // isolation; a throwing adapter close() must never mask this
        // escalation's real outcome.
      });
    }
  } catch (err) {
    // Mirrors worker/methods.ts's own failure posture: leave the worktree in
    // place (never auto-remove on a failure path — see worktree.ts's own
    // class-level doc comment) and carry its path in the thrown error's data
    // so orchestrate()'s own catch can report it, letting a human or a retry
    // inspect whatever the frontier had already written before it failed.
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `escalation failed: ${message}`, {
      worktree: { path: worktree.path, branch: worktree.branch },
    });
  }
}

// The pipeline itself: load -> route -> worker attempts (up to
// maxWorkerAttempts) -> escalate. See this module's header comment for the
// composition rationale, and the M5b Task 4 brief for the full contract.
export async function orchestrate(engine: Engine, params: OrchestrateParams): Promise<OrchestrateResult> {
  const attempts: OrchestrateAttempt[] = [];
  // Tracks the most recent worktree that exists on disk and hasn't been
  // cleaned up yet — set as soon as a worktree is known to exist (BEFORE any
  // risky operation against it), so an unexpected throw anywhere in the
  // pipeline still reports a real, inspectable path in the thrown error's
  // data (see the outer catch below) even though that attempt never made it
  // into `attempts`. Cleared back to null the moment a worktree is actually
  // removed.
  let lastWorktree: { path: string; branch: string } | null = null;
  let workerUsd: number | null = null;
  let frontierUsd: number | null = null;

  const nextAttemptNumber = (): number => attempts.length + 1;

  function finish(
    outcome: OrchestrateResult["outcome"],
    agentName: string,
    resolution: OrchestrateResult["resolution"],
    diff: string,
    diffStat: string,
    worktree: { path: string; branch: string } | null,
  ): OrchestrateResult {
    progress(engine, "done", `outcome: ${outcome}`);
    return {
      outcome,
      agent: agentName,
      resolution,
      attempts,
      diff,
      diffStat,
      worktree,
      cost: {
        workerUsd,
        frontierUsd,
        totalUsd: addCost(workerUsd, frontierUsd),
        note: "estimate-class",
      },
    };
  }

  try {
    progress(engine, "load", "loading harness bundle");
    requireGitRepo(params.projectDir);
    let harness;
    try {
      harness = loadHarness(params.projectDir);
    } catch (loadErr) {
      // Mirrors harness/methods.ts's own HarnessValidationError handling
      // (engine.harness.status/export): a harness that's PRESENT but
      // corrupt/hand-edited into an invalid shape is a caller-facing
      // SERVER_ERROR, not an uncaught throw that would otherwise fall
      // through to the dispatcher's generic INTERNAL_ERROR.
      if (loadErr instanceof HarnessValidationError) {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, loadErr.message, { issues: loadErr.issues });
      }
      throw loadErr;
    }
    if (harness === null) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no harness; run engine.harness.generate first");
    }
    const issues = validateHarness(harness);
    if (issues.length > 0) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "harness failed structural validation", { issues });
    }

    progress(engine, "route", "classifying and routing the task");
    const routed = routeTask(params.task, harness, engine.models.registry);
    progress(engine, "route", `routed to agent "${routed.agent.name}" (class ${routed.taskClass})`);

    const maxWorkerAttempts =
      params.maxWorkerAttempts ?? harness.routing.escalation.failuresBeforeFrontier ?? DEFAULT_MAX_WORKER_ATTEMPTS;

    if (routed.resolution !== "frontier") {
      const { providerId, model } = routed.resolution;

      for (let i = 0; i < maxWorkerAttempts; i++) {
        const n = nextAttemptNumber();
        progress(engine, `worker:${n}`, `running worker attempt ${n}/${maxWorkerAttempts}`);

        const workerResult = await callEngineMethod<WorkerRunResponse>(engine, "engine.worker.run", {
          projectDir: params.projectDir,
          task: buildWorkerTask(routed.agent, params.task),
          providerId,
          model,
          timeoutMs: params.workerTimeoutMs,
        });
        workerUsd = addCost(workerUsd, workerResult.costUsd);
        // Tentatively tracked as soon as it's known to exist — see the
        // `lastWorktree` doc comment above.
        lastWorktree = workerResult.worktree;

        if (workerResult.diff.trim().length === 0) {
          attempts.push({ n, kind: "worker", summary: workerResult.summary, empty: true });
          await cleanupWorktree(engine, params.projectDir, workerResult.worktree.path);
          lastWorktree = null;
          continue;
        }

        progress(engine, `review:${n}`, "reviewing the worker's diff with a read-only frontier session");
        const adapter = engine.frontier.getAdapter(FRONTIER_KIND);
        if (adapter === undefined) {
          throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown frontier engine: ${FRONTIER_KIND}`);
        }
        const wikiMcpUrl = await attachedWikiMcpUrl(engine, params.projectDir);
        const reviewSession = await adapter.createSession({
          projectDir: params.projectDir,
          wikiMcpUrl,
          log: engine.log,
          resultLabel: "frontier-review",
        });
        let verdict: ReviewVerdict;
        try {
          const reviewResult = await reviewDiff(
            reviewSession,
            { task: params.task, diff: workerResult.diff, summary: workerResult.summary },
            { timeoutMs: params.reviewTimeoutMs },
          );
          verdict = reviewResult.verdict;
          frontierUsd = addCost(frontierUsd, reviewResult.costUsd);
        } finally {
          await reviewSession.close().catch(() => {
            // Best-effort — see runEscalation's identical close() comment.
          });
        }

        attempts.push({ n, kind: "worker", summary: workerResult.summary, verdict });

        if (verdict.decision === "approve") {
          return finish(
            "worker-approved",
            routed.agent.name,
            routed.resolution,
            workerResult.diff,
            workerResult.diffStat,
            workerResult.worktree,
          );
        }

        await cleanupWorktree(engine, params.projectDir, workerResult.worktree.path);
        lastWorktree = null;
      }
    }

    // Escalate: either routing resolved straight to "frontier", or every
    // worker attempt above was rejected or produced an empty diff.
    progress(engine, "escalate", "escalating to the frontier with write access");
    let escalation: EscalationResult;
    try {
      escalation = await runEscalation(engine, params, routed.agent);
    } catch (err) {
      if (
        err instanceof RpcMethodError &&
        err.data !== undefined &&
        typeof err.data === "object" &&
        err.data !== null &&
        "worktree" in err.data
      ) {
        lastWorktree = (err.data as { worktree: { path: string; branch: string } }).worktree;
      }
      throw err;
    }
    frontierUsd = addCost(frontierUsd, escalation.costUsd);
    lastWorktree = escalation.worktree;

    const n = nextAttemptNumber();
    if (escalation.diff.trim().length === 0) {
      attempts.push({ n, kind: "frontier", summary: escalation.text, empty: true });
      await cleanupWorktree(engine, params.projectDir, escalation.worktree.path);
      lastWorktree = null;
      return finish("failed", routed.agent.name, routed.resolution, "", "", null);
    }

    attempts.push({ n, kind: "frontier", summary: escalation.text });
    return finish(
      "escalated",
      routed.agent.name,
      routed.resolution,
      escalation.diff,
      escalation.diffStat,
      escalation.worktree,
    );
  } catch (err) {
    // Nothing ran yet (a load/route failure before any attempt or worktree
    // existed) -> pass the original, already-correctly-coded error through
    // untouched, matching every sibling pipeline's own guard/routing errors.
    if (attempts.length === 0 && lastWorktree === null) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `orchestrate failed: ${message}`, {
      attempts,
      worktree: lastWorktree,
    });
  }
}
