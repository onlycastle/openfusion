import {
  StageReportSchema,
  computeStageVerdict,
  type StageReport,
} from "@openfusion/shared";
import {
  STAGE_REGISTRY,
  isRegisteredReasonCode,
  isRegisteredStageMessage,
  stageMessageId,
  type RegisteredStagePolicy,
} from "../harness/registry.js";

export type StagePolicy = RegisteredStagePolicy;
export const STAGE_POLICIES: readonly StagePolicy[] = STAGE_REGISTRY;

const policyById = new Map(STAGE_POLICIES.map((policy) => [policy.id, policy]));

export function getStagePolicy(stageId: string): StagePolicy | undefined {
  return policyById.get(stageId);
}

/**
 * Fill omitted policy checks as required/inconclusive and recompute the
 * verdict. This makes policy drift fail closed: adding a required check to a
 * policy cannot let an older caller continue emitting a passing report that
 * silently lacks the new evidence.
 */
export function enforceStagePolicy(report: StageReport): StageReport {
  const policy = getStagePolicy(report.stageId);
  if (policy === undefined) throw new Error(`unknown stage policy: ${report.stageId}`);

  const byId = new Map(report.checks.map((check) => [check.id, check]));
  const checks = [...report.checks];
  for (const id of policy.requiredCheckIds) {
    const existing = byId.get(id);
    if (existing === undefined) {
      checks.push(report.schemaVersion === 1
        ? {
            id,
            required: true,
            status: "inconclusive" as const,
            summary: "Required check evidence was not produced.",
            evidence: { reasonCode: "missing-required-check" },
          }
        : {
            id,
            required: true,
            status: "inconclusive" as const,
            messageId: stageMessageId(id, "inconclusive"),
            evidence: { reasonCode: "missing-required-check" },
          });
      continue;
    }
    if (!existing.required) {
      const index = checks.findIndex((check) => check.id === id);
      checks[index] = { ...existing, required: true };
    }
  }

  if (report.schemaVersion === 2) {
    for (const check of checks) {
      if (!("messageId" in check) || !isRegisteredStageMessage(check.messageId)) {
        throw new Error(`unknown stage message id: ${"messageId" in check ? check.messageId : "missing"}`);
      }
      const reasonCode = check.evidence?.reasonCode;
      if (reasonCode !== undefined && !isRegisteredReasonCode(reasonCode)) {
        throw new Error(`unknown stage reason code: ${reasonCode}`);
      }
    }
  }

  return StageReportSchema.parse({
    ...report,
    policyVersion: policy.version,
    checks,
    verdict: computeStageVerdict(checks, report.execution),
  });
}
