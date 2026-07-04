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
import type { AgentDef, WikiPage } from "../harness/schema.js";
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

// M6 Task 1 review round 1 (Important — Fix 1): reviewTimeoutMs (and, by
// extension, the escalation turn's own deadline) had NO default anywhere in
// this pipeline — an RPC caller simply omitting it left the review/
// escalation frontier call fully UNBOUNDED. That matters specifically
// because of the stdin-close shutdown path (main.ts: abortAll ->
// pipeline.drain -> engine.close): drain() waits on THIS in-flight
// orchestrate call to settle BEFORE close() ever runs and can reach (and
// force-close) the direct frontier session engine.frontier.track registered
// (see runEscalation/the worker loop's review session below) — so a wedged
// REAL review or escalation turn would hang the entire process, not just
// this one call, taking down an eval batch of N orchestrate loops with it.
// M6 Task 1 Change A made the real Claude adapter actually ENFORCE
// opts.timeoutMs (claude.ts) — before that, a default here would have been
// a no-op against the real adapter. With enforcement now real, defaulting
// here is what makes every sub-call self-bounding regardless of what an RPC
// caller passes (or omits). Kept as internal, unexported constants — same
// convention as worker/methods.ts's own DEFAULT_RUN_TIMEOUT_MS (the wire
// schema, methods.ts's OrchestrateParamsSchema, keeps both params OPTIONAL;
// applying the default HERE, not there, is what guarantees an omitted param
// still yields a bounded call).
const DEFAULT_REVIEW_TIMEOUT_MS = 300_000; // 5 min — a read-only judgment call; should be fast.
// 10 min — a full editing turn, comparable in scope to a worker attempt, so
// this mirrors worker/methods.ts's own DEFAULT_RUN_TIMEOUT_MS rather than
// reusing the (shorter) review default. An EXPLICIT reviewTimeoutMs from the
// caller is still reused verbatim for escalation too (unchanged from before
// this fix — see OrchestrateParamsSchema's own doc comment) since a caller
// providing one is clearly stating a per-sub-call deadline for this whole
// run; only the OMITTED case gets escalation's own, longer default.
const DEFAULT_ESCALATE_TIMEOUT_MS = 600_000;

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
  // M6 Task 2: the RoutedAgent's own taskClass (routing.ts), including the
  // DEFAULT_TASK_CLASS sentinel when nothing matched — previously only
  // surfaced in an "orchestrate.progress" notification (see the `route`
  // stage's progress() call below), so a caller reading only the RETURNED
  // result (M6's report card, notably) had no way to bucket a run by which
  // task class it was routed as. Kept alongside `agent`/`resolution` since
  // all three come off the same routeTask() call.
  taskClass: string;
  resolution: { providerId: string; model: string } | "frontier";
  attempts: OrchestrateAttempt[];
  diff: string;
  diffStat: string;
  worktree: { path: string; branch: string } | null;
  cost: {
    workerUsd: number | null;
    // M6 Task 2: frontier cost split by WHERE it was spent — reviewUsd is
    // the sum of every reviewDiff (read-only review session) call's own
    // costUsd across all worker attempts; escalateUsd is the write-scoped
    // escalation session's costUsd (at most one per orchestrate run, since
    // there is only ever one escalation attempt). Both are computed at
    // their own distinct call sites below (the review loop's
    // `reviewUsd = addCost(...)` and runEscalation's own
    // `escalateUsd = addCost(...)`) and surfaced separately so M6's report
    // card can bucket "review" spend apart from "escalate" spend — the two
    // answer different cost questions (the ongoing price of quality-gating
    // EVERY worker attempt vs. the one-time price of a frontier doing the
    // task itself).
    reviewUsd: number | null;
    // Kept for backward compatibility with every existing caller/test that
    // reads `cost.frontierUsd` as "total frontier spend" — now DERIVED as
    // reviewUsd + escalateUsd (addCost's null-safe sum) rather than
    // independently accumulated, so this can never drift from the split
    // that backs it.
    frontierUsd: number | null;
    escalateUsd: number | null;
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

// Final review Fix 3 (Important): what the PRIOR worker attempt (if any)
// produced, threaded into the loop below so the NEXT attempt's task text can
// react to it — a blind re-roll (attempt n+1 gets the identical prompt as
// attempt n) ignores the reviewer's own diagnosis and weakens convergence,
// inflating the escalation rate (an M6 metric). `empty: true` means the
// prior attempt's diff was blank (never reached review at all); `verdict`
// carries the prior review's own decision/reasons once one exists.
interface PriorAttempt {
  empty?: true;
  verdict?: ReviewVerdict;
}

// Renders PriorAttempt into the exact feedback line appended to the next
// attempt's task text — kept separate from buildWorkerTask so the two
// distinct "what went wrong" cases (no changes at all vs. reviewed and
// rejected) stay easy to read independently. Returns undefined when there is
// nothing to say (no prior attempt, or a prior attempt that was approved —
// which never reaches a second attempt in practice, but is handled the same
// way defensively: no feedback needed since the pipeline already returned).
function describePriorAttempt(prior: PriorAttempt | undefined): string | undefined {
  if (prior === undefined) return undefined;
  if (prior.empty === true) {
    return "A previous attempt produced no changes; make sure you actually edit files.";
  }
  if (prior.verdict !== undefined && prior.verdict.decision === "request-changes") {
    return `A previous attempt was reviewed and rejected for these reasons: ${prior.verdict.reasons.join(", ")}. Address them.`;
  }
  return undefined;
}

// M6 Task 2: the total combined wiki-digest text handed to the worker via
// engine.worker.run's `wikiDigest` param (see buildWikiDigestContext below)
// is capped here so a harness with many wiki pages can never blow a cheap
// worker model's context window. 8000 chars is roughly 2000 tokens at a
// conservative 4-chars/token estimate — small next to any current worker
// model's context, even stacked on top of the agent's own prompt and the
// task text. Measured against the DIGEST TEXT ONLY (not the "### <title>"
// markup this module wraps each page in below), so the actual prompt
// contribution is somewhat larger than this number but never
// unboundedly so.
const MAX_WIKI_DIGEST_CHARS = 8000;

// v1 of "wire wiki digests into worker prompts" (M6 Task 2): there is no
// agent.taskClasses -> wiki-page mapping yet (harness/schema.ts's WikiPage
// has no per-agent/per-taskClass affinity), so "which pages actually matter
// for THIS task" isn't decidable — sending every page's digest, bounded, is
// the simplest choice that can't silently starve a worker of context a
// smarter selection might have kept. This is the harness's headline value
// (distilled per-file/per-area knowledge that lets a cheap model work
// without reading the whole repo) actually reaching the worker for the
// first time; before this, buildWorkerTask (below) gave the worker only
// agent.prompt + the task, with no wiki context of any kind.
//
// Pages are taken in the harness's own order (bundle.pages, i.e. on-disk
// slug order — see harness/store.ts's loadHarness) until the NEXT page's
// digest would push the running total over MAX_WIKI_DIGEST_CHARS; every
// page up to that point is included in full (a digest is never
// partially/mid-sentence truncated), and everything left over is named —
// not silently dropped — in a trailing note so a truncated run is visible
// rather than quietly incomplete. Returns undefined when the harness has no
// pages at all (loadHarness's own readRequiredDir makes an empty
// `pages` vanishingly rare for a real engine.harness.generate output, but a
// hand-edited harness — schema.ts's own documented allowance — could still
// have one), so callers never send an empty/meaningless digest section.
//
// Composed as its OWN `wikiDigest` param on the engine.worker.run call
// (worker/methods.ts's RunParamsSchema already had this field; nothing
// wired it until now) rather than folded into buildWorkerTask's own task
// string — worker/loop.ts's buildPrompt already renders wikiDigest under
// its own "# Repository context" heading, ahead of the task, exactly
// mirroring how a real repository wiki would be handed to a human
// contributor: read the context, then do the task. The "## Project
// knowledge (from the harness wiki)" heading below nests one level inside
// that existing "# Repository context" section.
function buildWikiDigestContext(pages: readonly WikiPage[]): string | undefined {
  if (pages.length === 0) return undefined;

  const included: WikiPage[] = [];
  let total = 0;
  for (const page of pages) {
    if (total + page.digest.length > MAX_WIKI_DIGEST_CHARS) break;
    included.push(page);
    total += page.digest.length;
  }
  // Unreachable under a schema-valid harness (WikiPageSchema caps a single
  // digest at 1200 chars, well under MAX_WIKI_DIGEST_CHARS, so the FIRST
  // page always fits) — guarded anyway so a future cap change or a
  // hand-edited harness loaded straight off disk can never silently emit
  // an empty digest section instead of at least the first page's own.
  if (included.length === 0) {
    included.push(pages[0]!);
  }

  const sections = included.map((page) => `### ${page.title}\n\n${page.digest}`);
  const omitted = pages.length - included.length;
  const truncationNote =
    omitted > 0
      ? `\n\n[... ${omitted} more wiki page digest(s) omitted — combined digest context is capped at ${MAX_WIKI_DIGEST_CHARS} characters]`
      : "";
  return `## Project knowledge (from the harness wiki)\n\n${sections.join("\n\n")}${truncationNote}`;
}

// Builds the single `task` string handed to engine.worker.run: the routed
// agent's own specialist prompt, then the user's task — plus, from the
// second attempt onward, a feedback line naming what the PRIOR attempt got
// wrong (Final review Fix 3), so a retry is an informed correction rather
// than an identical re-roll. The harness's wiki digests are NOT folded in
// here — see buildWikiDigestContext's own doc comment above for why they
// travel as engine.worker.run's separate `wikiDigest` param instead.
function buildWorkerTask(agent: AgentDef, task: string, prior?: PriorAttempt): string {
  const base = `${agent.prompt}\n\n${task}`;
  const feedback = describePriorAttempt(prior);
  return feedback === undefined ? base : `${base}\n\n${feedback}`;
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

// Lifts the worktree breadcrumb a failed engine.worker.run (worker/
// methods.ts) or runEscalation (below) call carries in its thrown
// RpcMethodError's `data` — both leave the failed attempt's worktree ON
// DISK for inspection (see each's own "never remove on a failure path" doc
// comment), but only the error THEY threw reliably knows that attempt's
// path; the caller's own `lastWorktree` local can already be stale/null by
// the time this fires — e.g. an earlier attempt's worktree was cleaned up
// (rejected verdict) before this LATER attempt threw — so trusting
// `lastWorktree` instead of this lift would silently discard a real,
// still-on-disk worktree (M5b Task 4 review round 1, Finding 2).
function liftWorktreeFromError(err: unknown): { path: string; branch: string } | undefined {
  if (
    err instanceof RpcMethodError &&
    err.data !== undefined &&
    typeof err.data === "object" &&
    err.data !== null &&
    "worktree" in err.data
  ) {
    return (err.data as { worktree: { path: string; branch: string } }).worktree;
  }
  return undefined;
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
// was rejected/empty. `timeoutMs` is the CALLER'S already-resolved deadline
// (params.reviewTimeoutMs if the caller passed one, else
// DEFAULT_ESCALATE_TIMEOUT_MS — see orchestrate()'s own resolution below) —
// this function never reads params.reviewTimeoutMs itself, so it can never
// silently forward an unbounded `undefined` to the escalation turn.
async function runEscalation(
  engine: Engine,
  params: OrchestrateParams,
  agent: AgentDef,
  timeoutMs: number,
): Promise<EscalationResult> {
  const manager = await engine.worker.getManager(params.projectDir);
  const worktree = await manager.create(randomUUID());

  try {
    const adapter = engine.frontier.getAdapter(FRONTIER_KIND);
    if (adapter === undefined) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown frontier engine: ${FRONTIER_KIND}`);
    }
    // wikiMcpUrl stays keyed off the BASE project (params.projectDir) — the
    // escalation still wants the base repo's wiki context — independent of
    // the session's cwd (below), which is now the worktree, not the base
    // repo.
    const wikiMcpUrl = await attachedWikiMcpUrl(engine, params.projectDir);
    const session = await adapter.createSession({
      // FIX (M5b Task 4 review round 1, Finding 1 — CRITICAL): this
      // `projectDir` becomes the session subprocess's cwd (claude.ts:
      // `cwd: projectDir` in the query() options) — it MUST be the
      // worktree, not the base repo. toolPolicy.writeScope is
      // [worktree.path] below; a session whose cwd is the base repo has a
      // REAL frontier editing files at their natural base-repo-relative
      // paths, every one of which resolves OUTSIDE writeScope and gets
      // DENIED by canUseTool — the worktree (and therefore manager.diff,
      // below) stays untouched, so escalation could only ever produce a
      // non-empty diff against a fake adapter that ignored cwd and wrote
      // straight into writeScope[0].
      projectDir: worktree.path,
      wikiMcpUrl,
      log: engine.log,
      toolPolicy: { writeScope: [worktree.path] },
      resultLabel: "frontier-escalate",
    });
    // M6 Task 1 (eval-batch safety gate): this session is created DIRECTLY
    // off the registered adapter, bypassing engine.frontier.start entirely —
    // it never gets a sessionId and never touches FrontierService's own
    // #sessions bookkeeping, so Engine.close() had no way to reach (and
    // force-kill) a wedged escalation turn before this fix. track()
    // registers it for close()-time reachability; the returned untrack fn is
    // called in the same `finally` below where the session is closed.
    const untrackSession = engine.frontier.track(session);
    try {
      const turn = await runFrontierTurn(
        session,
        // Minor (M5b Task 4 review round 1): frame the turn with the routed
        // agent's own specialist prompt — mirrors buildWorkerTask's
        // identical framing for worker runs — so escalation gets the same
        // specialist context a worker attempt would have had. "current
        // working directory" is now literally correct: the session's cwd IS
        // the worktree (see the createSession call above).
        `${agent.prompt}\n\nComplete this task by editing files in the current working directory: ${params.task}`,
        timeoutMs,
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
      untrackSession();
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
  // M6 Task 2: split by where the cost was spent — see OrchestrateResult's
  // own doc comment on `cost.reviewUsd`/`cost.escalateUsd` for why these are
  // tracked as two separate running totals now instead of one combined
  // `frontierUsd` (frontierUsd is still returned, derived from these two,
  // for backward compatibility — see finish() below).
  let reviewUsd: number | null = null;
  let escalateUsd: number | null = null;

  const nextAttemptNumber = (): number => attempts.length + 1;

  function finish(
    outcome: OrchestrateResult["outcome"],
    agentName: string,
    taskClass: string,
    resolution: OrchestrateResult["resolution"],
    diff: string,
    diffStat: string,
    worktree: { path: string; branch: string } | null,
  ): OrchestrateResult {
    progress(engine, "done", `outcome: ${outcome}`);
    return {
      outcome,
      agent: agentName,
      taskClass,
      resolution,
      attempts,
      diff,
      diffStat,
      worktree,
      cost: {
        workerUsd,
        reviewUsd,
        frontierUsd: addCost(reviewUsd, escalateUsd),
        escalateUsd,
        totalUsd: addCost(workerUsd, addCost(reviewUsd, escalateUsd)),
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

    // M6 Task 2: computed ONCE per run (the harness's own pages never change
    // between worker attempts) and threaded into every engine.worker.run
    // call below via its `wikiDigest` param — see buildWikiDigestContext's
    // own doc comment for the v1 "send every page, bounded" design and the
    // MAX_WIKI_DIGEST_CHARS cap. Never logged (engine.log) anywhere in this
    // module — it's worker-prompt content, same posture as `params.task`
    // and every worker/frontier summary this pipeline handles.
    const wikiDigest = buildWikiDigestContext(harness.pages);

    const maxWorkerAttempts =
      params.maxWorkerAttempts ?? harness.routing.escalation.failuresBeforeFrontier ?? DEFAULT_MAX_WORKER_ATTEMPTS;
    // Fix 1 (M6 Task 1 review round 1): resolved ONCE, here — every
    // review/escalation call below reads these locals, never
    // params.reviewTimeoutMs directly, so an omitted param can't leak an
    // unbounded `undefined` past this point. See the DEFAULT_* constants'
    // own doc comment (top of file) for the drain()-hang rationale.
    const reviewTimeoutMs = params.reviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
    const escalateTimeoutMs = params.reviewTimeoutMs ?? DEFAULT_ESCALATE_TIMEOUT_MS;

    if (routed.resolution !== "frontier") {
      const { providerId, model } = routed.resolution;
      // Final review Fix 3: set right after the FIRST attempt completes
      // (empty or reviewed), so attempt 2+'s buildWorkerTask call below can
      // append what went wrong — attempt 1 always sees `undefined` here (no
      // prior attempt exists yet), matching this fix's "attempt-1 task is
      // unchanged" contract.
      let priorAttempt: PriorAttempt | undefined;

      for (let i = 0; i < maxWorkerAttempts; i++) {
        const n = nextAttemptNumber();
        progress(engine, `worker:${n}`, `running worker attempt ${n}/${maxWorkerAttempts}`);

        let workerResult: WorkerRunResponse;
        try {
          workerResult = await callEngineMethod<WorkerRunResponse>(engine, "engine.worker.run", {
            projectDir: params.projectDir,
            task: buildWorkerTask(routed.agent, params.task, priorAttempt),
            wikiDigest,
            providerId,
            model,
            // Fix 1: unlike reviewTimeoutMs/escalateTimeoutMs above, this is
            // deliberately left as `params.workerTimeoutMs` verbatim
            // (possibly undefined) rather than defaulted here —
            // engine.worker.run's OWN handler (worker/methods.ts) already
            // applies its own bounded default (`params.timeoutMs ??
            // DEFAULT_RUN_TIMEOUT_MS`, 600000) whenever this arrives as
            // undefined, so this sub-call is ALREADY self-bounding without
            // orchestrate needing to duplicate that default.
            timeoutMs: params.workerTimeoutMs,
          });
        } catch (err) {
          // FIX (M5b Task 4 review round 1, Finding 2 — Important): a
          // worker.run failure on attempt >=2 leaves ITS OWN worktree on
          // disk (worker/methods.ts's own catch), but `lastWorktree` is
          // guaranteed null right here whenever the PRIOR attempt was
          // rejected and cleaned up above (see cleanupWorktree calls below)
          // — lift the real path out of the thrown error's `data` instead
          // of letting that stale null reach the outer catch. Mirrors the
          // escalation catch's identical lift, below.
          const worktree = liftWorktreeFromError(err);
          if (worktree !== undefined) lastWorktree = worktree;
          throw err;
        }
        workerUsd = addCost(workerUsd, workerResult.costUsd);
        // Tentatively tracked as soon as it's known to exist — see the
        // `lastWorktree` doc comment above.
        lastWorktree = workerResult.worktree;

        if (workerResult.diff.trim().length === 0) {
          attempts.push({ n, kind: "worker", summary: workerResult.summary, empty: true });
          await cleanupWorktree(engine, params.projectDir, workerResult.worktree.path);
          lastWorktree = null;
          priorAttempt = { empty: true };
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
        // M6 Task 1 (eval-batch safety gate): this session is created
        // DIRECTLY off the registered adapter, bypassing
        // engine.frontier.start entirely — it never gets a sessionId and
        // never touches FrontierService's own #sessions bookkeeping, so
        // Engine.close() had no way to reach (and force-kill) a wedged
        // review turn before this fix. track() registers it for
        // close()-time reachability; the returned untrack fn is called in
        // the same `finally` below where the session is closed.
        const untrackReviewSession = engine.frontier.track(reviewSession);
        let verdict: ReviewVerdict;
        try {
          const reviewResult = await reviewDiff(
            reviewSession,
            { task: params.task, diff: workerResult.diff, summary: workerResult.summary },
            { timeoutMs: reviewTimeoutMs },
          );
          verdict = reviewResult.verdict;
          reviewUsd = addCost(reviewUsd, reviewResult.costUsd);
        } finally {
          await reviewSession.close().catch(() => {
            // Best-effort — see runEscalation's identical close() comment.
          });
          untrackReviewSession();
        }

        attempts.push({ n, kind: "worker", summary: workerResult.summary, verdict });

        if (verdict.decision === "approve") {
          return finish(
            "worker-approved",
            routed.agent.name,
            routed.taskClass,
            routed.resolution,
            workerResult.diff,
            workerResult.diffStat,
            workerResult.worktree,
          );
        }

        await cleanupWorktree(engine, params.projectDir, workerResult.worktree.path);
        lastWorktree = null;
        priorAttempt = { verdict };
      }
    }

    // Escalate: either routing resolved straight to "frontier", or every
    // worker attempt above was rejected or produced an empty diff.
    progress(engine, "escalate", "escalating to the frontier with write access");
    let escalation: EscalationResult;
    try {
      escalation = await runEscalation(engine, params, routed.agent, escalateTimeoutMs);
    } catch (err) {
      // Mirrors the worker-attempt catch's identical lift, above.
      const worktree = liftWorktreeFromError(err);
      if (worktree !== undefined) lastWorktree = worktree;
      throw err;
    }
    escalateUsd = addCost(escalateUsd, escalation.costUsd);
    lastWorktree = escalation.worktree;

    const n = nextAttemptNumber();
    if (escalation.diff.trim().length === 0) {
      attempts.push({ n, kind: "frontier", summary: escalation.text, empty: true });
      await cleanupWorktree(engine, params.projectDir, escalation.worktree.path);
      lastWorktree = null;
      return finish("failed", routed.agent.name, routed.taskClass, routed.resolution, "", "", null);
    }

    attempts.push({ n, kind: "frontier", summary: escalation.text });
    return finish(
      "escalated",
      routed.agent.name,
      routed.taskClass,
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
