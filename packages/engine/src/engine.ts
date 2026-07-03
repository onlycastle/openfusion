import { RpcDispatcher } from "./rpc/dispatcher.js";
import { FrontierService, registerFrontierMethods } from "./engines/methods.js";
import { HarnessService, registerHarnessMethods } from "./harness/methods.js";
import { registerCoreMethods } from "./methods.js";
import { ModelsService, registerModelsMethods } from "./models/methods.js";
import { WikiService, registerWikiMethods } from "./wiki/methods.js";

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

  constructor(options: EngineOptions = {}) {
    this.log = options.log ?? (() => {});
    this.notify = options.notify ?? (() => {});
    registerCoreMethods(this.dispatcher);
    registerWikiMethods(this);
    registerModelsMethods(this);
    registerFrontierMethods(this);
    registerHarnessMethods(this);
  }

  async close(): Promise<void> {
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
