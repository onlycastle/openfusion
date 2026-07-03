// Task classification + routing (M5b Task 2): turns a free-text task
// description into a concrete worker (AgentDef) and a model resolution the
// caller (Task 4's orchestrator, and worker.run) can hand straight to
// ProviderRegistry.resolve() — this module never calls resolve() itself, it
// only decides WHICH provider/model a run should use.
import { RpcErrorCodes } from "@openfusion/shared";
import type { AgentDef, HarnessBundle, Routing } from "../harness/schema.js";
import type { ProviderRegistry } from "../models/providers.js";
import { RpcMethodError } from "../rpc/errors.js";

// Sentinel classifyTask returns when no keyword rule matches (or the class
// it would otherwise pick doesn't actually exist in this harness's
// routing.taskClasses) — routeTask treats it identically to "class not
// found": fall back to routing.defaults.agent.
const DEFAULT_TASK_CLASS = "__default__";

export interface RoutedAgent {
  agent: AgentDef;
  // The raw classifyTask() result, INCLUDING the DEFAULT_TASK_CLASS
  // sentinel when nothing matched — kept as-is (not resolved to the
  // fallback agent's own task class) so callers can tell "this task hit a
  // specific class" apart from "this task fell through to defaults" for
  // logging/observability.
  taskClass: string;
  resolution: { providerId: string; model: string } | "frontier";
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
// Matching is case-insensitive substring matching against the raw task
// string — deliberately crude; the harness's own taskClasses map is the
// place to get more classes recognized, not this function.
export function classifyTask(task: string, routing: Routing): string {
  const lower = task.toLowerCase();
  const mentions = (...keywords: string[]): boolean => keywords.some((kw) => lower.includes(kw));
  const firstConfiguredClass = (...candidates: string[]): string | undefined =>
    candidates.find((name) => name in routing.taskClasses);

  if (mentions("test")) {
    const cls = firstConfiguredClass("tests", "test");
    if (cls !== undefined) return cls;
  }
  if (mentions("doc", "readme")) {
    const cls = firstConfiguredClass("docs", "documentation", "doc");
    if (cls !== undefined) return cls;
  }
  if (mentions("refactor")) {
    const cls = firstConfiguredClass("refactor", "refactoring");
    if (cls !== undefined) return cls;
  }
  if (mentions("fix", "bug")) {
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
  const taskClass = classifyTask(task, harness.routing);
  const entry = harness.routing.taskClasses[taskClass];
  const agentName = taskClass === DEFAULT_TASK_CLASS || entry === undefined
    ? harness.routing.defaults.agent
    : entry.agent;

  const agent = harness.agents.find((a) => a.name === agentName);
  if (agent === undefined) {
    // Shouldn't happen if validateHarness() passed at generation time (it
    // checks exactly this referential integrity) — guarded here anyway
    // since routeTask has no guarantee the harness it was handed went
    // through that check (e.g. a hand-edited harness loaded straight off
    // disk).
    throw new RpcMethodError(
      RpcErrorCodes.SERVER_ERROR,
      `routing references unknown agent: ${agentName}`,
    );
  }

  if (agent.model === "frontier") {
    return { agent, taskClass, resolution: "frontier" };
  }

  const { kind, model, providerId } = agent.model;

  if (providerId !== undefined) {
    const configured = registry.list().some((p) => p.id === providerId);
    if (!configured) {
      throw new RpcMethodError(
        RpcErrorCodes.SERVER_ERROR,
        `agent ${agent.name} requires provider ${providerId} which is not configured`,
      );
    }
    return { agent, taskClass, resolution: { providerId, model } };
  }

  // No providerId pinned on the agent: deterministic fallback — resolve to
  // whichever configured provider serves this model `kind`, but only if
  // there's exactly one. Zero or more than one is a configuration problem
  // routeTask refuses to guess through; the fix in both cases is to
  // configure/qualify providers, not to pick one arbitrarily.
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
    // Unreachable — the length checks above guarantee exactly one element
    // — but noUncheckedIndexedAccess still types destructuring as
    // possibly-undefined, so this satisfies strict TS without an
    // assertion.
    throw new RpcMethodError(
      RpcErrorCodes.SERVER_ERROR,
      `no configured provider of kind ${kind} for agent ${agent.name}`,
    );
  }
  return { agent, taskClass, resolution: { providerId: provider.id, model } };
}
