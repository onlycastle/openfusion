export type PolicyDecisionKind = "allow" | "ask" | "deny";

export interface PolicyRule {
  id: string;
  capability: string;
  resource?: string;
  decision: PolicyDecisionKind;
  reason?: string;
}

export interface PolicyLayer {
  id: string;
  rules: PolicyRule[];
}

export interface PolicyRequest {
  capability: string;
  resource?: string;
  interactive: boolean;
  registered?: boolean;
  contained?: boolean;
  sandboxed?: boolean;
}

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  source: string;
  ruleId: string;
  reason: string;
  requiresApproval: boolean;
}

export interface PolicyEvaluatorOptions {
  ceiling?: PolicyLayer;
  projectGrants?: PolicyLayer;
  sessionGrants?: PolicyLayer;
  restrictions?: PolicyLayer[];
  parentDecision?: (request: PolicyRequest) => PolicyDecision;
}

const DECISION_RANK: Readonly<Record<PolicyDecisionKind, number>> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globRegExp(pattern: string): RegExp {
  let result = "^";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        result += ".*";
        index += 2;
      } else {
        result += "[^/]*";
        index += 1;
      }
      continue;
    }
    result += escapeRegExp(char);
    index += 1;
  }
  return new RegExp(`${result}$`);
}

function matches(pattern: string, value: string): boolean {
  return pattern === "*" || pattern === "**" || globRegExp(pattern).test(value);
}

function specificity(rule: PolicyRule): number {
  const literalCapability = rule.capability.replaceAll("*", "").length;
  const literalResource = (rule.resource ?? "").replaceAll("*", "").length;
  const wildcards = (rule.capability.match(/\*/g)?.length ?? 0) +
    (rule.resource?.match(/\*/g)?.length ?? 0);
  return literalCapability * 10_000 + literalResource * 10 - wildcards;
}

function firstMatch(layer: PolicyLayer | undefined, request: PolicyRequest): PolicyRule | undefined {
  if (layer === undefined) return undefined;
  return layer.rules
    .filter((rule) => {
      if (!matches(rule.capability, request.capability)) return false;
      if (rule.resource === undefined) return true;
      return request.resource !== undefined && matches(rule.resource, request.resource);
    })
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => specificity(b.rule) - specificity(a.rule) || a.index - b.index)[0]?.rule;
}

function defaultDecision(request: PolicyRequest): PolicyDecision {
  if (request.registered === false || request.capability === "tool.unregistered") {
    return {
      decision: "deny",
      source: "developer-default",
      ruleId: "unknown-tool-deny",
      reason: "Unknown or unregistered tools are unavailable.",
      requiresApproval: false,
    };
  }
  if (request.capability === "file.read" || request.capability === "file.write") {
    const contained = request.contained === true;
    return {
      decision: contained ? "allow" : "deny",
      source: "developer-default",
      ruleId: contained ? "contained-file-allow" : "file-escape-deny",
      reason: contained
        ? "The file operation is contained in the isolated worktree."
        : "The file operation escapes the isolated worktree.",
      requiresApproval: false,
    };
  }
  if (request.capability === "process.execute") {
    const sandboxed = request.sandboxed === true;
    return {
      decision: sandboxed ? "allow" : "deny",
      source: "developer-default",
      ruleId: sandboxed ? "sandboxed-process-allow" : "unsandboxed-process-deny",
      reason: sandboxed
        ? "The process is constrained by an available sandbox backend."
        : "Unsandboxed process execution is unavailable.",
      requiresApproval: false,
    };
  }
  if (request.capability === "network" || request.capability.startsWith("network.")) {
    return {
      decision: "ask",
      source: "developer-default",
      ruleId: "network-ask",
      reason: "Network access requires an explicit scoped grant.",
      requiresApproval: true,
    };
  }
  if (request.capability === "secret.use") {
    return {
      decision: "ask",
      source: "developer-default",
      ruleId: "secret-ask",
      reason: "Secret use requires an explicit scoped grant.",
      requiresApproval: true,
    };
  }
  if (request.capability.startsWith("mcp.") || request.capability.startsWith("extension.")) {
    return {
      decision: "ask",
      source: "developer-default",
      ruleId: "extension-ask",
      reason: "External capabilities require an approved fingerprint.",
      requiresApproval: true,
    };
  }
  return {
    decision: "deny",
    source: "developer-default",
    ruleId: "unknown-capability-deny",
    reason: "The capability is not registered in the runtime policy.",
    requiresApproval: false,
  };
}

function fromRule(layer: PolicyLayer, rule: PolicyRule): PolicyDecision {
  return {
    decision: rule.decision,
    source: layer.id,
    ruleId: rule.id,
    reason: rule.reason ?? `${layer.id} selected ${rule.decision}.`,
    requiresApproval: rule.decision === "ask",
  };
}

function narrower(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return DECISION_RANK[b.decision] > DECISION_RANK[a.decision] ? b : a;
}

/**
 * Layered capability evaluator. Grants can resolve a default `ask`, but no
 * grant can override a ceiling deny, an explicit higher-layer deny, an
 * unregistered-tool deny, or a lower restriction. Headless callers collapse
 * unresolved `ask` to `deny`.
 */
export class PolicyEvaluator {
  readonly #options: PolicyEvaluatorOptions;

  constructor(options: PolicyEvaluatorOptions = {}) {
    this.#options = options;
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    const ceilingRule = firstMatch(this.#options.ceiling, request);
    if (ceilingRule?.decision === "deny") {
      return this.#headless(fromRule(this.#options.ceiling!, ceilingRule), request);
    }

    let decision = defaultDecision(request);
    const developerHardDeny = decision.decision === "deny" &&
      (decision.ruleId === "unknown-tool-deny" ||
        decision.ruleId === "unknown-capability-deny" ||
        decision.ruleId === "file-escape-deny" ||
        decision.ruleId === "unsandboxed-process-deny");

    const projectRule = firstMatch(this.#options.projectGrants, request);
    if (projectRule !== undefined && !developerHardDeny) {
      decision = fromRule(this.#options.projectGrants!, projectRule);
    }

    const sessionRule = firstMatch(this.#options.sessionGrants, request);
    if (sessionRule !== undefined && !developerHardDeny && decision.decision !== "deny") {
      decision = fromRule(this.#options.sessionGrants!, sessionRule);
    }

    if (ceilingRule !== undefined && ceilingRule.decision !== "allow") {
      decision = narrower(decision, fromRule(this.#options.ceiling!, ceilingRule));
    }

    for (const layer of this.#options.restrictions ?? []) {
      const restriction = firstMatch(layer, request);
      if (restriction === undefined || restriction.decision === "allow") continue;
      decision = narrower(decision, fromRule(layer, restriction));
    }

    if (this.#options.parentDecision !== undefined) {
      decision = narrower(decision, this.#options.parentDecision(request));
    }

    return this.#headless(decision, request);
  }

  /** Enforcing hooks may narrow to ask/deny, but `allow` never grants. */
  applyEnforcingHook(
    current: PolicyDecision,
    hook: { id: string; decision: PolicyDecisionKind; reason?: string },
    interactive: boolean,
  ): PolicyDecision {
    if (hook.decision === "allow") return this.#headless(current, { interactive });
    return this.#headless(
      narrower(current, {
        decision: hook.decision,
        source: `hook:${hook.id}`,
        ruleId: hook.id,
        reason: hook.reason ?? `Enforcing hook selected ${hook.decision}.`,
        requiresApproval: hook.decision === "ask",
      }),
      { interactive },
    );
  }

  #headless(decision: PolicyDecision, request: Pick<PolicyRequest, "interactive">): PolicyDecision {
    if (request.interactive || decision.decision !== "ask") return decision;
    return {
      decision: "deny",
      source: decision.source,
      ruleId: decision.ruleId,
      reason: `${decision.reason} Interactive approval is unavailable for this call.`,
      requiresApproval: false,
    };
  }
}
