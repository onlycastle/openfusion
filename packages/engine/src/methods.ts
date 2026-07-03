import type { RpcDispatcher } from "./rpc/dispatcher.js";
import { ENGINE_VERSION } from "./version.js";

export function registerCoreMethods(dispatcher: RpcDispatcher): void {
  dispatcher.register("engine.ping", () => ({
    pong: true,
    version: ENGINE_VERSION,
  }));
  dispatcher.register("engine.info", () => ({
    version: ENGINE_VERSION,
    nodeVersion: process.version,
    pid: process.pid,
    cwd: process.cwd(),
  }));
}
