// Directional baseline-versus-harness evaluation.
//
// Each task is reconstructed twice from the same historical pre-fix source
// state. The Git tree IDs must match before either arm starts. One wiki is
// built from that committed source and one authenticated MCP endpoint is
// shared by both arms so arm order cannot change repository knowledge.
//
// The baseline role performs the task directly in its scratch repository.
// The harness arm installs only the validated harness generation and runs the
// normal orchestration/candidate pipeline. Public verification commands may
// run while compiling the candidate. Evaluator-only tests/fixtures are
// materialized only after author and reviewer sessions close, then both final
// trees are scored by the same protected command oracle under the native
// evaluation sandbox. Policy violations and infrastructure failures are
// measurement/safety outcomes, not task-quality failures.
//
// Scratch repositories live under OS temp, while nested author/verifier
// worktrees live under the host-private WorktreeManager root. All are removed
// in finally blocks. The selected repository is read only for task/harness
// identity; evaluation never applies to it or mutates its harness.
//
// runEvals preserves the one-trial directional API. Repeated seeded trials,
// durable resume, intervals, pass@k/pass^k, and promotion evidence are composed
// by experiment.ts.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import type { FrontierSession } from "../engines/types.js";
import {
  resolveFrontierSelection,
  type EvalsFrontierSelections,
  type FrontierSelection,
} from "../engines/selection.js";
import type { PricingConfidence } from "../models/meter.js";
import {
  DIALECT_PACK_CATALOG_VERSION,
  FAMILY_CATALOG_VERSION,
} from "../models/catalog.js";
import { fingerprintHarness } from "../harness/fingerprint.js";
import { validateHarness } from "../harness/schema.js";
import { HarnessValidationError, loadHarness, writeHarness } from "../harness/store.js";
import { orchestrate, type OrchestrateResult } from "../orchestrate/orchestrate.js";
import { reviewDiff } from "../orchestrate/review.js";
import { routeTask } from "../orchestrate/routing.js";
import { RunCancelledError } from "../rpc/cancel-registry.js";
import { RpcMethodError } from "../rpc/errors.js";
import { requireGitRepo } from "../rpc/guards.js";
import type { RunSupervisor } from "../runtime/supervisor.js";
import { captureTaskSnapshot } from "../runtime/snapshot.js";
import { runtimeFingerprint } from "../runtime/context.js";
import type {
  ExperimentTrial,
  HarnessExperimentVariant,
  TrialFeatures,
  TrialMetrics,
} from "../runtime/evidence.js";
import { TOOL_OUTPUT_MAX_BYTES } from "../runtime/sandbox.js";
import type { RuntimeStore } from "../runtime/store.js";
import type { EvalTask, OracleResult } from "./tasks.js";
import { computeEvalsVerdict } from "./verdict.js";

// Local addCost for baseline/harness arm cost accumulation — same null-skip
// semantics as verdict.addCost / orchestrate.ts.
function addCost(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}

const execFileAsync = promisify(execFile);

// A full editing turn, comparable in scope to orchestrate.ts's own
// escalation attempt — mirrors its DEFAULT_ESCALATE_TIMEOUT_MS exactly,
// since the baseline primitive IS "a frontier does the task directly",
// structurally identical to escalation.
const DEFAULT_BASELINE_TIMEOUT_MS = 600_000;
export const EVAL_POLICY_VERSION = "eval-v1";
export const EVALUATOR_ORACLE_IDENTITY = runtimeFingerprint({
  evaluator: "repository-test-exit-code",
  contractVersion: 1,
  promptOwner: "openfusion-evaluator",
});

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
  frontier?: EvalsFrontierSelections;
  // M7b Task 2: READ-ONLY lookup only -- runEvals never register()s or
  // deregister()s this runId's controller; that is engine.evals.run's own
  // RPC handler's job (methods.ts). See cancel-registry.ts's header comment
  // for the full ownership split, and OrchestrateParams.runId's identical
  // doc comment in orchestrate.ts for the sibling convention this mirrors.
  runId?: string;
  supervisor?: RunSupervisor;
  /** Seeded experiment scheduler control; v1 callers default baseline-first. */
  armOrder?: "baseline-first" | "harness-first";
  /** Optional protected repeated-trial ledger. Completed arms resume without another model call. */
  experiment?: {
    id: string;
    variant: HarnessExperimentVariant;
    repeatIndex: number;
    seed: number;
  };
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
  baselinePolicyViolation?: boolean;
  harnessPolicyViolation?: boolean;
}

/** Phase 1: published harness configuration for eval reproducibility. */
export interface EvalsHarnessConfig {
  schemaVersion: 1 | 2;
  harnessProfile: string;
  familyCatalogVersion: string;
  dialectPackVersion: string;
  routePolicyVersion: string;
  evalPolicyVersion: typeof EVAL_POLICY_VERSION;
  evaluatorOracleIdentity: string;
  // Honest pin: generate/review/escalate still use this frontier engine only.
  frontierEngine: string;
  frontierRoles: {
    planning?: FrontierSelection;
    review: FrontierSelection;
    escalation: FrontierSelection;
    baseline: FrontierSelection;
  };
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
  // Worst PricingConfidence across every cost record THIS RUN produced —
  // genuinely run-scoped (M6 final review I2): a snapshot of
  // engine.models.meter.recordCount() taken before the task loop below lets
  // this be computed as engine.models.meter.totals(snapshotIndex), over only
  // the records this call to runEvals itself added, never records left over
  // from a prior run against the same long-lived engine (relevant from M7
  // onward). Taints the savings claim even when the arithmetic itself looks
  // fine. See also the `unpricedCalls`-driven verdict gate (C1) below, which
  // reads the same run-scoped slice.
  pricingConfidence: PricingConfidence;
  perTask: PerTaskResult[];
  note: string;
  // M7c Task 1: the CLEAN-SUBSET numbers the verdict computation above was
  // ACTUALLY computed from (see the "clean subset" comments in runEvals'
  // own body) — surfaced as structured fields, additively, so a caller (the
  // benchmark consumer can show WHY a verdict is what it is (e.g.
  // "inconclusive: 3/8 tasks had measurement failures; clean subset harness
  // 4/5 vs baseline 4/5") without re-deriving them from `perTask` itself.
  // Purely additive: no verdict-logic change — these are the exact same
  // values `verdict` above was branched on.
  cleanTaskCount: number;
  cleanBaselinePassed: number;
  cleanHarnessPassed: number;
  cleanSavingsPct: number | null;
  measurementFailureCount: number;
  /** Tasks with a baseline or harness policy violation; never folded into quality. */
  policyViolationCount: number;
  // True when the clean-subset quality gap is within the single-run noise
  // band (research 2026-07-07 §3.3) — i.e. any harness<baseline gap present
  // was too small to ground an ETH-hazard "fail". Purely informational.
  qualityGapWithinNoise: boolean;
  // Phase 1: model+harness configuration pins (Zhang et al. arXiv:2605.23950).
  harnessConfig?: EvalsHarnessConfig;
}

// M7c Task 5: `runId`, when supplied (the same batch-level runId this run's
// own cancelSignal lookup above uses), is included on every notification so a
// client with more than one concurrent evals run in flight can filter
// progress to just its own. Mirrors orchestrate.ts's identical `progress()`
// fix -- each field is present only when the caller actually supplied it
// (`taskId` for run-level "start"/"done" stages stays absent exactly as
// before; `runId` is absent entirely, not `runId: undefined`, when no runId
// was given), so an older/runId-less caller sees the exact same shape as
// before this task.
function progress(engine: Engine, stage: string, taskId?: string, runId?: string): void {
  const params: { stage: string; taskId?: string; runId?: string } = { stage };
  if (taskId !== undefined) params.taskId = taskId;
  if (runId !== undefined) params.runId = runId;
  engine.notify("evals.progress", params);
}

// Drains a frontier turn WITHOUT any JSON-schema expectation — used for the
// baseline primitive below, whose whole point is to make tool calls (write
// scoped to the baseline dir) and finish with a short prose summary, not a
// structured verdict. Mirrors orchestrate.ts's private runFrontierTurn,
// including its M7b Task 2 abort-threading pattern (see that function's own
// doc comment for why THREE separate `.aborted` checks are needed rather
// than one): `abortSignal`, when provided, is this eval run's own
// cancellation signal (runEvals's own cancelSignal, below).
async function drainFrontierTurn(
  session: FrontierSession,
  prompt: string,
  timeoutMs: number,
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

interface ProtectedOracleResult extends OracleResult {
  measurementFailure: boolean;
  policyViolation: boolean;
}

function resolveOracleExecutable(program: string): string {
  if (path.isAbsolute(program)) {
    if (!existsSync(program)) throw new Error(`runOracle: test command not found: ${JSON.stringify(program)}`);
    return realpathSync(program);
  }
  if (program === "node" || program === path.basename(process.execPath)) return realpathSync(process.execPath);
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, program);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(
    `runOracle: test command not found: ${JSON.stringify(program)}. ` +
      "This is a setup error, not a failed evaluation.",
  );
}

async function runProtectedOracle(
  engine: Engine,
  store: RuntimeStore,
  dir: string,
  testCommand: string[],
  abortSignal?: AbortSignal,
): Promise<ProtectedOracleResult> {
  const [program, ...args] = testCommand;
  if (program === undefined) throw new Error("runOracle: testCommand must contain a program");
  const executable = resolveOracleExecutable(program);
  const status = await engine.runtime.sandbox.status();
  if (!status.available) {
    throw new RpcMethodError(
      RpcErrorCodes.SERVER_ERROR,
      `evaluation sandbox is unavailable: ${status.reason ?? "startup probe failed"}`,
      { reasonCode: "eval-sandbox-unavailable", policyVersion: EVAL_POLICY_VERSION },
    );
  }

  let session = store.createSession({
    runId: randomUUID(),
    kind: "review",
    modelFingerprint: EVALUATOR_ORACLE_IDENTITY,
    configurationFingerprint: runtimeFingerprint({ policy: EVAL_POLICY_VERSION }),
  });
  session = store.updateSession(session.id, session.version, { status: "running" });
  const privateTempDir = await mkdtemp(path.join(os.tmpdir(), "of-eval-oracle-"));
  const writer = store.beginArtifact(session.id, "eval-oracle-output", { maxBytes: TOOL_OUTPUT_MAX_BYTES });
  const startedAt = Date.now();
  try {
    const executableDir = path.dirname(executable);
    const result = await engine.runtime.sandbox.run({
      executable,
      args,
      cwd: dir,
      privateTempDir,
      readablePaths: [
        executableDir,
        path.dirname(executableDir),
        path.dirname(process.execPath),
      ],
      executablePaths: [executable, process.execPath],
      networkGranted: false,
      profile: "eval",
      timeoutMs: 300_000,
      abortSignal,
      output: writer,
    });
    if (result.failure === "cancelled" || abortSignal?.aborted === true) throw new RunCancelledError();
    const policyViolation = /(?:sandbox-exec[^\n]*(?:deny|violation)|operation not permitted)/i
      .test(result.preview);
    const measurementFailure = result.failure === "spawn" || result.failure === "output-limit";
    const passed = result.failure === undefined && result.exitCode === 0 && !policyViolation;
    const latest = store.requireSession(session.id);
    store.updateSession(latest.id, latest.version, {
      status: "completed",
      outcome: policyViolation
        ? "policy-violation"
        : measurementFailure
          ? "measurement-failure"
          : passed
            ? "oracle-passed"
            : "oracle-failed",
    });
    return {
      passed,
      exitCode: result.exitCode ?? -1,
      durationMs: result.failure === "timeout" ? 300_000 : Date.now() - startedAt,
      measurementFailure,
      policyViolation,
    };
  } catch (error) {
    writer.abort();
    const latest = store.requireSession(session.id);
    if (latest.status === "running") {
      store.updateSession(latest.id, latest.version, {
        status: abortSignal?.aborted === true ? "cancelled" : "failed",
        outcome: abortSignal?.aborted === true ? "cancelled" : "oracle-execution-error",
      });
    }
    throw error;
  } finally {
    await rm(privateTempDir, { recursive: true, force: true });
  }
}

async function runTaskOracle(
  engine: Engine,
  store: RuntimeStore,
  dir: string,
  task: EvalTask,
  abortSignal?: AbortSignal,
): Promise<ProtectedOracleResult> {
  if (abortSignal?.aborted) throw new RunCancelledError();
  await task.prepareOracle?.(dir);
  if (abortSignal?.aborted) throw new RunCancelledError();
  return runProtectedOracle(engine, store, dir, task.testCommand, abortSignal);
}

// BASELINE primitive: a frontier does the task directly in one throwaway
// repository. It receives the same committed-source wiki MCP as the harness
// arm, but no generated harness routing or injected harness prose. The same
// protected oracle scores both arms.
async function runBaselineTask(
  engine: Engine,
  dir: string,
  task: EvalTask,
  frontier: FrontierSelection,
  reviewFrontier: FrontierSelection,
  wikiMcp: { url: string; bearerToken: string },
  runtimeStore: RuntimeStore,
  abortSignal?: AbortSignal,
  supervisor?: RunSupervisor,
): Promise<{
  passed: boolean;
  costUsd: number | null;
  outcome: BaselineTaskOutcome;
  policyViolation: boolean;
}> {
  let costUsd: number | null = null;
  let hasUnpricedCall = false;
  const recordBaselineCall = (next: number | null): void => {
    if (next === null) hasUnpricedCall = true;
    costUsd = addCost(costUsd, next);
    supervisor?.recordCost(next, next === null ? "unpriced" : "verified");
  };
  const baselineCost = (): number | null => hasUnpricedCall ? null : costUsd;
  const snapshot = await captureTaskSnapshot(engine, dir, EVAL_POLICY_VERSION);
  const manager = await engine.worker.getManager(dir);
  let authorWorktree: Awaited<ReturnType<typeof manager.create>> | undefined;
  try {
    authorWorktree = await manager.create(`eval-baseline-${randomUUID()}`, snapshot.baseSha);
    const adapter = engine.frontier.getAdapter(frontier.engine);
    if (adapter === undefined) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown frontier engine: ${frontier.engine}`);
    }
    const capabilities = await adapter.capabilities?.();
    if (capabilities?.sandboxCompatibility !== "certified") {
      throw new RpcMethodError(
        RpcErrorCodes.SERVER_ERROR,
        "evaluation baseline is disabled because the selected runtime has no certified sandbox",
        { reasonCode: "eval-runtime-unsupported", policyVersion: EVAL_POLICY_VERSION },
      );
    }
    const session = await engine.providerGateway.createFrontierSession(adapter, {
      projectDir: authorWorktree.path,
      wikiMcpUrl: wikiMcp.url,
      wikiMcpBearerToken: wikiMcp.bearerToken,
      log: engine.log,
      model: frontier.model,
      toolPolicy: { writeScope: [authorWorktree.path] },
      resultLabel: "eval-baseline",
    });
    const untrack = engine.frontier.track(session);
    let summary = "";
    try {
      supervisor?.reserveModelCall();
      const turn = await drainFrontierTurn(session, task.prompt, DEFAULT_BASELINE_TIMEOUT_MS, abortSignal);
      recordBaselineCall(turn.costUsd);
      summary = turn.text;
    } finally {
      await engine.frontier.closeSession(session);
      untrack();
    }

    const contract = {
      schemaVersion: 1 as const,
      requirements: [task.prompt],
      constraints: [],
      verificationCommands: task.verificationCommands ?? [],
    };
    const prepared = await engine.candidates.prepare(engine, {
      projectDir: dir,
      worktree: authorWorktree,
      snapshot,
      contract,
      signal: abortSignal,
    });
    const reviewAdapter = engine.frontier.getAdapter(reviewFrontier.engine);
    const reviewCapabilities = await reviewAdapter?.capabilities?.();
    if (reviewAdapter === undefined || reviewCapabilities?.sandboxCompatibility !== "certified") {
      throw new RpcMethodError(
        RpcErrorCodes.SERVER_ERROR,
        "evaluation baseline has no compliant independent reviewer",
        { reasonCode: "eval-reviewer-unavailable", policyVersion: EVAL_POLICY_VERSION },
      );
    }
    const reviewSession = await engine.providerGateway.createFrontierSession(reviewAdapter, {
      projectDir: authorWorktree.path,
      wikiMcpUrl: wikiMcp.url,
      wikiMcpBearerToken: wikiMcp.bearerToken,
      log: engine.log,
      model: reviewFrontier.model,
      resultLabel: "frontier-review",
    });
    const untrackReview = engine.frontier.track(reviewSession);
    let reviewResult: Awaited<ReturnType<typeof reviewDiff>>;
    try {
      reviewResult = await reviewDiff(
        reviewSession,
        {
          task: JSON.stringify({ request: task.prompt, contract }),
          diff: "",
          summary,
          verifierEvidence: JSON.stringify(prepared.reports.map((report) => ({
            stageId: report.stageId,
            verdict: report.verdict,
            outputRef: report.outputRef,
          }))),
        },
        {
          timeoutMs: DEFAULT_BASELINE_TIMEOUT_MS,
          abortSignal,
          beforePrompt: () => supervisor?.reserveModelCall(),
          onAttemptCost: recordBaselineCall,
        },
      );
    } finally {
      await engine.frontier.closeSession(reviewSession);
      untrackReview();
    }
    if (reviewResult.verdict.decision !== "approve") {
      await manager.remove(authorWorktree).catch(() => {});
      authorWorktree = undefined;
      await runTaskOracle(engine, runtimeStore, dir, task, abortSignal);
      return { passed: false, costUsd: baselineCost(), outcome: "completed", policyViolation: false };
    }
    const candidate = engine.candidates.mint({
      projectDir: dir,
      worktree: authorWorktree,
      snapshot,
      prepared,
      authorAttemptId: "baseline-attempt-1",
      authorSessionId: session.id,
      reviewerSessionId: reviewSession.id,
      verdict: reviewResult.verdict,
    });
    const grant = await engine.candidates.prepareApply(candidate.candidateId, dir);
    await engine.candidates.apply(candidate.candidateId, grant, dir);
    authorWorktree = undefined;
  } catch (err) {
    if (abortSignal?.aborted) throw err;
    if (authorWorktree !== undefined) await manager.remove(authorWorktree).catch(() => {});
    const reasonCode = err instanceof RpcMethodError && typeof err.data === "object" && err.data !== null
      ? (err.data as { reasonCode?: unknown }).reasonCode
      : undefined;
    if (reasonCode === "command-failed" || (err instanceof Error && /candidate diff is empty/.test(err.message))) {
      await runTaskOracle(engine, runtimeStore, dir, task, abortSignal);
      return { passed: false, costUsd: baselineCost(), outcome: "completed", policyViolation: false };
    }
    engine.log("evals.run: baseline attempt failed");
    const oracle = await runTaskOracle(engine, runtimeStore, dir, task, abortSignal);
    return { passed: oracle.passed, costUsd: null, outcome: "error", policyViolation: oracle.policyViolation };
  }
  const oracle = await runTaskOracle(engine, runtimeStore, dir, task, abortSignal);
  return {
    passed: oracle.passed,
    costUsd: baselineCost(),
    outcome: oracle.measurementFailure ? "error" : "completed",
    policyViolation: oracle.policyViolation,
  };
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
//
// M2 (final review — cheap footgun): the "already a repo" probe checks for
// `dir`'s OWN `.git` entry (a directory for a plain repo, or the "gitdir:
// <path>" file `git worktree add`/task.setup()'s own history-strip mechanism
// can leave behind) rather than shelling out to `git -C dir rev-parse
// --is-inside-work-tree`. That command answers "is ANY ancestor of dir a git
// repo", not "is dir ITSELF a repo root" — a false positive if the eval
// scratch tmp root (`os.tmpdir()`, mkdtemp'd by the caller) ever happened to
// be nested inside a git repo (e.g. a CI runner whose $TMPDIR lives under a
// checkout) would wrongly conclude `dir` is already a repo and skip `git
// init` here, silently anchoring every subsequent git operation this
// pipeline runs against `dir` (requireGitRepo, WorktreeManager's `git
// worktree add ... HEAD`, `git apply --3way`) to that OUTER repo instead of
// a fresh one rooted at `dir`. Checking for `dir`'s own `.git` path has no
// such ambiguity: it is only ever true when `dir` itself is a repo root.
async function initEvalGitRepo(dir: string): Promise<void> {
  if (existsSync(path.join(dir, ".git"))) {
    // Already a git repo (task.setup() itself initialized one) — nothing
    // more to do.
    return;
  }
  await execFileAsync("git", ["-C", dir, "init", "-q"]);
  await execFileAsync("git", ["-C", dir, "config", "user.email", "eval@openfusion.local"]);
  await execFileAsync("git", ["-C", dir, "config", "user.name", "openfusion-eval"]);
  await execFileAsync("git", ["-C", dir, "add", "-A"]);
  await execFileAsync("git", ["-C", dir, "commit", "-q", "-m", "eval baseline"]);
}

async function evalTreeSha(dir: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"], {
    encoding: "utf8",
  });
  return stdout.trim();
}

interface HarnessTaskTelemetry {
  taskClass: string;
  routeId: string;
  family: string;
  dialectPack: string;
  retryCount: number;
  escalationCount: number;
  interventionCount: number;
  toolErrorCount: number;
  policyViolation: boolean;
  fullyPriced: boolean;
}

interface HarnessTaskResult {
  passed: boolean;
  costUsd: number | null;
  outcome: HarnessTaskOutcome;
  telemetry?: HarnessTaskTelemetry;
}

function harnessTelemetry(result: OrchestrateResult): HarnessTaskTelemetry {
  const toolErrors = Object.entries(result.toolErrorCounts ?? {});
  return {
    taskClass: result.taskClass,
    routeId: result.routeId,
    family: result.family ?? "frontier",
    dialectPack: result.dialectPack ?? "none",
    retryCount: Math.max(0, result.attempts.length - 1),
    escalationCount: result.outcome === "escalated" ? 1 : 0,
    interventionCount: 0,
    toolErrorCount: toolErrors.reduce((total, [, count]) => total + count, 0),
    policyViolation: toolErrors.some(([key, count]) => count > 0 && key.endsWith(":policy_denied")),
    fullyPriced: result.costEstimate.completeness === "complete" && result.cost.totalUsd !== null,
  };
}

// HARNESS primitive: the full orchestrate loop, anchored to harnessDir (the
// same base-state scratch repository the protected oracle scores).
// `harnessDir` must already be a valid engine.orchestrate
// `projectDir` by the time this is called: a committed git repo (
// initEvalGitRepo) with the harness bundle written into it (writeHarness) —
// both are the caller's (runEvals's) responsibility, done once per task
// before this function runs.
async function runHarnessTask(
  engine: Engine,
  harnessDir: string,
  task: EvalTask,
  runtimeStore: RuntimeStore,
  opts: {
    runId?: string;
    abortSignal?: AbortSignal;
    frontier?: EvalsFrontierSelections;
    wikiMcp?: { url: string; bearerToken: string };
    experimentVariant?: HarnessExperimentVariant;
    supervisor?: RunSupervisor;
  } = {},
): Promise<HarnessTaskResult> {
  let result: OrchestrateResult;
  try {
    // M7b Task 2: `runId` forwarded VERBATIM -- this is the SAME batch-level
    // runId runEvals only ever get()s (never register()s/deregister()s;
    // that's engine.evals.run's own handler's job). orchestrate()'s own
    // cancelSignal resolves this identical runId to the SAME
    // AbortController via its own get()-only read, so a cancel reaches this
    // per-task harness run exactly as it reaches the baseline turn above.
    result = await orchestrate(engine, {
      projectDir: harnessDir,
      task: task.prompt,
      taskContract: {
        schemaVersion: 1,
        requirements: [task.prompt],
        constraints: [],
        verificationCommands: task.verificationCommands ?? [],
      },
      runId: opts.runId,
      frontier: { review: opts.frontier?.review, escalation: opts.frontier?.escalation },
      wikiMcp: opts.wikiMcp,
      experimentVariant: opts.experimentVariant,
      supervisor: opts.supervisor,
    });
  } catch (err) {
    // M7b Task 2: a cancellation must propagate, never be soft-scored as an
    // infra failure -- checked FIRST, ahead of the existing per-task-failure
    // handling below (mirrors runBaselineTask's identical guard).
    if (opts.abortSignal?.aborted) throw err;
    // A per-task infra failure (e.g. the frontier adapter throwing) must not
    // abort the WHOLE report card — score this task as not passed and keep
    // going. See HarnessTaskOutcome's own doc comment: this is a MEASUREMENT
    // failure, not quality evidence — the verdict computation in runEvals
    // must not treat it the same as a genuinely-produced-but-worse fix.
    // Host-private orchestration/candidate worktrees have their own cleanup;
    // the scratch repository is removed separately in the outer finally.
    engine.log("evals.run: harness orchestration failed");
    return { passed: false, costUsd: null, outcome: "error" };
  }

  const telemetry = harnessTelemetry(result);

  if (result.diff.trim().length === 0) {
    // Nothing to apply — harnessDir stays at task.setup()'s pre-change
    // state, so the oracle is expected to fail. This is a legitimate
    // (not mis-scored) failure: the harness produced no change at all, and
    // OrchestrateResult's own "failed" outcome is exactly this case (see
    // orchestrate.ts) — genuine quality evidence, not a measurement
    // failure: the harness had every opportunity (worker attempts + review
    // + escalation) and still produced nothing.
    const oracle = await runTaskOracle(engine, runtimeStore, harnessDir, task, opts.abortSignal);
    return {
      passed: oracle.passed,
      costUsd: result.cost.totalUsd,
      outcome: oracle.measurementFailure ? "error" : result.outcome,
      telemetry: {
        ...telemetry,
        policyViolation: telemetry.policyViolation || oracle.policyViolation,
      },
    };
  }

  if (result.candidateRef === null) {
    engine.log("evals.run: harness candidate verification was incomplete");
    return { passed: false, costUsd: result.cost.totalUsd, outcome: "error", telemetry };
  }

  try {
    const grant = await engine.candidates.prepareApply(result.candidateRef.candidateId, harnessDir);
    await engine.candidates.apply(result.candidateRef.candidateId, grant, harnessDir);
  } catch (err) {
    // A failed apply is a MEASUREMENT failure (HarnessTaskOutcome's own doc
    // comment) — see the verdict computation in runEvals for how this is
    // kept separate from a genuine quality failure. With Fix 1 in place this
    // should be rare (the diff's preimage context IS harnessDir's own
    // tracked content — same repo, same base commit), but a worker/frontier
    // can still, in principle, produce a diff that doesn't apply cleanly
    // (e.g. conflicting concurrent edits within one attempt's own worktree
    // lifecycle) — scored as a measurement failure, not a crashed run.
    engine.log("evals.run: candidate Apply failed");
    return { passed: false, costUsd: result.cost.totalUsd, outcome: "apply-failed", telemetry };
  }

  const oracle = await runTaskOracle(engine, runtimeStore, harnessDir, task, opts.abortSignal);
  return {
    passed: oracle.passed,
    costUsd: result.cost.totalUsd,
    outcome: oracle.measurementFailure ? "error" : result.outcome,
    telemetry: {
      ...telemetry,
      policyViolation: telemetry.policyViolation || oracle.policyViolation,
    },
  };
}

interface ExperimentTrialPair {
  matchId: string;
  baseline: ExperimentTrial;
  harness: ExperimentTrial;
}

function trialSeed(seed: number, index: number, arm: 0 | 1): number {
  const value = seed + index * 2 + arm;
  if (!Number.isSafeInteger(value)) throw new Error("experiment trial seed exceeds the safe integer range");
  return value;
}

async function planExperimentTrials(
  engine: Engine,
  params: EvalsRunParams & { experiment: NonNullable<EvalsRunParams["experiment"]> },
  harnessBundle: NonNullable<ReturnType<typeof loadHarness>>,
): Promise<ExperimentTrialPair[]> {
  const snapshot = await captureTaskSnapshot(engine, params.projectDir, EVAL_POLICY_VERSION);
  const harnessFingerprint = fingerprintHarness(harnessBundle).digest;
  const planned = params.tasks.flatMap((task, index) => {
    const routed = routeTask(task.prompt, harnessBundle, engine.models.registry);
    const resolution = routed.resolution;
    const common: Pick<TrialFeatures, "taskClass" | "difficulty" | "harnessFingerprint" | "projectFingerprint"> = {
      taskClass: routed.taskClass,
      difficulty: routed.difficulty,
      harnessFingerprint,
      projectFingerprint: snapshot.projectDigest,
    };
    const matchId = `sample-${String(index + 1).padStart(6, "0")}`;
    const contextPolicy: TrialFeatures["contextPolicy"] = params.experiment.variant === "full-history"
      ? "full-history"
      : "compaction";
    return [
      {
        experimentId: params.experiment.id,
        matchId,
        variant: "direct-lead" as const,
        repeatIndex: params.experiment.repeatIndex,
        seed: trialSeed(params.experiment.seed, index, 0),
        features: {
          ...common,
          routeId: "route:direct-lead",
          family: "frontier",
          dialectPack: "none",
          contextPolicy: "full-history" as const,
        },
      },
      {
        experimentId: params.experiment.id,
        matchId,
        variant: params.experiment.variant,
        repeatIndex: params.experiment.repeatIndex,
        seed: trialSeed(params.experiment.seed, index, 1),
        features: {
          ...common,
          routeId: routed.routeId,
          family: resolution === "frontier" ? "frontier" : resolution.family,
          dialectPack: resolution === "frontier"
            ? "none"
            : params.experiment.variant === "generic-worker"
              ? "string-edit-default"
              : resolution.dialectPack,
          contextPolicy,
        },
      },
    ];
  });
  const trials = engine.runtime.evidence.planTrials(engine.runtime.getStore(params.projectDir), planned);
  const byKey = new Map(trials.map((trial) => [
    `${trial.repeatIndex}:${trial.matchId}:${trial.variant}`,
    trial,
  ]));
  return params.tasks.map((_, index) => {
    const matchId = `sample-${String(index + 1).padStart(6, "0")}`;
    const baseline = byKey.get(`${params.experiment.repeatIndex}:${matchId}:direct-lead`);
    const harness = byKey.get(
      `${params.experiment.repeatIndex}:${matchId}:${params.experiment.variant}`,
    );
    if (baseline === undefined || harness === undefined) throw new Error("experiment trial plan is incomplete");
    return { matchId, baseline, harness };
  });
}

type BaselineTaskResult = Awaited<ReturnType<typeof runBaselineTask>>;

function resumedBaseline(trial: ExperimentTrial): BaselineTaskResult | null {
  if (trial.metrics === undefined) return null;
  return {
    passed: trial.metrics.qualityScore >= 0.5,
    costUsd: trial.metrics.costUsd,
    outcome: trial.metrics.measurementFailure ? "error" : "completed",
    policyViolation: trial.metrics.safetyViolation,
  };
}

function resumedHarness(trial: ExperimentTrial): HarnessTaskResult | null {
  if (trial.metrics === undefined) return null;
  return {
    passed: trial.metrics.qualityScore >= 0.5,
    costUsd: trial.metrics.costUsd,
    outcome: trial.metrics.measurementFailure
      ? "error"
      : trial.metrics.escalationCount > 0
        ? "escalated"
        : trial.metrics.qualityScore >= 0.5
          ? "worker-approved"
          : "failed",
    telemetry: {
      taskClass: trial.features.taskClass,
      routeId: trial.features.routeId,
      family: trial.features.family,
      dialectPack: trial.features.dialectPack,
      retryCount: trial.metrics.retryCount,
      escalationCount: trial.metrics.escalationCount,
      interventionCount: trial.metrics.interventionCount,
      toolErrorCount: trial.metrics.toolErrorCount,
      policyViolation: trial.metrics.safetyViolation,
      fullyPriced: trial.metrics.fullyPriced,
    },
  };
}

function baselineTrialMetrics(result: BaselineTaskResult, latencyMs: number): TrialMetrics {
  return {
    qualityScore: result.passed ? 1 : 0,
    costUsd: result.costUsd,
    latencyMs,
    retryCount: 0,
    escalationCount: 0,
    interventionCount: 0,
    toolErrorCount: 0,
    safetyViolation: result.policyViolation,
    measurementFailure: result.outcome === "error",
    fullyPriced: result.costUsd !== null,
  };
}

function harnessTrialMetrics(result: HarnessTaskResult, latencyMs: number): TrialMetrics {
  return {
    qualityScore: result.passed ? 1 : 0,
    costUsd: result.costUsd,
    latencyMs,
    retryCount: result.telemetry?.retryCount ?? 0,
    escalationCount: result.telemetry?.escalationCount ?? 0,
    interventionCount: result.telemetry?.interventionCount ?? 0,
    toolErrorCount: result.telemetry?.toolErrorCount ?? 0,
    safetyViolation: result.telemetry?.policyViolation ?? false,
    measurementFailure: result.outcome === "error" || result.outcome === "apply-failed",
    fullyPriced: result.telemetry?.fullyPriced ?? result.costUsd !== null,
  };
}

// The pipeline itself: guard -> per-task (baseline + harness, both scored by
// the same oracle) -> aggregate -> system benchmark verdict. See this
// module's header comment for the full baseline-vs-harness wiring rationale.
export async function runEvals(engine: Engine, params: EvalsRunParams): Promise<EvalsReportCard> {
  requireGitRepo(params.projectDir);
  const baselineFrontier = resolveFrontierSelection(params.frontier?.baseline);

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
  const runtimeStore = engine.runtime.getStore(params.projectDir);
  const evalSandboxStatus = await engine.runtime.sandbox.status();
  if (!evalSandboxStatus.available) {
    throw new RpcMethodError(
      RpcErrorCodes.SERVER_ERROR,
      `evaluation sandbox is unavailable: ${evalSandboxStatus.reason ?? "startup probe failed"}`,
      { reasonCode: "eval-sandbox-unavailable", policyVersion: EVAL_POLICY_VERSION },
    );
  }
  const experimentTrials = params.experiment === undefined
    ? undefined
    : await planExperimentTrials(
        engine,
        { ...params, experiment: params.experiment },
        harnessBundle,
      );
  const evidenceStore = experimentTrials === undefined
    ? undefined
    : runtimeStore;

  progress(engine, "start", undefined, params.runId);

  // C1 / I2 (final review): snapshot the meter's own record count BEFORE any
  // task in this run makes a single model call. Every aggregate this
  // function reads off the meter after the loop (pricingConfidence,
  // unpricedCalls) is scoped to `meter.totals(runMeterStartIndex)` — records
  // at or after this index — never the engine's whole-lifetime ledger. Under
  // M7's long-lived engine, a prior unrelated run's records must not taint
  // (or, for pricingConfidence, ever hide behind) this run's own report
  // card. See CostMeter.recordCount()'s own doc comment.
  const runMeterStartIndex = engine.models.meter.recordCount();

  // M7b Task 2: READ-ONLY lookup only -- see EvalsRunParams.runId's own doc
  // comment. `undefined` both when no runId was given and when a given
  // runId doesn't resolve to a registered controller -- either way, every
  // downstream `cancelSignal?.` check below degrades to a no-op.
  const cancelSignal = params.runId !== undefined ? engine.cancelRegistry.get(params.runId)?.signal : undefined;

  let escalations = 0;
  const perTask: PerTaskResult[] = [];

  try {
    for (const [taskIndex, task] of params.tasks.entries()) {
      // Checked at the very top of each iteration, BEFORE this task's own
      // mkdtemp calls -- this is the "check the cancel signal between
      // tasks" requirement, and it also guarantees a cancelled run never
      // even starts a new task's scratch dirs.
      if (cancelSignal?.aborted) throw new RunCancelledError();

      const experimentPair = experimentTrials?.[taskIndex];
      let baseline: BaselineTaskResult | null = experimentPair === undefined
        ? null
        : resumedBaseline(experimentPair.baseline);
      let harnessResult: HarnessTaskResult | null = experimentPair === undefined
        ? null
        : resumedHarness(experimentPair.harness);
      if (baseline !== null && harnessResult !== null) {
        progress(engine, "scored", task.id, params.runId);
        if (harnessResult.outcome === "escalated") escalations += 1;
        perTask.push({
          id: task.id,
          baselinePassed: baseline.passed,
          baselineOutcome: baseline.outcome,
          harnessPassed: harnessResult.passed,
          harnessOutcome: harnessResult.outcome,
          baselineUsd: baseline.costUsd,
          harnessUsd: harnessResult.costUsd,
          ...(baseline.policyViolation ? { baselinePolicyViolation: true } : {}),
          ...(harnessResult.telemetry?.policyViolation === true ? { harnessPolicyViolation: true } : {}),
        });
        continue;
      }

      // TMP placement — see this module's header comment. Never nested inside
      // params.projectDir.
      const baselineDir = await mkdtemp(path.join(os.tmpdir(), "of-eval-baseline-"));
      const harnessDir = await mkdtemp(path.join(os.tmpdir(), "of-eval-harness-"));
      let baselineClaimed = false;
      let harnessClaimed = false;
      try {
        await task.setup(baselineDir);
        await task.setup(harnessDir);
        await initEvalGitRepo(baselineDir);
        await initEvalGitRepo(harnessDir);
        const [baselineTree, harnessTree] = await Promise.all([
          evalTreeSha(baselineDir),
          evalTreeSha(harnessDir),
        ]);
        if (baselineTree !== harnessTree) {
          throw new Error(`evaluation arm snapshots differ for task ${task.id}`);
        }
        // Build and pin both identical committed-source indexes, then expose
        // one authenticated server to both arms. The identity comparison
        // prevents a transport optimization from hiding index drift.
        await Promise.all([
          engine.wiki.build(baselineDir),
          engine.wiki.build(harnessDir),
        ]);
        const baselineWiki = engine.wiki.getStore(baselineDir);
        const harnessWiki = engine.wiki.getStore(harnessDir);
        if (baselineWiki.getMeta("source_fingerprint") !== harnessWiki.getMeta("source_fingerprint")) {
          throw new Error(`evaluation arm wiki snapshots differ for task ${task.id}`);
        }
        const wikiServer = await engine.wiki.startMcpServer(engine, baselineDir);
        const taskWikiMcp = { url: wikiServer.url, bearerToken: wikiServer.bearerToken };
        await writeHarness(harnessDir, harnessBundle);

        const runBaselineArm = async (): Promise<void> => {
          if (baseline !== null) return;
          if (experimentPair !== undefined && evidenceStore !== undefined) {
            const claimed = engine.runtime.evidence.claimTrialById(evidenceStore, experimentPair.baseline.id);
            const resumed = resumedBaseline(claimed);
            if (resumed !== null) {
              baseline = resumed;
              return;
            }
            baselineClaimed = true;
          }
          progress(engine, "baseline", task.id, params.runId);
          const startedAt = Date.now();
          baseline = await runBaselineTask(
            engine,
            baselineDir,
            task,
            baselineFrontier,
            resolveFrontierSelection(params.frontier?.review),
            taskWikiMcp,
            runtimeStore,
            cancelSignal,
            params.supervisor,
          );
          if (experimentPair !== undefined && evidenceStore !== undefined) {
            engine.runtime.evidence.completeTrial(
              evidenceStore,
              experimentPair.baseline.id,
              baselineTrialMetrics(baseline, Date.now() - startedAt),
            );
            baselineClaimed = false;
          }
        };
        const runHarnessArm = async (): Promise<void> => {
          if (harnessResult !== null) return;
          if (experimentPair !== undefined && evidenceStore !== undefined) {
            const claimed = engine.runtime.evidence.claimTrialById(evidenceStore, experimentPair.harness.id);
            const resumed = resumedHarness(claimed);
            if (resumed !== null) {
              harnessResult = resumed;
              return;
            }
            harnessClaimed = true;
          }
          progress(engine, "harness", task.id, params.runId);
          const startedAt = Date.now();
          harnessResult = await runHarnessTask(engine, harnessDir, task, runtimeStore, {
            runId: params.runId,
            abortSignal: cancelSignal,
            frontier: params.frontier,
            wikiMcp: taskWikiMcp,
            experimentVariant: params.experiment?.variant,
            supervisor: params.supervisor,
          });
          if (experimentPair !== undefined && evidenceStore !== undefined) {
            engine.runtime.evidence.completeTrial(
              evidenceStore,
              experimentPair.harness.id,
              harnessTrialMetrics(harnessResult, Date.now() - startedAt),
            );
            harnessClaimed = false;
          }
        };
        if (params.armOrder === "harness-first") {
          await runHarnessArm();
          await runBaselineArm();
        } else {
          await runBaselineArm();
          await runHarnessArm();
        }

        if (baseline === null || harnessResult === null) {
          throw new Error("evaluation arm did not produce a result");
        }

        progress(engine, "scored", task.id, params.runId);

        if (harnessResult.outcome === "escalated") escalations += 1;

        perTask.push({
          id: task.id,
          baselinePassed: baseline.passed,
          baselineOutcome: baseline.outcome,
          harnessPassed: harnessResult.passed,
          harnessOutcome: harnessResult.outcome,
          baselineUsd: baseline.costUsd,
          harnessUsd: harnessResult.costUsd,
          ...(baseline.policyViolation ? { baselinePolicyViolation: true } : {}),
          ...(harnessResult.telemetry?.policyViolation === true ? { harnessPolicyViolation: true } : {}),
        });
      } finally {
        // Eval scratch repositories are transient and always removed on
        // success, failure, or cancellation. CandidateService removes an
        // applied candidate worktree immediately; engine shutdown removes
        // any remaining in-memory candidate authority and worktrees.
        if (baselineClaimed && evidenceStore !== undefined && experimentPair !== undefined) {
          engine.runtime.evidence.releaseTrial(evidenceStore, experimentPair.baseline.id);
        }
        if (harnessClaimed && evidenceStore !== undefined && experimentPair !== undefined) {
          engine.runtime.evidence.releaseTrial(evidenceStore, experimentPair.harness.id);
        }
        await engine.wiki.releaseProject(baselineDir);
        await engine.wiki.releaseProject(harnessDir);
        await rm(baselineDir, { recursive: true, force: true });
        await rm(harnessDir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    if (cancelSignal?.aborted) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "evals.run cancelled", {
        cancelled: true,
        taskCount: params.tasks.length,
        completedTasks: perTask.length,
        perTask,
      });
    }
    throw err; // a genuine bug/crash, not cancellation — unchanged behavior
  }

  progress(engine, "done", undefined, params.runId);

  // Run-scoped (C1 / I2): everything this run's own task loop added to the
  // meter, and nothing else — see runMeterStartIndex's own doc comment
  // above. Pure verdict math lives in ./verdict.ts (shared with the bench).
  const runMeterTotals = engine.models.meter.totals(runMeterStartIndex);
  const m = harnessBundle.manifest;
  const report = computeEvalsVerdict({
    perTask,
    unpricedCalls: runMeterTotals.unpricedCalls,
    pricingConfidence: runMeterTotals.pricingConfidence,
    escalations,
    sampleNote: params.sampleNote,
    harnessConfig: {
      schemaVersion: m.schemaVersion,
      harnessProfile: m.harnessProfile ?? "openfusion-native",
      familyCatalogVersion: m.familyCatalogVersion ?? FAMILY_CATALOG_VERSION,
      dialectPackVersion: m.dialectPackVersion ?? DIALECT_PACK_CATALOG_VERSION,
      routePolicyVersion: m.routePolicyVersion ?? String(harnessBundle.routing.version),
      evalPolicyVersion: EVAL_POLICY_VERSION,
      evaluatorOracleIdentity: EVALUATOR_ORACLE_IDENTITY,
      frontierEngine: [
        `review=${resolveFrontierSelection(params.frontier?.review).engine}`,
        `escalation=${resolveFrontierSelection(params.frontier?.escalation).engine}`,
        `baseline=${baselineFrontier.engine}`,
      ].join(","),
      frontierRoles: {
        ...(m.planningFrontier !== undefined ? { planning: m.planningFrontier } : {}),
        review: resolveFrontierSelection(params.frontier?.review),
        escalation: resolveFrontierSelection(params.frontier?.escalation),
        baseline: baselineFrontier,
      },
    },
  });

  // Benchmark results describe this pinned system configuration. They never
  // certify or mutate the individual project harness used to run the sample.
  return report;
}
