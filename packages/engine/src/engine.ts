import { RpcDispatcher } from "./rpc/dispatcher.js";
import { EvalsService, registerEvalsMethods } from "./evals/methods.js";
import { FrontierService, registerFrontierMethods } from "./engines/methods.js";
import { HarnessService, registerHarnessMethods } from "./harness/methods.js";
import { registerCoreMethods } from "./methods.js";
import { ModelsService, registerModelsMethods } from "./models/methods.js";
import { OrchestrateService, registerOrchestrateMethods } from "./orchestrate/methods.js";
import { CancelRegistry, registerCancelMethod } from "./rpc/cancel-registry.js";
import { RunsService, registerRunsMethods } from "./runs/methods.js";
import { registerRuntimeMethods } from "./runtime/methods.js";
import { RuntimeService } from "./runtime/service.js";
import { WikiService, registerWikiMethods } from "./wiki/methods.js";
import { WorkerService, registerWorkerMethods } from "./worker/methods.js";
import { recoverInterruptedRunJournals, RunKernel } from "./runtime/supervisor.js";
import { CandidateService, type VerificationRunner } from "./candidates/service.js";
import { registerCandidateMethods } from "./candidates/methods.js";
import type { SandboxBackend } from "./runtime/sandbox.js";
import { registerEvidenceMethods } from "./runtime/evidence-methods.js";
import { ProviderGateway } from "./models/gateway.js";

export interface EngineOptions {
  log?: (message: string) => void;
  // Server-initiated notification sink. Used by engine.frontier.prompt to
  // stream `frontier.event { sessionId, seq, event }` lines while a prompt
  // is in flight — the engine's first server→client notifications. Defaults
  // to a no-op so unit tests that construct an Engine directly don't need to
  // wire one up; main.ts supplies the real stdout writer (see main.ts).
  notify?: (method: string, params: unknown) => void;
  /** Host-owned application state root for isolated worktrees/artifacts. */
  appStorageDir?: string;
  verificationRunner?: VerificationRunner;
  sandboxBackend?: SandboxBackend;
}

export class Engine {
  readonly dispatcher = new RpcDispatcher();
  readonly log: (message: string) => void;
  readonly notify: (method: string, params: unknown) => void;
  readonly appStorageDir: string;
  readonly wiki = new WikiService();
  readonly models = new ModelsService();
  readonly providerGateway: ProviderGateway;
  readonly frontier = new FrontierService();
  readonly harness = new HarnessService();
  readonly worker: WorkerService;
  readonly orchestrate = new OrchestrateService();
  readonly evals = new EvalsService();
  readonly runs = new RunsService();
  readonly runtime: RuntimeService;
  readonly candidates: CandidateService;
  // M7b Task 2: runId (string) -> AbortController, so engine.cancel {runId}
  // can reach whichever sub-operation (worker attempt / review / escalation /
  // eval baseline turn) is currently in flight for that run, however deep it
  // is nested — see cancel-registry.ts's own header comment for the
  // register()/get() ownership split every call site must respect.
  readonly cancelRegistry = new CancelRegistry();
  readonly runKernel: RunKernel;

  constructor(options: EngineOptions = {}) {
    this.log = options.log ?? (() => {});
    this.notify = options.notify ?? (() => {});
    this.appStorageDir = path.resolve(
      options.appStorageDir
        ?? process.env.OPENFUSION_APP_STORAGE_DIR
        ?? path.join(os.tmpdir(), "openfusion-app-storage"),
    );
    const recovery = recoverInterruptedRunJournals(this.appStorageDir);
    if (recovery.recovered > 0 || recovery.malformed > 0) {
      this.log(
        `run-journal recovery recovered=${recovery.recovered} malformed=${recovery.malformed}`,
      );
    }
    this.worker = new WorkerService(this.appStorageDir);
    this.providerGateway = new ProviderGateway({ meter: this.models.meter });
    this.runtime = new RuntimeService({
      appStorageDir: this.appStorageDir,
      sandbox: options.sandboxBackend,
    });
    this.candidates = new CandidateService({ verificationRunner: options.verificationRunner });
    this.runKernel = new RunKernel(this);
    registerCoreMethods(this.dispatcher);
    registerWikiMethods(this);
    registerModelsMethods(this);
    registerFrontierMethods(this);
    registerHarnessMethods(this);
    registerWorkerMethods(this);
    registerCancelMethod(this);
    // Registered LAST: engine.orchestrate composes engine.worker.run through
    // the dispatcher itself (see orchestrate/orchestrate.ts's header
    // comment), so every method it might call must already be registered by
    // the time a caller can reach engine.orchestrate. Registration order
    // doesn't actually gate that (dispatch() resolves the target handler at
    // CALL time, not registration time), but this ordering keeps the
    // constructor's own reading order matching the real dependency
    // direction.
    registerOrchestrateMethods(this);
    // Registered LAST of all: engine.evals.run composes engine.orchestrate
    // (the harness side of the report card) AND engine.frontier/worker
    // directly (the baseline side + worktree cleanup) — it must be able to
    // reach every method engine.orchestrate itself depends on, so this stays
    // ordered after it for the same "constructor reading order matches
    // dependency direction" reason (registration order itself doesn't gate
    // anything — dispatch() resolves handlers at CALL time).
    registerEvalsMethods(this);
    registerRunsMethods(this);
    registerRuntimeMethods(this);
    registerEvidenceMethods(this);
    registerCandidateMethods(this);
  }

  async close(): Promise<void> {
    this.runtime.beginShutdown();
    this.runKernel.stopAdmission();
    this.providerGateway.stopAdmission();
    this.runKernel.abortAll();
    this.providerGateway.abortAll();
    this.frontier.abortAll();
    // Direct compatibility worker RPCs are not admitted through RunKernel.
    // Abort and join them before RuntimeStore closes, because their failure
    // path durably records the interruption in SQLite.
    await this.worker.close();
    // Async session RPCs return before their work is finished, so they sit
    // outside StdioPipeline's in-flight request set. Cancel and join them
    // explicitly before tearing down the worker/frontier services they use.
    await this.runtime.close(this);
    // All supervised runs have now received cancellation and their nested
    // compatibility/runtime tasks have been joined. Drain supervisor-owned
    // cleanup before closing the shared frontier and wiki services they use.
    await this.runKernel.close();
    // Candidate/grant authority is memory-only without the opt-in content
    // vault. Remove its transient worktrees before ending shared services.
    await this.candidates.close();
    // Frontier sessions may hold subprocesses that talk to the wiki's MCP
    // server, so tear them down before wiki.close() stops that server.
    await this.frontier.close();
    await this.wiki.close();
  }
}

export function createEngine(options: EngineOptions = {}): Engine {
  return new Engine(options);
}

export { RpcDispatcher } from "./rpc/dispatcher.js";
export type { RpcHandler } from "./rpc/dispatcher.js";
export { NdjsonDecoder, encodeNdjson } from "./rpc/ndjson.js";
export type { DecodedLine } from "./rpc/ndjson.js";
export { StdioPipeline } from "./rpc/stdio.js";
export { ENGINE_VERSION } from "./version.js";
export { RpcMethodError } from "./rpc/errors.js";
export { registerMethod } from "./rpc/register.js";
export { WikiService } from "./wiki/methods.js";
export { FrontierService, registerFrontierMethods } from "./engines/methods.js";
export type {
  FrontierAdapter,
  FrontierEvent,
  FrontierModel,
  FrontierPromptHandle,
  FrontierSession,
} from "./engines/types.js";
export { createClaudeAdapter } from "./engines/claude.js";
export type { CreateClaudeAdapterOptions } from "./engines/claude.js";
export { createCodexAdapter } from "./engines/codex.js";
export type { CreateCodexAdapterOptions } from "./engines/codex.js";
export {
  DEFAULT_FRONTIER_SELECTION,
  EvalsFrontierSelectionsSchema,
  FrontierSelectionSchema,
  OrchestrateFrontierSelectionsSchema,
  resolveFrontierSelection,
} from "./engines/selection.js";
export type {
  EvalsFrontierSelections,
  FrontierSelection,
  OrchestrateFrontierSelections,
} from "./engines/selection.js";
export { WikiStore, openWikiStore } from "./wiki/store.js";
export { WikiParser } from "./wiki/parser.js";
export { buildIndex, getHeadSha } from "./wiki/indexer.js";
export { McpWikiServer } from "./wiki/mcp.js";
export { ModelsService } from "./models/methods.js";
export {
  MAX_ACTIVE_CALLS_PER_PROVIDER,
  MAX_ACTIVE_PROVIDER_CALLS,
  MAX_QUEUED_PROVIDER_CALLS,
  ProviderGateway,
} from "./models/gateway.js";
export type { ProviderCallOptions, ProviderGatewayStats } from "./models/gateway.js";
export { ProviderRegistry, ProviderConfigSchema } from "./models/providers.js";
export type { ProviderConfig } from "./models/providers.js";
export { PRICING, lookupPricing, estimateCostUsd, normalizeUsage } from "./models/pricing.js";
export type { ModelPricing, NormalizedUsage } from "./models/pricing.js";
export { CostMeter } from "./models/meter.js";
export type { UsageRecord, MeterTotals, ModelTotals } from "./models/meter.js";
export {
  DIALECT_PACKS,
  DIALECT_PACK_CATALOG_VERSION,
  FAMILY_CATALOG_VERSION,
  MODEL_FAMILIES,
  getDialectPack,
  getModelFamily,
  profilePolicy,
  resolveDialectPackId,
  resolveFamily,
} from "./models/catalog.js";
export type {
  DialectPackMeta,
  EditDialect,
  HarnessProfile,
  ModelFamily,
  ProfilePolicy,
} from "./models/catalog.js";
export { HarnessService, registerHarnessMethods } from "./harness/methods.js";
export { generateHarness } from "./harness/generate.js";
export type { GenerateHarnessResult } from "./harness/generate.js";
export { HarnessGenError, promptForJson } from "./harness/driver.js";
export type { DriverNotice, PromptForJsonOpts } from "./harness/driver.js";
export { exportHarness } from "./harness/exporters.js";
export type { HarnessExportFormat, HarnessExportResult } from "./harness/exporters.js";
export {
  AgentDefSchema,
  HarnessBundleSchema,
  ManifestSchema,
  RoutingSchema,
  WIKI_PAGE_SLUGS,
  WikiPageSchema,
  validateHarness,
} from "./harness/schema.js";
export type { AgentDef, HarnessBundle, HarnessIssue, Manifest, Routing, WikiPage } from "./harness/schema.js";
export { upgradeHarnessV1ToV2, upgradeRouting, needsUpgrade } from "./harness/upgrade.js";
export {
  fingerprintHarness,
  REVIEW_POLICY_VERSION,
  RETRY_POLICY_VERSION,
} from "./harness/fingerprint.js";
export type {
  HarnessComponentRef,
  HarnessFingerprint,
} from "./harness/fingerprint.js";
export {
  activeHarnessDir,
  HarnessValidationError,
  harnessDir,
  harnessStatus,
  loadHarness,
  loadHarnessFingerprint,
  loadHarnessGenerationId,
  loadHarnessSnapshot,
  writeHarness,
} from "./harness/store.js";
export type { LoadedHarnessSnapshot } from "./harness/store.js";
export { WorkerService, registerWorkerMethods, runWorker } from "./worker/methods.js";
export type {
  WorkerRunner,
  WorkerRunParams,
  WorkerRunResult as WorkerServiceResult,
} from "./worker/methods.js";
export { WorktreeManager } from "./worker/worktree.js";
export type { Worktree } from "./worker/worktree.js";
export { createWorkerTools } from "./worker/tools.js";
export type { ToolContext, ToolErrorKind, ToolEvent } from "./worker/tools.js";
export {
  APPLY_PATCH_TOOL_SPEC,
  BASH_TOOL_SPEC,
  CLOSE_CHILD_TOOL_SPEC,
  EDIT_TOOL_SPEC,
  fingerprintToolSpecs,
  listToolSpecs,
  LOAD_SKILL_TOOL_SPEC,
  IMPORT_CHILD_DIFF_TOOL_SPEC,
  LIST_CHILDREN_TOOL_SPEC,
  READ_FILE_TOOL_SPEC,
  READ_TOOL_OUTPUT_SPEC,
  SEND_CHILD_TOOL_SPEC,
  SPAWN_CHILD_TOOL_SPEC,
  TOOL_REGISTRY_FINGERPRINT,
  TOOL_REGISTRY_VERSION,
  WIKI_MAP_TOOL_SPEC,
  WIKI_QUERY_TOOL_SPEC,
  WAIT_CHILD_TOOL_SPEC,
  WRITE_FILE_TOOL_SPEC,
} from "./tools/registry.js";
export { createToolInvocationClaim, ToolGateway } from "./tools/gateway.js";
export type { ToolAuthorizationRequest, ToolClaimPolicy, ToolResourceClaim } from "./tools/gateway.js";
export { frontierMcpAllowedTools, projectMcpTool, projectWorkerTool } from "./tools/projections.js";
export { defineToolSpec, renderToolDescription } from "./tools/spec.js";
export type {
  ToolPermission,
  ToolSpec,
  ToolTransport,
} from "./tools/spec.js";
export { createWorkerRuntime } from "./worker/runtime.js";
export type { WorkerRuntime } from "./worker/runtime.js";
export { runWorkerLoop } from "./worker/loop.js";
export type { WorkerRunInput, WorkerRunResult } from "./worker/loop.js";
export {
  classifyTask,
  classifyDifficulty,
  routeTask,
  resolveNamedAgent,
  DEFAULT_TASK_CLASS,
} from "./orchestrate/routing.js";
export type { RoutedAgent, WorkerResolution, TaskDifficulty } from "./orchestrate/routing.js";
export { ReviewVerdictSchema, reviewDiff } from "./orchestrate/review.js";
export type { ReviewVerdict, ReviewDiffInput, ReviewDiffOpts } from "./orchestrate/review.js";
export {
  buildReviewPrompt,
  REVIEW_POLICY_VERSION as PROTECTED_REVIEW_POLICY_VERSION,
  REVIEW_PROMPT_TEMPLATE,
} from "./orchestrate/review-policy.js";
export { OrchestrateService, registerOrchestrateMethods } from "./orchestrate/methods.js";
export { orchestrate } from "./orchestrate/orchestrate.js";
export type { OrchestrateParams, OrchestrateAttempt, OrchestrateResult } from "./orchestrate/orchestrate.js";
export { runOracle, synthEvalTask, goldenTaskFromCommit } from "./evals/tasks.js";
export type { EvalTask, OracleResult, SynthEvalTaskOptions } from "./evals/tasks.js";
export { EvalsService, registerEvalsMethods } from "./evals/methods.js";
export { runEvals } from "./evals/run.js";
export type { EvalsRunParams, EvalsReportCard, PerTaskResult, HarnessTaskOutcome } from "./evals/run.js";
export { runEvalsExperiment } from "./evals/experiment.js";
export type {
  EvalsExperimentParams,
  EvalsExperimentReport,
  EvalsTrialRunner,
} from "./evals/experiment.js";
export { evaluateHarnessHealth, summarizeOperationalHealth } from "./harness/health.js";
export type {
  HarnessHealthReport,
  HarnessHealthVerdict,
  HarnessOperationalEvidence,
  OperationalHealthVerdict,
} from "./harness/health.js";
export { appendRun, readRuns, recordRun, runsLedgerPath, RunRecordSchema } from "./runs/ledger.js";
export type { RunRecord } from "./runs/ledger.js";
export { RunsService, registerRunsMethods } from "./runs/methods.js";
export { CancelRegistry, RunCancelledError, registerCancelMethod } from "./rpc/cancel-registry.js";
export { CandidateService, canonicalizeCandidate } from "./candidates/service.js";
export type { CanonicalCandidate, PreparedCandidate, VerificationRunner } from "./candidates/service.js";
export { RuntimeService } from "./runtime/service.js";
export {
  RuntimeArtifactLimitError,
  RuntimeArtifactWriter,
  RuntimeInvalidTransitionError,
  RuntimeStore,
  RuntimeVersionConflictError,
  runtimeDbPath,
} from "./runtime/store.js";
export {
  RuntimeContentLockedError,
  RuntimeContentTamperedError,
  decodeRuntimeKey,
} from "./runtime/crypto.js";
export { PolicyEvaluator } from "./runtime/policy.js";
export type {
  PolicyDecision,
  PolicyDecisionKind,
  PolicyLayer,
  PolicyRequest,
  PolicyRule,
} from "./runtime/policy.js";
export {
  ContextCompiler,
  MAX_INLINE_CONTEXT_BYTES,
  MAX_TASK_CONTEXT_BYTES,
} from "./runtime/context-compiler.js";
export type {
  CompiledContextSource,
  CompiledModelContext,
  ContextCompilerInput,
  ContextSnapshotIdentity,
  RetrievedWikiContext,
} from "./runtime/context-compiler.js";
export {
  MacOsSandboxBackend,
  SandboxUnavailableError,
  TOOL_OUTPUT_MAX_BYTES,
  TOOL_OUTPUT_PREVIEW_BYTES,
  buildMacOsSandboxProfile,
  filterSandboxEnvironment,
} from "./runtime/sandbox.js";
export type {
  RuntimeApproval,
  RuntimeArtifact,
  RuntimeCheckpoint,
  RuntimeConfiguration,
  RuntimeEvent,
  RuntimeSession,
  SessionChangedNotification,
  SessionKind,
  SessionStatus,
} from "./runtime/types.js";
import os from "node:os";
import path from "node:path";
