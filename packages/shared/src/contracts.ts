import { z } from "zod";
import { ArtifactRefSchema, Sha256DigestSchema, safeId } from "./verification.js";

const GitShaSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/, "must be a Git object id");

export const RuntimeCapabilitiesSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeId: safeId(),
    runtimeVersion: z.string().min(1).max(128),
    protocolVersion: z.string().min(1).max(128),
    structuredOutput: z.boolean(),
    toolCalls: z.boolean(),
    pathAwareApprovals: z.boolean(),
    mcp: z.boolean(),
    resume: z.boolean(),
    fork: z.boolean(),
    compaction: z.boolean(),
    sandboxCompatibility: z.enum(["certified", "declared", "unsupported"]),
    capabilityDigest: Sha256DigestSchema,
  })
  .strict();
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

export const DirtyStateRefSchema = z
  .object({
    category: z.enum(["clean", "tracked", "untracked", "mixed"]),
    digest: Sha256DigestSchema,
  })
  .strict();

export const TaskSnapshotRefSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotId: safeId(),
    projectDigest: Sha256DigestSchema,
    baseSha: GitShaSchema,
    baseTreeDigest: Sha256DigestSchema,
    dirtyState: DirtyStateRefSchema,
    harnessGeneration: safeId().nullable(),
    harnessFingerprint: Sha256DigestSchema.nullable(),
    wikiHeadSha: GitShaSchema.nullable(),
    wikiDigest: Sha256DigestSchema.nullable(),
    toolRegistryDigest: Sha256DigestSchema,
    sandboxPolicyId: safeId(),
    runtimes: z.array(RuntimeCapabilitiesSchema).max(16),
    capturedAt: z.iso.datetime(),
  })
  .strict();
export type TaskSnapshotRef = z.infer<typeof TaskSnapshotRefSchema>;

export const CostEstimateSchema = z
  .object({
    knownUsd: z.number().nonnegative(),
    completeness: z.enum(["complete", "partial", "none"]),
    unpricedCalls: z.number().int().nonnegative(),
    pricingVersion: safeId(),
    confidence: z.enum(["verified", "estimated", "mixed", "unpriced"]),
  })
  .strict()
  .superRefine((estimate, ctx) => {
    if (estimate.completeness === "complete" && estimate.unpricedCalls !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["unpricedCalls"],
        message: "a complete estimate cannot contain unpriced calls",
      });
    }
    if (estimate.completeness === "none" && estimate.knownUsd !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["knownUsd"],
        message: "an estimate with no priced calls must report knownUsd as zero",
      });
    }
  });
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

export const RunEnvelopeV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    runId: safeId(),
    kind: z.enum(["orchestrate", "worker", "review", "verify", "apply", "generate", "eval", "experiment"]),
    taskSnapshot: TaskSnapshotRefSchema,
    rootSpanId: safeId(),
    budget: z
      .object({
        maxModelCalls: z.number().int().positive(),
        maxToolCalls: z.number().int().positive(),
        deadlineAt: z.iso.datetime(),
        maxKnownUsd: z.number().positive().optional(),
      })
      .strict(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type RunEnvelopeV2 = z.infer<typeof RunEnvelopeV2Schema>;

const MetadataScalarSchema = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]);
export const RunSpanEventV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    runId: safeId(),
    spanId: safeId(),
    parentSpanId: safeId().nullable(),
    attemptId: safeId().nullable(),
    seq: z.number().int().positive(),
    at: z.iso.datetime(),
    type: safeId(),
    terminal: z.boolean(),
    reasonCode: safeId().optional(),
    metadata: z.record(safeId(), MetadataScalarSchema).default({}),
  })
  .strict();
export type RunSpanEventV2 = z.infer<typeof RunSpanEventV2Schema>;

const ResourceClaimSchema = z
  .object({
    kind: z.enum(["filesystem-read", "filesystem-write", "process", "network", "secret"]),
    resource: z.string().min(1).max(2048),
  })
  .strict();

export const ToolInvocationClaimSchema = z
  .object({
    schemaVersion: z.literal(1),
    invocationId: safeId(),
    toolId: safeId(),
    claims: z.array(ResourceClaimSchema).max(64),
  })
  .strict();
export type ToolInvocationClaim = z.infer<typeof ToolInvocationClaimSchema>;

export const PolicyDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    decision: z.enum(["allow", "deny", "approval-required"]),
    policyId: safeId(),
    reasonCode: safeId(),
    effectiveClaims: z.array(ResourceClaimSchema).max(64),
  })
  .strict();
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const DelegationRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: safeId(),
    parentSessionId: safeId(),
    task: z.string().min(1).max(32_000),
    target: z
      .object({
        providerId: safeId(),
        model: z.string().min(1).max(256),
        dialectPack: safeId().optional(),
      })
      .strict(),
    budget: z
      .object({
        maxSteps: z.number().int().positive().max(100),
        deadlineAt: z.iso.datetime(),
      })
      .strict(),
    baseSha: GitShaSchema,
    authorityDigest: Sha256DigestSchema,
  })
  .strict();
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;

export const TaskContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    requirements: z.array(z.string().min(1).max(2_000)).min(1).max(128),
    constraints: z.array(z.string().min(1).max(2_000)).max(128).default([]),
    verificationCommands: z
      .array(z.array(z.string().min(1).max(1_024)).min(1).max(64))
      .max(32)
      .default([]),
  })
  .strict();
export type TaskContract = z.infer<typeof TaskContractSchema>;

export const CandidateLifecycleSchema = z.enum([
  "prepared",
  "verified",
  "approved",
  "stale",
  "rejected",
  "applied",
  "expired",
]);

export const CandidateRefSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidateId: safeId(),
    taskSnapshot: TaskSnapshotRefSchema,
    authorAttemptId: safeId(),
    authorSessionId: safeId(),
    reviewerSessionId: safeId(),
    diffDigest: Sha256DigestSchema,
    touchedPaths: z.array(z.string().min(1).max(4096)).max(4096),
    verifierReports: z.array(ArtifactRefSchema).max(64),
    lifecycle: CandidateLifecycleSchema,
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if (candidate.authorSessionId === candidate.reviewerSessionId) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewerSessionId"],
        message: "reviewer session must differ from author session",
      });
    }
    if (new Set(candidate.touchedPaths).size !== candidate.touchedPaths.length) {
      ctx.addIssue({ code: "custom", path: ["touchedPaths"], message: "touched paths must be unique" });
    }
  });
export type CandidateRef = z.infer<typeof CandidateRefSchema>;

export const ApprovalGrantSchema = z
  .object({
    schemaVersion: z.literal(1),
    grantId: safeId(),
    token: z.string().min(32).max(512),
    candidateId: safeId(),
    destinationProjectDigest: Sha256DigestSchema,
    baseSha: GitShaSchema,
    diffDigest: Sha256DigestSchema,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type ApprovalGrant = z.infer<typeof ApprovalGrantSchema>;
