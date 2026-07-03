import { describe, expect, it } from "vitest";
import { RpcDispatcher } from "../src/rpc/dispatcher.js";
import { StdioPipeline } from "../src/rpc/stdio.js";

function setup() {
  const dispatcher = new RpcDispatcher();
  dispatcher.register("slow", async () => {
    await new Promise((r) => setTimeout(r, 50));
    return "slow-done";
  });
  dispatcher.register("fast", () => "fast-done");
  const lines: string[] = [];
  const pipeline = new StdioPipeline(dispatcher, (l) => lines.push(l));
  return { pipeline, lines };
}

describe("StdioPipeline", () => {
  it("does not serialize dispatches: fast response overtakes slow", async () => {
    const { pipeline, lines } = setup();
    pipeline.handleDecoded({ ok: true, value: { jsonrpc: "2.0", id: 1, method: "slow" } });
    pipeline.handleDecoded({ ok: true, value: { jsonrpc: "2.0", id: 2, method: "fast" } });
    await pipeline.drain();
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { id: number };
    const second = JSON.parse(lines[1]!) as { id: number };
    expect(first.id).toBe(2);
    expect(second.id).toBe(1);
  });

  it("answers parse errors and suppresses notification responses", async () => {
    const { pipeline, lines } = setup();
    pipeline.handleDecoded({ ok: false, raw: "garbage" });
    pipeline.handleDecoded({ ok: true, value: { jsonrpc: "2.0", method: "fast" } });
    await pipeline.drain();
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { error: { code: number } }).error.code).toBe(-32700);
  });

  it("drain resolves when nothing is in flight", async () => {
    const { pipeline } = setup();
    await expect(pipeline.drain()).resolves.toBeUndefined();
  });
});
