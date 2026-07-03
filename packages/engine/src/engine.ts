import { RpcDispatcher } from "./rpc/dispatcher.js";
import { registerCoreMethods } from "./methods.js";

export interface EngineOptions {
  log?: (message: string) => void;
}

export class Engine {
  readonly dispatcher = new RpcDispatcher();
  readonly log: (message: string) => void;

  constructor(options: EngineOptions = {}) {
    this.log = options.log ?? (() => {});
    registerCoreMethods(this.dispatcher);
  }

  async close(): Promise<void> {
    // Services with resources (wiki store, etc.) hook in here in later tasks.
  }
}

export function createEngine(options: EngineOptions = {}): Engine {
  return new Engine(options);
}

export { RpcDispatcher } from "./rpc/dispatcher.js";
export type { RpcHandler } from "./rpc/dispatcher.js";
export { NdjsonDecoder, encodeNdjson } from "./rpc/ndjson.js";
export type { DecodedLine } from "./rpc/ndjson.js";
export { ENGINE_VERSION } from "./version.js";
export { RpcMethodError } from "./rpc/errors.js";
export { registerMethod } from "./rpc/register.js";
