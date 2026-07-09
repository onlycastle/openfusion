import { describe, expect, it } from "vitest";
import type { AgentDef, HarnessBundle, Manifest, Routing } from "../src/harness/schema.js";
import { ProviderRegistry } from "../src/models/providers.js";
import { classifyDifficulty, routeTask } from "../src/orchestrate/routing.js";

const TEST_API_KEY = "sk-test-fixture-never-real-1234567890";

function validManifest(): Manifest {
  return {
    schemaVersion: 2,
    generatorVersion: "0.0.1",
    engine: "claude-code",
    headSha: "abc",
    generatedAt: "2026-07-09T00:00:00.000Z",
    verification: { structural: "pass", evals: "pending" },
    artifacts: [],
    harnessProfile: "openfusion-native",
  };
}

function agent(name: string, model: string): AgentDef {
  return {
    name,
    role: "worker",
    description: name,
    prompt: `You are ${name}`,
    taskClasses: ["codegen"],
    model: { kind: "deepseek", model, providerId: "ds" },
    escalation: { maxAttempts: 2 },
  };
}

describe("classifyDifficulty", () => {
  it("detects low / high / mid", () => {
    expect(classifyDifficulty("fix a typo in the readme")).toBe("low");
    expect(classifyDifficulty("redesign auth concurrency")).toBe("high");
    expect(classifyDifficulty("add a feature flag")).toBe("mid");
  });
});

describe("routeTask chains", () => {
  it("returns agentChain from routing.chains keyed by taskClass:difficulty", () => {
    const routing: Routing = {
      version: 2,
      taskClasses: { codegen: { agent: "cheap-coder", routeId: "tc:codegen" } },
      escalation: { failuresBeforeFrontier: 2 },
      defaults: { agent: "cheap-coder", routeId: "tc:default" },
      chains: {
        "codegen:high": { agents: ["cheap-coder", "strong-coder"] },
      },
    };
    const harness: HarnessBundle = {
      manifest: validManifest(),
      pages: [],
      agents: [agent("cheap-coder", "deepseek-v4-flash"), agent("strong-coder", "deepseek-v4-pro")],
      routing,
    };
    const registry = new ProviderRegistry();
    registry.configure({ id: "ds", kind: "deepseek", apiKey: TEST_API_KEY });

    const routed = routeTask("complex architecture refactor of auth", harness, registry);
    expect(routed.difficulty).toBe("high");
    expect(routed.agentChain).toEqual(["cheap-coder", "strong-coder"]);
    expect(routed.agent.name).toBe("cheap-coder");
  });
});
