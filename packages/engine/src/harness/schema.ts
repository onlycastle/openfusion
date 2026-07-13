import { z } from "zod";
import { FrontierSelectionSchema } from "../engines/selection.js";
import {
  DIALECT_PACK_CATALOG_VERSION,
  FAMILY_CATALOG_VERSION,
  HarnessProfileSchema,
  getDialectPack,
} from "../models/catalog.js";

// The four frontier-generated prose pages (M4 Task 4) — each gets one page
// per slug, written straight from the frontier's page-generation stage. Kept
// here — not enforced as an enum on WikiPageSchema itself — because the
// schema also has to accept/validate pages loaded back off disk, and a
// hand-edited harness (spec §7.4, the Harness editor) is allowed to carry
// additional or renamed pages without failing structural validation.
export const PROSE_PAGE_SLUGS = [
  "architecture",
  "subsystems",
  "conventions",
  "build-and-test",
] as const;

// The human-approved "Project Card" page (spec §3.1, §3.4) — the only wiki
// page that is ALWAYS injected into every worker prompt, distinct from the
// four prose pages above which are consulted on demand. Its own generation
// stage (drafting + the approval gate) arrives in a later task; this slug is
// introduced now so WIKI_PAGE_SLUGS, the manifest's approval field, and the
// store's setCardState all agree on its name from day one.
export const CARD_SLUG = "project-card" as const;

// Every wiki page slug the harness can carry: the four prose pages plus the
// project card. Not enforced as an enum on WikiPageSchema itself (see above)
// — a hand-edited harness may carry additional or renamed pages without
// failing structural validation.
export const WIKI_PAGE_SLUGS = [...PROSE_PAGE_SLUGS, CARD_SLUG] as const;

// Shared by every artifact name/slug field (wiki page slugs, agent names):
// lowercase alphanumeric segments joined by single hyphens, no leading/
// trailing/doubled hyphens. Used both as a filesystem-safe identifier
// (becomes `<slug>.md` / `<name>.yaml`) and a stable cross-reference key
// (routing.yaml's taskClasses map agent names back to AgentDefSchema.name).
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const kebabString = () =>
  z.string().regex(KEBAB_RE, "must be kebab-case (lowercase alphanumeric segments joined by hyphens)");

export const ManifestSchema = z.object({
  // Phase 1 (model-family dialect packs): 1 = legacy pre-family bundles;
  // 2 = generated/upgraded bundles that pin catalog + profile versions.
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  generatorVersion: z.string().min(1),
  engine: z.string().min(1),
  // The exact planning runtime/model used to generate this bundle. Optional
  // for legacy manifests that recorded only `engine`.
  planningFrontier: FrontierSelectionSchema.optional(),
  headSha: z.string().min(1),
  // Full ISO-8601 datetime (zod v4's `z.iso.datetime()`), not a bare date —
  // generation timestamps need sub-day precision for the report card / eval
  // history (M6).
  generatedAt: z.iso.datetime(),
  verification: z.object({
    // Whether the bundle passed zod + validateHarness cross-validation at
    // generation time. "fail" is representable (and written) rather than
    // refused outright, so a partially-broken harness is still inspectable
    // in the editor instead of vanishing on generation failure.
    structural: z.enum(["pass", "fail"]),
    // Legacy only: older bundles stored a project-local benchmark verdict.
    // New generation omits it because benchmark correctness does not certify
    // an individual project harness. Kept optional so existing bundles load
    // and can be regenerated without a migration cliff.
    evals: z.enum(["pending", "pass", "fail"]).optional(),
    // Human-approval gate for the project-card wiki page (spec §3.4):
    // "draft" until a human reviews and approves it, then "approved". A
    // missing card is a LEGACY manifest — written before this field existed,
    // or before the card stage (a later task) exists at all — and carries no
    // card semantics whatsoever (harnessStatus surfaces this as `card:
    // null`, not "draft"). OPTIONAL, never `.default(...)`, specifically so
    // "never had a card" and "has a card, still in draft" stay distinguishable.
    card: z.enum(["draft", "approved"]).optional(),
  }),
  // Relative POSIX paths owned by this immutable generation (for example
  // routing.yaml, wiki/architecture.md, agents/coder.yaml). manifest.json
  // and cache state are excluded. Readers use the inventory for validation;
  // new generations never prune or rewrite an active older generation.
  // `.default([])` keeps legacy flat manifests readable.
  artifacts: z.array(z.string()).default([]),
  // Phase 1 additive pins (optional on v1 manifests; required on new v2
  // generates). Eval report cards echo these so a "pass" is comparable.
  harnessProfile: HarnessProfileSchema.optional(),
  familyCatalogVersion: z.string().min(1).optional(),
  dialectPackVersion: z.string().min(1).optional(),
  // "1" | "2" matching routing.version as a string pin for reports.
  routePolicyVersion: z.string().min(1).optional(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const WikiPageSchema = z.object({
  slug: kebabString(),
  title: z.string().min(1),
  // The token-budgeted summary agents actually consume (wiki digests are
  // injected into worker prompts, not the full page body) — 2500 chars is
  // the hard ceiling for a SINGLE digest injection (spec §3.1): unlike the
  // four prose pages (consulted on demand, so their digests stay small — see
  // generate.ts's buildPagePrompt), the project-card page is the one digest
  // injected into EVERY worker prompt unconditionally, so it alone gets the
  // wider budget.
  digest: z.string().min(1).max(2500),
  body: z.string(),
});
export type WikiPage = z.infer<typeof WikiPageSchema>;

export const AgentModelObjectSchema = z.object({
  kind: z.string().min(1),
  model: z.string().min(1),
  // Which configured provider (models/providers.ts's ProviderRegistry id,
  // NOT the provider "kind") should serve this agent's model — added in
  // M5b Task 1 so the routing layer (Task 2) can resolve a specific
  // registered provider instead of guessing one from `kind` alone.
  // OPTIONAL for backward compatibility: an agent def written before this
  // field existed (on disk, or a hand-edited harness) still parses; a
  // missing providerId is resolved by the routing layer, not rejected
  // here.
  providerId: z.string().optional(),
  // Phase 1: model family + dialect pack pins (optional on disk for upgraded
  // bundles; required after generate v2). Missing values are filled by
  // upgradeHarnessV1ToV2 / resolveFamily at load time.
  family: kebabString().optional(),
  dialectPack: kebabString().optional(),
});

export const AgentModelSchema = z.union([AgentModelObjectSchema, z.literal("frontier")]);
export type AgentModel = z.infer<typeof AgentModelSchema>;

export const AgentDefSchema = z.object({
  name: kebabString(),
  role: z.string().min(1),
  description: z.string().min(1),
  prompt: z.string().min(1),
  taskClasses: z.array(z.string().min(1)).min(1),
  model: AgentModelSchema,
  escalation: z.object({
    maxAttempts: z.number().int().min(1).max(3),
  }),
});
export type AgentDef = z.infer<typeof AgentDefSchema>;

const RoutingTaskEntrySchema = z.object({
  agent: z.string().min(1),
  // Stable id for telemetry; defaulted by upgrader to `tc:<taskClass>`.
  routeId: z.string().min(1).optional(),
});

export const RoutingV1Schema = z.object({
  version: z.literal(1),
  taskClasses: z.record(z.string().min(1), z.object({ agent: z.string().min(1) })),
  escalation: z.object({
    failuresBeforeFrontier: z.number().int().min(1).max(3),
  }),
  defaults: z.object({ agent: z.string().min(1) }),
});

// Ordered fallback agents for a route key (taskClass or "taskClass:difficulty").
export const RouteChainSchema = z.object({
  agents: z.array(z.string().min(1)).min(1),
});

export const RoutingV2Schema = z.object({
  version: z.literal(2),
  taskClasses: z.record(z.string().min(1), RoutingTaskEntrySchema),
  escalation: z.object({
    failuresBeforeFrontier: z.number().int().min(1).max(3),
  }),
  defaults: z.object({
    agent: z.string().min(1),
    routeId: z.string().min(1).optional(),
  }),
  // Candidate chains: keys are taskClass or "taskClass:low|mid|high".
  // When present, orchestrate walks agents[] on failure before frontier.
  chains: z.record(z.string().min(1), RouteChainSchema).optional(),
});

export const RoutingSchema = z.union([RoutingV1Schema, RoutingV2Schema]);
export type Routing = z.infer<typeof RoutingSchema>;
export type RoutingV1 = z.infer<typeof RoutingV1Schema>;
export type RoutingV2 = z.infer<typeof RoutingV2Schema>;

export const HarnessBundleSchema = z.object({
  manifest: ManifestSchema,
  pages: z.array(WikiPageSchema),
  agents: z.array(AgentDefSchema),
  routing: RoutingSchema,
}).refine(
  (bundle) => {
    const slugs = bundle.pages.map((p) => p.slug);
    return new Set(slugs).size === slugs.length;
  },
  {
    // Two pages sharing a slug would silently overwrite each other under
    // `wiki/<slug>.md` at write time — catch it as a structural error
    // instead of a silent last-write-wins on disk.
    message: "wiki pages must have unique slugs",
    path: ["pages"],
  },
);
export type HarnessBundle = z.infer<typeof HarnessBundleSchema>;

export interface HarnessIssue {
  // Dotted/bracketed pointer into the bundle, e.g.
  // "routing.taskClasses.codegen.agent" or "agents[1].taskClasses[0]".
  path: string;
  message: string;
}

// Cross-artifact referential integrity that a single schema's `.parse()`
// cannot express (it would need to see both `agents` and `routing` at once).
// Two directions, both required for a routable harness:
//   1. every routing entry (per task class, plus the default) must name an
//      agent that actually exists, or dispatch has nowhere to send a task.
//   2. every agent's declared task classes must appear as routing keys, or
//      that agent is unreachable by the router regardless of how good its
//      prompt is.
// Phase 1 also checks: any explicit agent.model.dialectPack must exist in
// the bundled catalog (unknown packs are hard structural failures).
// Returns an empty array when the bundle is fully consistent; callers (the
// generation pipeline, and eventually the Harness editor) treat a non-empty
// result as a hard structural failure — see manifest.verification.structural
// and spec §12.1's ETH hazard gate.
export function validateHarness(bundle: HarnessBundle): HarnessIssue[] {
  const issues: HarnessIssue[] = [];
  const agentNames = new Set(bundle.agents.map((a) => a.name));

  for (const [taskClass, entry] of Object.entries(bundle.routing.taskClasses)) {
    if (!agentNames.has(entry.agent)) {
      issues.push({
        path: `routing.taskClasses.${taskClass}.agent`,
        message: `references unknown agent "${entry.agent}"`,
      });
    }
  }

  if (!agentNames.has(bundle.routing.defaults.agent)) {
    issues.push({
      path: "routing.defaults.agent",
      message: `references unknown agent "${bundle.routing.defaults.agent}"`,
    });
  }

  const routingKeys = new Set(Object.keys(bundle.routing.taskClasses));
  bundle.agents.forEach((agent, agentIndex) => {
    agent.taskClasses.forEach((taskClass, taskClassIndex) => {
      if (!routingKeys.has(taskClass)) {
        issues.push({
          path: `agents[${agentIndex}].taskClasses[${taskClassIndex}]`,
          message: `task class "${taskClass}" (agent "${agent.name}") has no routing.taskClasses entry`,
        });
      }
    });

    if (agent.model !== "frontier" && agent.model.dialectPack !== undefined) {
      if (getDialectPack(agent.model.dialectPack) === undefined) {
        issues.push({
          path: `agents[${agentIndex}].model.dialectPack`,
          message: `unknown dialect pack "${agent.model.dialectPack}"`,
        });
      }
    }
  });

  // Chain agent references (routing v2 only).
  if (bundle.routing.version === 2 && bundle.routing.chains !== undefined) {
    for (const [key, chain] of Object.entries(bundle.routing.chains)) {
      chain.agents.forEach((name, i) => {
        if (!agentNames.has(name)) {
          issues.push({
            path: `routing.chains.${key}.agents[${i}]`,
            message: `references unknown agent "${name}"`,
          });
        }
      });
    }
  }

  return issues;
}

/** Catalog version constants re-exported for generate / eval report cards. */
export { FAMILY_CATALOG_VERSION, DIALECT_PACK_CATALOG_VERSION };
