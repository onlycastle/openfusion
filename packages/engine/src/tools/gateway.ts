import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  PolicyDecisionSchema,
  ToolInvocationClaimSchema,
  type PolicyDecision as ContractPolicyDecision,
  type ToolInvocationClaim,
} from "@openfusion/shared";
import { isPathContained } from "../engines/path-scope.js";
import { PolicyEvaluator } from "../runtime/policy.js";
import { listToolSpecs } from "./registry.js";
import type { ToolPermission } from "./spec.js";

export type ToolResourceClaim = ToolInvocationClaim["claims"][number];

export interface ToolClaimPolicy {
  policyId: string;
  claims: readonly ToolResourceClaim[];
}

export interface ToolGatewayOptions {
  evaluator?: PolicyEvaluator;
  interactive?: boolean;
  registeredToolIds?: readonly string[];
  onDecision?: (invocation: ToolInvocationClaim, decision: ContractPolicyDecision) => void;
}

export interface ToolAuthorizationRequest {
  invocation: ToolInvocationClaim;
  /** Parent, role, and tool policies. Every layer must cover every claim. */
  policies: readonly ToolClaimPolicy[];
  sandboxed: boolean;
  /** True only after an interactive approval boundary has completed. */
  approvalSatisfied?: boolean;
}

function covers(bound: ToolResourceClaim, requested: ToolResourceClaim): boolean {
  if (bound.kind !== requested.kind) return false;
  if (bound.resource === "*") return true;
  if (bound.kind === "filesystem-read" || bound.kind === "filesystem-write") {
    if (!path.isAbsolute(bound.resource) || !path.isAbsolute(requested.resource)) return false;
    return isPathContained(path.resolve(requested.resource), path.resolve(bound.resource));
  }
  return bound.resource === requested.resource;
}

function policyCovers(policy: ToolClaimPolicy, claim: ToolResourceClaim): boolean {
  return policy.claims.some((bound) => covers(bound, claim));
}

function capabilityFor(claim: ToolResourceClaim): string {
  switch (claim.kind) {
    case "filesystem-read":
      return "file.read";
    case "filesystem-write":
      return "file.write";
    case "process":
      return "process.execute";
    case "network":
      return "network";
    case "secret":
      return "secret.use";
  }
}

function permissionAllows(permission: ToolPermission | undefined, claim: ToolResourceClaim): boolean {
  switch (permission) {
    case "read":
      return claim.kind === "filesystem-read";
    case "write":
      return claim.kind === "filesystem-read" || claim.kind === "filesystem-write";
    case "execute":
      return claim.kind !== "secret";
    case "network":
      return claim.kind === "network";
    case "dangerous":
      return true;
    case undefined:
      return false;
  }
}

function contractDecision(input: {
  decision: ContractPolicyDecision["decision"];
  policyId: string;
  reasonCode: string;
  effectiveClaims: ToolResourceClaim[];
}): ContractPolicyDecision {
  return PolicyDecisionSchema.parse({ schemaVersion: 1, ...input });
}

/**
 * Transport-neutral enforcement point for dynamic tool resource claims.
 *
 * An invocation is authorized only when every parent/role/tool claim policy
 * covers every requested resource and the composed PolicyEvaluator allows the
 * corresponding capability. A lower layer can therefore narrow authority but
 * can never expand it.
 */
export class ToolGateway {
  readonly #evaluator: PolicyEvaluator;
  readonly #interactive: boolean;
  readonly #registeredToolIds: Set<string>;
  readonly #toolPermissions: Map<string, ToolPermission>;
  readonly #onDecision?: ToolGatewayOptions["onDecision"];

  constructor(options: ToolGatewayOptions = {}) {
    this.#evaluator = options.evaluator ?? new PolicyEvaluator();
    this.#interactive = options.interactive === true;
    const specs = listToolSpecs();
    this.#registeredToolIds = new Set(options.registeredToolIds ?? specs.map((tool) => tool.id));
    this.#toolPermissions = new Map(specs.map((tool) => [tool.id, tool.permission]));
    this.#onDecision = options.onDecision;
  }

  /** Register an approved runtime-discovered tool without widening any policy layer. */
  registerTool(toolId: string, permission: ToolPermission): void {
    ToolInvocationClaimSchema.parse({
      schemaVersion: 1,
      invocationId: "tool-registration",
      toolId,
      claims: [],
    });
    const existing = this.#toolPermissions.get(toolId);
    if (existing !== undefined && existing !== permission) {
      throw new Error(`tool ${toolId} is already registered with ${existing} permission`);
    }
    this.#registeredToolIds.add(toolId);
    this.#toolPermissions.set(toolId, permission);
  }

  authorize(request: ToolAuthorizationRequest): ContractPolicyDecision {
    const invocation = ToolInvocationClaimSchema.parse(request.invocation);
    if (!this.#registeredToolIds.has(invocation.toolId)) {
      const decision = contractDecision({
        decision: "deny",
        policyId: "tool-gateway-v1",
        reasonCode: "unknown-tool-deny",
        effectiveClaims: [],
      });
      this.#onDecision?.(invocation, decision);
      return decision;
    }
    if (invocation.claims.some((claim) => !permissionAllows(this.#toolPermissions.get(invocation.toolId), claim))) {
      const decision = contractDecision({
        decision: "deny",
        policyId: "tool-gateway-v1",
        reasonCode: "tool-claim-kind-denied",
        effectiveClaims: [],
      });
      this.#onDecision?.(invocation, decision);
      return decision;
    }
    const uncovered = invocation.claims.find((claim) =>
      request.policies.length === 0 || request.policies.some((policy) => !policyCovers(policy, claim)));
    if (uncovered !== undefined) {
      const decision = contractDecision({
        decision: "deny",
        policyId: "tool-gateway-v1",
        reasonCode: "tool-claim-outside-policy",
        effectiveClaims: [],
      });
      this.#onDecision?.(invocation, decision);
      return decision;
    }

    let approvalRequired = false;
    for (const claim of invocation.claims) {
      const evaluated = this.#evaluator.evaluate({
        capability: capabilityFor(claim),
        resource: claim.resource,
        interactive: this.#interactive,
        registered: true,
        contained: claim.kind === "filesystem-read" || claim.kind === "filesystem-write",
        sandboxed: request.sandboxed,
      });
      if (evaluated.decision === "deny") {
        const decision = contractDecision({
          decision: "deny",
          policyId: "tool-gateway-v1",
          reasonCode: evaluated.ruleId,
          effectiveClaims: [],
        });
        this.#onDecision?.(invocation, decision);
        return decision;
      }
      if (evaluated.decision === "ask") approvalRequired = true;
    }

    const decision = contractDecision({
      decision: approvalRequired && request.approvalSatisfied !== true ? "approval-required" : "allow",
      policyId: "tool-gateway-v1",
      reasonCode: approvalRequired && request.approvalSatisfied !== true
        ? "tool-approval-required"
        : "tool-policy-allowed",
      effectiveClaims: [...invocation.claims],
    });
    this.#onDecision?.(invocation, decision);
    return decision;
  }
}

export function createToolInvocationClaim(
  toolId: string,
  claims: readonly ToolResourceClaim[],
): ToolInvocationClaim {
  return ToolInvocationClaimSchema.parse({
    schemaVersion: 1,
    invocationId: randomUUID(),
    toolId,
    claims,
  });
}
