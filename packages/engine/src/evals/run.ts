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
//   with `projectDir: harnessDir` — the SAME base-state scratch directory
//   the oracle scores, NOT the real project being evaluated. This is the
//   Task 4 fix for a CRITICAL measurement-validity flaw in the original v1
//   wiring (kept here, in detail, so it is never reintroduced):
//
//     THE FLAW: the original wiring ran orchestrate against
//     `projectDir: realProjectDir` (the actual project under evaluation, at
//     its CURRENT HEAD), reasoning that orchestrate needs the real
//     project's `.openfusion/` harness bundle for routing/wiki and that
//     worker/escalation worktrees are naturally scoped to a real project's
//     own WorktreeManager. That reasoning is correct about WHY
//     realProjectDir seemed necessary, but wrong about what it costs: for a
//     golden task mined from realProjectDir's OWN history
//     (goldenTaskFromCommit), the eval scratch dirs are seeded at the
//     target commit's PARENT state (the bug/gap present) — but
//     realProjectDir's HEAD, by construction, is usually a DESCENDANT of
//     that commit (the fix is already merged into history). Pointing
//     orchestrate at realProjectDir therefore asks the harness to
//     "implement a change" that is already implemented at the substrate it
//     was handed — best case, the worker/frontier makes no edits at all
//     (an empty diff, since the code already does what's asked), which then
//     gets applied to (or, doing nothing, leaves untouched) a harnessDir
//     that is STILL at the pre-fix parent state — a GUARANTEED oracle
//     failure that has nothing to do with the harness's actual competence.
//     Every real multi-task run (HEAD != every task's own commit parent)
//     would structurally measure ~0% harness pass rate, misreported as a
//     genuine ETH-hazard "fail" and flipping the manifest's evals verdict
//     to "fail" on a measurement artifact, not a quality signal.
//
//     THE FIX: harnessDir itself becomes a fresh, disconnected, throwaway
//     git project AT THE TASK'S OWN BASE STATE, with the harness bundle
//     copied in — so orchestrate works the exact same task, from the exact
//     same starting point, that the baseline and the oracle also work from.
//     Concretely, per task (see the main loop below):
//       1. `task.setup(harnessDir)` — identical to the baseline's own setup
//          call; materializes the pre-change state.
//       2. `initEvalGitRepo(harnessDir)` — ensures harnessDir is a git repo
//          with (at least) one commit (a no-op for golden tasks, whose own
//          setup() already does this as part of its history-strip
//          mechanism; see tasks.ts). This is what makes harnessDir a valid
//          `projectDir` for engine.orchestrate at all: requireGitRepo and
//          WorktreeManager (`git worktree add ... HEAD`) both need a real
//          commit to anchor to.
//       3. `writeHarness(harnessDir, harnessBundle)` — writes the ALREADY
//          LOADED-AND-VALIDATED harness bundle (routing.yaml, wiki/*.md,
//          agents/*.yaml, manifest.json — read once, near the top of
//          runEvals, off the REAL project) into harnessDir's own
//          `.openfusion/`. Deliberately done AFTER step 2's commit (not
//          folded into it), so the copied bundle stays UNTRACKED in
//          harnessDir's git history — it doesn't need to be committed:
//          orchestrate's own loadHarness/attachedWikiMcpUrl calls read
//          `.openfusion/` straight off `params.projectDir`'s filesystem
//          (harnessDir's top-level checkout), never through git, and the
//          worker/escalation child worktrees engine.worker.getManager
//          creates never need `.openfusion` present in THEIR OWN directory
//          either (the wiki digest travels as a plain string param —
//          buildWikiDigestContext in orchestrate.ts — computed once from
//          the bundle object, not re-read from disk per attempt). Reusing
//          writeHarness (the same tested primitive engine.harness.generate
//          itself writes through) instead of a raw recursive directory copy
//          also means this can never accidentally drag in
//          `.openfusion/cache/` (the wiki symbol-index sqlite db, tied to
//          the real project's own content/paths) or
//          `.openfusion/worktrees/` (any OTHER live worker worktrees the
//          real project happens to have lying around) into the isolated
//          eval directory — only the four artifact kinds writeHarness ever
//          writes (manifest/wiki/agents/routing) ever land there.
//       4. `orchestrate(engine, { projectDir: harnessDir, task: task.prompt })`
//          — now runs the FULL harness loop (route -> worker attempts ->
//          review -> escalate) entirely inside harnessDir's own worktree
//          hierarchy (`harnessDir/.openfusion/worktrees/<id>`), producing a
//          diff relative to harnessDir's OWN base commit.
//       5. The returned diff is applied back onto harnessDir itself (still
//          `engine.orchestrate.apply`, `git apply --3way`) — and now
//          applies TRIVIALLY: the diff's preimage context IS harnessDir's
//          own tracked content (same repo, same base commit — no more
//          disconnected-object-store apply risk described in the old KNOWN
//          v1 LIMITATION note this comment used to carry). runOracle then
//          scores harnessDir, exactly like the baseline.
//     The APPROXIMATION this fix accepts (documented, not hidden): the
//     copied wiki digests were generated against the real project's CURRENT
//     state, not the task's own (older, for a golden task) base state —
//     they describe a past version of the same project approximately, not
//     exactly. That is a much smaller and more honest approximation than
//     the flaw it replaces (which wasn't "approximately right", it was
//     structurally guaranteed wrong whenever HEAD had moved on).
//     SECURITY NOTE: harnessDir's `.git` history is its OWN (from
//     task.setup(), per tasks.ts's own history-strip mechanism for golden
//     tasks, or a from-scratch init for synthetic ones) — copying the
//     harness bundle via writeHarness never touches git, adds no remote, no
//     reflog entry, and no fetchable pointer back to the real project. See
//     the TMP-placement note below for the rest of this pipeline's own
//     isolation posture.
//
//   Because harnessDir now IS the substrate orchestrate works against,
//   there is no separate "orchestrate's own scratch worktree, living in the
//   REAL project, that must be cleaned up afterward" concern this pipeline
//   used to carry: every worktree engine.worker.getManager creates for a
//   harness-side run lives INSIDE harnessDir, which this loop's own
//   `finally` already removes wholesale (`rm(harnessDir, {recursive:true,
//   force:true})`) once the task is scored — success or failure. No
//   dedicated cleanup call against a persistent, user-facing project
//   directory is needed anymore.
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
//
// --- Measurement failures vs. quality failures (the second Task 4 fix) ---
//
// A harness-side outcome of "apply-failed" or "error" (HarnessTaskOutcome's
// own doc comment below) means the PIPELINE failed to produce or apply a
// scoreable result — NOT that the harness produced and was scored on a bad
// fix. Before this fix, both were folded into `harnessPassed: false`
// indistinguishably from a genuine bad fix, so an infra hiccup (a transient
// adapter error) or an apply mismatch could flip the manifest's evals
// verdict to "fail" — a FALSE ETH hazard. The verdict computation at the
// bottom of runEvals now separates the two: it only reports "fail" when the
// harness GENUINELY produced a tested fix that scored worse than the
// baseline; a quality gap that is fully or partially explained by
// measurement failures (on EITHER side — a baseline infra failure is
// exactly as much of a measurement failure as a harness one) is reported as
// "inconclusive" instead, with a note naming the outcome counts. See the
// verdict computation's own comments for the exact rule.
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
import { HarnessValidationError, loadHarness, setEvalsVerdict, writeHarness } from "../harness/store.js";
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

// Task 4 Fix 2: the fraction of ALL tasks (not just the ones on the "wrong"
// side of a raw quality gap) that hit a measurement failure before the
// pipeline stops trusting that run's OWN "fail" conclusion, even if the raw
// gap happens to survive excluding those tasks. Chosen as a conservative,
// clearly-documented threshold rather than a tuned constant: at 20%+
// measurement-failure tasks, a materially large slice of the run's own data
// is not a genuine quality read at all, so an ETH-hazard "fail" — the most
// consequential verdict this pipeline can produce — should not be asserted
// off a run that unreliable, regardless of how the arithmetic on the
// remaining "clean" tasks happens to come out.
const MATERIAL_MEASUREMENT_FAILURE_FRACTION = 0.2;

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
// engine.orchestrate itself having failed: "apply-failed" (a diff was
// produced but didn't apply onto harnessDir — see engine.orchestrate.apply)
// and "error" (engine.orchestrate itself threw — an infra hiccup on ONE task
// must not abort the whole report card; see runHarnessTask below). BOTH are
// MEASUREMENT failures, never quality evidence — see this module's header
// comment and the verdict computation in runEvals.
export type HarnessTaskOutcome = OrchestrateResult["outcome"] | "apply-failed" | "error";

// The baseline side's per-task outcome — symmetric with HarnessTaskOutcome
// (Task 4 Fix 3): "error" means the direct frontier turn itself failed
// (missing adapter, a session/turn that threw) BEFORE ever producing a real
// attempt at the task — a baseline measurement failure, exactly as much as
// a harness "error"/"apply-failed" is. "completed" means the frontier turn
// ran to completion; `baselinePassed` (the oracle's own verdict on whatever
// state the directory ended up in) is the quality signal for that case,
// independent of this field.
export type BaselineTaskOutcome = "completed" | "error";

export interface PerTaskResult {
  id: string;
  baselinePassed: boolean;
  baselineOutcome: BaselineTaskOutcome;
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
  // Raw pass-count comparison ONLY — see the verdict computation for how
  // measurement failures (Fix 2) and a zero-baseline run (Fix 3) keep this
  // raw number from being over-read as "fail"/"pass" on its own.
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
// engine.orchestrate.apply).
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
): Promise<{ passed: boolean; costUsd: number | null; outcome: BaselineTaskOutcome }> {
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
    // runHarnessTask's identical posture for engine.orchestrate below. This
    // is a MEASUREMENT failure (Fix 3, BaselineTaskOutcome's own doc
    // comment) — the verdict computation must not fold it into the quality
    // comparison the same way a genuine baseline attempt that ran to
    // completion and simply got the task wrong would be. runOracle is
    // deliberately NOT inside this catch: a runOracle failure is a SETUP
    // error (see tasks.ts's own doc comment — a bad testCommand, not a
    // failed eval) and should propagate out of runEvals entirely, not be
    // silently folded into "baseline failed".
    const message = err instanceof Error ? err.message : String(err);
    engine.log(`evals.run: baseline run failed for task ${task.id}: ${message}`);
    const oracle = await runOracle(dir, task.testCommand);
    return { passed: oracle.passed, costUsd: null, outcome: "error" };
  }
  const oracle = await runOracle(dir, task.testCommand);
  return { passed: oracle.passed, costUsd, outcome: "completed" };
}

// Turns `dir` into a plain git repo containing whatever task.setup() put
// there as a single commit — required for `dir` to be a valid
// engine.orchestrate `projectDir` (requireGitRepo, and
// engine.worker.getManager's WorktreeManager, both need at least one commit
// to anchor `git worktree add ... HEAD` to) and for engine.orchestrate.apply
// (`git apply --3way`, whose own requireGitRepo guard rejects a non-git
// target). A goldenTaskFromCommit-produced task's own setup() ALREADY does
// this (its own from-scratch "baseline" commit, tasks.ts's documented
// history-strip mechanism) — re-running `git init`/`commit` unconditionally
// on top of that would find nothing new to commit and fail, so this checks
// first and is a no-op for that case. A synthEvalTask-produced task's
// setup() does NOT touch git at all, so this is what makes ITS output a
// valid engine.orchestrate/apply target. Deliberately called BEFORE the
// harness bundle is written into `dir` (see writeHarness call in the main
// loop below) so that bundle stays untracked in this commit either way —
// nothing downstream needs it committed (see this module's header comment).
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

// HARNESS primitive: the full orchestrate loop, run against harnessDir
// ITSELF (the same base-state scratch directory runOracle scores) — see
// this module's header comment for the full base-identity rationale and
// Fix 1's history. `harnessDir` must already be a valid engine.orchestrate
// `projectDir` by the time this is called: a committed git repo (
// initEvalGitRepo) with the harness bundle written into it (writeHarness) —
// both are the caller's (runEvals's) responsibility, done once per task
// before this function runs.
async function runHarnessTask(
  engine: Engine,
  harnessDir: string,
  task: EvalTask,
): Promise<{ passed: boolean; costUsd: number | null; outcome: HarnessTaskOutcome }> {
  let result: OrchestrateResult;
  try {
    result = await orchestrate(engine, { projectDir: harnessDir, task: task.prompt });
  } catch (err) {
    // A per-task infra failure (e.g. the frontier adapter throwing) must not
    // abort the WHOLE report card — score this task as not passed and keep
    // going. See HarnessTaskOutcome's own doc comment: this is a MEASUREMENT
    // failure, not quality evidence — the verdict computation in runEvals
    // must not treat it the same as a genuinely-produced-but-worse fix.
    // Unlike the pre-Fix-1 pipeline, there is no separate "orchestrate's own
    // worktree, living in the real project" to lift a path for and clean up
    // here: any worktree engine.orchestrate created lives INSIDE harnessDir,
    // which runEvals's own per-task `finally` already removes wholesale
    // regardless of how this task scored.
    const message = err instanceof Error ? err.message : String(err);
    engine.log(`evals.run: engine.orchestrate failed for task ${task.id}: ${message}`);
    return { passed: false, costUsd: null, outcome: "error" };
  }

  if (result.diff.trim().length === 0) {
    // Nothing to apply — harnessDir stays at task.setup()'s pre-change
    // state, so the oracle is expected to fail. This is a legitimate
    // (not mis-scored) failure: the harness produced no change at all, and
    // OrchestrateResult's own "failed" outcome is exactly this case (see
    // orchestrate.ts) — genuine quality evidence, not a measurement
    // failure: the harness had every opportunity (worker attempts + review
    // + escalation) and still produced nothing.
    const oracle = await runOracle(harnessDir, task.testCommand);
    return { passed: oracle.passed, costUsd: result.cost.totalUsd, outcome: result.outcome };
  }

  try {
    await callEngineMethod(engine, "engine.orchestrate.apply", { projectDir: harnessDir, diff: result.diff });
  } catch (err) {
    // A failed apply is a MEASUREMENT failure (HarnessTaskOutcome's own doc
    // comment) — see the verdict computation in runEvals for how this is
    // kept separate from a genuine quality failure. With Fix 1 in place this
    // should be rare (the diff's preimage context IS harnessDir's own
    // tracked content — same repo, same base commit), but a worker/frontier
    // can still, in principle, produce a diff that doesn't apply cleanly
    // (e.g. conflicting concurrent edits within one attempt's own worktree
    // lifecycle) — scored as a measurement failure, not a crashed run.
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
  extraNotes?: string[];
}): string {
  const parts: string[] = [];
  parts.push(
    opts.taskCount < MIN_TASK_COUNT_FOR_VERDICT
      ? `Sample size ${opts.taskCount} task(s) is below the ${MIN_TASK_COUNT_FOR_VERDICT}-task minimum for a credible savings claim (Anthropic eval guidance — see docs/research/2026-07-04-m6-pricing-eval-verification.md) -- this is a demo, not a claim.`
      : `Sample size: ${opts.taskCount} task(s) (a credible claim wants 20-50 paired tasks; treat this as directional).`,
  );
  parts.push("Cost figures are estimate-class (see engine.orchestrate's own cost.note) -- directional, not exact.");
  parts.push(`Pricing confidence: ${opts.pricingConfidence} (the worst confidence across every cost record this run produced).`);
  for (const note of opts.extraNotes ?? []) {
    parts.push(note);
  }
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
      // Fix 1 (base identity — see this module's header comment): harnessDir
      // gets the SAME task.setup() base state the baseline used, THEN a
      // committed git repo, THEN the real project's harness bundle copied
      // in (untracked) — only after all three is it a valid substrate for
      // engine.orchestrate to work the task against.
      await task.setup(harnessDir);
      await initEvalGitRepo(harnessDir);
      await writeHarness(harnessDir, harnessBundle);
      const harnessResult = await runHarnessTask(engine, harnessDir, task);

      progress(engine, "scored", task.id);

      if (baseline.passed) baselinePassed += 1;
      if (harnessResult.passed) harnessPassed += 1;
      if (harnessResult.outcome === "escalated") escalations += 1;
      baselineCostTotal = addCost(baselineCostTotal, baseline.costUsd);
      harnessCostTotal = addCost(harnessCostTotal, harnessResult.costUsd);

      perTask.push({
        id: task.id,
        baselinePassed: baseline.passed,
        baselineOutcome: baseline.outcome,
        harnessPassed: harnessResult.passed,
        harnessOutcome: harnessResult.outcome,
        baselineUsd: baseline.costUsd,
        harnessUsd: harnessResult.costUsd,
      });
    } finally {
      // Eval scratch is transient (unlike orchestrate's own user-facing
      // worktrees) — always auto-remove, success or failure. This also
      // removes any worktree engine.orchestrate created for the harness
      // side, since (post Fix 1) those always live INSIDE harnessDir.
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

  // Fix 2 (measurement failures vs. quality failures — see this module's
  // header comment): a task counts as a MEASUREMENT failure if EITHER side
  // failed to produce a genuine, oracle-scoreable attempt at the task —
  // harness "apply-failed"/"error", or baseline "error" (Fix 3's own
  // baseline/harness symmetry). These are tallied and named in the report's
  // note regardless of verdict, for transparency.
  const isHarnessMeasurementFailure = (outcome: HarnessTaskOutcome): boolean =>
    outcome === "apply-failed" || outcome === "error";
  const measurementFailureIds = new Set(
    perTask
      .filter((t) => isHarnessMeasurementFailure(t.harnessOutcome) || t.baselineOutcome === "error")
      .map((t) => t.id),
  );
  const harnessApplyFailedCount = perTask.filter((t) => t.harnessOutcome === "apply-failed").length;
  const harnessErrorCount = perTask.filter((t) => t.harnessOutcome === "error").length;
  const baselineErrorCount = perTask.filter((t) => t.baselineOutcome === "error").length;
  const measurementFailureCount = measurementFailureIds.size;

  const extraNotes: string[] = [];
  if (measurementFailureCount > 0) {
    extraNotes.push(
      `${measurementFailureCount} of ${taskCount} task(s) hit a measurement failure rather than a genuine, ` +
        `oracle-scoreable quality result (harness: ${harnessApplyFailedCount} apply-failed, ${harnessErrorCount} ` +
        `error; baseline: ${baselineErrorCount} error) -- excluded from the quality-gap attribution below.`,
    );
  }

  let verdict: EvalsReportCard["verdict"];
  if (!qualityHeld) {
    // A raw quality gap (harnessPassed < baselinePassed) is the ETH-hazard
    // shape — but Fix 2 requires the gap be attributable to the harness
    // GENUINELY producing a worse fix, not to measurement failures on
    // either side. Recompute the same comparison over only the "clean"
    // tasks (neither side measurement-failed): if the gap doesn't survive
    // that exclusion (including the vacuous "no clean tasks at all" case,
    // where 0 >= 0 trivially holds), or if measurement failures are a
    // material fraction of the WHOLE run (even when the gap technically
    // does survive on the remaining clean tasks — a run that unreliable
    // shouldn't ground the pipeline's most consequential verdict), this is
    // reported as "inconclusive", never "fail".
    if (measurementFailureCount > 0) {
      const cleanTasks = perTask.filter((t) => !measurementFailureIds.has(t.id));
      const cleanBaselinePassed = cleanTasks.filter((t) => t.baselinePassed).length;
      const cleanHarnessPassed = cleanTasks.filter((t) => t.harnessPassed).length;
      const qualityHeldOnCleanTasks = cleanHarnessPassed >= cleanBaselinePassed;
      const measurementFailureFractionIsMaterial =
        measurementFailureCount / taskCount >= MATERIAL_MEASUREMENT_FAILURE_FRACTION;

      if (qualityHeldOnCleanTasks || measurementFailureFractionIsMaterial) {
        verdict = "inconclusive";
        extraNotes.push(
          "The raw quality gap above is not attributable to the harness genuinely producing a worse fix once " +
            "measurement failures are excluded -- reported as inconclusive rather than an ETH-hazard fail.",
        );
      } else {
        // ETH HAZARD (spec §12.1): even excluding every measurement
        // failure, the harness still genuinely produced tested fixes that
        // scored worse than the baseline. Never reported as a savings win,
        // regardless of cost.
        verdict = "fail";
      }
    } else {
      // No measurement failures at all -- a clean, fully-attributable
      // quality gap. ETH HAZARD (spec §12.1).
      verdict = "fail";
    }
  } else if (baselinePassed === 0) {
    // Fix 3: harnessPassed >= baselinePassed is trivially true at 0 >= 0 --
    // "savings at held quality" is meaningless when the baseline solved
    // NOTHING to hold quality against. Never a "pass" on a 0-vs-0 (or
    // N-vs-0) count, however good the savings arithmetic looks.
    verdict = "inconclusive";
    extraNotes.push("The baseline solved 0 of the tasks in this run -- there is nothing to measure quality against.");
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
    note: buildNote({ taskCount, pricingConfidence, sampleNote: params.sampleNote, extraNotes }),
  };
}
