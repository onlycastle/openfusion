import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import { loadHarness, writeHarness } from "../src/harness/store.js";
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
      { name: "reviewer", role: "reviews code", description: "d", prompt: "p", taskClasses: ["review"],
        model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" },
        escalation: { maxAttempts: 2 } },
    ],
    routing: {
      version: 1, taskClasses: { codegen: { agent: "coder" }, review: { agent: "reviewer" } },
      escalation: { failuresBeforeFrontier: 2 }, defaults: { agent: "coder" },
    },
  };
}

async function setup(): Promise<void> {
  engine = createEngine();
  dir = mkdtempSync(path.join(os.tmpdir(), "of-upd-"));
  await writeHarness(dir, bundle());
}

describe("engine.harness.updateAgentModel", () => {
  it("reassigns an agent's model and persists it", async () => {
    await setup();
    const res = await call("engine.harness.updateAgentModel", {
      projectDir: dir, agentName: "coder",
      model: { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" },
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ updated: true });
    expect(loadHarness(dir)!.agents[0]!.model).toEqual({ kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" });
  });

  it("accepts the frontier sentinel", async () => {
    await setup();
    await call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "coder", model: "frontier" });
    expect(loadHarness(dir)!.agents[0]!.model).toBe("frontier");
  });

  it("errors on an unknown agent", async () => {
    await setup();
    const res = await call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "nope", model: "frontier" });
    expect(res.error.message).toMatch(/unknown agent/i);
  });

  it("errors on a malformed model", async () => {
    await setup();
    const res = await call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "coder", model: { kind: "moonshot" } });
    expect(res.error.message).toMatch(/invalid params/i);
  });

  it("preserves manifest provenance after a write", async () => {
    await setup();
    await call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "coder", model: "frontier" });
    const reloaded = loadHarness(dir)!;
    expect(reloaded.manifest.generatorVersion).toBe("test");
    expect(reloaded.manifest.artifacts.length).toBeGreaterThan(0);
  });

  // Regression for the lost-update race: mutateHarness does an unlocked
  // loadHarness -> mutate -> validate -> writeHarness. Without serializing
  // writes per project, two concurrent updateAgentModel calls targeting
  // DIFFERENT agents can both loadHarness() the pre-mutation bundle before
  // either writeHarness() lands, so whichever call's writeHarness finishes
  // LAST wins outright and silently clobbers the other call's change — the
  // reloaded bundle would show only one of the two models updated, never
  // both. Firing both calls via Promise.all (no artificial delay) is exactly
  // the shape the stdio pipeline produces when a user reassigns two agents
  // in quick succession, and is the reproduction this test asserts against.
  it("reassigns two different agents concurrently without losing either update", async () => {
    await setup();
    const [resA, resB] = await Promise.all([
      call("engine.harness.updateAgentModel", {
        projectDir: dir, agentName: "coder",
        model: { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" },
      }),
      call("engine.harness.updateAgentModel", {
        projectDir: dir, agentName: "reviewer",
        model: { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" },
      }),
    ]);
    expect(resA.error).toBeUndefined();
    expect(resB.error).toBeUndefined();

    const reloaded = loadHarness(dir)!;
    const coder = reloaded.agents.find((a) => a.name === "coder")!;
    const reviewer = reloaded.agents.find((a) => a.name === "reviewer")!;
    expect(coder.model).toEqual({ kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" });
    expect(reviewer.model).toEqual({ kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" });
  });
});

describe("engine.harness.updateEscalation", () => {
  it("sets failuresBeforeFrontier", async () => {
    await setup();
    const res = await call("engine.harness.updateEscalation", { projectDir: dir, failuresBeforeFrontier: 3 });
    expect(res.result).toEqual({ updated: true });
    expect(loadHarness(dir)!.routing.escalation.failuresBeforeFrontier).toBe(3);
  });

  it("errors on out-of-range values", async () => {
    await setup();
    const res = await call("engine.harness.updateEscalation", { projectDir: dir, failuresBeforeFrontier: 9 });
    expect(res.error.message).toMatch(/invalid params/i);
  });
});
