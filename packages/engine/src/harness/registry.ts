import type { CheckStatus } from "@openfusion/shared";
import { REVIEW_POLICY_VERSION, REVIEW_PROMPT_TEMPLATE } from "../orchestrate/review-policy.js";
import { TOOL_REGISTRY_FINGERPRINT, listToolSpecs } from "../tools/registry.js";

export interface RegisteredStagePolicy {
  id: string;
  version: number;
  requiredCheckIds: readonly string[];
}

const stages = [
  { id: "setup.project", version: 2, requiredCheckIds: ["project.git-repository", "project.head-resolved", "project.snapshot-stable", "project.scope-allowed"] },
  { id: "setup.providers", version: 2, requiredCheckIds: ["providers.model-resolved", "providers.completion-roundtrip", "providers.frontier-roles-resolved"] },
  { id: "setup.wiki.index", version: 2, requiredCheckIds: ["wiki.db-present", "wiki.db-integrity", "wiki.head-current", "wiki.source-current", "wiki.coverage-complete"] },
  { id: "setup.wiki.retrieval", version: 2, requiredCheckIds: ["wiki.query-canaries", "wiki.map-canary"] },
  { id: "setup.wiki.delivery", version: 2, requiredCheckIds: ["wiki.mcp-started", "wiki.mcp-tools-listed", "wiki.mcp-roundtrip"] },
  { id: "setup.harness.overview", version: 2, requiredCheckIds: ["harness.overview-schema", "harness.overview-grounded", "harness.overview-coverage"] },
  { id: "setup.harness.pages", version: 2, requiredCheckIds: ["harness.pages-schema", "harness.pages-grounded", "harness.pages-consistent"] },
  { id: "setup.harness.card", version: 2, requiredCheckIds: ["harness.card-schema", "harness.card-commands-grounded", "harness.card-anchors-grounded"] },
  { id: "setup.harness.agents", version: 2, requiredCheckIds: ["harness.agents-schema", "harness.agents-task-coverage", "harness.agents-models-resolved"] },
  { id: "setup.harness.routing", version: 2, requiredCheckIds: ["harness.routing-references", "harness.routing-reachability", "harness.routing-probes"] },
  { id: "setup.harness.persistence", version: 2, requiredCheckIds: ["harness.atomic-write", "harness.reload-equality", "harness.fingerprint-current"] },
  { id: "setup.ready", version: 2, requiredCheckIds: ["ready.project", "ready.providers", "ready.wiki", "ready.harness", "ready.routing", "ready.verification-policy"] },
  { id: "task.contract", version: 2, requiredCheckIds: ["task.requirements-preserved", "task.constraints-preserved", "task.ambiguity-non-material"] },
  { id: "task.route", version: 2, requiredCheckIds: ["route.agent-resolved", "route.model-resolved", "route.policy-current"] },
  { id: "task.context", version: 2, requiredCheckIds: ["context.approved", "context.current", "context.within-budget"] },
  { id: "task.worktree", version: 2, requiredCheckIds: ["worktree.base-current", "worktree.isolated", "worktree.initially-empty", "worktree.contained"] },
  { id: "task.worker", version: 2, requiredCheckIds: ["worker.terminated-normally", "worker.within-step-budget", "worker.no-fatal-tool-error"] },
  { id: "task.diff", version: 2, requiredCheckIds: ["diff.non-empty", "diff.valid", "diff.complete", "diff.paths-allowed"] },
  { id: "task.verify", version: 2, requiredCheckIds: ["verify.profile-approved", "verify.required-commands", "verify.no-policy-violation"] },
  { id: "task.coverage", version: 2, requiredCheckIds: ["coverage.requirements-evidenced"] },
  { id: "task.review", version: 2, requiredCheckIds: ["review.rubric-complete", "review.machine-checks-honored", "review.approved"] },
  { id: "task.retry", version: 2, requiredCheckIds: ["retry.feedback-attached", "retry.fresh-base"] },
  { id: "task.escalate", version: 2, requiredCheckIds: ["escalate.candidate-produced", "escalate.verified", "escalate.independently-reviewed"] },
  { id: "task.candidate", version: 2, requiredCheckIds: ["candidate.task-covered", "candidate.verified", "candidate.approved", "candidate.current"] },
  { id: "apply.preflight", version: 2, requiredCheckIds: ["apply.project-matched", "apply.base-current", "apply.artifact-matched", "apply.git-preflight"] },
  { id: "apply.write", version: 2, requiredCheckIds: ["apply.user-approved", "apply.git-succeeded", "apply.no-conflicts"] },
  { id: "eval.task", version: 2, requiredCheckIds: ["eval.task-parent-fails", "eval.task-golden-passes", "eval.task-isolated"] },
  { id: "eval.isolation", version: 2, requiredCheckIds: ["eval.arms-identical", "eval.oracle-identical", "eval.no-cross-arm-leak"] },
  { id: "eval.oracle", version: 2, requiredCheckIds: ["eval.oracle-executed", "eval.oracle-classified"] },
  { id: "eval.verdict", version: 2, requiredCheckIds: ["eval.measurement-quality", "eval.sample-gate", "eval.quality-gate", "eval.cost-gate"] },
] as const satisfies readonly RegisteredStagePolicy[];

export const STAGE_REGISTRY: readonly RegisteredStagePolicy[] = stages;

export const VERIFICATION_REASON_CODES = [
  "aborted",
  "backend-unsupported",
  "base-changed",
  "candidate-expired",
  "candidate-stale",
  "command-failed",
  "db-open-failed",
  "dirty-path-overlap",
  "diff-empty",
  "diff-invalid",
  "diff-policy-violation",
  "grant-expired",
  "grant-invalid",
  "grant-reused",
  "head-changed",
  "mcp-roundtrip-mismatch",
  "mcp-tools-missing",
  "mcp-unavailable",
  "missing-required-check",
  "path-unreadable",
  "prerequisite-not-passed",
  "project-unavailable",
  "review-rejected",
  "reviewer-not-independent",
  "snapshot-unavailable",
  "verification-unavailable",
  "wiki-coverage-incomplete",
  "wiki-db-missing",
  "wiki-head-mismatch",
  "wiki-index-not-ready",
  "wiki-index-unavailable",
  "wiki-map-failed",
  "wiki-query-failed",
  "wiki-retrieval-not-ready",
  "wiki-source-mismatch",
] as const;

const stageCheckIds = new Set(STAGE_REGISTRY.flatMap((stage) => stage.requiredCheckIds));
const reasonCodes = new Set<string>(VERIFICATION_REASON_CODES);

export function stageMessageId(checkId: string, status: CheckStatus): string {
  return `${checkId}.${status}`;
}

export function isRegisteredStageMessage(messageId: string): boolean {
  const split = messageId.lastIndexOf(".");
  if (split < 1) return false;
  const checkId = messageId.slice(0, split);
  const status = messageId.slice(split + 1);
  return stageCheckIds.has(checkId) && ["passed", "failed", "skipped", "inconclusive"].includes(status);
}

export function isRegisteredReasonCode(reasonCode: string): boolean {
  return reasonCodes.has(reasonCode);
}

export const HARNESS_COMPONENT_IDS = [
  "harness.source",
  "context.project-card",
  "models.roster",
  "models.family-catalog",
  "tools.dialect-pack-catalog",
  "tools.registry",
  "routing.policy",
  "retry.policy",
  "review.policy",
] as const;

export const HARNESS_REGISTRY = Object.freeze({
  version: "1",
  stages: STAGE_REGISTRY,
  tools: listToolSpecs().map((tool) => ({ id: tool.id, version: tool.version })),
  toolRegistryDigest: TOOL_REGISTRY_FINGERPRINT.digest,
  protectedPrompts: [
    { id: "review.candidate", version: REVIEW_POLICY_VERSION, content: REVIEW_PROMPT_TEMPLATE },
  ],
  components: HARNESS_COMPONENT_IDS,
  policies: {
    retry: "1",
    review: REVIEW_POLICY_VERSION,
    sandbox: "macos-v1",
    tools: "tool-gateway-v1",
    candidate: "1",
    apply: "1",
  },
});
