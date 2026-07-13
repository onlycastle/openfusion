import path from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyDecisionSchema, ToolInvocationClaimSchema } from "@openfusion/shared";
import { PolicyEvaluator } from "../src/runtime/policy.js";
import {
  createToolInvocationClaim,
  ToolGateway,
  type ToolClaimPolicy,
  type ToolResourceClaim,
} from "../src/tools/gateway.js";

function policies(root: string, claims: ToolResourceClaim[]): ToolClaimPolicy[] {
  return [
    {
      policyId: "role",
      claims: [
        { kind: "filesystem-read", resource: root },
        { kind: "filesystem-write", resource: root },
        { kind: "process", resource: "/bin/sh" },
        { kind: "network", resource: "tool:bash" },
      ],
    },
    { policyId: "tool", claims },
  ];
}

describe("ToolGateway", () => {
  it("allows a contained registered file claim covered by every policy layer", () => {
    const root = path.resolve("/tmp/openfusion-tool-gateway");
    const claims: ToolResourceClaim[] = [
      { kind: "filesystem-read", resource: path.join(root, "src/index.ts") },
    ];
    const decision = new ToolGateway().authorize({
      invocation: createToolInvocationClaim("read_file", claims),
      policies: policies(root, claims),
      sandboxed: true,
    });

    expect(PolicyDecisionSchema.parse(decision).decision).toBe("allow");
    expect(decision.effectiveClaims).toEqual(claims);
  });

  it("denies a claim when either the role or tool policy does not cover it", () => {
    const root = path.resolve("/tmp/openfusion-tool-gateway");
    const claims: ToolResourceClaim[] = [
      { kind: "filesystem-write", resource: path.resolve("/tmp/outside/escape.ts") },
    ];
    const decision = new ToolGateway().authorize({
      invocation: createToolInvocationClaim("write_file", claims),
      policies: policies(root, claims),
      sandboxed: true,
    });

    expect(decision).toMatchObject({
      decision: "deny",
      reasonCode: "tool-claim-outside-policy",
      effectiveClaims: [],
    });
  });

  it("requires interactive approval for a covered network claim and allows it only after approval", () => {
    const claims: ToolResourceClaim[] = [{ kind: "network", resource: "tool:bash" }];
    const gateway = new ToolGateway({ interactive: true });
    const invocation = createToolInvocationClaim("bash", claims);
    const request = { invocation, policies: policies("/tmp", claims), sandboxed: true } as const;

    expect(gateway.authorize(request).decision).toBe("approval-required");
    expect(gateway.authorize({ ...request, approvalSatisfied: true }).decision).toBe("allow");
  });

  it("fails a headless network request closed", () => {
    const claims: ToolResourceClaim[] = [{ kind: "network", resource: "tool:bash" }];
    const decision = new ToolGateway().authorize({
      invocation: createToolInvocationClaim("bash", claims),
      policies: policies("/tmp", claims),
      sandboxed: true,
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reasonCode).toBe("network-ask");
  });

  it("preserves a parent deny and never treats approval as authority expansion", () => {
    const evaluator = new PolicyEvaluator({
      parentDecision: () => ({
        decision: "deny",
        source: "parent",
        ruleId: "parent-deny",
        reason: "Parent denied the process.",
        requiresApproval: false,
      }),
    });
    const claims: ToolResourceClaim[] = [{ kind: "process", resource: "/bin/sh" }];
    const decision = new ToolGateway({ evaluator, interactive: true }).authorize({
      invocation: createToolInvocationClaim("bash", claims),
      policies: policies("/tmp", claims),
      sandboxed: true,
      approvalSatisfied: true,
    });
    expect(decision).toMatchObject({ decision: "deny", reasonCode: "parent-deny" });
  });

  it("denies unknown tools before evaluating their resource claims", () => {
    const invocation = ToolInvocationClaimSchema.parse({
      schemaVersion: 1,
      invocationId: "unknown-invocation",
      toolId: "not_registered",
      claims: [],
    });
    const decision = new ToolGateway().authorize({
      invocation,
      policies: [{ policyId: "none", claims: [] }],
      sandboxed: true,
    });
    expect(decision).toMatchObject({ decision: "deny", reasonCode: "unknown-tool-deny" });
  });

  it("admits a runtime-discovered tool only after explicit registration and the same claim intersection", () => {
    const gateway = new ToolGateway();
    const claims: ToolResourceClaim[] = [{ kind: "process", resource: "/bin/sh" }];
    const invocation = createToolInvocationClaim("mcp__approved__probe", claims);
    const request = { invocation, policies: policies("/tmp", claims), sandboxed: true } as const;

    expect(gateway.authorize(request).reasonCode).toBe("unknown-tool-deny");
    gateway.registerTool(invocation.toolId, "dangerous");
    expect(gateway.authorize(request).decision).toBe("allow");
    expect(() => gateway.registerTool(invocation.toolId, "read")).toThrow(/already registered/);
  });

  it("does not let a caller manufacture a broader tool policy for a read-only tool", () => {
    const claims: ToolResourceClaim[] = [{ kind: "network", resource: "tool:bash" }];
    const decision = new ToolGateway({ interactive: true }).authorize({
      invocation: createToolInvocationClaim("read_file", claims),
      policies: policies("/tmp", claims),
      sandboxed: true,
      approvalSatisfied: true,
    });
    expect(decision).toMatchObject({ decision: "deny", reasonCode: "tool-claim-kind-denied" });
  });
});
