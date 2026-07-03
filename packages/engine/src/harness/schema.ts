import { z } from "zod";

// Canonical wiki page set the generation pipeline (M4 Task 4) produces one
// page per slug for. Kept here — not enforced as an enum on WikiPageSchema
// itself — because the schema also has to accept/validate pages loaded back
// off disk, and a hand-edited harness (spec §7.4, the Harness editor) is
// allowed to carry additional or renamed pages without failing structural
// validation.
export const WIKI_PAGE_SLUGS = [
  "architecture",
  "subsystems",
  "conventions",
  "build-and-test",
] as const;

// Shared by every artifact name/slug field (wiki page slugs, agent names):
// lowercase alphanumeric segments joined by single hyphens, no leading/
// trailing/doubled hyphens. Used both as a filesystem-safe identifier
// (becomes `<slug>.md` / `<name>.yaml`) and a stable cross-reference key
// (routing.yaml's taskClasses map agent names back to AgentDefSchema.name).
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const kebabString = () =>
  z.string().regex(KEBAB_RE, "must be kebab-case (lowercase alphanumeric segments joined by hyphens)");

export const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generatorVersion: z.string().min(1),
  engine: z.string().min(1),
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
    // ETH hazard gate (spec §12.1): stays "pending" until M6's eval loop
    // runs baseline-vs-harness and flips it. Never silently trusted.
    evals: z.enum(["pending", "pass", "fail"]),
  }),
  // Relative POSIX paths (under `.openfusion/`, e.g. "routing.yaml",
  // "wiki/architecture.md", "agents/coder.yaml") of every harness artifact
  // THIS generation wrote — excludes manifest.json itself and anything
  // under cache/. store.ts's writeHarness populates this on every write and
  // reads the PRIOR manifest's list back to know exactly which on-disk
  // files it, itself, is responsible for and may prune on the next
  // regeneration — as opposed to a file a user hand-added via the Harness
  // editor (spec §7.4), which was never recorded here and must never be
  // pruned. `.default([])` lets an older-shaped manifest (written before
  // this field existed) still parse, as an empty — i.e. "prune nothing,
  // I don't know what I wrote" — list.
  artifacts: z.array(z.string()).default([]),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const WikiPageSchema = z.object({
  slug: kebabString(),
  title: z.string().min(1),
  // The token-budgeted summary agents actually consume (wiki digests are
  // injected into worker prompts, not the full page body) — 1200 chars is
  // the hard ceiling that keeps a 4-page digest set cheap regardless of
  // model context window.
  digest: z.string().min(1).max(1200),
  body: z.string(),
});
export type WikiPage = z.infer<typeof WikiPageSchema>;

const AgentModelSchema = z.union([
  z.object({ kind: z.string().min(1), model: z.string().min(1) }),
  z.literal("frontier"),
]);

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

export const RoutingSchema = z.object({
  version: z.literal(1),
  taskClasses: z.record(z.string().min(1), z.object({ agent: z.string().min(1) })),
  escalation: z.object({
    failuresBeforeFrontier: z.number().int().min(1).max(3),
  }),
  defaults: z.object({ agent: z.string().min(1) }),
});
export type Routing = z.infer<typeof RoutingSchema>;

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
  });

  return issues;
}
