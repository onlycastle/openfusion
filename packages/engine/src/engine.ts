import { RpcDispatcher } from "./rpc/dispatcher.js";
import { registerCoreMethods } from "./methods.js";
import { ModelsService, registerModelsMethods } from "./models/methods.js";
import { WikiService, registerWikiMethods } from "./wiki/methods.js";

export interface EngineOptions {
  log?: (message: string) => void;
}

export class Engine {
  readonly dispatcher = new RpcDispatcher();
  readonly log: (message: string) => void;
  readonly wiki = new WikiService();
  readonly models = new ModelsService();

  constructor(options: EngineOptions = {}) {
    this.log = options.log ?? (() => {});
    registerCoreMethods(this.dispatcher);
    registerWikiMethods(this);
    registerModelsMethods(this);
  }

  async close(): Promise<void> {
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
