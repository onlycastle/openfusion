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
export interface ModelProviderSummary {
  id: string;
  kind: "moonshot" | "zai" | "deepseek" | "openai-compatible";
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

// M7c Task 2: the `engine.orchestrate`/`engine.evals.run` result shapes the
// Orchestrate/Eval-report-card cockpit screens need — same hand-mirror
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
   *    `method` equals `progressMethod` to `onProgress`, and unsubscribes
   *    the instant the run's promise settles (success, failure, OR
   *    cancellation) — no leaked subscription.
   *
   *    ASSUMPTION (v1, single-run-at-a-time per kind): neither
   *    `orchestrate.progress` nor `evals.progress` carries a `runId` in its
   *    params today (checked against the engine's actual `notify()` call
   *    sites: `orchestrate.ts`'s and `evals/run.ts`'s own `progress()`
   *    helpers) — so this filters by `method` ALONE, not by runId. Two
   *    concurrently in-flight runs of the SAME kind would have their
   *    progress notifications interleave onto both callers' `onProgress`.
   *    M7c Task 5 is tracked to add `runId` to these notifications; once it
   *    does, this filter should ALSO match `notification.params.runId ===
   *    runId`. Until then, the Orchestrate/Evals cockpit screens must not
   *    start a second run of the same kind while one is already in flight.
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
