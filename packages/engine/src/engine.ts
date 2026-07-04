import { RpcDispatcher } from "./rpc/dispatcher.js";
import { EvalsService, registerEvalsMethods } from "./evals/methods.js";
import { FrontierService, registerFrontierMethods } from "./engines/methods.js";
import { HarnessService, registerHarnessMethods } from "./harness/methods.js";
import { registerCoreMethods } from "./methods.js";
import { ModelsService, registerModelsMethods } from "./models/methods.js";
import { OrchestrateService, registerOrchestrateMethods } from "./orchestrate/methods.js";
import { WikiService, registerWikiMethods } from "./wiki/methods.js";
import { WorkerService, registerWorkerMethods } from "./worker/methods.js";

export interface EngineOptions {
  log?: (message: string) => void;
  // Server-initiated notification sink. Used by engine.frontier.prompt to
  // stream `frontier.event { sessionId, seq, event }` lines while a prompt
  // is in flight — the engine's first server→client notifications. Defaults
  // to a no-op so unit tests that construct an Engine directly don't need to
  // wire one up; main.ts supplies the real stdout writer (see main.ts).
  notify?: (method: string, params: unknown) => void;
}

export class Engine {
  readonly dispatcher = new RpcDispatcher();
  readonly log: (message: string) => void;
  readonly notify: (method: string, params: unknown) => void;
  readonly wiki = new WikiService();
  readonly models = new ModelsService();
  readonly frontier = new FrontierService();
  readonly harness = new HarnessService();
  readonly worker = new WorkerService();
  readonly orchestrate = new OrchestrateService();
  readonly evals = new EvalsService();

  constructor(options: EngineOptions = {}) {
    this.log = options.log ?? (() => {});
    this.notify = options.notify ?? (() => {});
    registerCoreMethods(this.dispatcher);
    registerWikiMethods(this);
    registerModelsMethods(this);
    registerFrontierMethods(this);
    registerHarnessMethods(this);
    registerWorkerMethods(this);
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
  }

  async close(): Promise<void> {
    // Abort any in-flight worker run FIRST: a wedged runWorkerLoop() call
    // has no other way to unblock, and — since WorkerService.close() only
    // fires the abort signal without waiting for the run's own promise to
    // settle (see its own doc comment) — this is cheap to put ahead of the
    // frontier/wiki teardown below rather than racing it against them.
    await this.worker.close();
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
  FrontierPromptHandle,
  FrontierSession,
} from "./engines/types.js";
export { createClaudeAdapter } from "./engines/claude.js";
export type { CreateClaudeAdapterOptions } from "./engines/claude.js";
export { WikiStore, openWikiStore } from "./wiki/store.js";
export { WikiParser } from "./wiki/parser.js";
export { buildIndex, getHeadSha } from "./wiki/indexer.js";
export { McpWikiServer } from "./wiki/mcp.js";
export { ModelsService } from "./models/methods.js";
export { ProviderRegistry, ProviderConfigSchema } from "./models/providers.js";
export type { ProviderConfig } from "./models/providers.js";
export { PRICING, lookupPricing, estimateCostUsd, normalizeUsage } from "./models/pricing.js";
export type { ModelPricing, NormalizedUsage } from "./models/pricing.js";
export { CostMeter } from "./models/meter.js";
export type { UsageRecord, MeterTotals, ModelTotals } from "./models/meter.js";
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
export {
  HarnessValidationError,
  harnessDir,
  harnessStatus,
  loadHarness,
  writeHarness,
} from "./harness/store.js";
export { WorkerService, registerWorkerMethods } from "./worker/methods.js";
export { WorktreeManager } from "./worker/worktree.js";
export type { Worktree } from "./worker/worktree.js";
export { createWorkerTools } from "./worker/tools.js";
export type { ToolContext } from "./worker/tools.js";
export { runWorkerLoop } from "./worker/loop.js";
export type { WorkerRunInput, WorkerRunResult } from "./worker/loop.js";
export { classifyTask, routeTask, DEFAULT_TASK_CLASS } from "./orchestrate/routing.js";
export type { RoutedAgent } from "./orchestrate/routing.js";
export { ReviewVerdictSchema, reviewDiff } from "./orchestrate/review.js";
export type { ReviewVerdict, ReviewDiffInput, ReviewDiffOpts } from "./orchestrate/review.js";
export { OrchestrateService, registerOrchestrateMethods } from "./orchestrate/methods.js";
export { orchestrate } from "./orchestrate/orchestrate.js";
export type { OrchestrateParams, OrchestrateAttempt, OrchestrateResult } from "./orchestrate/orchestrate.js";
export { runOracle, synthEvalTask, goldenTaskFromCommit } from "./evals/tasks.js";
export type { EvalTask, OracleResult, SynthEvalTaskOptions } from "./evals/tasks.js";
export { EvalsService, registerEvalsMethods } from "./evals/methods.js";
export { runEvals } from "./evals/run.js";
export type { EvalsRunParams, EvalsReportCard, PerTaskResult, HarnessTaskOutcome } from "./evals/run.js";
export { setEvalsVerdict } from "./harness/store.js";
