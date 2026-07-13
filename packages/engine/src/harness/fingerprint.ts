import { createHash } from "node:crypto";
import {
  DIALECT_PACKS,
  DIALECT_PACK_CATALOG_VERSION,
  FAMILY_CATALOG_VERSION,
  MODEL_FAMILIES,
} from "../models/catalog.js";
import {
  REVIEW_POLICY_VERSION,
  REVIEW_PROMPT_TEMPLATE,
} from "../orchestrate/review-policy.js";
import { TOOL_REGISTRY_FINGERPRINT } from "../tools/registry.js";
import { HARNESS_REGISTRY } from "./registry.js";
import { CARD_SLUG, HarnessBundleSchema, type HarnessBundle, type Routing } from "./schema.js";
import { upgradeHarnessV1ToV2 } from "./upgrade.js";

// Retry semantics still live in orchestration code rather than a harness
// artifact, so bump this version whenever they become non-comparable. Review
// policy is stronger: fingerprintHarness hashes its actual protected static
// prompt template below rather than relying on a manual version alone.
export const RETRY_POLICY_VERSION = HARNESS_REGISTRY.policies.retry;
export { REVIEW_POLICY_VERSION };

export interface HarnessComponentRef {
  id: string;
  digest: string;
  version?: string;
}

export interface HarnessFingerprint {
  digest: string;
  components: HarnessComponentRef[];
}

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function canonicalize(value: unknown): CanonicalValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item) ?? null);
  }
  if (typeof value === "object") {
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value).sort()) {
      const canonical = canonicalize((value as Record<string, unknown>)[key]);
      if (canonical !== undefined) result[key] = canonical;
    }
    return result;
  }
  throw new TypeError(`cannot fingerprint value of type ${typeof value}`);
}

function canonicalJson(value: unknown): string {
  const canonical = canonicalize(value);
  if (canonical === undefined) throw new TypeError("cannot fingerprint undefined");
  return JSON.stringify(canonical);
}

function digestValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

// localeCompare can vary with the host ICU locale. Fingerprints must be
// byte-for-byte stable across machines, so order identifiers by JavaScript
// code units instead.
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function component(id: string, value: unknown, version?: string): HarnessComponentRef {
  return {
    id,
    digest: digestValue(value),
    ...(version !== undefined ? { version } : {}),
  };
}

function routingPolicy(routing: Routing): unknown {
  return routing.version === 1
    ? {
        version: routing.version,
        taskClasses: routing.taskClasses,
        defaults: routing.defaults,
      }
    : {
        version: routing.version,
        taskClasses: routing.taskClasses,
        defaults: routing.defaults,
        ...(routing.chains !== undefined ? { chains: routing.chains } : {}),
      };
}

/**
 * Compute a content-only identity for the effective harness configuration.
 *
 * The input is parsed and upgraded in memory first, matching loadHarness(),
 * so semantically equivalent legacy v1 and current v2 bundles compare equal.
 * Volatile manifest fields (generatedAt, eval verdict, artifact write order)
 * are deliberately excluded. The returned structure contains only component
 * IDs, versions, and digests — never prompt/wiki prose.
 */
export function fingerprintHarness(bundle: HarnessBundle): HarnessFingerprint {
  const parsed = HarnessBundleSchema.parse(bundle);
  const effective = upgradeHarnessV1ToV2(parsed);
  const sortedPages = [...effective.pages].sort((a, b) => compareIds(a.slug, b.slug));
  const sortedAgents = [...effective.agents].sort((a, b) => compareIds(a.name, b.name));
  const card = sortedPages.find((page) => page.slug === CARD_SLUG);

  const components: HarnessComponentRef[] = [
    component(
      "harness.source",
      {
        schemaVersion: effective.manifest.schemaVersion,
        generatorVersion: effective.manifest.generatorVersion,
        engine: effective.manifest.engine,
        planningFrontier: effective.manifest.planningFrontier,
        headSha: effective.manifest.headSha,
        harnessProfile: effective.manifest.harnessProfile,
      },
      effective.manifest.generatorVersion,
    ),
    component(
      "context.project-card",
      {
        state: effective.manifest.verification.card ?? "missing",
        page: card ?? null,
      },
    ),
    ...sortedPages
      .filter((page) => page.slug !== CARD_SLUG)
      .map((page) => component(`context.wiki.${page.slug}`, page)),
    ...sortedAgents.map((agent) =>
      component(`agent.${agent.name}.prompt`, {
        name: agent.name,
        prompt: agent.prompt,
      }),
    ),
    component(
      "models.roster",
      sortedAgents.map((agent) => ({ name: agent.name, model: agent.model })),
    ),
    component(
      "models.family-catalog",
      [...MODEL_FAMILIES].sort((a, b) => compareIds(a.id, b.id)),
      FAMILY_CATALOG_VERSION,
    ),
    component(
      "tools.dialect-pack-catalog",
      [...DIALECT_PACKS].sort((a, b) => compareIds(a.id, b.id)),
      DIALECT_PACK_CATALOG_VERSION,
    ),
    component(
      "tools.registry",
      TOOL_REGISTRY_FINGERPRINT.tools,
      TOOL_REGISTRY_FINGERPRINT.version,
    ),
    component(
      "routing.policy",
      routingPolicy(effective.routing),
      effective.manifest.routePolicyVersion ?? String(effective.routing.version),
    ),
    component(
      "retry.policy",
      {
        routing: effective.routing.escalation,
        agents: sortedAgents.map((agent) => ({
          name: agent.name,
          escalation: agent.escalation,
        })),
      },
      RETRY_POLICY_VERSION,
    ),
    component(
      "review.policy",
      {
        reviewer: "frontier",
        posture: "read-only",
        decisions: ["approve", "request-changes"],
        promptTemplate: REVIEW_PROMPT_TEMPLATE,
      },
      HARNESS_REGISTRY.policies.review,
    ),
  ].sort((a, b) => compareIds(a.id, b.id));

  return {
    digest: digestValue(components),
    components,
  };
}
