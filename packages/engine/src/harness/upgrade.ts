// Deterministic v1 → v2 harness upgrader (Phase 1). Pure: same catalog
// version → same normalized output. Does NOT rewrite disk — loadHarness
// upgrades in memory; generateHarness always writes schemaVersion 2.
// Spec: docs/superpowers/specs/2026-07-09-model-family-dialect-packs-design.md §5.
import {
  DIALECT_PACK_CATALOG_VERSION,
  FAMILY_CATALOG_VERSION,
  resolveDialectPackId,
  resolveFamily,
  type HarnessProfile,
} from "../models/catalog.js";
import type {
  AgentDef,
  AgentModel,
  HarnessBundle,
  Manifest,
  Routing,
  RoutingV2,
} from "./schema.js";

export function needsUpgrade(bundle: HarnessBundle): boolean {
  if (bundle.manifest.schemaVersion === 1) return true;
  if (bundle.routing.version === 1) return true;
  if (bundle.manifest.harnessProfile === undefined) return true;
  if (bundle.manifest.familyCatalogVersion === undefined) return true;
  if (bundle.manifest.dialectPackVersion === undefined) return true;
  if (bundle.manifest.routePolicyVersion === undefined) return true;
  for (const agent of bundle.agents) {
    if (agent.model === "frontier") continue;
    if (agent.model.family === undefined || agent.model.dialectPack === undefined) return true;
  }
  return false;
}

export function upgradeRouting(routing: Routing): RoutingV2 {
  if (routing.version === 2) {
    const taskClasses: RoutingV2["taskClasses"] = {};
    for (const [name, entry] of Object.entries(routing.taskClasses)) {
      taskClasses[name] = {
        agent: entry.agent,
        routeId: entry.routeId ?? `tc:${name}`,
      };
    }
    return {
      version: 2,
      taskClasses,
      escalation: routing.escalation,
      defaults: {
        agent: routing.defaults.agent,
        routeId: routing.defaults.routeId ?? "tc:default",
      },
      ...(routing.chains !== undefined ? { chains: routing.chains } : {}),
    };
  }

  const taskClasses: RoutingV2["taskClasses"] = {};
  for (const [name, entry] of Object.entries(routing.taskClasses)) {
    taskClasses[name] = {
      agent: entry.agent,
      routeId: `tc:${name}`,
    };
  }
  return {
    version: 2,
    taskClasses,
    escalation: routing.escalation,
    defaults: {
      agent: routing.defaults.agent,
      routeId: "tc:default",
    },
  };
}

function upgradeAgentModel(model: AgentModel): AgentModel {
  if (model === "frontier") return "frontier";
  const family =
    model.family ?? resolveFamily(model.kind, model.model).id;
  const dialectPack =
    model.dialectPack ??
    resolveDialectPackId({
      familyId: family,
      providerKind: model.kind,
      modelId: model.model,
    });
  return {
    ...model,
    family,
    dialectPack,
  };
}

function upgradeAgent(agent: AgentDef): AgentDef {
  return {
    ...agent,
    model: upgradeAgentModel(agent.model),
  };
}

function upgradeManifest(manifest: Manifest, routing: RoutingV2): Manifest {
  const profile: HarnessProfile = manifest.harnessProfile ?? "openfusion-native";
  return {
    ...manifest,
    schemaVersion: 2,
    harnessProfile: profile,
    familyCatalogVersion: manifest.familyCatalogVersion ?? FAMILY_CATALOG_VERSION,
    dialectPackVersion: manifest.dialectPackVersion ?? DIALECT_PACK_CATALOG_VERSION,
    routePolicyVersion: manifest.routePolicyVersion ?? String(routing.version),
  };
}

/**
 * Upgrade a v1 (or partially-v2) bundle to the normalized Phase-1 v2 form.
 * Idempotent on the normalized shape: upgrade(upgrade(b)) deep-equals
 * upgrade(b) for fields this function owns.
 */
export function upgradeHarnessV1ToV2(bundle: HarnessBundle): HarnessBundle {
  const routing = upgradeRouting(bundle.routing);
  const agents = bundle.agents.map(upgradeAgent);
  const manifest = upgradeManifest(bundle.manifest, routing);
  return {
    manifest,
    pages: bundle.pages,
    agents,
    routing,
  };
}
