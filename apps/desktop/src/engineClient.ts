// The typed boundary between the React UI and the two things it talks to:
//
//   1. the engine sidecar, via the Rust `engine_call` / `engine_events`
//      commands (`apps/desktop/src-tauri/src/commands.rs`) — JSON-RPC 2.0
//      request/response plus a notification stream;
//   2. the OS keychain-backed secret store, via its own dedicated Rust
//      commands (`apps/desktop/src-tauri/src/secrets.rs`) — NOT engine RPC.
//
// Keeping those two invoke surfaces behind separate method groups here (the
// `EngineClient` class vs. the free `setSecret`/`getSecret`/... functions)
// mirrors that boundary: a caller reading this file's exports can always
// tell which one it's targeting.
//
// ## The M7a de-dup finding this fixes
//
// M7a's placeholder screen (see git history for the old `src/main.ts`)
// called `invoke('engine_events', { channel })` directly from a page-level
// `subscribeToEngineEvents()`. That's fine for exactly one caller ever
// subscribing, but the Rust side (`commands.rs::engine_events`) spawns a
// brand-new pump task and broadcast subscriber on EVERY invocation — so if
// two components each called it, the sidecar's notification stream would be
// forwarded twice, onto two different channels, doubling every downstream
// notification handler's work (and, worse, each pump silently leaking until
// app shutdown).
//
// `EngineClient` closes that gap: `onEngineEvent` is the only public way to
// receive notifications, and it lazily invokes `engine_events` AT MOST ONCE
// per `EngineClient` instance, no matter how many UI components subscribe.
// The app-wide singleton exported below (`engineClient`) is what every
// screen should import — one instance, one Channel, one invoke, for the
// whole app's lifetime.
//
// ## No-content-logging invariant
//
// Same rule as the Rust side of this bridge: nothing in this module ever
// logs a call's `method`/`params`/`result`, a notification's body, or a
// secret's value — only this doc comment's prose does. A dedicated grep
// test (`noConsoleLogging.test.ts`) enforces that no `console.*` call
// exists anywhere under `src/` at all, which is a stronger, simpler
// invariant to hold than "never log THESE specific fields."
import { invoke, Channel } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// engine_call + typed error mapping
// ---------------------------------------------------------------------------

/** Mirrors `commands::EngineCallError` (apps/desktop/src-tauri/src/commands.rs)
 * — the JSON-RPC `{code, message, data}` shape a rejected `engine_call`
 * invoke() rejects with. */
interface RawEngineCallError {
  code: number;
  message: string;
  data?: unknown;
}

function isRawEngineCallError(value: unknown): value is RawEngineCallError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code: unknown }).code === "number" &&
    typeof (value as { message: unknown }).message === "string"
  );
}

/** The typed error the UI catches. Carries the same `code`/`message`/`data`
 * as the Rust-side `EngineCallError`, so a catch site can branch on `code`
 * (a JSON-RPC error code) without parsing anything itself. */
export class EngineError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.data = data;
  }
}

export interface CallOptions {
  timeoutMs?: number;
}

/** Thrown by a `CancellableRun`'s `promise` when the run ended because it was
 * CANCELLED, as opposed to a genuine failure. `engine.orchestrate`'s and
 * `engine.evals.run`'s own pipelines (packages/engine/src/orchestrate/
 * orchestrate.ts, packages/engine/src/evals/run.ts) report a cancellation as
 * a SERVER_ERROR `EngineError` whose `data.cancelled === true` — this class
 * is what a `runOrchestrate`/`runEvals` caller actually sees instead, so a UI
 * catch site can `instanceof RunCancelledError` to render "Cancelled" rather
 * than "Failed" without inspecting `error.data` itself. `data` carries
 * whatever the underlying `EngineError` attached (orchestrate's own partial
 * `attempts`/`worktree`, or evals.run's own `taskCount`/`completedTasks`/
 * `perTask`) so a caller can still show partial progress if it wants to. */
export class RunCancelledError extends Error {
  readonly runId: string;
  readonly data: unknown;

  constructor(runId: string, data: unknown) {
    super(`run ${runId} was cancelled`);
    this.name = "RunCancelledError";
    this.runId = runId;
    this.data = data;
  }
}

/** True for an `EngineError` carrying the engine's cancellation marker
 * (`data.cancelled === true` — see `RunCancelledError`'s own doc comment for
 * exactly which engine-side catch sets it). Anything else — a plain object
 * `data` with no `cancelled` field, a non-object `data`, or a rejection that
 * isn't an `EngineError` at all — is a genuine failure, not a cancellation. */
function isCancelledEngineError(err: unknown): err is EngineError {
  return (
    err instanceof EngineError &&
    typeof err.data === "object" &&
    err.data !== null &&
    (err.data as { cancelled?: unknown }).cancelled === true
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// engine.cancel({runId}) returns {cancelled:false} both for an unknown/
// already-finished runId AND for the cancel-before-register race (the RPC
// handler that mints and register()s this runId — orchestrate/methods.ts's
// or evals/methods.ts's own handler — hasn't reached its register() call
// yet when engine.cancel arrives). CancellableRun.cancel() can't tell those
// apart from the response alone, so it retries a bounded few times, a short
// delay apart, UNLESS the run has already settled on its own (nothing left
// to cancel) — see `#startCancellableRun`'s own `cancel` closure below.
const CANCEL_RETRY_ATTEMPTS = 3;
const CANCEL_RETRY_DELAY_MS = 150;

// ---------------------------------------------------------------------------
// engine_events notifications: a typed envelope + pub/sub
// ---------------------------------------------------------------------------

/** A JSON-RPC notification forwarded off the engine's broadcast channel: a
 * `method` (e.g. `"orchestrate.progress"`) and its `params`. This is a loose
 * envelope, not a full discriminated union over every method Task 6/M7c
 * will add — narrowing on `method` is left to each subscriber. */
export interface EngineNotification {
  method: string;
  params: unknown;
}

function toEngineNotification(message: unknown): EngineNotification {
  if (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { method?: unknown }).method === "string"
  ) {
    const { method, params } = message as { method: string; params?: unknown };
    return { method, params };
  }
  // Defensive fallback: the sidecar is expected to only ever emit
  // {method, params} notifications (see engine_bridge.rs), but a malformed
  // or unexpected message shouldn't crash a subscriber — surface it as an
  // "unknown" notification instead.
  return { method: "unknown", params: message };
}

export type EngineEventHandler = (notification: EngineNotification) => void;
export type Unsubscribe = () => void;

/** The result of starting a cancellable long-running engine call
 * (`runOrchestrate`/`runEvals` below): a client-minted `runId` (also passed
 * to the engine RPC call so `engine.cancel({runId})` can reach it), the
 * call's own `promise` (rejects with a `RunCancelledError` — not a plain
 * `EngineError` — if the run was cancelled rather than genuinely failing),
 * and a `cancel()` that requests cancellation (see `#startCancellableRun`'s
 * own doc comment for the full contract, including the cancel-before-register
 * retry and the single-run-at-a-time progress-filtering assumption). */
export interface CancellableRun<T> {
  runId: string;
  promise: Promise<T>;
  cancel: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Hand-mirrored response shapes — evaluated at Task 6, kept hand-mirrored
// ---------------------------------------------------------------------------
//
// `ModelProviderSummary`/`WikiBuildStats`/`WikiStatus` mirror response types
// that really live in `@openfusion/engine`
// (`packages/engine/src/models/providers.ts`'s `ProviderRegistry.list()`
// return type, `packages/engine/src/wiki/indexer.ts`'s `IndexStats`,
// `packages/engine/src/wiki/methods.ts`'s inline `engine.wiki.status`
// result). Task 6 evaluated importing rather than re-declaring them:
//
//   - `@openfusion/engine` is a Node-only backend package (better-sqlite3
//     native bindings, tree-sitter WASM parsers, the `ai` SDK and its
//     provider clients) — a browser/webview bundle (this Vite app) has no
//     business depending on it, even just for types; the desktop
//     `package.json` doesn't (and shouldn't) list it as a dependency.
//   - `@openfusion/shared` (`packages/shared/src/index.ts`/`rpc.ts`) IS
//     already the clean cross-package import site (zod, no Node-only
//     runtime deps) — but today it only exports the generic JSON-RPC
//     envelope (`RpcErrorCodes`, request/response schemas), not per-method
//     result shapes. Making it export e.g. a `WikiBuildResultSchema` would
//     mean moving/duplicating that shape out of `@openfusion/engine`,
//     which is engine-side work outside this task's scope (the engine
//     package + its test suite are untouched by this milestone).
//
// Decision: keep hand-mirroring here, but fix the drift Task 5 shipped with
// (`WikiBuildStats` below was missing over half of the real `IndexStats`
// fields) and document the risk inline. TODO(future milestone): if
// `@openfusion/shared` grows per-method zod schemas that both the engine's
// `registerMethod` call sites and this client can import, switch to those
// and delete these hand mirrors — until then, a shape change on the engine
// side (`IndexStats`, `ProviderRegistry.list()`, `engine.wiki.status`'s
// inline return) has no compile-time link to these interfaces; only a
// runtime shape mismatch would catch drift.

export type ProviderKind = "moonshot" | "zai" | "deepseek" | "openai-compatible";

export interface ProviderConfigInput {
  id: string;
  kind: ProviderKind;
  apiKey: string;
  baseURL?: string;
}

export interface ProviderConnectionCheckInput extends ProviderConfigInput {
  model: string;
}

export interface ModelProviderSummary {
  id: string;
  kind: ProviderKind;
  baseURL?: string;
}

export interface ModelsListResult {
  providers: ModelProviderSummary[];
}

/** Mirrors `packages/engine/src/wiki/indexer.ts`'s `IndexStats` — the real
 * result of `engine.wiki.build`. Task 5's version of this interface only had
 * `filesIndexed`/`filesSkipped`; fixed here to match every field the engine
 * actually returns. */
export interface WikiBuildStats {
  filesSeen: number;
  filesIndexed: number;
  filesSkipped: number;
  filesFailed: number;
  filesRemoved: number;
  symbols: number;
  refs: number;
  headSha: string;
  sourceFingerprint: string;
  coverage: {
    supportedTracked: number;
    currentEntries: number;
    unchanged: number;
    oversized: number;
    unreadable: number;
    parseFailed: number;
    removed: number;
  };
}

/** Mirrors the inline result shape of `engine.wiki.status`
 * (`packages/engine/src/wiki/methods.ts`). `headSha` is `null` when the
 * wiki hasn't been built yet for this project. */
export interface WikiStatus {
  built: boolean;
  headSha: string | null;
  currentSha: string;
  stale: boolean;
  files: number;
  symbols: number;
  refs: number;
}

/** Mirrors `packages/engine/src/harness/store.ts`'s `harnessStatus` return:
 * a cheap manifest-only read of whether `.openfusion` has a generated
 * harness, whether its structure passed, and which git HEAD it targets.
 * `card` mirrors `manifest.verification.card` — `null` when no project card
 * exists yet (a hand-edited or pre-card-feature bundle). This panel doesn't
 * read `card` itself (it reads `HarnessTeam.card` via `harnessRead`
 * instead), but Task 10's screen does. */
export interface HarnessStatus {
  present: boolean;
  structural: "pass" | "fail" | null;
  headSha: string | null;
  card: "draft" | "approved" | null;
}

export interface HarnessHealthIssue {
  code: string;
  severity: "error" | "warning" | "info";
}

export interface HarnessHealthReport {
  checkedAt: string;
  overall: "healthy" | "degraded" | "insufficient-evidence" | "failed";
  harness: {
    present: boolean;
    structural: "passed" | "failed" | "not-run";
    freshness: "current" | "stale" | "unknown";
    card: "draft" | "approved" | "missing";
  };
  wiki: {
    operational: "passed" | "failed" | "inconclusive" | "not-run";
    index: "passed" | "failed" | "inconclusive" | "cancelled" | "not-run";
    retrieval: "passed" | "failed" | "inconclusive" | "cancelled" | "not-run";
    delivery: "passed" | "failed" | "inconclusive" | "cancelled" | "not-run";
  };
  operational: {
    status: "healthy" | "degraded" | "insufficient-evidence";
    sampleSize: number;
    successfulRuns: number;
    failedRuns: number;
    errorRuns: number;
    cancelledRuns: number;
    escalatedRuns: number;
    reviewRequestChanges: number;
    toolErrors: number;
    applySucceeded: number;
    applyFailed: number;
    lastRunAt: string | null;
  };
  issues: HarnessHealthIssue[];
}

/** Mirrors the engine's `AgentModel` (harness/schema.ts). */
export type AgentModel = "frontier" | { kind: string; model: string; providerId?: string };

export type FrontierEngineKind = "claude-code" | "codex";
export interface FrontierSelection {
  engine: FrontierEngineKind;
  model?: string;
}
export interface FrontierRoleSelections {
  planning: FrontierSelection;
  review: FrontierSelection;
  escalation: FrontierSelection;
  baseline: FrontierSelection;
}
export interface FrontierModelEntry {
  engine: FrontierEngineKind;
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}
export interface FrontierModelsResult {
  models: FrontierModelEntry[];
  unavailable: Array<{ engine: FrontierEngineKind; message: string }>;
}

/** One row of the harness team, as `engine.harness.read` returns it. */
export interface HarnessAgentView {
  name: string;
  role: string;
  taskClasses: string[];
  model: AgentModel;
}

/** `engine.harness.read` result — the trimmed, editable team view. `card` is
 * `null` when the harness has no project card page (a hand-edited bundle can
 * have one without the other — see the engine's `findCardPage` +
 * `manifest.verification.card` gate in `harness/methods.ts`). */
export interface HarnessTeam {
  agents: HarnessAgentView[];
  defaultAgent: string;
  escalation: number;
  card: { digest: string; body: string; state: "draft" | "approved" } | null;
}

export interface RoutingCandidate {
  id: string;
  harnessDigest: string;
  evidenceDigest: string;
  status: "proposed" | "shadowed" | "promoted" | "rejected" | "rolled-back";
  shadowCompleted: boolean;
  gate: {
    cleanMatchedTasks: number;
    noSafetyViolation: boolean;
    fullyPriced: boolean;
    eligible: boolean;
    reasons: string[];
    qualityDelta: { mean: number; lower95: number; upper95: number };
    pairedSavings: { mean: number; lower95: number; upper95: number };
  };
  table: {
    version: 3;
    evidenceDigest: string;
    fallback: "configured-route";
    overrides: Array<{
      when: Record<string, string>;
      routeId: string;
      family: string;
      dialectPack: string;
      contextPolicy: "full-history" | "compaction" | "unknown";
    }>;
  };
}

/** Mirrors `packages/engine/src/harness/generate.ts`'s
 * `GenerateHarnessResult`: the one-time build result after the frontier
 * session writes the harness bundle. */
export interface GenerateHarnessResult {
  files: string[];
  reportCard: { structural: "pass"; operational: "insufficient-evidence" };
  estimatedCostUsd: number | null;
  pages: number;
  agents: number;
  note: string;
}

// M7c Task 2: the `engine.orchestrate` result shape and occasional
// `engine.evals.run` benchmark result shape — same hand-mirror
// posture and drift caveat as `WikiBuildStats`/`WikiStatus` above (checked
// field-for-field against `packages/engine/src/orchestrate/orchestrate.ts`'s
// `OrchestrateResult`/`OrchestrateAttempt` and
// `packages/engine/src/evals/run.ts`'s `EvalsReportCard`/`PerTaskResult` as
// of this task; a later engine-side shape change has no compile-time link to
// these interfaces).

/** Mirrors `packages/engine/src/models/meter.ts`'s `PricingConfidence`. */
export type PricingConfidence = "verified" | "provider-reported" | "secondary" | "unverified" | "unpriced";

/** Mirrors `packages/engine/src/orchestrate/review.ts`'s `ReviewVerdict` —
 * the structured decision a read-only frontier review session returns for
 * one worker attempt's diff. */
export interface ReviewVerdict {
  decision: "approve" | "request-changes";
  reasons: string[];
  severity: "none" | "minor" | "major";
}

/** Mirrors `OrchestrateAttempt` (orchestrate.ts) — one worker or frontier
 * attempt within a single `engine.orchestrate` run. `verdict` is present once
 * a worker attempt's (non-empty) diff has been reviewed; `empty: true` marks
 * an attempt that produced no changes at all (never reached review). */
export interface OrchestrateAttempt {
  n: number;
  kind: "worker" | "frontier";
  summary: string;
  verdict?: ReviewVerdict;
  empty?: boolean;
}

export interface CandidateRef {
  schemaVersion: 1;
  candidateId: string;
  diffDigest: string;
  touchedPaths: string[];
  lifecycle: "prepared" | "verified" | "approved" | "stale" | "rejected" | "applied" | "expired";
  createdAt: string;
  expiresAt: string;
}

export interface ApprovalGrant {
  schemaVersion: 1;
  grantId: string;
  token: string;
  candidateId: string;
  destinationProjectDigest: string;
  baseSha: string;
  diffDigest: string;
  issuedAt: string;
  expiresAt: string;
}

export interface CostEstimate {
  knownUsd: number;
  completeness: "complete" | "partial" | "none";
  unpricedCalls: number;
  pricingVersion: string;
  confidence: "verified" | "estimated" | "mixed" | "unpriced";
}

/** Mirrors `OrchestrateResult` (orchestrate.ts) — the full result of one
 * `engine.orchestrate` run: which agent/model it routed to, every attempt
 * made, the final diff (empty on `"failed"`), the worktree it was produced
 * in (`null` once cleaned up — a `"failed"` outcome with an empty escalation
 * diff, notably), and a cost breakdown.
 *
 * `cost.pricingConfidence` is NOT part of the engine's actual
 * `OrchestrateResult` today — only `EvalsReportCard` carries a top-level
 * `pricingConfidence` (below), aggregated across a whole eval run. Kept here
 * as an OPTIONAL field per this task's own brief, so the Orchestrate screen
 * can read it defensively if a future engine change adds a per-run pricing
 * confidence to `cost` — but this type must not be read as claiming the
 * engine returns it today (see this section's drift-caveat header comment).
 */
export interface OrchestrateResult {
  outcome: "worker-approved" | "escalated" | "failed";
  agent: string;
  taskClass: string;
  resolution: { providerId: string; model: string } | "frontier";
  frontier?: { review: FrontierSelection; escalation: FrontierSelection };
  taskSnapshot?: {
    baseSha: string;
    dirtyState: {
      category: "clean" | "tracked" | "untracked" | "mixed";
      digest: string;
    };
  };
  candidateRef: CandidateRef | null;
  verificationIncomplete?: boolean;
  attempts: OrchestrateAttempt[];
  diff: string;
  diffStat: string;
  worktree: { path: string; branch: string } | null;
  cost: {
    workerUsd: number | null;
    reviewUsd: number | null;
    frontierUsd: number | null;
    escalateUsd: number | null;
    totalUsd: number | null;
    note: "estimate-class";
    pricingConfidence?: PricingConfidence;
  };
  costEstimate: CostEstimate;
}

/** Mirrors `HarnessTaskOutcome` (evals/run.ts) — the harness side's per-task
 * outcome, one step wider than `OrchestrateResult["outcome"]` to name the two
 * ways scoring can fail WITHOUT `engine.orchestrate` itself failing:
 * `"apply-failed"` (a diff was produced but didn't apply) and `"error"` (the
 * orchestrate call itself threw). Both are MEASUREMENT failures, not quality
 * evidence — see `EvalsReportCard.measurementFailureCount`. */
export type HarnessTaskOutcome = OrchestrateResult["outcome"] | "apply-failed" | "error";

/** Mirrors `BaselineTaskOutcome` (evals/run.ts) — symmetric with
 * `HarnessTaskOutcome`: `"error"` means the direct frontier baseline turn
 * itself failed before producing a scoreable attempt; `"completed"` means it
 * ran to completion (independent of whether it actually passed). */
export type BaselineTaskOutcome = "completed" | "error";

/** Mirrors `PerTaskResult` (evals/run.ts) — one paired baseline-vs-harness
 * task result within an `engine.evals.run` report card. */
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

/** Mirrors `EvalsReportCard` (evals/run.ts) — the M6 baseline-vs-harness
 * report card `engine.evals.run` returns. `savingsPct`/`qualityHeld` are the
 * RAW (all-task) figures; `verdict` is actually computed off the CLEAN
 * subset (tasks where neither side hit a measurement failure) — the
 * `clean*`/`measurementFailureCount` fields (M7c Task 1) surface exactly the
 * numbers that computation used, so a caller can show WHY a verdict is what
 * it is without re-deriving them from `perTask`. */
export interface EvalsReportCard {
  taskCount: number;
  baseline: { passed: number; costUsd: number | null };
  harness: { passed: number; costUsd: number | null; escalations: number };
  savingsPct: number | null;
  qualityHeld: boolean;
  verdict: "pass" | "fail" | "inconclusive";
  pricingConfidence: PricingConfidence;
  perTask: PerTaskResult[];
  note: string;
  cleanTaskCount: number;
  cleanBaselinePassed: number;
  cleanHarnessPassed: number;
  cleanSavingsPct: number | null;
  measurementFailureCount: number;
  policyViolationCount: number;
  harnessConfig?: {
    schemaVersion: 1 | 2;
    harnessProfile: string;
    familyCatalogVersion: string;
    dialectPackVersion: string;
    routePolicyVersion: string;
    evalPolicyVersion: "eval-v1";
    evaluatorOracleIdentity: string;
    frontierEngine: string;
    frontierRoles: {
      planning?: FrontierSelection;
      review: FrontierSelection;
      escalation: FrontierSelection;
      baseline: FrontierSelection;
    };
  };
}

// -- runOrchestrate/runEvals request params (runId is minted internally —
// see `#startCancellableRun` — so it is deliberately NOT part of either
// caller-facing params type below) ------------------------------------------

/** Mirrors `OrchestrateParams` (orchestrate.ts), minus `runId` (minted by
 * `runOrchestrate` itself) — the params a caller supplies. */
export interface OrchestrateRunParams {
  projectDir: string;
  task: string;
  maxWorkerAttempts?: number;
  workerTimeoutMs?: number;
  reviewTimeoutMs?: number;
  frontier?: { review?: FrontierSelection; escalation?: FrontierSelection };
}

export type RuntimeSessionStatus =
  | "created"
  | "running"
  | "waiting-approval"
  | "interrupted"
  | "needs-recovery"
  | "completed"
  | "failed"
  | "cancelled";

export type RuntimeSessionKind = "orchestrate" | "worker" | "child" | "review" | "escalation";

export interface RuntimeSession {
  id: string;
  runId: string;
  parentSessionId?: string;
  kind: RuntimeSessionKind;
  status: RuntimeSessionStatus;
  version: number;
  resumeCapability: "exact" | "worktree-only" | "locked";
  projectDir: string;
  worktreePath?: string;
  baseSha?: string;
  modelFingerprint?: string;
  configurationFingerprint?: string;
  budgetSteps?: number;
  budgetDeadlineAt?: string;
  usedSteps: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  createdAt: string;
  updatedAt: string;
  outcome?: string;
}

export type RuntimeLockedValue<T> =
  | { state: "absent" }
  | { state: "locked" }
  | { state: "available"; value: T };

export interface RuntimeEvent<T = unknown> {
  sessionId: string;
  seq: number;
  type: string;
  at: string;
  metadata: Record<string, unknown>;
  payload: RuntimeLockedValue<T>;
}

export interface RuntimeApproval {
  id: string;
  sessionId: string;
  policySource: string;
  status: "pending" | "approved" | "denied" | "cancelled";
  scope: Record<string, unknown>;
  request: RuntimeLockedValue<unknown>;
  response: RuntimeLockedValue<unknown>;
  createdAt: string;
}

export interface RuntimeSessionDetails {
  session: RuntimeSession;
  pendingApproval: RuntimeApproval | null;
  events?: RuntimeEvent[];
}

export type RuntimeSessionAction =
  | { type: "respond-approval"; approvalId: string; approved: boolean; response?: unknown }
  | { type: "resume" }
  | { type: "recover-current-state" }
  | { type: "recover-checkpoint" }
  | { type: "cancel" }
  | { type: "send-child"; childSessionId: string; message: unknown }
  | { type: "close-child"; childSessionId: string }
  | { type: "import-child-diff"; childSessionId: string };

export interface RuntimeConfiguration {
  traceEnabled: boolean;
  retentionDays: number;
  retentionBytes: number;
  sandboxGrants: string[];
  enabledExtensions: string[];
  childrenEnabled: boolean;
}

export type RuntimeExtensionKind = "skill" | "mcp" | "hook";

export interface RuntimeExtensionRegistration {
  kind: RuntimeExtensionKind;
  id: string;
  fingerprint: string;
  config: Record<string, unknown>;
  diagnostics: Array<{ code: string; message: string }>;
  approvalStatus: "pending" | "approved" | "revoked";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSkillSummary {
  id: string;
  name: string;
  description: string;
  dialect: "common" | "claude-code" | "codex";
  sourcePath: string;
  resources: string[];
  allowedTools: string[];
  invocation: { implicit: boolean; userInvocable: boolean };
  fingerprint: string;
  requiresApproval: boolean;
  diagnostics: Array<{ code: string; field?: string; message: string }>;
}

/** Mirrors `engine.evals.run`'s RPC-level `TaskDescriptorSchema`
 * (evals/methods.ts) — a JSON-safe golden-commit descriptor, the only task
 * shape this RPC method accepts (see that file's own header comment for why
 * the engine-internal `EvalTask` with its `setup()` closure can never cross
 * the wire). */
export interface EvalsTaskDescriptor {
  commitSha: string;
  testCommand: string[];
}

/** Mirrors `engine.evals.run`'s RPC-level `RunParamsSchema` (evals/methods.ts),
 * minus `runId` (minted by `runEvals` itself). */
export interface EvalsRunRequestParams {
  projectDir: string;
  tasks: EvalsTaskDescriptor[];
  sampleNote?: string;
  frontier?: {
    review?: FrontierSelection;
    escalation?: FrontierSelection;
    baseline?: FrontierSelection;
  };
}

// -- progress notification payloads ------------------------------------------

/** Mirrors `orchestrate.ts`'s own `progress()` helper's notification params
 * (`engine.notify("orchestrate.progress", { stage, detail })`) — both fields
 * are always present on every emission. */
export interface OrchestrateProgressEvent {
  stage: string;
  detail: string;
}

/** Mirrors `evals/run.ts`'s own `progress()` helper's notification params
 * (`engine.notify("evals.progress", taskId ? { stage, taskId } : { stage })`)
 * — `taskId` is only present once a specific task's baseline/harness/scored
 * stage is reached (absent for the run-level `"start"`/`"done"` stages). */
export interface EvalsProgressEvent {
  stage: string;
  taskId?: string;
}

/** Mirrors `harness.progress` notifications emitted while
 * `engine.harness.generate` builds the project harness. */
export interface HarnessProgressEvent {
  projectDir: string;
  stage: string;
  detail: string;
}

/** The engine-RPC half of the client (`call` + typed method wrappers) plus
 * the single-subscription notification pub/sub. Construct your own instance
 * in tests; the app itself imports the `engineClient` singleton below. */
export class EngineClient {
  #handlers = new Set<EngineEventHandler>();
  #subscribed = false;

  /** `invoke('engine_call', {method, params, timeoutMs})`, with a thrown
   * `EngineCallError` mapped to a typed `EngineError`. Any other rejection
   * (e.g. `invoke` itself failing outside the engine bridge) is rethrown
   * as-is. */
  async call<T>(method: string, params: unknown, opts?: CallOptions): Promise<T> {
    try {
      return await invoke<T>("engine_call", { method, params, timeoutMs: opts?.timeoutMs });
    } catch (err) {
      if (isRawEngineCallError(err)) {
        throw new EngineError(err.code, err.message, err.data);
      }
      throw err;
    }
  }

  ensureRuntimeKey(projectDir: string): Promise<string> {
    return ensureRuntimeKey(projectDir);
  }

  /** Subscribe to engine notifications. Lazily establishes the ONE
   * `engine_events` Channel/invoke on this instance's first subscriber;
   * every subsequent subscriber (on the same instance) shares it — no
   * additional `engine_events` invoke is ever made. Returns an unsubscribe
   * function; unsubscribing one handler never tears down the shared
   * channel while any other handler remains subscribed (it is never torn
   * down at all — it lives for the instance's lifetime, matching "one
   * subscription for the whole app"). */
  onEngineEvent(handler: EngineEventHandler): Unsubscribe {
    this.#ensureSubscribed();
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  #ensureSubscribed(): void {
    if (this.#subscribed) return;
    this.#subscribed = true;
    const channel = new Channel<unknown>();
    channel.onmessage = (message) => {
      const notification = toEngineNotification(message);
      for (const handler of this.#handlers) {
        handler(notification);
      }
    };
    void invoke("engine_events", { channel });
  }

  // -- typed method wrappers (Task 6's cockpit screens need these) --------

  modelsList(opts?: CallOptions): Promise<ModelsListResult> {
    return this.call<ModelsListResult>("engine.models.list", {}, opts);
  }

  /** Make one minimal provider request before any key or metadata is saved.
   * The engine uses a scratch registry, so a failed check cannot leave a
   * broken provider available for routing. */
  modelsCheckConnection(
    config: ProviderConnectionCheckInput,
    opts?: CallOptions,
  ): Promise<{ connected: true }> {
    return this.call<{ connected: true }>("engine.models.check", config, opts);
  }

  /** `engine.models.configure` — registers (or overwrites) a provider in the
   * engine's in-memory registry so routing can resolve to it. The engine keeps
   * the apiKey memory-only per its own contract; this call carries it once. */
  modelsConfigure(config: ProviderConfigInput, opts?: CallOptions): Promise<{ configured: boolean }> {
    return this.call<{ configured: boolean }>("engine.models.configure", config, opts);
  }

  /** Remove a provider from the engine's live in-memory registry. */
  modelsUnconfigure(id: string, opts?: CallOptions): Promise<{ unconfigured: boolean }> {
    return this.call<{ unconfigured: boolean }>("engine.models.unconfigure", { id }, opts);
  }

  wikiBuild(projectDir: string, opts?: CallOptions): Promise<WikiBuildStats> {
    return this.call<WikiBuildStats>("engine.wiki.build", { projectDir }, opts);
  }

  /** `engine.wiki.status` — cheap, non-mutating: whether a wiki index
   * exists for `projectDir`, whether it's stale (HEAD moved since the last
   * build), and its current file/symbol/ref counts. Also doubles as the
   * Project screen's "is this even a git repo" check: like `wikiBuild`,
   * this throws the engine's `SERVER_ERROR` (via `requireGitRepo`) for a
   * non-git directory. */
  wikiStatus(projectDir: string, opts?: CallOptions): Promise<WikiStatus> {
    return this.call<WikiStatus>("engine.wiki.status", { projectDir }, opts);
  }

  harnessStatus(projectDir: string, opts?: CallOptions): Promise<HarnessStatus> {
    return this.call<HarnessStatus>("engine.harness.status", { projectDir }, opts);
  }

  /** Deterministic harness/wiki verification plus metadata-only operational
   * evidence from recent real runs. This does not run model comparisons or
   * claim that any generated answer is semantically correct. */
  harnessHealth(projectDir: string, opts?: CallOptions): Promise<HarnessHealthReport> {
    return this.call<HarnessHealthReport>("engine.harness.health", { projectDir }, opts);
  }

  /** `engine.harness.generate` is long-running and currently not
   * cancellable. Progress is streamed through `harness.progress` and filtered
   * by projectDir so a stale in-flight notification cannot land in a newly
   * selected project. */
  harnessGenerate(
    projectDir: string,
    onProgress?: (event: HarnessProgressEvent) => void,
    frontier?: FrontierSelection,
    opts?: CallOptions,
  ): Promise<GenerateHarnessResult> {
    const unsubscribe =
      onProgress === undefined
        ? undefined
        : this.onEngineEvent((notification) => {
            if (notification.method !== "harness.progress") return;
            if (typeof notification.params !== "object" || notification.params === null) return;
            const event = notification.params as Partial<HarnessProgressEvent>;
            if (event.projectDir !== projectDir || typeof event.stage !== "string" || typeof event.detail !== "string") {
              return;
            }
            onProgress(event as HarnessProgressEvent);
          });

    return this.call<GenerateHarnessResult>(
      "engine.harness.generate",
      frontier === undefined ? { projectDir } : { projectDir, frontier },
      opts,
    ).finally(() => {
      unsubscribe?.();
    });
  }

  frontierModels(opts?: CallOptions): Promise<FrontierModelsResult> {
    return this.call<FrontierModelsResult>("engine.frontier.models", {}, opts);
  }

  /** `engine.harness.read` — the team view for a READY harness. Throws an
   * `EngineError` when the harness is absent/invalid; gate on `harnessStatus`
   * first for the missing/stale/invalid distinction. */
  harnessRead(projectDir: string, opts?: CallOptions): Promise<HarnessTeam> {
    return this.call<HarnessTeam>("engine.harness.read", { projectDir }, opts);
  }

  /** `engine.harness.updateAgentModel` — reassign one agent's model. */
  harnessUpdateAgentModel(projectDir: string, agentName: string, model: AgentModel, opts?: CallOptions): Promise<{ updated: boolean }> {
    return this.call<{ updated: boolean }>("engine.harness.updateAgentModel", { projectDir, agentName, model }, opts);
  }

  /** `engine.harness.updateEscalation` — set failuresBeforeFrontier (1–3). */
  harnessUpdateEscalation(projectDir: string, failuresBeforeFrontier: number, opts?: CallOptions): Promise<{ updated: boolean }> {
    return this.call<{ updated: boolean }>("engine.harness.updateEscalation", { projectDir, failuresBeforeFrontier }, opts);
  }

  /** `engine.harness.card.update` — save an edited card digest. The engine
   * always resets the card to "draft" as part of this same write (an edit
   * invalidates any prior approval), so no separate approve-reset call is
   * needed here. */
  harnessCardUpdate(projectDir: string, digest: string, opts?: CallOptions): Promise<void> {
    return this.call<void>("engine.harness.card.update", { projectDir, digest }, opts);
  }

  /** `engine.harness.card.approve` — flip the project card's manifest state
   * to "approved" (manifest-only write; see `harness/methods.ts`'s
   * `engine.harness.card.approve` for why it skips `mutateHarness`). */
  harnessCardApprove(projectDir: string, opts?: CallOptions): Promise<void> {
    return this.call<void>("engine.harness.card.approve", { projectDir }, opts);
  }

  routingProposals(projectDir: string, opts?: CallOptions): Promise<{ candidates: RoutingCandidate[] }> {
    return this.call("engine.routing.proposals.list", { projectDir }, opts);
  }

  routingStatus(projectDir: string, opts?: CallOptions): Promise<{
    active: RoutingCandidate | null;
    currentHarnessDigest: string;
  }> {
    return this.call("engine.routing.status", { projectDir }, opts);
  }

  routingCreateProposal(projectDir: string, opts?: CallOptions): Promise<{ candidate: RoutingCandidate }> {
    return this.call("engine.routing.proposals.create", { projectDir }, opts);
  }

  routingCompleteShadow(
    projectDir: string,
    candidate: Pick<RoutingCandidate, "id" | "evidenceDigest">,
    opts?: CallOptions,
  ): Promise<{ candidate: RoutingCandidate }> {
    return this.call(
      "engine.routing.proposals.shadow",
      { projectDir, candidateId: candidate.id, evidenceDigest: candidate.evidenceDigest },
      opts,
    );
  }

  routingPromote(
    projectDir: string,
    candidateId: string,
    expectedHarnessDigest: string,
    opts?: CallOptions,
  ): Promise<{ candidate: RoutingCandidate }> {
    return this.call(
      "engine.routing.proposals.promote",
      { projectDir, candidateId, expectedHarnessDigest, humanApproved: true },
      opts,
    );
  }

  routingRollback(projectDir: string, candidateId: string, opts?: CallOptions): Promise<{
    activeCandidateId?: string;
  }> {
    return this.call("engine.routing.rollback", { projectDir, candidateId }, opts);
  }

  // -- cancellable long runs (M7c Task 2) ----------------------------------

  /** `engine.orchestrate` as a `CancellableRun<OrchestrateResult>` — see
   * `#startCancellableRun`'s own doc comment for the full contract (UUID
   * runId, no timeoutMs, progress filtering + its single-run assumption,
   * cancel-before-register retry, `RunCancelledError` mapping). */
  runOrchestrate(
    params: OrchestrateRunParams,
    onProgress?: (event: OrchestrateProgressEvent) => void,
  ): CancellableRun<OrchestrateResult> {
    return this.#startCancellableRun<OrchestrateResult, OrchestrateProgressEvent>(
      "engine.orchestrate",
      "orchestrate.progress",
      params,
      onProgress,
    );
  }

  /** Durable async orchestration: acknowledges admission immediately. */
  orchestrateStart(
    params: OrchestrateRunParams & { runId?: string },
    opts?: CallOptions,
  ): Promise<{ sessionId: string; runId: string; status: RuntimeSessionStatus; version: number }> {
    return this.call("engine.orchestrate.start", params, opts);
  }

  runtimeConfigure(
    projectDir: string,
    input: Partial<RuntimeConfiguration> & { traceKey?: string },
    opts?: CallOptions,
  ): Promise<{ configured: true; configuration: RuntimeConfiguration }> {
    return this.call("engine.runtime.configure", { projectDir, ...input }, opts);
  }

  runtimeStatus(projectDir: string, opts?: CallOptions): Promise<{
    configuration: RuntimeConfiguration;
    keyState: "host" | "ephemeral" | "locked";
    database: { path: string; schemaVersion: number; integrity: "ok" | "failed" };
    sandbox: { available: boolean; provisional: boolean; reason?: string };
  }> {
    return this.call("engine.runtime.status", { projectDir }, opts);
  }

  runtimeExtensionsList(
    projectDir: string,
    kind?: RuntimeExtensionKind,
    opts?: CallOptions,
  ): Promise<{ extensions: RuntimeExtensionRegistration[] }> {
    return this.call("engine.runtime.extensions.list", { projectDir, ...(kind === undefined ? {} : { kind }) }, opts);
  }

  runtimeExtensionRegister(
    projectDir: string,
    input: Pick<RuntimeExtensionRegistration, "kind" | "id" | "fingerprint" | "config"> & {
      diagnostics?: Array<{ code: string; message: string }>;
    },
    opts?: CallOptions,
  ): Promise<{ extension: RuntimeExtensionRegistration }> {
    return this.call("engine.runtime.extensions.register", { projectDir, ...input }, opts);
  }

  runtimeExtensionApprove(
    projectDir: string,
    extension: Pick<RuntimeExtensionRegistration, "kind" | "id" | "fingerprint">,
    approved: boolean,
    opts?: CallOptions,
  ): Promise<{ extension: RuntimeExtensionRegistration }> {
    return this.call("engine.runtime.extensions.approve", { projectDir, ...extension, approved }, opts);
  }

  runtimeExtensionEnable(
    projectDir: string,
    extension: Pick<RuntimeExtensionRegistration, "kind" | "id" | "fingerprint">,
    enabled: boolean,
    opts?: CallOptions,
  ): Promise<{ extension: RuntimeExtensionRegistration }> {
    return this.call("engine.runtime.extensions.enable", { projectDir, ...extension, enabled }, opts);
  }

  runtimeSkillsDiscover(projectDir: string, opts?: CallOptions): Promise<{ skills: RuntimeSkillSummary[] }> {
    return this.call("engine.runtime.skills.discover", { projectDir }, opts);
  }

  runtimeMcpRegister(
    projectDir: string,
    config: Record<string, unknown>,
    opts?: CallOptions,
  ): Promise<{ extension: RuntimeExtensionRegistration }> {
    return this.call("engine.runtime.mcp.register", { projectDir, config }, opts);
  }

  runtimeMcpConnect(projectDir: string, id: string, opts?: CallOptions): Promise<{
    status: "configuration-approval-required" | "inventory-approval-required" | "connected";
    configurationFingerprint: string;
    inventoryFingerprint?: string;
  }> {
    return this.call("engine.runtime.mcp.connect", { projectDir, id }, opts);
  }

  runtimeHookFingerprint(
    input: { id: string; mode: "observational" | "enforcing"; executable: string; args?: string[] },
    opts?: CallOptions,
  ): Promise<{ fingerprint: string }> {
    return this.call("engine.runtime.hooks.fingerprint", input, opts);
  }

  runtimeCredentialConfigure(reference: string, value?: string, opts?: CallOptions): Promise<{ configured: boolean }> {
    return this.call("engine.runtime.credentials.configure", { reference, value }, opts);
  }

  sessionGet(
    projectDir: string,
    sessionId: string,
    options: { includeEvents?: boolean; afterSeq?: number; eventLimit?: number } = {},
    opts?: CallOptions,
  ): Promise<RuntimeSessionDetails> {
    return this.call("engine.sessions.get", { projectDir, sessionId, ...options }, opts);
  }

  sessionsList(
    projectDir: string,
    filters: {
      status?: RuntimeSessionStatus;
      kind?: RuntimeSessionKind;
      parentSessionId?: string | null;
      limit?: number;
    } = {},
    opts?: CallOptions,
  ): Promise<{ sessions: RuntimeSession[] }> {
    return this.call("engine.sessions.list", { projectDir, ...filters }, opts);
  }

  sessionAction(
    projectDir: string,
    sessionId: string,
    expectedVersion: number,
    action: RuntimeSessionAction,
    opts?: CallOptions,
  ): Promise<{ session: RuntimeSession; approval?: RuntimeApproval }> {
    return this.call(
      "engine.sessions.action",
      { projectDir, sessionId, expectedVersion, action },
      opts,
    );
  }

  /** `engine.evals.run` as a `CancellableRun<EvalsReportCard>` — see
   * `#startCancellableRun`'s own doc comment for the full contract. */
  runEvals(
    params: EvalsRunRequestParams,
    onProgress?: (event: EvalsProgressEvent) => void,
  ): CancellableRun<EvalsReportCard> {
    return this.#startCancellableRun<EvalsReportCard, EvalsProgressEvent>(
      "engine.evals.run",
      "evals.progress",
      params,
      onProgress,
    );
  }

  candidatePrepareApply(
    candidateId: string,
    projectDir: string,
    opts?: CallOptions,
  ): Promise<{ approvalGrant: ApprovalGrant }> {
    return this.call<{ approvalGrant: ApprovalGrant }>(
      "engine.candidates.prepareApply",
      { candidateId, projectDir },
      opts,
    );
  }

  candidateApply(
    candidateId: string,
    approvalGrant: ApprovalGrant,
    projectDir: string,
    runId?: string,
    opts?: CallOptions,
  ): Promise<{ applied: true; candidateId: string }> {
    return this.call<{ applied: true; candidateId: string }>(
      "engine.orchestrate.apply",
      {
        candidateId,
        approvalGrant,
        projectDir,
        ...(runId === undefined ? {} : { runId }),
      },
      opts,
    );
  }

  /** The shared engine behind `runOrchestrate`/`runEvals`:
   *
   * 1. Mints a UUID `runId` (`crypto.randomUUID()`, available in the
   *    webview) and passes it to `method` ALONGSIDE `params`.
   * 2. Fires that call via the plain `call<T>(method, params)` — NO `opts`,
   *    and therefore NO `timeoutMs`. HARD RULE: a long `engine.orchestrate`/
   *    `engine.evals.run` call must NEVER carry a client-side timeoutMs — a
   *    Rust-side per-call timeout (`commands.rs`'s `call_with_timeout`)
   *    abandons the RESPONSE while the engine run keeps executing in the
   *    background; `engine.cancel({runId})` is the only real stop.
   * 3. Subscribes to `onEngineEvent`, forwarding every notification whose
   *    `method` equals `progressMethod` (and, when present, whose `runId`
   *    matches THIS run's) to `onProgress`, and unsubscribes the instant the
   *    run's promise settles (success, failure, OR cancellation) — no leaked
   *    subscription.
   *
   *    RUNID FILTERING (M7c Task 5): `orchestrate.progress`/`evals.progress`
   *    now carry a `runId` (the engine-side fix — `orchestrate.ts`'s and
   *    `evals/run.ts`'s own `progress()` helpers). This filters on it when
   *    present: a notification whose `params.runId` is defined and does NOT
   *    equal this run's own `runId` is dropped, so two concurrently in-flight
   *    runs of the SAME kind no longer interleave onto each other's
   *    `onProgress`. Kept BACKWARD TOLERANT for a notification with no
   *    `runId` at all (`params.runId === undefined`) — treated as "not
   *    filterable, forward it anyway" rather than dropped, so an older
   *    engine build (or any future notification this client doesn't fully
   *    type) can't silently go missing.
   * 4. Returns a `cancel()` that calls `engine.cancel({runId})`. A
   *    `{cancelled:true}` response means the run's own pipeline will reject
   *    with the cancellation marker shortly (handled by the `.catch` below).
   *    A `{cancelled:false}` response is ambiguous — it means either
   *    "unknown/already-finished runId" OR the CANCEL-BEFORE-REGISTER race
   *    (this call reached the engine before `engine.orchestrate`'s/
   *    `engine.evals.run`'s own RPC handler called `CancelRegistry.register`
   *    for this runId — see `cancel-registry.ts`'s header comment). If the
   *    run's promise is STILL PENDING when that ambiguous `false` comes
   *    back, it's treated as the race and retried up to
   *    `CANCEL_RETRY_ATTEMPTS` times, `CANCEL_RETRY_DELAY_MS` apart, before
   *    giving up; if the run has already settled on its own, there is
   *    nothing left to cancel and this returns immediately.
   * 5. The returned `promise` rejects with a `RunCancelledError` — not a
   *    plain `EngineError` — when the underlying call's rejection carries
   *    the engine's cancellation marker (`data.cancelled === true`); any
   *    other rejection (a genuine failure) is rethrown unchanged as the
   *    ordinary `EngineError` (or whatever else `call` rejects with). */
  #startCancellableRun<T, P>(
    method: string,
    progressMethod: string,
    params: object,
    onProgress?: (event: P) => void,
  ): CancellableRun<T> {
    const runId = crypto.randomUUID();
    let settled = false;

    const unsubscribe = this.onEngineEvent((notification) => {
      if (notification.method !== progressMethod) return;
      // See this method's own doc comment ("RUNID FILTERING"): filter on
      // runId only when the notification actually carries one; an absent
      // runId is forwarded rather than dropped (backward tolerant).
      const notificationRunId = (notification.params as { runId?: string } | undefined)?.runId;
      if (notificationRunId !== undefined && notificationRunId !== runId) return;
      onProgress?.(notification.params as P);
    });

    const promise = this.call<T>(method, { ...params, runId })
      .catch((err: unknown) => {
        if (isCancelledEngineError(err)) {
          throw new RunCancelledError(runId, err.data);
        }
        throw err;
      })
      .finally(() => {
        settled = true;
        unsubscribe();
      });

    const cancel = async (): Promise<void> => {
      // Always issues AT LEAST ONE engine.cancel call — an explicit cancel()
      // from the caller always reaches the engine at least once, regardless
      // of what this client-side `settled` flag (inherently racy/eventually
      // consistent) currently believes. `settled` only gates whether a
      // {cancelled:false} response is worth RETRYING (see below).
      for (let attempt = 1; attempt <= CANCEL_RETRY_ATTEMPTS; attempt++) {
        let response: { cancelled: boolean };
        try {
          response = await this.call<{ cancelled: boolean }>("engine.cancel", { runId });
        } catch {
          // engine.cancel itself failing (a transport hiccup) — nothing more
          // this method can do; the run's own promise still settles on its
          // own timeline regardless of this failed cancel attempt.
          return;
        }
        if (response.cancelled) return;
        // {cancelled:false} is ambiguous (unknown/already-finished runId, OR
        // the cancel-before-register race). If the run has ALREADY settled
        // naturally by now, there's nothing left to cancel -- stop instead
        // of burning more attempts. Otherwise, this looks like the race:
        // retry a bounded few more times, a short delay apart.
        if (settled) return;
        if (attempt < CANCEL_RETRY_ATTEMPTS) {
          await delay(CANCEL_RETRY_DELAY_MS);
        }
      }
    };

    return { runId, promise, cancel };
  }
}

/** The app-wide singleton. Every screen/component subscribes through this
 * one instance so the single-subscription invariant holds across the whole
 * app, not just within one component. */
export const engineClient = new EngineClient();

// ---------------------------------------------------------------------------
// Secret commands — separate Rust commands, NOT engine_call/engine RPC.
// ---------------------------------------------------------------------------

/** `invoke('set_secret', {id, value, persist})`. `persist` opts into OS
 * Keychain storage; otherwise the value lives in memory only for this
 * process's lifetime. Never logs `value`. */
export function setSecret(id: string, value: string, persist: boolean): Promise<void> {
  return invoke("set_secret", { id, value, persist });
}

/** `invoke('get_secret', {id})`. Resolves `null` if unset — never throws
 * for a missing id. */
export function getSecret(id: string): Promise<string | null> {
  return invoke<string | null>("get_secret", { id });
}

/** `invoke('delete_secret', {id})`. */
export function deleteSecret(id: string): Promise<void> {
  return invoke("delete_secret", { id });
}

/** `invoke('list_secret_ids')`. Ids only — never values — for populating a
 * "your saved keys" list. */
export function listSecretIds(): Promise<string[]> {
  return invoke<string[]>("list_secret_ids");
}

/** `invoke('load_persisted_secrets')`. Loads every persisted id's value
 * from the Keychain back into the store's in-memory map (normally called
 * once at app startup; exposed here for completeness/tests). */
export function loadPersistedSecrets(): Promise<void> {
  return invoke("load_persisted_secrets");
}

/** Host-generated, Keychain-backed AES-256 trace key for this project. */
export function ensureRuntimeKey(projectDir: string): Promise<string> {
  return invoke<string>("ensure_runtime_key", { projectDir });
}

// ---------------------------------------------------------------------------
// Provider metadata commands (non-secret) — Rust host, NOT engine RPC.
// ---------------------------------------------------------------------------

/** Non-secret provider metadata (never an API key). Mirrors `providers.rs`'s
 * `ProviderMeta`. */
export interface ProviderMeta {
  id: string;
  kind: ProviderKind;
  baseURL?: string;
  model: string;
}

/** `invoke('list_provider_configs')`. */
export function listProviderConfigs(): Promise<ProviderMeta[]> {
  return invoke<ProviderMeta[]>("list_provider_configs");
}

/** `invoke('save_provider_config', { meta })`. */
export function saveProviderConfig(meta: ProviderMeta): Promise<void> {
  return invoke("save_provider_config", { meta });
}

/** `invoke('delete_provider_config', { id })`. */
export function deleteProviderConfig(id: string): Promise<void> {
  return invoke("delete_provider_config", { id });
}

// ---------------------------------------------------------------------------
// Project registry commands (non-secret) — Rust host, NOT engine RPC.
// ---------------------------------------------------------------------------

/** A remembered project. Mirrors `projects.rs`'s `ProjectMeta`. Never a key. */
export interface ProjectMeta {
  path: string;
  name: string;
}

/** `invoke('list_projects')` — MRU order, front = most recently opened. */
export function listProjects(): Promise<ProjectMeta[]> {
  return invoke<ProjectMeta[]>("list_projects");
}

/** `invoke('add_project', { project })` — upsert-to-front. */
export function addProject(project: ProjectMeta): Promise<void> {
  return invoke("add_project", { project });
}

/** `invoke('remove_project', { path })` — metadata only; never touches the repo. */
export function removeProject(path: string): Promise<void> {
  return invoke("remove_project", { path });
}

/** On launch, re-register every persisted provider with the engine (whose
 * registry starts empty each run) by pairing its saved metadata with its
 * Keychain key. The key value is read into a local and passed straight to
 * `modelsConfigure` — never rendered, never logged. A provider whose key is
 * missing (e.g. a Keychain entry was removed out-of-band) is skipped. */
export async function reconfigureProvidersOnLaunch(): Promise<void> {
  const metas = await listProviderConfigs();
  await Promise.all(
    metas.map(async (meta) => {
      const apiKey = await getSecret(meta.id);
      if (apiKey === null) return;
      await engineClient.modelsConfigure({ id: meta.id, kind: meta.kind, apiKey, baseURL: meta.baseURL });
    }),
  );
}

// ---------------------------------------------------------------------------
// Frontier CLI-auth commands — Rust host. No token ever crosses this surface.
// ---------------------------------------------------------------------------

/** Mirrors `frontier.rs`'s `FrontierAuthStatus`. */
export interface FrontierAuthStatus {
  state: "connected" | "disconnected" | "not-installed";
  detail?: string;
}

/** `invoke('frontier_login_status', { engine })`. */
export function frontierLoginStatus(engine: FrontierEngineKind): Promise<FrontierAuthStatus> {
  return invoke<FrontierAuthStatus>("frontier_login_status", { engine });
}

/** `invoke('frontier_login', { engine })` — launches the official CLI login. */
export function frontierLogin(engine: FrontierEngineKind): Promise<void> {
  return invoke("frontier_login", { engine });
}

/** `invoke('frontier_logout', { engine })`. */
export function frontierLogout(engine: FrontierEngineKind): Promise<void> {
  return invoke("frontier_logout", { engine });
}
