import { describe, expect, it } from "vitest";
import { PolicyEvaluator, type PolicyLayer } from "../src/runtime/policy.js";

const ceiling: PolicyLayer = {
  id: "eval-v1-ceiling",
  rules: [
    { id: "deny-prod", capability: "network", resource: "prod.example/**", decision: "deny" },
  ],
};

describe("PolicyEvaluator", () => {
  it("allows contained files and sandboxed processes by developer default", () => {
    const evaluator = new PolicyEvaluator();
    expect(evaluator.evaluate({ capability: "file.write", contained: true, interactive: true }).decision)
      .toBe("allow");
    expect(evaluator.evaluate({ capability: "process.execute", sandboxed: true, interactive: true }).decision)
      .toBe("allow");
  });

  it("fails closed for file escape, unsandboxed execution, and unregistered tools", () => {
    const evaluator = new PolicyEvaluator({
      projectGrants: {
        id: "project",
        rules: [{ id: "grant-all", capability: "*", decision: "allow" }],
      },
    });
    expect(evaluator.evaluate({ capability: "file.read", contained: false, interactive: true }).decision)
      .toBe("deny");
    expect(evaluator.evaluate({ capability: "process.execute", sandboxed: false, interactive: true }).decision)
      .toBe("deny");
    expect(evaluator.evaluate({ capability: "tool.unregistered", registered: false, interactive: true }).decision)
      .toBe("deny");
  });

  it("lets a scoped project grant resolve developer-default network ask", () => {
    const evaluator = new PolicyEvaluator({
      projectGrants: {
        id: "project-grants",
        rules: [
          { id: "docs", capability: "network", resource: "docs.example/**", decision: "allow" },
        ],
      },
    });
    expect(evaluator.evaluate({ capability: "network", resource: "docs.example/api", interactive: true }))
      .toMatchObject({ decision: "allow", source: "project-grants", ruleId: "docs" });
    expect(evaluator.evaluate({ capability: "network", resource: "other.example/api", interactive: true }).decision)
      .toBe("ask");
  });

  it("applies the most-specific rule first within one layer", () => {
    const evaluator = new PolicyEvaluator({
      projectGrants: {
        id: "project",
        rules: [
          { id: "broad", capability: "network", resource: "**", decision: "allow" },
          { id: "private", capability: "network", resource: "private/**", decision: "deny" },
        ],
      },
    });
    expect(evaluator.evaluate({ capability: "network", resource: "private/db", interactive: true }))
      .toMatchObject({ decision: "deny", ruleId: "private" });
  });

  it("never permits a grant to override the immutable ceiling", () => {
    const evaluator = new PolicyEvaluator({
      ceiling,
      projectGrants: {
        id: "project",
        rules: [{ id: "grant-prod", capability: "network", resource: "prod.example/**", decision: "allow" }],
      },
    });
    expect(evaluator.evaluate({ capability: "network", resource: "prod.example/api", interactive: true }))
      .toMatchObject({ decision: "deny", source: "eval-v1-ceiling" });
  });

  it("intersects child authority with the effective parent decision", () => {
    const parent = new PolicyEvaluator();
    const child = new PolicyEvaluator({ parentDecision: (request) => parent.evaluate(request) });
    expect(child.evaluate({ capability: "network", interactive: true }).decision).toBe("ask");
    expect(child.evaluate({ capability: "file.write", contained: false, interactive: true }).decision)
      .toBe("deny");
  });

  it("collapses ask to deny for compatibility/headless calls", () => {
    const decision = new PolicyEvaluator().evaluate({ capability: "network", interactive: false });
    expect(decision.decision).toBe("deny");
    expect(decision.requiresApproval).toBe(false);
  });

  it("allows enforcing hooks to narrow but never to grant", () => {
    const evaluator = new PolicyEvaluator();
    const denied = evaluator.evaluate({ capability: "tool.unregistered", registered: false, interactive: true });
    expect(evaluator.applyEnforcingHook(denied, { id: "optimistic", decision: "allow" }, true).decision)
      .toBe("deny");
    const allowed = evaluator.evaluate({ capability: "file.read", contained: true, interactive: true });
    expect(evaluator.applyEnforcingHook(allowed, { id: "review", decision: "ask" }, true))
      .toMatchObject({ decision: "ask", source: "hook:review" });
  });
});
