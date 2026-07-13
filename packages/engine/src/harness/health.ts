import type { StageVerdict } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { readRuns, type RunRecord } from "../runs/ledger.js";
import { getProjectHeadSha } from "../verification/project.js";
import { verifyWiki } from "../wiki/verify.js";
import { harnessStatus, loadHarness } from "./store.js";
import { validateHarness } from "./schema.js";

const OPERATIONAL_SAMPLE_SIZE = 5;
const DEGRADED_TASK_FAILURE_FRACTION = 0.4;
const RECENT_RUN_LIMIT = 50;

export type HarnessHealthVerdict = "healthy" | "degraded" | "insufficient-evidence" | "failed";
export type HarnessFreshness = "current" | "stale" | "unknown";
export type OperationalHealthVerdict = "healthy" | "degraded" | "insufficient-evidence";

export interface HarnessHealthIssue {
  code: string;
  severity: "error" | "warning" | "info";
}

export interface HarnessOperationalEvidence {
  status: OperationalHealthVerdict;
  sampleSize: number;
  successfulRuns: number;
  failedRuns: number;
  errorRuns: number;
  cancelledRuns: number;
  escalatedRuns: number;
  reviewRequestChanges: number;
  toolErrors: number;
  applySucceeded: number;
  applyFailed: number;
  lastRunAt: string | null;
}

export interface HarnessHealthReport {
  checkedAt: string;
  overall: HarnessHealthVerdict;
  harness: {
    present: boolean;
    structural: "passed" | "failed" | "not-run";
    freshness: HarnessFreshness;
    card: "draft" | "approved" | "missing";
  };
  wiki: {
    operational: "passed" | "failed" | "inconclusive" | "not-run";
    index: StageVerdict | "not-run";
    retrieval: StageVerdict | "not-run";
    delivery: StageVerdict | "not-run";
  };
  operational: HarnessOperationalEvidence;
  issues: HarnessHealthIssue[];
}

function isOrchestrateRecord(record: RunRecord): record is Extract<RunRecord, { kind: "orchestrate" }> {
  return record.kind === "orchestrate";
}

function isApplyRecord(record: RunRecord): record is Extract<RunRecord, { kind: "apply" }> {
  return record.kind === "apply";
}

export function summarizeOperationalHealth(records: readonly RunRecord[]): {
  evidence: HarnessOperationalEvidence;
  issues: HarnessHealthIssue[];
} {
  const orchestrateRecords = records.filter(isOrchestrateRecord);
  const applyRecords = records.filter(isApplyRecord);
  const cancelledRuns = orchestrateRecords.filter((record) => record.errorCategory === "cancelled").length;
  const observedRuns = orchestrateRecords.filter((record) => record.errorCategory !== "cancelled");
  const successfulRuns = observedRuns.filter(
    (record) => record.outcome === "worker-approved" || record.outcome === "escalated",
  ).length;
  const failedRuns = observedRuns.filter((record) => record.outcome === "failed").length;
  const errorRuns = observedRuns.filter((record) => record.outcome === "error").length;
  const escalatedRuns = observedRuns.filter((record) => record.escalated).length;
  const reviewRequestChanges = observedRuns.reduce(
    (total, record) => total + record.reviews.filter((review) => review.decision === "request-changes").length,
    0,
  );
  const toolErrors = observedRuns.reduce(
    (total, record) => total + Object.values(record.toolErrorCounts ?? {}).reduce((sum, count) => sum + count, 0),
    0,
  );
  const applySucceeded = applyRecords.filter((record) => record.outcome === "succeeded").length;
  const applyFailed = applyRecords.filter((record) => record.outcome === "failed").length;
  const sampleSize = observedRuns.length;
  const failureFraction = sampleSize === 0 ? 0 : failedRuns / sampleSize;

  let status: OperationalHealthVerdict;
  if (errorRuns > 0 || applyFailed > 0) {
    status = "degraded";
  } else if (sampleSize < OPERATIONAL_SAMPLE_SIZE) {
    status = "insufficient-evidence";
  } else if (failureFraction >= DEGRADED_TASK_FAILURE_FRACTION) {
    status = "degraded";
  } else {
    status = "healthy";
  }

  const issues: HarnessHealthIssue[] = [];
  if (errorRuns > 0) issues.push({ code: "runtime-errors-observed", severity: "error" });
  if (applyFailed > 0) issues.push({ code: "apply-failures-observed", severity: "error" });
  if (sampleSize >= OPERATIONAL_SAMPLE_SIZE && failureFraction >= DEGRADED_TASK_FAILURE_FRACTION) {
    issues.push({ code: "high-task-failure-rate", severity: "warning" });
  }
  if (toolErrors > 0) issues.push({ code: "tool-errors-observed", severity: "warning" });
  if (sampleSize < OPERATIONAL_SAMPLE_SIZE) {
    issues.push({ code: "insufficient-production-evidence", severity: "info" });
  }

  return {
    evidence: {
      status,
      sampleSize,
      successfulRuns,
      failedRuns,
      errorRuns,
      cancelledRuns,
      escalatedRuns,
      reviewRequestChanges,
      toolErrors,
      applySucceeded,
      applyFailed,
      lastRunAt: records[0]?.at ?? null,
    },
    issues,
  };
}

export async function evaluateHarnessHealth(engine: Engine, projectDir: string): Promise<HarnessHealthReport> {
  const issues: HarnessHealthIssue[] = [];
  const currentSha = getProjectHeadSha(projectDir);
  let status;
  try {
    status = harnessStatus(projectDir);
  } catch {
    status = { present: true, structural: "fail" as const, headSha: null, card: null };
  }

  let structural: HarnessHealthReport["harness"]["structural"] = "not-run";
  if (!status.present) {
    issues.push({ code: "harness-missing", severity: "error" });
  } else {
    try {
      const bundle = loadHarness(projectDir);
      structural = bundle !== null && validateHarness(bundle).length === 0 ? "passed" : "failed";
    } catch {
      structural = "failed";
    }
    if (structural === "failed") {
      issues.push({ code: "harness-structural-invalid", severity: "error" });
    }
  }

  const freshness: HarnessFreshness =
    status.headSha === null ? "unknown" : status.headSha === currentSha ? "current" : "stale";
  if (freshness === "stale") issues.push({ code: "harness-stale", severity: "error" });

  let wiki: HarnessHealthReport["wiki"] = {
    operational: "not-run",
    index: "not-run",
    retrieval: "not-run",
    delivery: "not-run",
  };
  if (status.present && structural === "passed") {
    try {
      const result = await verifyWiki(engine, projectDir);
      wiki = {
        operational: result.operational,
        index: result.stages.index.verdict,
        retrieval: result.stages.retrieval.verdict,
        delivery: result.stages.delivery.verdict,
      };
      if (result.stages.index.verdict === "failed") {
        issues.push({ code: "wiki-index-failed", severity: "error" });
      }
      if (result.stages.retrieval.verdict !== "passed") {
        issues.push({ code: "wiki-retrieval-unavailable", severity: "warning" });
      }
      if (result.stages.delivery.verdict !== "passed") {
        issues.push({ code: "wiki-delivery-unavailable", severity: "warning" });
      }
    } catch {
      wiki = { operational: "failed", index: "failed", retrieval: "not-run", delivery: "not-run" };
      issues.push({ code: "wiki-verification-error", severity: "error" });
    }
  }

  const recent = readRuns(projectDir, { limit: 200 }).records
    .filter((record) => record.kind === "orchestrate" || record.kind === "apply")
    .slice(0, RECENT_RUN_LIMIT);
  const operational = summarizeOperationalHealth(recent);
  issues.push(...operational.issues);

  let overall: HarnessHealthVerdict;
  if (!status.present || structural === "failed") {
    overall = "failed";
  } else if (freshness === "stale" || wiki.operational === "failed" || operational.evidence.status === "degraded") {
    overall = "degraded";
  } else if (wiki.operational !== "passed" || operational.evidence.status === "insufficient-evidence") {
    overall = "insufficient-evidence";
  } else {
    overall = "healthy";
  }

  return {
    checkedAt: new Date().toISOString(),
    overall,
    harness: {
      present: status.present,
      structural,
      freshness,
      card: status.card ?? "missing",
    },
    wiki,
    operational: operational.evidence,
    issues,
  };
}
