// Model family + dialect-pack catalog (Phase 1): first-class objects that
// sit ABOVE provider config/pricing. Families name capability + cost tiers;
// dialect packs name the *runtime contract* open workers actually run under
// (edit dialect, toolset, prompt budget). See
// docs/superpowers/specs/2026-07-09-model-family-dialect-packs-design.md.
import { z } from "zod";

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const kebabString = () =>
  z.string().regex(KEBAB_RE, "must be kebab-case (lowercase alphanumeric segments joined by hyphens)");

export const FAMILY_CATALOG_VERSION = "2026.07.09";
// Snapshot of the highest pack semver set we ship — bump when any pack meta
// changes in a way that would make old eval numbers non-comparable.
export const DIALECT_PACK_CATALOG_VERSION = "1.0.0";

export const ModelCapabilitySchema = z.enum([
  "coding",
  "tools",
  "long-ctx",
  "reasoning",
  "cheap-bulk",
  "frontier-plan",
]);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

export const ProvenanceSchema = z.object({
  source: z.string().min(1),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ModelFamilySchema = z.object({
  id: kebabString(),
  displayName: z.string().min(1),
  providerKinds: z.array(z.string().min(1)).min(1),
  // Exact model ids or prefix matchers (trailing "*"). Exact match wins over
  // prefix; a lone "*" matches any model for that provider kind.
  modelMatchers: z.array(z.string().min(1)).min(1),
  contextWindow: z.number().int().positive(),
  capabilities: z.array(ModelCapabilitySchema).min(1),
  costTier: z.enum(["frontier", "mid", "cheap"]),
  latencyTier: z.enum(["fast", "mid", "slow"]),
  cacheBehavior: z.enum(["strong", "weak", "unknown"]).default("unknown"),
  bestFor: z.array(z.string()).default([]),
  avoidFor: z.array(z.string()).default([]),
  defaultDialectPack: kebabString(),
  provenance: ProvenanceSchema,
  evalScores: z.record(z.string(), z.number()).optional(),
});
export type ModelFamily = z.infer<typeof ModelFamilySchema>;

export const EditDialectSchema = z.enum(["string-replace", "whole-file", "apply-patch"]);
export type EditDialect = z.infer<typeof EditDialectSchema>;

export const DialectPackMetaSchema = z.object({
  id: kebabString(),
  version: z.string().min(1),
  editDialect: EditDialectSchema,
  toolset: z.enum(["minimal", "standard", "standard+wiki"]),
  maxSteps: z.number().int().min(1).max(80).default(30),
  promptBudgetChars: z.number().int().positive().default(2000),
  // 0 = off. Worker loop is single-shot multi-step today; field is recorded
  // for reproducibility and applied only when the loop supports mid-run
  // compression.
  compactionThresholdSteps: z.number().int().min(0).default(0),
  permissionPosture: z
    .enum(["permissive-worker", "read-prefer", "no-bash"])
    .default("permissive-worker"),
  provenance: ProvenanceSchema,
});
export type DialectPackMeta = z.infer<typeof DialectPackMetaSchema>;

export const HarnessProfileSchema = z.enum([
  "openfusion-native",
  "claude-like",
  "codex-like",
  "opencode-like",
  "pi-like",
]);
export type HarnessProfile = z.infer<typeof HarnessProfileSchema>;

export interface ProfilePolicy {
  promptBudgetChars: number;
  toolset: DialectPackMeta["toolset"];
  preferredEditDialect: EditDialect;
  compactionThresholdSteps: number;
  permissionPosture: DialectPackMeta["permissionPosture"];
  exportFormatDefault: "agents-md" | "claude-subagents";
}

const BUNDLED_PROVENANCE: Provenance = {
  source: "openfusion-bundled",
  asOf: "2026-07-09",
  notes: "Phase 1 catalog; static scores omitted until DashBench loop lands",
};

export const DIALECT_PACKS: readonly DialectPackMeta[] = [
  DialectPackMetaSchema.parse({
    id: "string-edit-default",
    version: "1.0.0",
    editDialect: "string-replace",
    toolset: "standard+wiki",
    maxSteps: 30,
    promptBudgetChars: 2000,
    compactionThresholdSteps: 0,
    permissionPosture: "permissive-worker",
    provenance: BUNDLED_PROVENANCE,
  }),
  DialectPackMetaSchema.parse({
    id: "string-edit-strict",
    version: "1.0.0",
    editDialect: "string-replace",
    toolset: "standard+wiki",
    maxSteps: 30,
    promptBudgetChars: 2200,
    compactionThresholdSteps: 0,
    permissionPosture: "permissive-worker",
    provenance: {
      ...BUNDLED_PROVENANCE,
      notes: "Tighter edit uniqueness + retry hints for families that over-edit",
    },
  }),
  DialectPackMetaSchema.parse({
    id: "whole-file-prefer",
    version: "1.0.0",
    editDialect: "whole-file",
    toolset: "standard+wiki",
    maxSteps: 30,
    promptBudgetChars: 2000,
    compactionThresholdSteps: 0,
    permissionPosture: "permissive-worker",
    provenance: {
      ...BUNDLED_PROVENANCE,
      notes: "Prefer write_file; omit find/replace edit for brittle tool callers",
    },
  }),
  DialectPackMetaSchema.parse({
    id: "apply-patch-v1",
    version: "1.0.0",
    editDialect: "apply-patch",
    toolset: "standard+wiki",
    maxSteps: 30,
    promptBudgetChars: 2400,
    compactionThresholdSteps: 0,
    permissionPosture: "permissive-worker",
    provenance: {
      ...BUNDLED_PROVENANCE,
      notes: "Codex/OpenAI-style freeform apply_patch tool; runtime-wired",
    },
  }),
];

export const MODEL_FAMILIES: readonly ModelFamily[] = [
  ModelFamilySchema.parse({
    id: "kimi",
    displayName: "Kimi",
    providerKinds: ["moonshot"],
    modelMatchers: ["kimi-*", "*"],
    contextWindow: 262_144,
    capabilities: ["coding", "tools", "long-ctx"],
    costTier: "mid",
    latencyTier: "mid",
    cacheBehavior: "strong",
    bestFor: ["feature", "multi-file", "long-session"],
    avoidFor: ["ultra-cheap-bulk"],
    defaultDialectPack: "string-edit-default",
    provenance: BUNDLED_PROVENANCE,
  }),
  ModelFamilySchema.parse({
    id: "glm",
    displayName: "GLM",
    providerKinds: ["zai"],
    modelMatchers: ["glm-*", "*"],
    contextWindow: 1_000_000,
    capabilities: ["coding", "tools", "long-ctx"],
    costTier: "mid",
    latencyTier: "mid",
    cacheBehavior: "strong",
    bestFor: ["feature", "long-ctx", "multi-file"],
    avoidFor: [],
    defaultDialectPack: "string-edit-default",
    provenance: BUNDLED_PROVENANCE,
  }),
  ModelFamilySchema.parse({
    id: "deepseek",
    displayName: "DeepSeek",
    providerKinds: ["deepseek"],
    modelMatchers: ["deepseek-*", "*"],
    contextWindow: 1_000_000,
    capabilities: ["coding", "tools", "long-ctx", "cheap-bulk"],
    costTier: "cheap",
    latencyTier: "fast",
    cacheBehavior: "strong",
    bestFor: ["bulk", "mechanical", "intermediate-escalation"],
    avoidFor: [],
    defaultDialectPack: "string-edit-default",
    provenance: BUNDLED_PROVENANCE,
  }),
  ModelFamilySchema.parse({
    id: "qwen",
    displayName: "Qwen",
    providerKinds: ["openai-compatible"],
    modelMatchers: ["qwen*"],
    contextWindow: 262_144,
    capabilities: ["coding", "tools", "cheap-bulk"],
    costTier: "cheap",
    latencyTier: "fast",
    cacheBehavior: "weak",
    bestFor: ["tests", "docs", "mechanical"],
    avoidFor: ["hard-architecture"],
    defaultDialectPack: "string-edit-default",
    provenance: BUNDLED_PROVENANCE,
  }),
  ModelFamilySchema.parse({
    id: "minimax",
    displayName: "MiniMax",
    providerKinds: ["openai-compatible"],
    modelMatchers: ["minimax*"],
    contextWindow: 200_000,
    capabilities: ["coding", "tools", "cheap-bulk"],
    costTier: "cheap",
    latencyTier: "fast",
    cacheBehavior: "unknown",
    bestFor: ["budget-coding"],
    avoidFor: [],
    defaultDialectPack: "string-edit-default",
    provenance: BUNDLED_PROVENANCE,
  }),
  ModelFamilySchema.parse({
    id: "generic-openai",
    displayName: "Generic OpenAI-compatible",
    providerKinds: ["openai-compatible"],
    modelMatchers: ["*"],
    contextWindow: 128_000,
    capabilities: ["coding", "tools"],
    costTier: "mid",
    latencyTier: "mid",
    cacheBehavior: "unknown",
    bestFor: [],
    avoidFor: [],
    defaultDialectPack: "string-edit-default",
    provenance: BUNDLED_PROVENANCE,
  }),
  ModelFamilySchema.parse({
    id: "claude-frontier",
    displayName: "Claude (frontier seat)",
    providerKinds: ["claude-code", "anthropic"],
    modelMatchers: ["*"],
    contextWindow: 1_000_000,
    capabilities: ["coding", "tools", "long-ctx", "reasoning", "frontier-plan"],
    costTier: "frontier",
    latencyTier: "mid",
    cacheBehavior: "strong",
    bestFor: ["plan", "review", "hard-escalation"],
    avoidFor: ["metered-bulk"],
    defaultDialectPack: "string-edit-default",
    provenance: BUNDLED_PROVENANCE,
  }),
  ModelFamilySchema.parse({
    id: "openai-codex",
    displayName: "OpenAI Codex (frontier seat)",
    providerKinds: ["openai", "codex"],
    modelMatchers: ["*"],
    contextWindow: 400_000,
    capabilities: ["coding", "tools", "reasoning", "frontier-plan"],
    costTier: "frontier",
    latencyTier: "mid",
    cacheBehavior: "strong",
    bestFor: ["plan", "review"],
    avoidFor: ["metered-bulk"],
    defaultDialectPack: "apply-patch-v1",
    provenance: BUNDLED_PROVENANCE,
  }),
];

const PACK_BY_ID = new Map(DIALECT_PACKS.map((p) => [p.id, p]));
const FAMILY_BY_ID = new Map(MODEL_FAMILIES.map((f) => [f.id, f]));

export function getDialectPack(id: string): DialectPackMeta | undefined {
  return PACK_BY_ID.get(id);
}

export function requireDialectPack(id: string): DialectPackMeta {
  const pack = PACK_BY_ID.get(id);
  if (pack === undefined) {
    throw new Error(`unknown dialect pack: ${id}`);
  }
  return pack;
}

export function getModelFamily(id: string): ModelFamily | undefined {
  return FAMILY_BY_ID.get(id);
}

function matcherScore(matcher: string, modelId: string): number | null {
  if (matcher === "*") return 1;
  if (matcher.endsWith("*")) {
    const prefix = matcher.slice(0, -1);
    if (modelId.startsWith(prefix)) return 100 + prefix.length;
    return null;
  }
  if (matcher === modelId) return 1000;
  return null;
}

/**
 * Resolve (providerKind, modelId) → family. Exact modelMatchers beat
 * prefixes; a lone "*" is the weak default for that kind. Falls back to
 * generic-openai when nothing matches.
 */
export function resolveFamily(providerKind: string, modelId: string): ModelFamily {
  let best: { family: ModelFamily; score: number } | undefined;
  for (const family of MODEL_FAMILIES) {
    if (!family.providerKinds.includes(providerKind)) continue;
    for (const matcher of family.modelMatchers) {
      const score = matcherScore(matcher, modelId);
      if (score === null) continue;
      if (best === undefined || score > best.score) {
        best = { family, score };
      }
    }
  }
  if (best !== undefined) return best.family;
  const generic = FAMILY_BY_ID.get("generic-openai");
  if (generic === undefined) {
    throw new Error("catalog missing generic-openai family");
  }
  return generic;
}

export function resolveDialectPackId(args: {
  explicit?: string;
  familyId?: string;
  providerKind?: string;
  modelId?: string;
}): string {
  if (args.explicit !== undefined) return args.explicit;
  if (args.familyId !== undefined) {
    const family = FAMILY_BY_ID.get(args.familyId);
    if (family !== undefined) return family.defaultDialectPack;
  }
  if (args.providerKind !== undefined && args.modelId !== undefined) {
    return resolveFamily(args.providerKind, args.modelId).defaultDialectPack;
  }
  return "string-edit-default";
}

export function profilePolicy(profile: HarnessProfile): ProfilePolicy {
  switch (profile) {
    case "pi-like":
      return {
        promptBudgetChars: 400,
        toolset: "minimal",
        preferredEditDialect: "string-replace",
        compactionThresholdSteps: 0,
        permissionPosture: "permissive-worker",
        exportFormatDefault: "agents-md",
      };
    case "claude-like":
      return {
        promptBudgetChars: 4000,
        toolset: "standard+wiki",
        preferredEditDialect: "string-replace",
        compactionThresholdSteps: 0,
        permissionPosture: "permissive-worker",
        exportFormatDefault: "claude-subagents",
      };
    case "codex-like":
      return {
        promptBudgetChars: 2500,
        toolset: "standard",
        preferredEditDialect: "apply-patch",
        compactionThresholdSteps: 0,
        permissionPosture: "permissive-worker",
        exportFormatDefault: "agents-md",
      };
    case "opencode-like":
      return {
        promptBudgetChars: 2000,
        toolset: "standard+wiki",
        preferredEditDialect: "string-replace",
        compactionThresholdSteps: 0,
        permissionPosture: "permissive-worker",
        exportFormatDefault: "agents-md",
      };
    case "openfusion-native":
    default:
      return {
        promptBudgetChars: 2000,
        toolset: "standard+wiki",
        preferredEditDialect: "string-replace",
        compactionThresholdSteps: 0,
        permissionPosture: "permissive-worker",
        exportFormatDefault: "agents-md",
      };
  }
}

export function knownDialectPackIds(): string[] {
  return DIALECT_PACKS.map((p) => p.id);
}

export function knownFamilyIds(): string[] {
  return MODEL_FAMILIES.map((f) => f.id);
}
