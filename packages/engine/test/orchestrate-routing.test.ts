import { describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import type { AgentDef, HarnessBundle, Manifest, Routing } from "../src/harness/schema.js";
import { validateHarness } from "../src/harness/schema.js";
import { ProviderRegistry } from "../src/models/providers.js";
import { classifyTask, routeTask } from "../src/orchestrate/routing.js";
import { RpcMethodError } from "../src/rpc/errors.js";

// Fixture literal only — must never appear outside test files.
const TEST_API_KEY = "sk-test-fixture-never-real-1234567890";

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
    description: "Writes and edits code for codegen tasks.",
    prompt: "You are a codegen specialist.",
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

function validBundle(overrides: Partial<HarnessBundle> = {}): HarnessBundle {
  return {
    manifest: validManifest(),
    pages: [],
    agents: [validAgent()],
    routing: validRouting(),
    ...overrides,
  };
}

// A richer bundle used across most routeTask tests: five agents, one per
// task class (tests/docs/fix/codegen), plus a fifth agent reachable only
// via a "review" class so a frontier resolution can be exercised without
// needing classifyTask's keyword rules to reach it directly.
function multiClassBundle(): HarnessBundle {
  const agents: AgentDef[] = [
    validAgent({
      name: "tests-worker",
      taskClasses: ["tests"],
      model: { kind: "deepseek", model: "deepseek-tests" },
    }),
    validAgent({
      name: "docs-worker",
      taskClasses: ["docs"],
      model: { kind: "zai", model: "glm-docs", providerId: "docs-provider" },
    }),
    validAgent({
      name: "fix-worker",
      taskClasses: ["fix"],
      model: { kind: "moonshot", model: "kimi-fix" },
    }),
    validAgent({
      name: "codegen-worker",
      taskClasses: ["codegen"],
      model: { kind: "deepseek", model: "deepseek-chat" },
    }),
    validAgent({
      name: "review-worker",
      taskClasses: ["review"],
      model: "frontier",
    }),
  ];
  const routing: Routing = {
    version: 1,
    taskClasses: {
      tests: { agent: "tests-worker" },
      docs: { agent: "docs-worker" },
      fix: { agent: "fix-worker" },
      codegen: { agent: "codegen-worker" },
      review: { agent: "review-worker" },
    },
    escalation: { failuresBeforeFrontier: 2 },
    defaults: { agent: "codegen-worker" },
  };
  return validBundle({ agents, routing });
}

describe("classifyTask", () => {
  const routing = multiClassBundle().routing;

  it("maps a task mentioning 'test' to the tests class", () => {
    expect(classifyTask("write a unit test for the parser", routing)).toBe("tests");
  });

  it("maps a task mentioning 'doc'/'readme' to the docs class", () => {
    expect(classifyTask("update the README", routing)).toBe("docs");
    expect(classifyTask("write API docs for the new endpoint", routing)).toBe("docs");
  });

  it("maps a task mentioning 'fix'/'bug' to the fix class, case-insensitively", () => {
    expect(classifyTask("fix the null bug", routing)).toBe("fix");
    expect(classifyTask("FIX THE CRASH", routing)).toBe("fix");
  });

  it("maps a task mentioning 'refactor' to a refactor class when one exists", () => {
    const withRefactor: Routing = {
      ...routing,
      taskClasses: { ...routing.taskClasses, refactor: { agent: "codegen-worker" } },
    };
    expect(classifyTask("refactor the auth module", withRefactor)).toBe("refactor");
  });

  it("falls back to the codegen class for an otherwise-unmatched task", () => {
    expect(classifyTask("add a widget to the dashboard", routing)).toBe("codegen");
  });

  it("falls back to __default__ when nothing matches and there is no codegen class", () => {
    const { codegen: _codegen, ...rest } = routing.taskClasses;
    const noCodegen: Routing = { ...routing, taskClasses: rest };
    expect(classifyTask("add a widget to the dashboard", noCodegen)).toBe("__default__");
  });

  it("falls back to __default__ when a matched keyword's class doesn't exist in this harness", () => {
    const { tests: _tests, codegen: _codegen, ...rest } = routing.taskClasses;
    const noTestsOrCodegen: Routing = { ...routing, taskClasses: rest };
    expect(classifyTask("write a unit test for the parser", noTestsOrCodegen)).toBe("__default__");
  });

  it("only matches classes that actually exist — recognizes an alternate class name (bugfix vs fix)", () => {
    const { fix: fixEntry, ...rest } = routing.taskClasses;
    const bugfixNamed: Routing = { ...routing, taskClasses: { ...rest, bugfix: fixEntry! } };
    expect(classifyTask("fix the crash", bugfixNamed)).toBe("bugfix");
  });

  it("is case-insensitive", () => {
    expect(classifyTask("WRITE A UNIT TEST", routing)).toBe("tests");
  });
});

describe("routeTask", () => {
  it("resolves an agent with an explicit configured providerId directly", () => {
    const harness = multiClassBundle();
    const registry = new ProviderRegistry();
    registry.configure({ id: "docs-provider", kind: "zai", apiKey: TEST_API_KEY });

    const routed = routeTask("update the README", harness, registry);

    expect(routed.taskClass).toBe("docs");
    expect(routed.agent.name).toBe("docs-worker");
    expect(routed.resolution).toEqual({ providerId: "docs-provider", model: "glm-docs" });
  });

  it("throws SERVER_ERROR when the agent's explicit providerId is not configured", () => {
    const harness = multiClassBundle();
    const registry = new ProviderRegistry(); // docs-provider never configured

    let caught: unknown;
    try {
      routeTask("update the README", harness, registry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcMethodError);
    expect((caught as RpcMethodError).code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect((caught as RpcMethodError).message).toBe(
      "agent docs-worker requires provider docs-provider which is not configured",
    );
  });

  it("resolves a kind-only agent to the single configured provider of that kind", () => {
    const harness = multiClassBundle();
    const registry = new ProviderRegistry();
    registry.configure({ id: "ds-1", kind: "deepseek", apiKey: TEST_API_KEY });

    const routed = routeTask("write a unit test for X", harness, registry);

    expect(routed.taskClass).toBe("tests");
    expect(routed.agent.name).toBe("tests-worker");
    expect(routed.resolution).toEqual({ providerId: "ds-1", model: "deepseek-tests" });
  });

  it("throws SERVER_ERROR when zero providers of the required kind are configured", () => {
    const harness = multiClassBundle();
    const registry = new ProviderRegistry(); // no deepseek provider configured

    let caught: unknown;
    try {
      routeTask("write a unit test for X", harness, registry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcMethodError);
    expect((caught as RpcMethodError).code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect((caught as RpcMethodError).message).toBe(
      "no configured provider of kind deepseek for agent tests-worker",
    );
  });

  it("throws SERVER_ERROR (ambiguous) when more than one provider of the required kind is configured", () => {
    const harness = multiClassBundle();
    const registry = new ProviderRegistry();
    registry.configure({ id: "ds-1", kind: "deepseek", apiKey: TEST_API_KEY });
    registry.configure({ id: "ds-2", kind: "deepseek", apiKey: TEST_API_KEY });

    let caught: unknown;
    try {
      routeTask("write a unit test for X", harness, registry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcMethodError);
    expect((caught as RpcMethodError).code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect((caught as RpcMethodError).message).toBe(
      "ambiguous provider kind deepseek for agent tests-worker; specify providerId",
    );
  });

  it("routes an unknown/unmatched task class to routing.defaults.agent", () => {
    const harness = multiClassBundle();
    const registry = new ProviderRegistry();
    registry.configure({ id: "ds-1", kind: "deepseek", apiKey: TEST_API_KEY });

    const routed = routeTask("do something entirely unclassifiable, like make coffee", harness, registry);

    // "add"/"widget"-style tasks land on codegen (which is also the
    // defaults.agent here) — use a task with none of the keyword hits AND
    // no "codegen" mention path, still expected to land on defaults.agent
    // via the codegen fallback since codegen exists in this harness.
    expect(routed.agent.name).toBe(harness.routing.defaults.agent);
  });

  it("routes to defaults.agent when the task's class truly has no routing entry", () => {
    const agents: AgentDef[] = [
      validAgent({ name: "fallback-worker", taskClasses: ["codegen"] }),
    ];
    const routing: Routing = {
      version: 1,
      taskClasses: {}, // no classes at all — every classification is __default__
      escalation: { failuresBeforeFrontier: 2 },
      defaults: { agent: "fallback-worker" },
    };
    const harness = validBundle({ agents, routing });
    const registry = new ProviderRegistry();
    registry.configure({ id: "ds-1", kind: "deepseek", apiKey: TEST_API_KEY });

    const routed = routeTask("write a unit test for X", harness, registry);

    expect(routed.taskClass).toBe("__default__");
    expect(routed.agent.name).toBe("fallback-worker");
    expect(routed.resolution).toEqual({ providerId: "ds-1", model: "deepseek-chat" });
  });

  it("resolves a frontier agent to the 'frontier' sentinel without touching the registry", () => {
    // classifyTask's v1 keyword rules never target "review" directly, so
    // route to the frontier agent via defaults.agent instead — an empty
    // taskClasses map means every classification falls through to
    // "__default__" regardless of keywords.
    const agents: AgentDef[] = [
      validAgent({ name: "review-worker", taskClasses: ["codegen"], model: "frontier" }),
    ];
    const routing: Routing = {
      version: 1,
      taskClasses: {},
      escalation: { failuresBeforeFrontier: 2 },
      defaults: { agent: "review-worker" },
    };
    const harness = validBundle({ agents, routing });
    const registry = new ProviderRegistry(); // deliberately unconfigured — must not be consulted

    const routed = routeTask("something with no keyword hits at all", harness, registry);

    expect(routed.taskClass).toBe("__default__");
    expect(routed.agent.name).toBe("review-worker");
    expect(routed.resolution).toBe("frontier");
  });

  it("throws SERVER_ERROR when routing references an agent name that doesn't exist", () => {
    const agents: AgentDef[] = [validAgent({ name: "codegen-worker", taskClasses: ["codegen"] })];
    const routing: Routing = {
      version: 1,
      taskClasses: { codegen: { agent: "ghost-agent" } },
      escalation: { failuresBeforeFrontier: 2 },
      defaults: { agent: "codegen-worker" },
    };
    const harness = validBundle({ agents, routing });
    const registry = new ProviderRegistry();

    let caught: unknown;
    try {
      routeTask("add a widget", harness, registry);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcMethodError);
    expect((caught as RpcMethodError).code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect((caught as RpcMethodError).message).toBe("routing references unknown agent: ghost-agent");
  });

  it("multiClassBundle() fixture itself is a structurally valid, cross-referentially consistent harness", () => {
    expect(validateHarness(multiClassBundle())).toEqual([]);
  });
});
