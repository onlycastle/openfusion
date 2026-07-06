import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import { writeHarness } from "../src/harness/store.js";
import type { HarnessBundle } from "../src/harness/schema.js";

let dir: string;
let engine: Engine;

afterEach(async () => {
  await engine.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

function bundle(): HarnessBundle {
  return {
    manifest: {
      schemaVersion: 1, generatorVersion: "test", engine: "test", headSha: "abc",
      generatedAt: "2026-07-06T00:00:00.000Z",
      verification: { structural: "pass", evals: "pending" }, artifacts: [],
    },
    pages: [{ slug: "architecture", title: "A", digest: "d", body: "b" }],
    agents: [
      { name: "coder", role: "writes code", description: "d", prompt: "p", taskClasses: ["codegen"],
        model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" },
        escalation: { maxAttempts: 2 } },
      { name: "fallback", role: "default", description: "d", prompt: "p", taskClasses: ["docs"],
        model: "frontier", escalation: { maxAttempts: 1 } },
    ],
    routing: {
      version: 1,
      taskClasses: { codegen: { agent: "coder" }, docs: { agent: "fallback" } },
      escalation: { failuresBeforeFrontier: 2 },
      defaults: { agent: "fallback" },
    },
  };
}

describe("engine.harness.read", () => {
  it("returns the trimmed team view for a ready harness", async () => {
    engine = createEngine();
    dir = mkdtempSync(path.join(os.tmpdir(), "of-read-"));
    await writeHarness(dir, bundle());

    const res = await call("engine.harness.read", { projectDir: dir });

    expect(res.error).toBeUndefined();
    expect(res.result.escalation).toBe(2);
    expect(res.result.defaultAgent).toBe("fallback");
    expect(res.result.agents).toHaveLength(2);
    expect(res.result.agents[0]).toEqual({
      name: "coder", role: "writes code", taskClasses: ["codegen"],
      model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" },
    });
    expect(res.result.agents[1].model).toBe("frontier");
    // prompt/body are NOT leaked into the read shape
    expect(res.result.agents[0].prompt).toBeUndefined();
  });

  it("errors when no harness has been generated", async () => {
    engine = createEngine();
    dir = mkdtempSync(path.join(os.tmpdir(), "of-read-"));
    const res = await call("engine.harness.read", { projectDir: dir });
    expect(res.result).toBeUndefined();
    expect(res.error.message).toMatch(/no valid harness/i);
  });
});
