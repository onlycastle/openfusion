import { RpcDispatcher } from "./rpc/dispatcher.js";
import { registerCoreMethods } from "./methods.js";

export function createEngine(): RpcDispatcher {
  const dispatcher = new RpcDispatcher();
  registerCoreMethods(dispatcher);
  return dispatcher;
}

export { RpcDispatcher } from "./rpc/dispatcher.js";
export type { RpcHandler } from "./rpc/dispatcher.js";
export { NdjsonDecoder, encodeNdjson } from "./rpc/ndjson.js";
export type { DecodedLine } from "./rpc/ndjson.js";
export { ENGINE_VERSION } from "./version.js";
