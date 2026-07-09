import { describe, expect, it } from "vitest";
import type { AgentDef, HarnessBundle, Manifest, Routing } from "../src/harness/schema.js";
import { validateHarness } from "../src/harness/schema.js";
import { needsUpgrade, upgradeHarnessV1ToV2, upgradeRouting } from "../src/harness/upgrade.js";
import {
  DIALECT_PACK_CATALOG_VERSION,
  FAMILY_CATALOG_VERSION,
} from "../src/models/catalog.js";

function validManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    generatorVersion: "0.0.1",
    engine: "claude-code",
    headSha: "abc123",
    generatedAt: "2026-07-03T12:00:00.000Z",
    verification: { structural: "pass", evals: "pending" },
    artifacts: [],
    ...overrides,
  };
}

function validAgent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "codegen-worker",
    role: "worker",
    description: "Writes code",
    prompt: "You write code.",
    taskClasses: ["codegen"],
    model: { kind: "deepseek", model: "deepseek-chat" },
    escalation: { maxAttempts: 2 },
    ...overrides,
  };
}

function validRouting(overrides: Partial<Routing> = {}): Routing {
  return {
    version: 1,
    taskClasses: { codegen: { agent: "codegen-worker" } },
    escalation: { failuresBeforeFrontier: 2 },
    defaults: { agent: "codegen-worker" },
    ...overrides,
  };
}

function v1Bundle(): HarnessBundle {
  return {
    manifest: validManifest(),
    pages: [],
    agents: [validAgent()],
    routing: validRouting(),
  };
}

describe("upgradeHarnessV1ToV2", () => {
  it("upgrades a v1 fixture to schemaVersion 2 with family + dialectPack + routeIds", () => {
    const upgraded = upgradeHarnessV1ToV2(v1Bundle());
    expect(upgraded.manifest.schemaVersion).toBe(2);
    expect(upgraded.manifest.harnessProfile).toBe("openfusion-native");
    expect(upgraded.manifest.familyCatalogVersion).toBe(FAMILY_CATALOG_VERSION);
    expect(upgraded.manifest.dialectPackVersion).toBe(DIALECT_PACK_CATALOG_VERSION);
    expect(upgraded.manifest.routePolicyVersion).toBe("2");
    expect(upgraded.routing.version).toBe(2);
    if (upgraded.routing.version === 2) {
      expect(upgraded.routing.taskClasses.codegen?.routeId).toBe("tc:codegen");
      expect(upgraded.routing.defaults.routeId).toBe("tc:default");
    }
    const model = upgraded.agents[0]!.model;
    expect(model).not.toBe("frontier");
    if (model !== "frontier") {
      expect(model.family).toBe("deepseek");
      expect(model.dialectPack).toBe("string-edit-default");
    }
    expect(validateHarness(upgraded)).toEqual([]);
  });

  it("is idempotent on the normalized form", () => {
    const once = upgradeHarnessV1ToV2(v1Bundle());
    const twice = upgradeHarnessV1ToV2(once);
    expect(twice).toEqual(once);
    expect(needsUpgrade(once)).toBe(false);
  });

  it("preserves frontier agents", () => {
    const upgraded = upgradeHarnessV1ToV2({
      ...v1Bundle(),
      agents: [validAgent({ model: "frontier" })],
    });
    expect(upgraded.agents[0]!.model).toBe("frontier");
  });

  it("flags unknown dialectPack as structural failure after upgrade", () => {
    const upgraded = upgradeHarnessV1ToV2({
      ...v1Bundle(),
      agents: [
        validAgent({
          model: {
            kind: "deepseek",
            model: "deepseek-chat",
            dialectPack: "does-not-exist",
          },
        }),
      ],
    });
    const issues = validateHarness(upgraded);
    expect(issues.some((i) => i.path.includes("dialectPack"))).toBe(true);
  });
});

describe("upgradeRouting", () => {
  it("fills routeIds for v1 routing", () => {
    const v2 = upgradeRouting(validRouting());
    expect(v2.version).toBe(2);
    expect(v2.taskClasses.codegen?.routeId).toBe("tc:codegen");
  });
});
