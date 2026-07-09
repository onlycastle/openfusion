// Task classification + routing (M5b Task 2): turns a free-text task
// description into a concrete worker (AgentDef) and a model resolution the
// caller (Task 4's orchestrator, and worker.run) can hand straight to
// ProviderRegistry.resolve() — this module never calls resolve() itself, it
// only decides WHICH provider/model a run should use.
import { RpcErrorCodes } from "@openfusion/shared";
import type { AgentDef, HarnessBundle, Routing } from "../harness/schema.js";
import { upgradeRouting } from "../harness/upgrade.js";
import {
  resolveDialectPackId,
  resolveFamily,
} from "../models/catalog.js";
import type { ProviderRegistry } from "../models/providers.js";
import { RpcMethodError } from "../rpc/errors.js";

// Sentinel classifyTask returns when no keyword rule matches (or the class
// it would otherwise pick doesn't actually exist in this harness's
// routing.taskClasses) — routeTask treats it identically to "class not
// found": fall back to routing.defaults.agent.
export const DEFAULT_TASK_CLASS = "__default__";

export interface WorkerResolution {
  providerId: string;
  model: string;
  family: string;
  dialectPack: string;
}

export type TaskDifficulty = "low" | "mid" | "high";

export interface RoutedAgent {
  agent: AgentDef;
  // The raw classifyTask() result, INCLUDING the DEFAULT_TASK_CLASS
  // sentinel when nothing matched — kept as-is (not resolved to the
  // fallback agent's own task class) so callers can tell "this task hit a
  // specific class" apart from "this task fell through to defaults" for
  // logging/observability.
  taskClass: string;
  // Stable route id from routing v2 (or upgraded v1) for telemetry.
  routeId: string;
  difficulty: TaskDifficulty;
  // Ordered agent names to try (includes the primary agent first). When a
  // chain is configured, subsequent names are cheaper/stronger fallbacks
  // before frontier escalation.
  agentChain: string[];
  resolution: WorkerResolution | "frontier";
}

/** Keyword difficulty heuristic — free, no model call. */
export function classifyDifficulty(task: string): TaskDifficulty {
  const lower = task.toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  const has = (...kws: string[]) => kws.some((kw) => tokens.includes(kw));
  if (has("trivial", "typo", "rename", "docs", "readme", "comment", "format", "lint")) {
    return "low";
  }
  if (
    has(
      "architecture",
      "migrate",
      "migration",
      "security",
      "auth",
      "concurrency",
      "race",
      "refactor",
      "redesign",
      "hard",
      "complex",
    )
  ) {
    return "high";
  }
  return "mid";
}

function resolveAgentModel(
  agent: AgentDef,
  registry: ProviderRegistry,
): WorkerResolution | "frontier" {
  if (agent.model === "frontier") return "frontier";
  const { kind, model, providerId, family: pinnedFamily, dialectPack: pinnedPack } = agent.model;
  const family = pinnedFamily ?? resolveFamily(kind, model).id;
  const dialectPack = resolveDialectPackId({
    explicit: pinnedPack,
    familyId: family,
    providerKind: kind,
    modelId: model,
  });
  if (providerId !== undefined) {
    const configured = registry.list().some((p) => p.id === providerId);
    if (!configured) {
      throw new RpcMethodError(
        RpcErrorCodes.SERVER_ERROR,
        `agent ${agent.name} requires provider ${providerId} which is not configured`,
      );
    }
    return { providerId, model, family, dialectPack };
  }
  const providersOfKind = registry.list().filter((p) => p.kind === kind);
  if (providersOfKind.length === 0) {
    throw new RpcMethodError(
      RpcErrorCodes.SERVER_ERROR,
      `no configured provider of kind ${kind} for agent ${agent.name}`,
    );
  }
  if (providersOfKind.length > 1) {
    throw new RpcMethodError(
      RpcErrorCodes.SERVER_ERROR,
      `ambiguous provider kind ${kind} for agent ${agent.name}; specify providerId`,
    );
  }
  const [provider] = providersOfKind;
  if (provider === undefined) {
    throw new RpcMethodError(
      RpcErrorCodes.SERVER_ERROR,
      `no configured provider of kind ${kind} for agent ${agent.name}`,
    );
  }
  return { providerId: provider.id, model, family, dialectPack };
}

// v1 task classifier: a small deterministic keyword heuristic, NOT a model
// call. It exists so routing has *something* principled to key off of
// before M6 (or later) swaps this out for a frontier-backed classifier that
// actually reads the task and the harness's task-class descriptions. Rules
// are checked in a fixed priority order and each rule only fires if a
// matching class name actually exists in `routing.taskClasses` — this
// function never hardcodes an assumption that a given class exists, it only
// hardcodes the candidate NAMES to look for, so a harness that renamed or
// dropped a class degrades gracefully to the next rule (and ultimately to
// `"__default__"`) instead of routing to a class that isn't there.
//
// Matching is case-insensitive word-boundary matching: the task is tokenized
// into lowercase words (split on non-alphanumeric characters), and a keyword
// only matches if it equals one of those tokens (whole-word match). This
// prevents substring collisions like "Dockerfile" matching "doc" or "prefix"
// matching "fix".
export function classifyTask(task: string, routing: Routing): string {
  const lower = task.toLowerCase();
  // Tokenize into words: split on non-alphanumeric, filter empties
  const tokens = lower.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  const mentions = (...keywords: string[]): boolean =>
    keywords.some((kw) => tokens.includes(kw));
  const firstConfiguredClass = (...candidates: string[]): string | undefined =>
    candidates.find((name) => name in routing.taskClasses);

  if (mentions("test", "tests")) {
    const cls = firstConfiguredClass("tests", "test");
    if (cls !== undefined) return cls;
  }
  if (mentions("doc", "docs", "readme")) {
    const cls = firstConfiguredClass("docs", "documentation", "doc");
    if (cls !== undefined) return cls;
  }
  if (mentions("refactor", "refactoring")) {
    const cls = firstConfiguredClass("refactor", "refactoring");
    if (cls !== undefined) return cls;
  }
  if (mentions("fix", "bug", "bugs")) {
    const cls = firstConfiguredClass("fix", "bugfix", "bug");
    if (cls !== undefined) return cls;
  }

  // Nothing keyword-specific matched: treat this as general code writing
  // and land it on the harness's "codegen" class, if it has one, before
  // giving up and returning the default sentinel.
  const codegenCls = firstConfiguredClass("codegen");
  if (codegenCls !== undefined) return codegenCls;

  return DEFAULT_TASK_CLASS;
}

// Escalation-knob reconciliation (documented per the M5b Task 2 brief —
// there are two escalation-shaped numbers in the harness and they answer
// different questions):
//
//   - `routing.escalation.failuresBeforeFrontier` is the ORCHESTRATOR's
//     (Task 4) knob: how many worker.run ATTEMPTS at a task may fail before
//     the orchestrator gives up on worker models and escalates the task to
//     the frontier. This module doesn't consume it — routeTask always
//     resolves to a worker (or "frontier", if the routed agent's OWN model
//     is "frontier") on the first call; re-routing after repeated failure
//     is the orchestrator's job, driven by this number.
//
//   - `agent.escalation.maxAttempts` is a PER-AGENT cap that is reserved
//     for a future in-worker sub-retry loop (e.g. "if the worker's diff
//     fails to apply, let it try again up to maxAttempts times within the
//     same worker.run before counting the whole run as one failure"). v1
//     does not implement that loop: one worker.run call is unconditionally
//     one attempt. Until that sub-retry loop exists, maxAttempts is
//     informational only — it is not read anywhere in the routing or
//     orchestration path, and routing.escalation.failuresBeforeFrontier is
//     the sole authority for "how many attempts before escalating".
export function routeTask(
  task: string,
  harness: HarnessBundle,
  registry: ProviderRegistry,
): RoutedAgent {
  // Normalize routing to v2 shape so routeId is always available for
  // telemetry, even when the on-disk harness is still version 1.
  const routing = upgradeRouting(harness.routing);
  const taskClass = classifyTask(task, routing);
  const difficulty = classifyDifficulty(task);
  const entry = routing.taskClasses[taskClass];
  const agentName =
    taskClass === DEFAULT_TASK_CLASS || entry === undefined
      ? routing.defaults.agent
      : entry.agent;
  const routeId =
    taskClass === DEFAULT_TASK_CLASS || entry === undefined
      ? (routing.defaults.routeId ?? "tc:default")
      : (entry.routeId ?? `tc:${taskClass}`);

  // Chain lookup: prefer "taskClass:difficulty", then "taskClass", then primary alone.
  const chainKeySpecific =
    taskClass === DEFAULT_TASK_CLASS ? undefined : `${taskClass}:${difficulty}`;
  const chainKeyClass = taskClass === DEFAULT_TASK_CLASS ? undefined : taskClass;
  const chainFromConfig =
    (chainKeySpecific !== undefined ? routing.chains?.[chainKeySpecific]?.agents : undefined) ??
    (chainKeyClass !== undefined ? routing.chains?.[chainKeyClass]?.agents : undefined);
  const agentChain =
    chainFromConfig !== undefined && chainFromConfig.length > 0
      ? [...new Set([agentName, ...chainFromConfig])]
      : [agentName];

  const agent = harness.agents.find((a) => a.name === agentName);
  if (agent === undefined) {
    throw new RpcMethodError(
      RpcErrorCodes.SERVER_ERROR,
      `routing references unknown agent: ${agentName}`,
    );
  }

  // Validate chain names exist (soft: drop unknown names with log-free skip)
  const validChain = agentChain.filter((name) => harness.agents.some((a) => a.name === name));
  const finalChain = validChain.length > 0 ? validChain : [agentName];

  return {
    agent,
    taskClass,
    routeId,
    difficulty,
    agentChain: finalChain,
    resolution: resolveAgentModel(agent, registry),
  };
}

/** Resolve a named agent from the harness to a model resolution. */
export function resolveNamedAgent(
  agentName: string,
  harness: HarnessBundle,
  registry: ProviderRegistry,
): { agent: AgentDef; resolution: WorkerResolution | "frontier" } {
  const agent = harness.agents.find((a) => a.name === agentName);
  if (agent === undefined) {
    throw new RpcMethodError(
      RpcErrorCodes.SERVER_ERROR,
      `routing references unknown agent: ${agentName}`,
    );
  }
  return { agent, resolution: resolveAgentModel(agent, registry) };
}
