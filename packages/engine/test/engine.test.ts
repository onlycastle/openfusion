import { describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";

describe("createEngine", () => {
  it("returns an Engine whose dispatcher answers engine.ping", async () => {
    const engine = createEngine();
    const res = await engine.dispatcher.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "engine.ping",
    });
    expect((res?.result as { pong: boolean }).pong).toBe(true);
    await engine.close();
  });

  it("defaults log to a no-op and accepts an injected logger", () => {
    const lines: string[] = [];
    const engine = createEngine({ log: (m) => lines.push(m) });
    engine.log("hello");
    expect(lines).toEqual(["hello"]);
    expect(() => createEngine().log("ignored")).not.toThrow();
  });
});
