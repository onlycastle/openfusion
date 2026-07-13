import { z } from "zod";

export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export const safeId = () =>
  z.string().min(1).max(128).regex(SAFE_ID_RE, "must be a safe metadata identifier");

export const Sha256DigestSchema = z
  .string()
  .regex(SHA256_DIGEST_RE, "must be a sha256 digest");

export const CheckStatusSchema = z.enum([
  "passed",
  "failed",
  "skipped",
  "inconclusive",
]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const StageExecutionSchema = z.enum(["completed", "failed", "cancelled"]);
export type StageExecution = z.infer<typeof StageExecutionSchema>;

export const StageVerdictSchema = z.enum([
  "passed",
  "failed",
  "inconclusive",
  "cancelled",
]);
export type StageVerdict = z.infer<typeof StageVerdictSchema>;

export const ArtifactRefSchema = z
  .object({
    id: safeId(),
    digest: Sha256DigestSchema,
  })
  .strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const CheckEvidenceSchema = z
  .object({
    artifactId: safeId().optional(),
    artifactDigest: Sha256DigestSchema.optional(),
    verifierId: safeId().optional(),
    exitCode: z.number().int().min(-1).max(255).optional(),
    durationMs: z.number().int().min(0).optional(),
    count: z.number().int().min(0).optional(),
    expectedCount: z.number().int().min(0).optional(),
    reasonCode: safeId().optional(),
  })
  .strict();
export type CheckEvidence = z.infer<typeof CheckEvidenceSchema>;

export const CheckResultV1Schema = z
  .object({
    id: safeId(),
    required: z.boolean(),
    status: CheckStatusSchema,
    summary: z.string().min(1).max(240),
    evidence: CheckEvidenceSchema.optional(),
  })
  .strict();
export type CheckResultV1 = z.infer<typeof CheckResultV1Schema>;

export const CheckResultV2Schema = z
  .object({
    id: safeId(),
    required: z.boolean(),
    status: CheckStatusSchema,
    messageId: safeId(),
    evidence: CheckEvidenceSchema.optional(),
  })
  .strict()
  .superRefine((check, ctx) => {
    if (check.status !== "passed" && check.evidence?.reasonCode === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence", "reasonCode"],
        message: "non-passing v2 checks require a catalogued reasonCode",
      });
    }
  });
export type CheckResultV2 = z.infer<typeof CheckResultV2Schema>;

export const CheckResultSchema = z.union([CheckResultV1Schema, CheckResultV2Schema]);
export type CheckResult = z.infer<typeof CheckResultSchema>;

/**
 * Derive a stage verdict from execution plus its declared checks. Advisory
 * failures remain visible but do not fail the stage. A required check must
 * explicitly pass; skipped, missing (when a policy fills it), and
 * inconclusive required evidence all produce an inconclusive stage.
 */
export function computeStageVerdict(
  checks: readonly CheckResult[],
  execution: StageExecution,
): StageVerdict {
  if (execution === "cancelled") return "cancelled";
  if (execution === "failed") return "failed";

  const required = checks.filter((check) => check.required);
  if (required.some((check) => check.status === "failed")) return "failed";
  if (required.some((check) => check.status !== "passed")) return "inconclusive";
  return "passed";
}

const StageReportV1BaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    stageId: safeId(),
    policyVersion: z.number().int().min(1),
    attempt: z.number().int().min(1),
    inputRef: ArtifactRefSchema,
    outputRef: ArtifactRefSchema.optional(),
    execution: StageExecutionSchema,
    verdict: StageVerdictSchema,
    checks: z.array(CheckResultV1Schema),
    startedAt: z.iso.datetime(),
    durationMs: z.number().int().min(0),
  })
  .strict();

function validateStageReport(
  report: {
    checks: readonly CheckResult[];
    execution: StageExecution;
    verdict: StageVerdict;
  },
  ctx: z.RefinementCtx,
): void {
  const ids = report.checks.map((check) => check.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: "custom",
      path: ["checks"],
      message: "check IDs must be unique within a stage report",
    });
  }

  const expected = computeStageVerdict(report.checks, report.execution);
  if (report.verdict !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["verdict"],
      message: `verdict must be derived from execution and required checks (${expected})`,
    });
  }
}

export const StageReportV1Schema = StageReportV1BaseSchema.superRefine(validateStageReport);
export type StageReportV1 = z.infer<typeof StageReportV1Schema>;

const StageReportV2BaseSchema = z
  .object({
    schemaVersion: z.literal(2),
    stageId: safeId(),
    policyVersion: z.number().int().min(1),
    attempt: z.number().int().min(1),
    inputRef: ArtifactRefSchema,
    outputRef: ArtifactRefSchema.optional(),
    execution: StageExecutionSchema,
    verdict: StageVerdictSchema,
    checks: z.array(CheckResultV2Schema),
    startedAt: z.iso.datetime(),
    durationMs: z.number().int().min(0),
  })
  .strict();

export const StageReportV2Schema = StageReportV2BaseSchema.superRefine(validateStageReport);
export type StageReportV2 = z.infer<typeof StageReportV2Schema>;

/** New writers emit v2. Readers accept both versions during migration. */
export const StageReportSchema = z.union([StageReportV1Schema, StageReportV2Schema]);
export type StageReport = z.infer<typeof StageReportSchema>;
