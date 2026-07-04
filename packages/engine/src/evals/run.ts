// engine.evals.run — the M6 EXIT CRITERION: the baseline-vs-harness report
// card. This MEASURES whether the harness (cheap worker + review +
// escalate-if-needed, engine.orchestrate) saves cost relative to a frontier
// doing the task directly (the baseline), AT HELD QUALITY — and FLAGS the
// ETH hazard (spec §12.1): a harness whose pass rate is materially below the
// baseline's is a "fail" verdict, never quietly reported as a savings win.
//
// --- Baseline-vs-harness wiring (read this before changing the flow) ------
//
// Per task, TWO fresh scratch directories are created (see the TMP-placement
// note below) and independently seeded via the task's own `setup()`:
//
//   BASELINE: a frontier session is opened DIRECTLY (bypassing
//   engine.frontier.start entirely — mirrors orchestrate.ts's runEscalation
//   "frontier does the task directly, write-scoped to one directory"
//   primitive) with toolPolicy.writeScope = [baselineDir] and cwd =
//   baselineDir. No wiki is attached and no harness routing is involved —
//   that is the entire point of a baseline: what would a frontier do with
//   NONE of the harness's help? Once the turn completes, runOracle scores
//   baselineDir directly (no diff/apply step — the frontier edited files
//   in place).
//
//   HARNESS: engine.orchestrate (../orchestrate/orchestrate.ts) is invoked
//   with `projectDir: <the REAL project being evaluated>` — NOT harnessDir —
//   because orchestrate needs the real project's `.openfusion/` harness
//   bundle for routing/wiki, and because runEscalation/engine.worker.run
//   always operate through THAT project's own WorktreeManager (a fresh
//   `git worktree add ... HEAD` checkout of the real project, sharing its
//   object store). There is no parameter on engine.orchestrate to redirect
//   its internal worktree at an arbitrary external directory or base
//   commit, so orchestrate's own worktree is unavoidably a scratch space
//   inside the REAL project, disconnected from harnessDir's task.setup()
//   state. The pipeline therefore: (1) runs the full orchestrate loop
//   against the real project to get back a `diff`, (2) applies that diff
//   onto harnessDir via engine.orchestrate.apply (git apply --3way — the
//   exact mechanism a human reviewer would use), (3) scores harnessDir with
//   runOracle, and (4) cleans up orchestrate's OWN worktree in the real
//   project (engine.worker.cleanup) since it was only ever scratch space for
//   producing the diff — the artifact this pipeline actually cares about is
//   the diff APPLIED to harnessDir, not the worktree it came from.
//
//   KNOWN v1 LIMITATION: step (2) can fail. `git apply` matches by textual
//   context (or, with --3way, by the preimage blob's presence in the
//   target's OWN object store) — it has no notion that harnessDir and the
//   real project's worktree are "the same task, different directories". If
//   the worker/frontier creates a file at a path that does not already
//   exist in the real project (so the diff is a "new file" patch) AND that
//   same path already exists in harnessDir (because task.setup() put a
//   pre-change stub there — which it must, for the oracle to have anything
//   to fail against), the apply fails with "already exists". This is most
//   likely for synthetic fixture tasks; for golden tasks mined from the
//   real project's OWN history (where the file being fixed typically already
//   exists at HEAD), the diff is ordinarily a "modify" patch that applies by
//   context regardless of the two directories' disconnected object stores.
//   A failed apply is scored as a failed task (`harnessOutcome:
//   "apply-failed"`), not a crashed run — a patch that doesn't compose with
//   the target environment is itself a legitimate (if blunt) failure
//   signal, matching SWE-bench's own convention.
//
// --- TMP placement (CRITICAL security constraint, inherited from Task 3) --
//
// Both scratch directories are created via `mkdtemp(os.tmpdir())` —
// deliberately AWAY from both the real project's directory and (for a
// golden task) the mined repo's directory. goldenTaskFromCommit's own
// "unreachable by construction" guarantee is a GIT-GRAPH-only property (no
// history/remote/reflog points back at the source repo); it does NOT
// guarantee an adversarial worker process can't reach the real project by
// another channel (a known filesystem path + `git fetch <path> <sha>`, or a
// raw filesystem read). Placing the scratch dirs under the OS's shared tmp
// directory, never nested inside the project being evaluated, is this
// pipeline's own contribution to that guarantee. Eval integrity against a
// worker that deliberately tries to reach outside its scratch directory
// still ultimately rests on the worker/frontier tool sandbox (path-scoped
// bash/read/write — worker/tools.ts, path-scope.ts): full process-level
// isolation is deferred to M7. v1 assumes a NON-ADVERSARIAL worker. Both
// scratch directories are pure eval machinery (never a user-facing
// deliverable the way orchestrate's own worktrees are) and are always
// removed after scoring, success or failure.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import type { FrontierSession } from "../engines/types.js";
import type { PricingConfidence } from "../models/meter.js";
import { validateHarness } from "../harness/schema.js";
import { HarnessValidationError, loadHarness, setEvalsVerdict } from "../harness/store.js";
import { orchestrate, type OrchestrateResult } from "../orchestrate/orchestrate.js";
import { RpcMethodError } from "../rpc/errors.js";
import { requireGitRepo } from "../rpc/guards.js";
import type { EvalTask } from "./tasks.js";
import { runOracle } from "./tasks.js";

const execFileAsync = promisify(execFile);

// The only frontier engine kind this pipeline (or engine.orchestrate) drives
// today — mirrors orchestrate.ts's own FRONTIER_KIND constant.
const FRONTIER_KIND = "claude-code";

// A full editing turn, comparable in scope to orchestrate.ts's own
// escalation attempt — mirrors its DEFAULT_ESCALATE_TIMEOUT_MS exactly,
// since the baseline primitive IS "a frontier does the task directly",
// structurally identical to escalation.
const DEFAULT_BASELINE_TIMEOUT_MS = 600_000;

// Anthropic eval guidance (docs/research/2026-07-04-m6-pricing-eval-
// verification.md, "Sample size"): a 5-task run is a demo, not a claim — a
// credible savings claim wants 20-50 paired tasks. Below this threshold the
// verdict is always "inconclusive" regardless of how good the numbers look,
// so a quick CI/demo run can never be mistaken for a real measurement.
const MIN_TASK_COUNT_FOR_VERDICT = 5;

export interface EvalsRunParams {
  projectDir: string;
  // Full, already-constructed EvalTask objects (setup() closures and all) —
  // this is the engine-internal API. The RPC surface (./methods.ts) only
  // ever accepts JSON-safe golden-commit descriptors and reconstructs
  // EvalTask[] via goldenTaskFromCommit before calling this function; see
  // methods.ts's own header comment for why synthEvalTask fixtures can never
  // cross a real wire.
  tasks: EvalTask[];
  sampleNote?: string;
}

// The harness side's per-task result, one step wider than
// OrchestrateResult["outcome"] to name the two ways scoring can fail WITHOUT
// engine.orchestrate itself having failed: "apply-failed" (see this module's
// header comment on the known v1 limitation) and "error" (engine.orchestrate
// itself threw — an infra hiccup on ONE task must not abort the whole
// report card; see runHarnessTask below).
export type HarnessTaskOutcome = OrchestrateResult["outcome"] | "apply-failed" | "error";

export interface PerTaskResult {
  id: string;
  baselinePassed: boolean;
  harnessPassed: boolean;
  harnessOutcome: HarnessTaskOutcome;
  baselineUsd: number | null;
  harnessUsd: number | null;
}

export interface EvalsReportCard {
  taskCount: number;
  baseline: { passed: number; costUsd: number | null };
  harness: { passed: number; costUsd: number | null; escalations: number };
  // (baseline.costUsd - harness.costUsd) / baseline.costUsd — null unless
  // BOTH totals are priced (never divides by a zero/null baseline either;
  // see the computation below).
  savingsPct: number | null;
  // harness.passed >= baseline.passed (M6 v1 tolerance: harness not worse).
  qualityHeld: boolean;
  verdict: "pass" | "fail" | "inconclusive";
  // Worst PricingConfidence across every cost record this run produced
  // (engine.models.meter.totals().pricingConfidence) — taints the savings
  // claim even when the arithmetic itself looks fine.
  pricingConfidence: PricingConfidence;
  perTask: PerTaskResult[];
  note: string;
}

// Null-safe running total — same shape as orchestrate.ts's own addCost (and
// harness/driver.ts's/harness/generate.ts's copies): null contributes
// nothing; the running total only becomes (and then stays) a number once
// ANY addend is one. Duplicated locally rather than exported/shared, per
// this codebase's own established precedent for this exact three-line
// helper (see orchestrate.ts's doc comment on its own copy).
function addCost(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}

function progress(engine: Engine, stage: string, taskId?: string): void {
  engine.notify("evals.progress", taskId !== undefined ? { stage, taskId } : { stage });
}

// Invokes an already-registered engine.* RPC method through the engine's own
// in-process dispatcher — mirrors orchestrate.ts's own private
// callEngineMethod helper exactly (duplicated locally since that one isn't
// exported; same "reuse the handler that already owns worktree/apply
// correctness" rationale it documents applies here for
// engine.orchestrate.apply / engine.worker.cleanup).
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

// Drains a frontier turn WITHOUT any JSON-schema expectation — used for the
// baseline primitive below, whose whole point is to make tool calls (write
// scoped to the baseline dir) and finish with a short prose summary, not a
// structured verdict. Mirrors orchestrate.ts's own private runFrontierTurn
// (duplicated locally for the same reason as callEngineMethod above).
async function drainFrontierTurn(
  session: FrontierSession,
  prompt: string,
  timeoutMs: number,
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

// BASELINE primitive: "a frontier does the task directly", write-scoped to
// one throwaway directory, no wiki, no harness routing — see this module's
// header comment. Scored by the SAME oracle the harness side uses, so the
// two are genuinely comparable.
async function runBaselineTask(
  engine: Engine,
  dir: string,
  task: EvalTask,
): Promise<{ passed: boolean; costUsd: number | null }> {
  let costUsd: number | null = null;
  try {
    const adapter = engine.frontier.getAdapter(FRONTIER_KIND);
    if (adapter === undefined) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown frontier engine: ${FRONTIER_KIND}`);
    }
    const session = await adapter.createSession({
      projectDir: dir,
      wikiMcpUrl: null,
      log: engine.log,
      toolPolicy: { writeScope: [dir] },
      // Distinct purpose tag (types.ts's own `resultLabel` mechanism) so a
      // caller driving BOTH this baseline call and orchestrate's own
      // review/escalate calls through the same registered adapter can tell
      // them apart. NOTE (v1 scope): the REAL adapter's onResult -> meter
      // mapping (engines/methods.ts's mapResultLabelToSource) does not know
      // this label and falls back to "frontier-review" for accounting
      // purposes — this pipeline never reads that bucket for its own cost
      // math (baseline.costUsd comes directly off this turn's own events,
      // below), only engine.models.meter.totals().pricingConfidence (which
      // aggregates every record regardless of source) for the report card's
      // pricingConfidence field.
      resultLabel: "eval-baseline",
    });
    // engine.close() must be able to reach this session even though it was
    // opened directly off the adapter (bypassing engine.frontier.start) —
    // mirrors orchestrate.ts's identical track()/untrack() use for its own
    // review/escalation sessions (M6 Task 1's eval-batch safety gate).
    const untrack = engine.frontier.track(session);
    try {
      const turn = await drainFrontierTurn(session, task.prompt, DEFAULT_BASELINE_TIMEOUT_MS);
      costUsd = turn.costUsd;
    } finally {
      await session.close().catch(() => {
        // Best-effort — mirrors orchestrate.ts's identical close() posture.
      });
      untrack();
    }
  } catch (err) {
    // A per-task baseline infra failure (missing adapter, a session/turn
    // that throws) must not abort the WHOLE report card — mirrors
    // runHarnessTask's identical posture for engine.orchestrate below.
    // runOracle is deliberately NOT inside this catch: a runOracle failure
    // is a SETUP error (see tasks.ts's own doc comment — a bad testCommand,
    // not a failed eval) and should propagate out of runEvals entirely, not
    // be silently folded into "baseline failed".
    const message = err instanceof Error ? err.message : String(err);
    engine.log(`evals.run: baseline run failed for task ${task.id}: ${message}`);
    const oracle = await runOracle(dir, task.testCommand);
    return { passed: oracle.passed, costUsd: null };
  }
  const oracle = await runOracle(dir, task.testCommand);
  return { passed: oracle.passed, costUsd };
}

// Lifts the worktree breadcrumb a failed engine.orchestrate call carries in
// its thrown RpcMethodError's `data` — mirrors orchestrate.ts's OWN
// liftWorktreeFromError exactly (duplicated locally for the same reason as
// callEngineMethod/drainFrontierTurn above: that one isn't exported, and the
// shape it reads is orchestrate.ts's own internal contract, not a shared
// type worth exporting for one caller).
function liftWorktreeFromError(err: unknown): { path: string; branch: string } | undefined {
  if (
    err instanceof RpcMethodError &&
    err.data !== undefined &&
    typeof err.data === "object" &&
    err.data !== null &&
    "worktree" in err.data
  ) {
    const worktree = (err.data as { worktree: { path: string; branch: string } | null }).worktree;
    return worktree ?? undefined;
  }
  return undefined;
}

// Best-effort removal of the orchestrate-produced worktree left behind in
// the REAL project (see this module's header comment: it is scratch space
// for producing the diff, not a user-facing deliverable — the diff itself
// is already captured in `result.diff` and independently applied to
// harnessDir). Swallows its own failure: a stray worktree the operator can
// later sweep with engine.worker.gc must never abort the eval run or mask
// its real outcome.
async function cleanupOrchestrateWorktree(engine: Engine, projectDir: string, worktreePath: string): Promise<void> {
  try {
    await callEngineMethod(engine, "engine.worker.cleanup", { projectDir, worktreePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    engine.log(`evals.run: failed to clean up orchestrate worktree ${worktreePath}: ${message}`);
  }
}

// Turns harnessDir into a plain git repo containing task.setup()'s output as
// a single commit — required for engine.orchestrate.apply (git apply
// --3way), whose own requireGitRepo guard rejects a non-git target. A
// goldenTaskFromCommit-produced task's own setup() ALREADY does this (its
// own from-scratch "baseline" commit, tasks.ts's documented history-strip
// mechanism) — re-running `git init`/`commit` unconditionally on top of that
// would find nothing new to commit and fail, so this checks first and is a
// no-op for that case. A synthEvalTask-produced task's setup() does NOT
// touch git at all, so this is what makes ITS output a valid apply target.
async function initEvalGitRepo(dir: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
    // Already a git repo (task.setup() itself initialized one) — nothing
    // more to do.
    return;
  } catch {
    // Not a git repo yet — fall through and create one below.
  }
  await execFileAsync("git", ["-C", dir, "init", "-q"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "eval@openfusion.local"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "openfusion-eval"]);
  await execFileAsync("git", ["-C", dir, "add", "-A"]);
  await execFileAsync("git", ["-C", dir, "commit", "-q", "-m", "eval baseline"]);
}

// HARNESS primitive: the full orchestrate loop, run against the REAL
// project, its diff applied onto harnessDir and scored there — see this
// module's header comment for the full wiring rationale and its known v1
// apply-failure limitation.
async function runHarnessTask(
  engine: Engine,
  realProjectDir: string,
  harnessDir: string,
  task: EvalTask,
): Promise<{ passed: boolean; costUsd: number | null; outcome: HarnessTaskOutcome }> {
  let result: OrchestrateResult;
  try {
    result = await orchestrate(engine, { projectDir: realProjectDir, task: task.prompt });
  } catch (err) {
    // A per-task infra failure (e.g. the frontier adapter throwing) must not
    // abort the WHOLE report card — score this task as not passed and keep
    // going. See HarnessTaskOutcome's own doc comment. orchestrate.ts's own
    // failure path deliberately leaves its worktree on disk (never
    // auto-removed on ITS failure path) and carries the path in the thrown
    // error's `data` (mirrors orchestrate.ts's own liftWorktreeFromError) —
    // lifted here so a per-task throw doesn't leak that worktree in the
    // REAL project across repeated eval runs the way a successful result's
    // worktree is already cleaned up below.
    const message = err instanceof Error ? err.message : String(err);
    engine.log(`evals.run: engine.orchestrate failed for task ${task.id}: ${message}`);
    const worktree = liftWorktreeFromError(err);
    if (worktree !== undefined) {
      await cleanupOrchestrateWorktree(engine, realProjectDir, worktree.path);
    }
    return { passed: false, costUsd: null, outcome: "error" };
  }

  if (result.worktree !== null) {
    await cleanupOrchestrateWorktree(engine, realProjectDir, result.worktree.path);
  }

  if (result.diff.trim().length === 0) {
    // Nothing to apply — harnessDir stays at task.setup()'s pre-change
    // state, so the oracle is expected to fail. This is a legitimate
    // (not mis-scored) failure: the harness produced no change at all.
    const oracle = await runOracle(harnessDir, task.testCommand);
    return { passed: oracle.passed, costUsd: result.cost.totalUsd, outcome: result.outcome };
  }

  try {
    await callEngineMethod(engine, "engine.orchestrate.apply", { projectDir: harnessDir, diff: result.diff });
  } catch (err) {
    // KNOWN v1 LIMITATION — see this module's header comment. A failed
    // apply is scored as a failed task, not a crashed run.
    const message = err instanceof Error ? err.message : String(err);
    engine.log(`evals.run: applying the harness diff failed for task ${task.id}: ${message}`);
    return { passed: false, costUsd: result.cost.totalUsd, outcome: "apply-failed" };
  }

  const oracle = await runOracle(harnessDir, task.testCommand);
  return { passed: oracle.passed, costUsd: result.cost.totalUsd, outcome: result.outcome };
}

function buildNote(opts: {
  taskCount: number;
  pricingConfidence: PricingConfidence;
  sampleNote?: string;
}): string {
  const parts: string[] = [];
  parts.push(
    opts.taskCount < MIN_TASK_COUNT_FOR_VERDICT
      ? `Sample size ${opts.taskCount} task(s) is below the ${MIN_TASK_COUNT_FOR_VERDICT}-task minimum for a credible savings claim (Anthropic eval guidance — see docs/research/2026-07-04-m6-pricing-eval-verification.md) -- this is a demo, not a claim.`
      : `Sample size: ${opts.taskCount} task(s) (a credible claim wants 20-50 paired tasks; treat this as directional).`,
  );
  parts.push("Cost figures are estimate-class (see engine.orchestrate's own cost.note) -- directional, not exact.");
  parts.push(`Pricing confidence: ${opts.pricingConfidence} (the worst confidence across every cost record this run produced).`);
  parts.push(
    "Eval integrity assumes a NON-ADVERSARIAL worker: a worker that deliberately reaches outside its scratch " +
      "directory (e.g. git-fetching the real project directory, or a raw filesystem read) could defeat this " +
      "run's isolation -- full worker process sandboxing is deferred to M7.",
  );
  if (opts.sampleNote !== undefined && opts.sampleNote.length > 0) {
    parts.push(opts.sampleNote);
  }
  return parts.join(" ");
}

// The pipeline itself: guard -> per-task (baseline + harness, both scored by
// the same oracle) -> aggregate -> verdict -> manifest flip. See this
// module's header comment for the full baseline-vs-harness wiring rationale.
export async function runEvals(engine: Engine, params: EvalsRunParams): Promise<EvalsReportCard> {
  requireGitRepo(params.projectDir);

  let harnessBundle;
  try {
    harnessBundle = loadHarness(params.projectDir);
  } catch (err) {
    if (err instanceof HarnessValidationError) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, err.message, { issues: err.issues });
    }
    throw err;
  }
  if (harnessBundle === null) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no harness; run engine.harness.generate first");
  }
  const issues = validateHarness(harnessBundle);
  if (issues.length > 0) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "harness failed structural validation", { issues });
  }
  if (params.tasks.length === 0) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "engine.evals.run requires at least one task");
  }

  progress(engine, "start");

  let baselinePassed = 0;
  let harnessPassed = 0;
  let baselineCostTotal: number | null = null;
  let harnessCostTotal: number | null = null;
  let escalations = 0;
  const perTask: PerTaskResult[] = [];

  for (const task of params.tasks) {
    // TMP placement — see this module's header comment. Never nested inside
    // params.projectDir.
    const baselineDir = await mkdtemp(path.join(os.tmpdir(), "of-eval-baseline-"));
    const harnessDir = await mkdtemp(path.join(os.tmpdir(), "of-eval-harness-"));
    try {
      progress(engine, "baseline", task.id);
      await task.setup(baselineDir);
      const baseline = await runBaselineTask(engine, baselineDir, task);

      progress(engine, "harness", task.id);
      await task.setup(harnessDir);
      await initEvalGitRepo(harnessDir);
      const harnessResult = await runHarnessTask(engine, params.projectDir, harnessDir, task);

      progress(engine, "scored", task.id);

      if (baseline.passed) baselinePassed += 1;
      if (harnessResult.passed) harnessPassed += 1;
      if (harnessResult.outcome === "escalated") escalations += 1;
      baselineCostTotal = addCost(baselineCostTotal, baseline.costUsd);
      harnessCostTotal = addCost(harnessCostTotal, harnessResult.costUsd);

      perTask.push({
        id: task.id,
        baselinePassed: baseline.passed,
        harnessPassed: harnessResult.passed,
        harnessOutcome: harnessResult.outcome,
        baselineUsd: baseline.costUsd,
        harnessUsd: harnessResult.costUsd,
      });
    } finally {
      // Eval scratch is transient (unlike orchestrate's own user-facing
      // worktrees) — always auto-remove, success or failure.
      await rm(baselineDir, { recursive: true, force: true });
      await rm(harnessDir, { recursive: true, force: true });
    }
  }

  progress(engine, "done");

  const taskCount = params.tasks.length;
  const pricingConfidence = engine.models.meter.totals().pricingConfidence;
  const savingsPct =
    baselineCostTotal !== null && harnessCostTotal !== null && baselineCostTotal > 0
      ? (baselineCostTotal - harnessCostTotal) / baselineCostTotal
      : null;
  const qualityHeld = harnessPassed >= baselinePassed;

  let verdict: EvalsReportCard["verdict"];
  if (!qualityHeld) {
    // ETH HAZARD (spec §12.1): the harness degrades quality relative to the
    // baseline — the exact thing evals exist to catch. Never reported as a
    // savings win, regardless of cost.
    verdict = "fail";
  } else if (taskCount < MIN_TASK_COUNT_FOR_VERDICT || savingsPct === null) {
    // Too few tasks (a demo, not a claim) or an unpriced cost figure (the
    // savings arithmetic itself is meaningless) — either way, not enough to
    // stand behind.
    verdict = "inconclusive";
  } else if (savingsPct > 0) {
    verdict = "pass";
  } else {
    // Quality held, priced, enough samples -- but the harness didn't
    // actually save money (savingsPct <= 0). Not a hazard (quality is
    // fine), but not a "saves cost" claim either.
    verdict = "inconclusive";
  }

  // engine.evals.run flips the manifest on a definitive verdict only — an
  // "inconclusive" run leaves manifest.verification.evals exactly as it was
  // (typically "pending" from generation).
  if (verdict === "pass") {
    await setEvalsVerdict(params.projectDir, "pass");
  } else if (verdict === "fail") {
    await setEvalsVerdict(params.projectDir, "fail");
  }

  return {
    taskCount,
    baseline: { passed: baselinePassed, costUsd: baselineCostTotal },
    harness: { passed: harnessPassed, costUsd: harnessCostTotal, escalations },
    savingsPct,
    qualityHeld,
    verdict,
    pricingConfidence,
    perTask,
    note: buildNote({ taskCount, pricingConfidence, sampleNote: params.sampleNote }),
  };
}
