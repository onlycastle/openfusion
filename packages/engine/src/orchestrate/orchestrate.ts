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
// COMPOSITION CHOICE (worker vs frontier): worker runs go through the typed
// WorkerRunner application service rather than the JSON-RPC transport or a
// duplicated pipeline, because that service already owns the correctness-critical plumbing this task must
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
import {
  RpcErrorCodes,
  type CandidateRef,
  type CostEstimate,
  type TaskContract,
  type TaskSnapshotRef,
} from "@openfusion/shared";
import type { Engine } from "../engine.js";
import type { FrontierSession } from "../engines/types.js";
import {
  resolveFrontierSelection,
  type FrontierSelection,
  type OrchestrateFrontierSelections,
} from "../engines/selection.js";
import type { AgentDef, HarnessBundle } from "../harness/schema.js";
import { CARD_SLUG, validateHarness } from "../harness/schema.js";
import { fingerprintHarness } from "../harness/fingerprint.js";
import { HarnessValidationError, loadHarnessSnapshot } from "../harness/store.js";
import { RunCancelledError } from "../rpc/cancel-registry.js";
import { RpcMethodError } from "../rpc/errors.js";
import { requireGitRepo } from "../rpc/guards.js";
import { wikiDbPath } from "../wiki/store.js";
import { captureTaskSnapshot } from "../runtime/snapshot.js";
import type { RunSupervisor } from "../runtime/supervisor.js";
import type { HarnessExperimentVariant } from "../runtime/evidence.js";
import type { Worktree } from "../worker/worktree.js";
import type { WorkerRunResult } from "../worker/methods.js";
import { reviewDiff, type ReviewVerdict } from "./review.js";
import { resolveNamedAgent, routeTask, type WorkerResolution } from "./routing.js";

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
  frontier?: OrchestrateFrontierSelections;
  // M7b Task 2: client-supplied (or evals.run-forwarded) run identifier used
  // ONLY to look up (never register/deregister) this run's cancellation
  // signal — see cancel-registry.ts's header comment for the ownership
  // split. orchestrate() itself never mints or owns a registry entry; that
  // is engine.orchestrate's own RPC handler's job (methods.ts), which is
  // what lets evals.run's per-task nested orchestrate() call reuse the SAME
  // batch-level runId without this function clobbering that registration.
  runId?: string;
  /** Internal parent session identity for worker child-session linkage. */
  runtimeSessionId?: string;
  taskContract?: TaskContract;
  /** Internal: captured once by the top-level RunSupervisor. */
  taskSnapshot?: TaskSnapshotRef;
  supervisor?: RunSupervisor;
  /** Internal eval/runtime override for a snapshot-pinned authenticated wiki. */
  wikiMcp?: { url: string; bearerToken: string } | null;
  /** Internal: async sessions may stop at policy approvals. */
  interactive?: boolean;
  /** Internal protected-evaluation variant. Controlled trials bypass promoted routing. */
  experimentVariant?: HarnessExperimentVariant;
  /** Internal exact worker continuation loaded from the encrypted trace. */
  resumeWorker?: {
    sessionId: string;
    approvalResponse?: { approvalId: string; approved: boolean; reason?: string };
    task: string;
    providerId: string;
    model: string;
    wikiDigest?: string;
    dialectPack?: string;
  };
}

export interface OrchestrateApprovalPauseState {
  workerSessionId: string;
  approvalId: string;
  worker: {
    task: string;
    providerId: string;
    model: string;
    dialectPack?: string;
  };
}

export class OrchestrateApprovalPause extends Error {
  readonly state: OrchestrateApprovalPauseState;

  constructor(state: OrchestrateApprovalPauseState) {
    super("orchestration is waiting for approval");
    this.name = "OrchestrateApprovalPause";
    this.state = state;
  }
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
  resolution: WorkerResolution | "frontier";
  frontier: { review: FrontierSelection; escalation: FrontierSelection };
  taskSnapshot: TaskSnapshotRef;
  candidateRef: CandidateRef | null;
  verificationIncomplete?: boolean;
  // Phase 1 telemetry pins — reconstructible eval configuration.
  routeId: string;
  family?: string;
  dialectPack?: string;
  // Which always-on wiki context was injected into worker prompts.
  contextBranch: "approved-card" | "build-and-test-fallback" | "none";
  toolCallCounts?: Record<string, number>;
  toolErrorCounts?: Record<string, number>;
  editFailCount?: number;
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
  costEstimate: CostEstimate;
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

async function attachedWikiMcp(
  engine: Engine,
  projectDir: string,
): Promise<{ url: string; bearerToken: string } | null> {
  if (!isWikiBuilt(engine, projectDir)) return null;
  const server = await engine.wiki.startMcpServer(engine, projectDir);
  return { url: server.url, bearerToken: server.bearerToken };
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

// M6 Task 6 (the ETH-anti-pattern injection swap): everything this function
// replaces (the old buildWikiDigestContext, deleted here) sent EVERY wiki
// page's digest into EVERY worker prompt, bounded only by a combined
// character cap — exactly the configuration the ETH Zurich + DeepMind
// AGENTS.md study (arXiv:2602.11988, v2 Jun 2026 — see this repo's own
// docs/research/2026-07-07-harness-composition.md, §0 "the spine") measured
// as HARMFUL, not merely low-value: LLM-generated context that restates what
// an agent can already read from the repo cost -0.5-2% success and +20-23%
// inference in 5 of 8 settings. The mechanism is redundancy, not noise —
// which is why "send fewer/smaller digests" was never the fix; a categorical
// swap is (spec docs/superpowers/specs/2026-07-08-wiki-project-card-design.md
// §4):
//
//   1. An APPROVED Project Card (harness/schema.ts's CARD_SLUG page, gated on
//      manifest.verification.card === "approved" — spec §3.4's mandatory
//      human approval gate) is the ONLY generated content this whole research
//      basis endorses injecting unconditionally: the same ETH study found
//      HUMAN-CURATED context gave +4% at acceptable cost, because a human
//      reviewer is exactly the filter that keeps restated/inferable material
//      out. A card still in "draft" has not cleared that filter and gets
//      NO MORE trust than no card at all — draft content falls straight
//      through to branch 2, never a degraded/partial injection of its own.
//   2. Failing that, the `build-and-test` prose page (if the harness has one)
//      is injected ALONE — never combined with any other prose page, and
//      never as a blanket "send all four prose pages" fallback the way this
//      function's predecessor did. Exact build/test/run commands are the one
//      class of "non-inferable or expensive to rediscover" fact the research
//      doc's Pillar 1 table calls out as the harness's own approved-card
//      content rule (spec §3.2) ALSO wants — this is the one legacy
//      (unreviewed) digest class the research turned up positive evidence
//      for, so it is kept as a fallback rather than dropped to nothing.
//   3. Otherwise: nothing. Every other prose page (architecture, subsystems,
//      conventions, or even build-and-test when a draft/approved card
//      already satisfied branch 1) is available to a worker ONLY through the
//      on-demand retrieval tools spec §5 describes (a later task) — never
//      bulk-injected into the prompt.
//
// The returned `branch` exists purely so the CALL SITE can notify which of
// the three paths fired (`progress(engine, "load", \`worker context:
// ${branch}\`, ...)`, below) without ever putting the digest TEXT itself into
// a log line or notification — same never-logged posture the deleted
// function held (this is worker-PROMPT content, same class as `params.task`
// and every worker/frontier summary this pipeline already treats this way).
type WorkerContextBranch = "approved-card" | "build-and-test-fallback" | "none";

function buildWorkerContext(bundle: HarnessBundle): { text: string | undefined; branch: WorkerContextBranch } {
  const cardPage = bundle.pages.find((page) => page.slug === CARD_SLUG);
  if (cardPage !== undefined && bundle.manifest.verification.card === "approved") {
    return { text: `## Project card\n\n${cardPage.digest}`, branch: "approved-card" };
  }

  const buildAndTestPage = bundle.pages.find((page) => page.slug === "build-and-test");
  if (buildAndTestPage !== undefined) {
    return {
      text: `## Project knowledge (from the harness wiki)\n\n### ${buildAndTestPage.title}\n\n${buildAndTestPage.digest}`,
      branch: "build-and-test-fallback",
    };
  }

  return { text: undefined, branch: "none" };
}

// Builds the single `task` string handed to engine.worker.run: the routed
// agent's own specialist prompt, then the user's task — plus, from the
// second attempt onward, a feedback line naming what the PRIOR attempt got
// wrong (Final review Fix 3), so a retry is an informed correction rather
// than an identical re-roll. The harness's worker context (the approved
// card, or its build-and-test fallback) is NOT folded in here — see
// buildWorkerContext's own doc comment above for why it travels as
// engine.worker.run's separate `wikiDigest` param instead.
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
//
// M7b Task 2: `abortSignal`, when provided, is this run's own cancellation
// signal (see OrchestrateParams.runId's doc comment) — a listener calls
// handle.abort() the instant it fires, and the turn is reported as cancelled
// via THREE separate `.aborted` checks (before starting, in the catch, and
// right after the loop ends normally) rather than relying on any one of them
// alone. That triple-check is deliberate, not defensive overkill: a manual
// handle.abort() (as opposed to a timeout) does not reliably make the
// underlying adapter THROW a recognizable error — per claude.ts's own doc
// comment, an abort with no timeoutMs deadline armed can just let the
// query's iterator end quietly (`{done: true}`) — so a catch-only check
// would miss that path entirely; the post-loop check closes that gap.
async function runFrontierTurn(
  session: FrontierSession,
  prompt: string,
  timeoutMs: number | undefined,
  abortSignal?: AbortSignal,
): Promise<{ text: string; costUsd: number | null }> {
  if (abortSignal?.aborted) throw new RunCancelledError();
  const handle = session.prompt(prompt, { timeoutMs });
  const onCancel = (): void => handle.abort();
  abortSignal?.addEventListener("abort", onCancel, { once: true });
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
    if (abortSignal?.aborted) throw new RunCancelledError();
    throw err;
  } finally {
    abortSignal?.removeEventListener("abort", onCancel);
  }
  if (abortSignal?.aborted) throw new RunCancelledError();
  return { text, costUsd };
}

// Best-effort cleanup for a worktree that did NOT survive (a rejected or
// empty-diff worker attempt) — reuses WorkerService's typed
// find-by-path-then-remove logic. Swallows its own failure
// (logged, not thrown): losing track of one stale worktree must never abort
// the whole orchestrate run or mask its real outcome.
async function cleanupWorktree(engine: Engine, projectDir: string, worktreePath: string): Promise<void> {
  try {
    await engine.worker.cleanup(projectDir, worktreePath);
  } catch (err) {
    engine.log("orchestrate: failed to clean up a worktree");
  }
}

// M7c Task 5: `runId`, when supplied (the same runId threaded through this
// run's own cancelSignal lookup above), is included on every notification so
// a client with more than one concurrent orchestrate run can filter progress
// to just its own -- omitted entirely (not even `runId: undefined`) when no
// runId was given, so an older/runId-less caller sees the exact same shape
// as before this task.
function progress(engine: Engine, stage: string, detail: string, runId?: string): void {
  engine.notify("orchestrate.progress", runId !== undefined ? { stage, detail, runId } : { stage, detail });
}

// Lifts the worktree breadcrumb a failed engine.worker.run (worker/
// methods.ts) or runEscalation (below) call carries in its thrown
// RpcMethodError's `data` -- only the error THEY threw reliably knows that
// attempt's path; the caller's own `lastWorktree` local can already be
// stale/null by the time this fires (an earlier attempt's worktree was
// cleaned up before this LATER attempt threw), so trusting it instead of
// this lift would silently discard a real, still-on-disk worktree.
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

// Fix 2 (final review): candidates.prepare's own thrown errors must NOT be
// blanket-downgraded to "verification incomplete" -- only a genuine
// verification-COMMAND failure (candidates/service.ts's "command-failed"
// reasonCode) earns that soft path; a cancellation or any other error (e.g.
// an unavailable backend, a real bug) must propagate to the caller.
function isVerificationCommandFailure(err: unknown): boolean {
  return (
    err instanceof RpcMethodError &&
    typeof err.data === "object" &&
    err.data !== null &&
    (err.data as { reasonCode?: unknown }).reasonCode === "command-failed"
  );
}

interface EscalationResult {
  worktree: Worktree;
  authorSessionId: string;
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
  frontier: FrontierSelection,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<EscalationResult> {
  const adapter = engine.frontier.getAdapter(frontier.engine);
  if (adapter === undefined) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown frontier engine: ${frontier.engine}`);
  }
  const capabilities = await adapter.capabilities?.();
  if (capabilities?.sandboxCompatibility !== "certified") {
    throw new RpcMethodError(
      RpcErrorCodes.SERVER_ERROR,
      "frontier authoring is disabled because the selected runtime has no certified sandbox",
      { reasonCode: "backend-unsupported" },
    );
  }
  const manager = await engine.worker.getManager(params.projectDir);
  const worktree = await manager.create(randomUUID(), params.taskSnapshot?.baseSha);

  try {
    // wikiMcpUrl stays keyed off the BASE project (params.projectDir) — the
    // escalation still wants the base repo's wiki context — independent of
    // the session's cwd (below), which is now the worktree, not the base
    // repo.
    const wikiMcp = params.wikiMcp !== undefined
      ? params.wikiMcp
      : await attachedWikiMcp(engine, params.projectDir);
    const session = await engine.providerGateway.createFrontierSession(adapter, {
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
      wikiMcpUrl: wikiMcp?.url ?? null,
      ...(wikiMcp === null ? {} : { wikiMcpBearerToken: wikiMcp.bearerToken }),
      log: engine.log,
      model: frontier.model,
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
        abortSignal,
      );
      const diff = await manager.diff(worktree);
      const diffStat = await manager.diffStat(worktree);
      return {
        worktree,
        authorSessionId: session.id,
        diff,
        diffStat,
        text: turn.text,
        costUsd: turn.costUsd,
      };
    } finally {
      await engine.frontier.closeSession(session);
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
  const reviewFrontier = resolveFrontierSelection(params.frontier?.review);
  const escalationFrontier = resolveFrontierSelection(params.frontier?.escalation);
  // M7b Task 2: READ-ONLY lookup only — orchestrate() never register()s or
  // deregister()s a runId's controller (see OrchestrateParams.runId's own
  // doc comment and cancel-registry.ts's header comment for the ownership
  // split this depends on). `undefined` both when no runId was given at all
  // and when a given runId doesn't (yet, or any longer) resolve to a
  // registered controller — either way, every downstream `abortSignal?.`
  // check below degrades to a no-op, so an un-cancellable run behaves
  // exactly as it did before this task.
  const cancelSignal = params.runId !== undefined ? engine.cancelRegistry.get(params.runId)?.signal : undefined;
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
  let knownUsd = 0;
  let pricedCalls = 0;
  let unpricedCalls = 0;
  let candidateRef: CandidateRef | null = null;
  let verificationIncomplete = false;
  // FIX (Phase 0 stabilize, Task 2 — root cause of both evals-run
  // failures): a supervisor's own `taskSnapshot` (RunSupervisor.initialize,
  // runtime/supervisor.ts) is captured ONCE, against `supervisor.projectDir`
  // — the top-level run's own directory. That's a safe, ready-made
  // snapshot to reuse here ONLY when THIS orchestrate() call operates
  // against that SAME directory, which is always true for the direct
  // engine.orchestrate RPC path (orchestrate/methods.ts hands runKernel.run
  // and orchestrate() the identical params.projectDir). It is NOT true for
  // evals/run.ts's per-task harness arm: runHarnessTask shares ONE
  // top-level supervisor (captured against the real project being
  // evaluated) across every per-task orchestrate() call, each scoped to its
  // OWN ephemeral scratch `harnessDir` copy — a different git repo with its
  // own HEAD/baseSha and its own freshly-written harness generation.
  // Trusting the mismatched snapshot there used to fail two ways: the
  // "harness changed after task snapshot capture" guard below always fired
  // (a fresh scratch copy's harness generationId can never equal the real
  // project's), and — had that guard not caught it — every later use of
  // `taskSnapshot.baseSha` (runEscalation's worktree creation, worker.run's
  // params) would have pinned a baseSha from the WRONG repository entirely.
  // Comparing directories here and falling through to a fresh capture
  // (below) when they disagree keeps the identity check meaningful for both
  // callers instead of only the direct-RPC one, with no change in behavior
  // for that direct-RPC case (the comparison always passes there).
  let taskSnapshot = params.taskSnapshot ??
    (params.supervisor !== undefined && params.supervisor.projectDir === path.resolve(params.projectDir)
      ? params.supervisor.taskSnapshot
      : undefined);

  const recordCost = (costUsd: number | null, confidence: CostEstimate["confidence"]): void => {
    if (costUsd === null) unpricedCalls += 1;
    else {
      knownUsd += costUsd;
      pricedCalls += 1;
    }
    params.supervisor?.recordCost(costUsd, confidence);
  };

  const currentCostEstimate = (): CostEstimate =>
    params.supervisor?.costEstimate() ?? {
      knownUsd,
      completeness: unpricedCalls === 0
        ? pricedCalls === 0
          ? "none"
          : "complete"
        : pricedCalls === 0
          ? "none"
          : "partial",
      unpricedCalls,
      pricingVersion: "pricing-v1",
      confidence: unpricedCalls > 0
        ? pricedCalls > 0
          ? "mixed"
          : "unpriced"
        : "estimated",
    };

  const nextAttemptNumber = (): number => attempts.length + 1;

  // Accumulated across worker attempts (last successful/approved attempt wins
  // for display; failures still contribute error counters when present).
  let lastToolCallCounts: Record<string, number> | undefined;
  let lastToolErrorCounts: Record<string, number> | undefined;
  let lastEditFailCount: number | undefined;
  let lastDialectPack: string | undefined;
  let contextBranch: OrchestrateResult["contextBranch"] = "none";

  function finish(
    outcome: OrchestrateResult["outcome"],
    agentName: string,
    taskClass: string,
    resolution: OrchestrateResult["resolution"],
    diff: string,
    diffStat: string,
    worktree: { path: string; branch: string } | null,
    routeId: string,
  ): OrchestrateResult {
    progress(engine, "done", `outcome: ${outcome}`, params.runId);
    const family = resolution === "frontier" ? undefined : resolution.family;
    const dialectPack =
      resolution === "frontier" ? lastDialectPack : (lastDialectPack ?? resolution.dialectPack);
    if (taskSnapshot === undefined) throw new Error("orchestrate finished without a task snapshot");
    const costEstimate = currentCostEstimate();
    return {
      outcome,
      agent: agentName,
      taskClass,
      resolution,
      frontier: { review: reviewFrontier, escalation: escalationFrontier },
      taskSnapshot,
      candidateRef,
      ...(verificationIncomplete ? { verificationIncomplete: true } : {}),
      routeId,
      family,
      dialectPack,
      contextBranch,
      toolCallCounts: lastToolCallCounts,
      toolErrorCounts: lastToolErrorCounts,
      editFailCount: lastEditFailCount,
      attempts,
      diff,
      diffStat,
      worktree,
      cost: {
        workerUsd,
        reviewUsd,
        frontierUsd: addCost(reviewUsd, escalateUsd),
        escalateUsd,
        totalUsd: costEstimate.completeness === "complete" ? costEstimate.knownUsd : null,
        note: "estimate-class",
      },
      costEstimate,
    };
  }

  try {
    progress(engine, "load", "loading harness bundle", params.runId);
    requireGitRepo(params.projectDir);
    taskSnapshot ??= await captureTaskSnapshot(engine, params.projectDir);
    params.taskSnapshot = taskSnapshot;
    if (taskSnapshot.dirtyState.category !== "clean") {
      progress(
        engine,
        "snapshot",
        `working tree is ${taskSnapshot.dirtyState.category}; workers use committed HEAD and exclude those edits`,
        params.runId,
      );
    }
    let harnessSnapshot;
    try {
      harnessSnapshot = loadHarnessSnapshot(params.projectDir);
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
    if (harnessSnapshot === null) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no harness; run engine.harness.generate first");
    }
    if (
      harnessSnapshot.generationId !== taskSnapshot.harnessGeneration ||
      harnessSnapshot.fingerprint.digest !== taskSnapshot.harnessFingerprint
    ) {
      throw new RpcMethodError(
        RpcErrorCodes.SERVER_ERROR,
        "harness changed after task snapshot capture",
        { reasonCode: "base-changed" },
      );
    }
    const harness = harnessSnapshot.bundle;
    const issues = validateHarness(harness);
    if (issues.length > 0) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "harness failed structural validation", { issues });
    }

    progress(engine, "route", "classifying and routing the task", params.runId);
    let routed = routeTask(params.task, harness, engine.models.registry);
    const harnessFingerprint = fingerprintHarness(harness).digest;
    const routingOverride = params.experimentVariant === undefined
      ? engine.runtime.evidence.resolve(
          engine.runtime.getStore(params.projectDir),
          harnessFingerprint,
          {
            taskClass: routed.taskClass,
            difficulty: routed.difficulty,
            harnessFingerprint,
            projectFingerprint: taskSnapshot.projectDigest,
          },
        )
      : null;
    if (routingOverride !== null) {
      const taskEntries = Object.entries(harness.routing.taskClasses);
      const matched = taskEntries.find(([taskClass, entry]) =>
        ("routeId" in entry ? entry.routeId : undefined) === routingOverride.routeId ||
        `tc:${taskClass}` === routingOverride.routeId);
      const defaultRouteId = harness.routing.version === 2
        ? (harness.routing.defaults.routeId ?? "tc:default")
        : "tc:default";
      const overrideAgent = matched?.[1].agent ??
        (routingOverride.routeId === defaultRouteId ? harness.routing.defaults.agent : undefined);
      if (overrideAgent !== undefined) {
        const resolved = resolveNamedAgent(overrideAgent, harness, engine.models.registry);
        routed = {
          ...routed,
          agent: resolved.agent,
          resolution: resolved.resolution === "frontier"
            ? "frontier"
            : { ...resolved.resolution, dialectPack: routingOverride.dialectPack },
          routeId: routingOverride.routeId,
          agentChain: [resolved.agent.name],
        };
      }
    }
    progress(engine, "route", `routed to agent "${routed.agent.name}" (class ${routed.taskClass})`, params.runId);

    // M6 Task 6: computed ONCE per run (the harness's own pages/manifest
    // never change between worker attempts) and threaded into every
    // engine.worker.run call below via its `wikiDigest` param — see
    // buildWorkerContext's own doc comment (above) for the ETH-anti-pattern
    // injection-swap rationale (approved card first, build-and-test fallback
    // second, nothing otherwise). Only the branch NAME is ever logged or
    // notified (immediately below) — the digest TEXT itself never reaches
    // engine.log or a notification, same posture as `params.task` and every
    // worker/frontier summary this pipeline handles.
    const workerContext = buildWorkerContext(harness);
    contextBranch = workerContext.branch;
    progress(engine, "load", `worker context: ${workerContext.branch}`, params.runId);
    const taskContract: TaskContract = params.taskContract ?? {
      schemaVersion: 1,
      requirements: [params.task],
      constraints: [],
      verificationCommands: [],
    };
    // The independent reviewer must see the same structured contract whose
    // digest is bound into the candidate coverage report. JSON encoding keeps
    // every user string unambiguous without duplicating the full candidate
    // diff in the prompt.
    const reviewerTask = JSON.stringify({ request: params.task, contract: taskContract });
    const taskWikiMcp = params.wikiMcp !== undefined
      ? params.wikiMcp
      : await attachedWikiMcp(engine, params.projectDir);

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
      // Walk agentChain: each failed attempt may advance to the next chain
      // agent (cheaper → stronger) before frontier escalation.
      let chainIndex = 0;
      let currentAgent = routed.agent;
      let currentResolution: WorkerResolution | "frontier" = routed.resolution;
      // Final review Fix 3: set right after the FIRST attempt completes
      // (empty or reviewed), so attempt 2+'s buildWorkerTask call below can
      // append what went wrong — attempt 1 always sees `undefined` here (no
      // prior attempt exists yet), matching this fix's "attempt-1 task is
      // unchanged" contract.
      let priorAttempt: PriorAttempt | undefined;

      for (let i = 0; i < maxWorkerAttempts; i++) {
        if (currentResolution === "frontier") break;
        // Narrowed: currentResolution is WorkerResolution past the check above.
        const workerRes = currentResolution as WorkerResolution;
        const { providerId, model, dialectPack } = workerRes;
        const n = nextAttemptNumber();
        progress(
          engine,
          `worker:${n}`,
          `running worker attempt ${n}/${maxWorkerAttempts} agent=${currentAgent.name}`,
          params.runId,
        );

        let workerResult: WorkerRunResult;
        const resumedWorker = i === 0 ? params.resumeWorker : undefined;
        const workerTask = resumedWorker?.task ?? buildWorkerTask(currentAgent, params.task, priorAttempt);
        try {
          workerResult = await engine.worker.run(engine, {
            projectDir: params.projectDir,
            task: workerTask,
            wikiDigest: resumedWorker?.wikiDigest ?? workerContext.text,
            providerId: resumedWorker?.providerId ?? providerId,
            model: resumedWorker?.model ?? model,
            dialectPack: resumedWorker?.dialectPack ?? (
              params.experimentVariant === "generic-worker" ? "string-edit-default" : dialectPack
            ),
            experimentVariant: params.experimentVariant,
            // Fix 1: unlike reviewTimeoutMs/escalateTimeoutMs above, this is
            // deliberately left as `params.workerTimeoutMs` verbatim
            // (possibly undefined) rather than defaulted here —
            // engine.worker.run's OWN handler (worker/methods.ts) already
            // applies its own bounded default (`params.timeoutMs ??
            // DEFAULT_RUN_TIMEOUT_MS`, 600000) whenever this arrives as
            // undefined, so this sub-call is ALREADY self-bounding without
            // orchestrate needing to duplicate that default.
            timeoutMs: params.workerTimeoutMs,
            // M7b Task 2: forwarded VERBATIM (including undefined) — this is
            // the SAME runId this function only ever get()s (see the
            // cancelSignal comment above); engine.worker.run's own handler
            // resolves it to the identical AbortController via the same
            // get()-only read, so engine.cancel({runId}) reaches whichever
            // worker attempt happens to be in flight.
            runId: params.runId,
            parentSessionId: params.runtimeSessionId,
            interactive: params.interactive === true,
            resumeSessionId: resumedWorker?.sessionId,
            approvalResponse: resumedWorker?.approvalResponse,
            baseSha: taskSnapshot.baseSha,
            harnessGeneration: taskSnapshot.harnessGeneration,
            harnessFingerprint: taskSnapshot.harnessFingerprint,
            taskWikiHeadSha: taskSnapshot.wikiHeadSha,
            taskWikiDigest: taskSnapshot.wikiDigest,
          }, params.supervisor);
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
        if (workerResult.paused === true) {
          if (workerResult.sessionId === undefined || workerResult.approvalId === undefined) {
            throw new Error("worker paused without durable approval identifiers");
          }
          throw new OrchestrateApprovalPause({
            workerSessionId: workerResult.sessionId,
            approvalId: workerResult.approvalId,
            worker: {
              task: workerTask,
              providerId: resumedWorker?.providerId ?? providerId,
              model: resumedWorker?.model ?? model,
              ...((resumedWorker?.dialectPack ?? dialectPack) === undefined
                ? {}
                : { dialectPack: resumedWorker?.dialectPack ?? dialectPack }),
            },
          });
        }
        if (workerResult.diff === undefined || workerResult.diffStat === undefined) {
          throw new Error("worker completed without an exact diff result");
        }
        workerUsd = addCost(workerUsd, workerResult.costUsd);
        if (params.supervisor === undefined) {
          recordCost(workerResult.costUsd, workerResult.costUsd === null ? "unpriced" : "estimated");
        }
        // Tentatively tracked as soon as it's known to exist — see the
        // `lastWorktree` doc comment above.
        lastWorktree = workerResult.worktree;
        lastToolCallCounts = workerResult.toolCallCounts;
        lastToolErrorCounts = workerResult.toolErrorCounts;
        lastEditFailCount = workerResult.editFailCount;
        lastDialectPack = workerResult.dialectPack ?? dialectPack;

        if (workerResult.diff.trim().length === 0) {
          attempts.push({ n, kind: "worker", summary: workerResult.summary, empty: true });
          await cleanupWorktree(engine, params.projectDir, workerResult.worktree.path);
          lastWorktree = null;
          priorAttempt = { empty: true };
          // Advance chain on empty diff when a next agent exists.
          if (chainIndex + 1 < routed.agentChain.length) {
            chainIndex += 1;
            const next = resolveNamedAgent(routed.agentChain[chainIndex]!, harness, engine.models.registry);
            currentAgent = next.agent;
            currentResolution = next.resolution;
          }
          continue;
        }

        progress(engine, `verify:${n}`, "materializing and deterministically verifying the exact candidate", params.runId);
        const candidateWorktree: Worktree = {
          id: path.basename(workerResult.worktree.path),
          path: workerResult.worktree.path,
          branch: workerResult.worktree.branch,
          base: params.projectDir,
          baseSha: taskSnapshot.baseSha,
        };
        let prepared;
        try {
          prepared = await engine.candidates.prepare(engine, {
            projectDir: params.projectDir,
            worktree: candidateWorktree,
            snapshot: taskSnapshot,
            contract: taskContract,
            signal: cancelSignal,
          });
        } catch (err) {
          if (cancelSignal?.aborted) throw err;
          if (!isVerificationCommandFailure(err)) throw err;
          verificationIncomplete = true;
          const verdict: ReviewVerdict = {
            decision: "request-changes",
            reasons: ["Deterministic verification was incomplete."],
            severity: "major",
          };
          attempts.push({ n, kind: "worker", summary: workerResult.summary, verdict });
          await cleanupWorktree(engine, params.projectDir, workerResult.worktree.path);
          lastWorktree = null;
          return finish(
            "failed",
            currentAgent.name,
            routed.taskClass,
            currentResolution,
            workerResult.diff,
            workerResult.diffStat,
            null,
            routed.routeId,
          );
        }

        progress(engine, `review:${n}`, "reviewing the verified candidate in its exact read-only tree", params.runId);
        const adapter = engine.frontier.getAdapter(reviewFrontier.engine);
        if (adapter === undefined) {
          throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown frontier engine: ${reviewFrontier.engine}`);
        }
        const reviewerCapabilities = await adapter.capabilities?.();
        if (reviewerCapabilities?.sandboxCompatibility !== "certified") {
          verificationIncomplete = true;
          const verdict: ReviewVerdict = {
            decision: "request-changes",
            reasons: ["No compliant independent read-only reviewer is available."],
            severity: "major",
          };
          attempts.push({ n, kind: "worker", summary: workerResult.summary, verdict });
          await cleanupWorktree(engine, params.projectDir, workerResult.worktree.path);
          lastWorktree = null;
          return finish(
            "failed",
            currentAgent.name,
            routed.taskClass,
            currentResolution,
            prepared.canonical.diff,
            prepared.diffStat,
            null,
            routed.routeId,
          );
        }
        const reviewSession = await engine.providerGateway.createFrontierSession(adapter, {
          projectDir: workerResult.worktree.path,
          wikiMcpUrl: taskWikiMcp?.url ?? null,
          ...(taskWikiMcp === null ? {} : { wikiMcpBearerToken: taskWikiMcp.bearerToken }),
          log: engine.log,
          model: reviewFrontier.model,
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
            {
              task: reviewerTask,
              diff: "",
              summary: workerResult.summary,
              verifierEvidence: JSON.stringify(
                prepared.reports.map((report) => ({
                  stageId: report.stageId,
                  verdict: report.verdict,
                  outputRef: report.outputRef,
                })),
              ),
            },
            {
              timeoutMs: reviewTimeoutMs,
              abortSignal: cancelSignal,
              beforePrompt: () => params.supervisor?.reserveModelCall(),
              onAttemptCost: (cost) => recordCost(cost, cost === null ? "unpriced" : "verified"),
            },
          );
          verdict = reviewResult.verdict;
          reviewUsd = addCost(reviewUsd, reviewResult.costUsd);
        } finally {
          await engine.frontier.closeSession(reviewSession);
          untrackReviewSession();
        }

        attempts.push({ n, kind: "worker", summary: workerResult.summary, verdict });

        if (verdict.decision === "approve") {
          candidateRef = engine.candidates.mint({
            projectDir: params.projectDir,
            worktree: candidateWorktree,
            snapshot: taskSnapshot,
            prepared,
            authorAttemptId: `attempt-${n}`,
            authorSessionId: workerResult.runId ?? candidateWorktree.id,
            reviewerSessionId: reviewSession.id,
            verdict,
          });
          return finish(
            "worker-approved",
            currentAgent.name,
            routed.taskClass,
            currentResolution,
            prepared.canonical.diff,
            prepared.diffStat,
            workerResult.worktree,
            routed.routeId,
          );
        }

        await cleanupWorktree(engine, params.projectDir, workerResult.worktree.path);
        lastWorktree = null;
        priorAttempt = { verdict };
        // Advance chain on rejection when a next agent exists.
        if (chainIndex + 1 < routed.agentChain.length) {
          chainIndex += 1;
          const next = resolveNamedAgent(routed.agentChain[chainIndex]!, harness, engine.models.registry);
          currentAgent = next.agent;
          currentResolution = next.resolution;
        }
      }
    }

    // Escalate: either routing resolved straight to "frontier", or every
    // worker attempt above was rejected or produced an empty diff.
    progress(engine, "escalate", "escalating to a lead model with write access", params.runId);
    let escalation: EscalationResult;
    try {
      params.supervisor?.reserveModelCall();
      escalation = await runEscalation(
        engine,
        params,
        routed.agent,
        escalationFrontier,
        escalateTimeoutMs,
        cancelSignal,
      );
    } catch (err) {
      // Mirrors the worker-attempt catch's identical lift, above.
      const worktree = liftWorktreeFromError(err);
      if (worktree !== undefined) lastWorktree = worktree;
      throw err;
    }
    escalateUsd = addCost(escalateUsd, escalation.costUsd);
    recordCost(escalation.costUsd, escalation.costUsd === null ? "unpriced" : "verified");
    lastWorktree = escalation.worktree;

    const n = nextAttemptNumber();
    if (escalation.diff.trim().length === 0) {
      attempts.push({ n, kind: "frontier", summary: escalation.text, empty: true });
      await cleanupWorktree(engine, params.projectDir, escalation.worktree.path);
      lastWorktree = null;
      return finish(
        "failed",
        routed.agent.name,
        routed.taskClass,
        routed.resolution,
        "",
        "",
        null,
        routed.routeId,
      );
    }

    let prepared;
    try {
      prepared = await engine.candidates.prepare(engine, {
        projectDir: params.projectDir,
        worktree: escalation.worktree,
        snapshot: taskSnapshot,
        contract: taskContract,
        signal: cancelSignal,
      });
    } catch (err) {
      if (cancelSignal?.aborted) throw err;
      if (!isVerificationCommandFailure(err)) throw err;
      verificationIncomplete = true;
      attempts.push({
        n,
        kind: "frontier",
        summary: escalation.text,
        verdict: {
          decision: "request-changes",
          reasons: ["Deterministic verification was incomplete."],
          severity: "major",
        },
      });
      await cleanupWorktree(engine, params.projectDir, escalation.worktree.path);
      lastWorktree = null;
      return finish(
        "failed",
        routed.agent.name,
        routed.taskClass,
        routed.resolution,
        escalation.diff,
        escalation.diffStat,
        null,
        routed.routeId,
      );
    }

    const reviewAdapter = engine.frontier.getAdapter(reviewFrontier.engine);
    const reviewCapabilities = await reviewAdapter?.capabilities?.();
    if (reviewAdapter === undefined || reviewCapabilities?.sandboxCompatibility !== "certified") {
      verificationIncomplete = true;
      attempts.push({
        n,
        kind: "frontier",
        summary: escalation.text,
        verdict: {
          decision: "request-changes",
          reasons: ["No compliant independent read-only reviewer is available."],
          severity: "major",
        },
      });
      await cleanupWorktree(engine, params.projectDir, escalation.worktree.path);
      lastWorktree = null;
      return finish(
        "failed",
        routed.agent.name,
        routed.taskClass,
        routed.resolution,
        prepared.canonical.diff,
        prepared.diffStat,
        null,
        routed.routeId,
      );
    }
    const reviewSession = await engine.providerGateway.createFrontierSession(reviewAdapter, {
      projectDir: escalation.worktree.path,
      wikiMcpUrl: taskWikiMcp?.url ?? null,
      ...(taskWikiMcp === null ? {} : { wikiMcpBearerToken: taskWikiMcp.bearerToken }),
      log: engine.log,
      model: reviewFrontier.model,
      resultLabel: "frontier-review",
    });
    const untrackReview = engine.frontier.track(reviewSession);
    let escalationVerdict: ReviewVerdict;
    try {
      const reviewResult = await reviewDiff(
        reviewSession,
        {
          task: reviewerTask,
          diff: "",
          summary: escalation.text,
          verifierEvidence: JSON.stringify(
            prepared.reports.map((report) => ({
              stageId: report.stageId,
              verdict: report.verdict,
              outputRef: report.outputRef,
            })),
          ),
        },
        {
          timeoutMs: reviewTimeoutMs,
          abortSignal: cancelSignal,
          beforePrompt: () => params.supervisor?.reserveModelCall(),
          onAttemptCost: (cost) => recordCost(cost, cost === null ? "unpriced" : "verified"),
        },
      );
      escalationVerdict = reviewResult.verdict;
      reviewUsd = addCost(reviewUsd, reviewResult.costUsd);
    } finally {
      await engine.frontier.closeSession(reviewSession);
      untrackReview();
    }
    attempts.push({ n, kind: "frontier", summary: escalation.text, verdict: escalationVerdict });
    if (escalationVerdict.decision !== "approve") {
      await cleanupWorktree(engine, params.projectDir, escalation.worktree.path);
      lastWorktree = null;
      return finish(
        "failed",
        routed.agent.name,
        routed.taskClass,
        routed.resolution,
        prepared.canonical.diff,
        prepared.diffStat,
        null,
        routed.routeId,
      );
    }
    candidateRef = engine.candidates.mint({
      projectDir: params.projectDir,
      worktree: escalation.worktree,
      snapshot: taskSnapshot,
      prepared,
      authorAttemptId: `attempt-${n}`,
      authorSessionId: escalation.authorSessionId,
      reviewerSessionId: reviewSession.id,
      verdict: escalationVerdict,
    });
    return finish(
      "escalated",
      routed.agent.name,
      routed.taskClass,
      routed.resolution,
      prepared.canonical.diff,
      prepared.diffStat,
      escalation.worktree,
      routed.routeId,
    );
  } catch (err) {
    if (err instanceof OrchestrateApprovalPause) throw err;
    // M7b Task 2: checked via cancelSignal's OWN `.aborted` flag rather than
    // `instanceof RunCancelledError` -- an intermediate catch (e.g.
    // runEscalation's) may have already re-wrapped it by the time it lands here.
    const cancelled = cancelSignal?.aborted === true;
    // Nothing ran yet (a load/route failure) -> pass the original error
    // through untouched, UNLESS this is a cancellation, which always gets
    // its own dedicated "orchestrate cancelled" marker.
    if (attempts.length === 0 && lastWorktree === null) {
      if (cancelled) {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "orchestrate cancelled", {
          cancelled: true,
          attempts: [],
          worktree: null,
        });
      }
      throw err;
    }
    // Cancellation flows through the same "leave lastWorktree, report its
    // path" breadcrumb discipline every other failure here already uses.
    const message = err instanceof Error ? err.message : String(err);
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `orchestrate failed: ${message}`, {
      attempts,
      worktree: lastWorktree,
      ...(cancelled ? { cancelled: true } : {}),
    });
  }
}
