import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";
import { ENGINE_VERSION } from "../src/version.js";

describe("core methods", () => {
  it("engine.ping returns pong and the engine version", async () => {
    const res = await createEngine().dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "engine.ping",
    });
    expect(res?.result).toEqual({ pong: true, version: ENGINE_VERSION });
  });

  it("engine.info reports process facts", async () => {
    const res = await createEngine().dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 2,
      method: "engine.info",
    });
    const info = res?.result as {
      version: string;
      nodeVersion: string;
      pid: number;
      cwd: string;
    };
    expect(info.version).toBe(ENGINE_VERSION);
    expect(info.nodeVersion).toBe(process.version);
    expect(info.pid).toBe(process.pid);
    expect(typeof info.cwd).toBe("string");
  });
});
