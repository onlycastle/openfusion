// Pure M6.1 two-dimensional cost/quality verdict math.
//
// Extracted from runEvals so the same definition can score (a) repo-tests
// oracle rows and (b) SWE-bench official-resolved-status rows. Benchmark
// computation is side-effect free with respect to project harness state.
//
// CRITICAL: unpricedCalls is a required input. Omitting it reopens the C1
// mixed-priced false-pass path (addCost null-skips undercount one arm).

import type { PricingConfidence } from "../models/meter.js";

// Types live in run.ts (public eval surface). Type-only import — no runtime
// cycle when run.ts imports computeEvalsVerdict from this module.
import type {
  BaselineTaskOutcome,
  EvalsHarnessConfig,
  EvalsReportCard,
  HarnessTaskOutcome,
  PerTaskResult,
} from "./run.js";

// Anthropic eval guidance / research 2026-07-07: low floor for hazard flags;
// higher floor for a savings PASS claim.
export const MIN_TASK_COUNT_FOR_VERDICT = 5;
export const MIN_TASK_COUNT_FOR_SAVINGS_PASS = 20;
export const MATERIAL_MEASUREMENT_FAILURE_FRACTION = 0.2;
export const QUALITY_NOISE_BAND = 0.05;
export const COST_REGRESSION_FAIL_FRACTION = 0.1;

export function addCost(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}

export function isHarnessMeasurementFailure(outcome: HarnessTaskOutcome): boolean {
  return outcome === "apply-failed" || outcome === "error";
}

export function isBaselineMeasurementFailure(outcome: BaselineTaskOutcome): boolean {
  return outcome === "error";
}

export function isMeasurementFailure(row: PerTaskResult): boolean {
  return isHarnessMeasurementFailure(row.harnessOutcome) || isBaselineMeasurementFailure(row.baselineOutcome);
}

export interface ComputeEvalsVerdictParams {
  perTask: PerTaskResult[];
  /** Run-scoped unpriced model-call count (CostMeter.totals slice). Required. */
  unpricedCalls: number;
  pricingConfidence: PricingConfidence;
  escalations: number;
  sampleNote?: string;
  /** Extra note fragments prepended after sample-size / pricing boilerplate. */
  extraNotes?: string[];
  /** Phase 1: published model+harness configuration pins. */
  harnessConfig?: EvalsHarnessConfig;
}

export type ComputeEvalsVerdictResult = Omit<EvalsReportCard, never>;

export function buildEvalsNote(opts: {
  taskCount: number;
  pricingConfidence: PricingConfidence;
  sampleNote?: string;
  extraNotes?: string[];
}): string {
  const parts: string[] = [];
  parts.push(
    opts.taskCount < MIN_TASK_COUNT_FOR_SAVINGS_PASS
      ? `Sample size ${opts.taskCount} task(s) is below the ${MIN_TASK_COUNT_FOR_SAVINGS_PASS}-task floor for a credible savings claim (docs/research/2026-07-07-harness-composition.md §4.2) -- a hazard flag can still fire, but a savings PASS cannot. This is a demo, not a claim.`
      : `Sample size: ${opts.taskCount} task(s) (a credible claim wants 20-50 paired tasks; treat this as directional).`,
  );
  parts.push(
    "Cost figures are estimate-class (see engine.orchestrate's own cost.note) -- directional, not exact.",
  );
  parts.push(
    `Pricing confidence: ${opts.pricingConfidence} (the worst confidence across every cost record this run produced).`,
  );
  for (const note of opts.extraNotes ?? []) {
    parts.push(note);
  }
  parts.push(
    "Repository commands and evaluator-owned oracles run under the fail-closed eval-v1 sandbox with network " +
      "disabled. A missing or failed sandbox probe prevents the benchmark from starting.",
  );
  if (opts.sampleNote !== undefined && opts.sampleNote.length > 0) {
    parts.push(opts.sampleNote);
  }
  return parts.join(" ");
}

/**
 * Pure M6.1 verdict computation. Identical branching to the pre-extraction
 * runEvals body — including the unpricedCalls false-pass gate.
 */
export function computeEvalsVerdict(params: ComputeEvalsVerdictParams): EvalsReportCard {
  const { perTask, unpricedCalls, pricingConfidence, escalations } = params;
  const taskCount = perTask.length;

  let baselinePassed = 0;
  let harnessPassed = 0;
  let baselineCostTotal: number | null = null;
  let harnessCostTotal: number | null = null;
  for (const t of perTask) {
    if (t.baselinePassed) baselinePassed += 1;
    if (t.harnessPassed) harnessPassed += 1;
    baselineCostTotal = addCost(baselineCostTotal, t.baselineUsd);
    harnessCostTotal = addCost(harnessCostTotal, t.harnessUsd);
  }

  const savingsPct =
    baselineCostTotal !== null && harnessCostTotal !== null && baselineCostTotal > 0
      ? (baselineCostTotal - harnessCostTotal) / baselineCostTotal
      : null;
  const qualityHeld = harnessPassed >= baselinePassed;

  const measurementFailureIds = new Set(perTask.filter(isMeasurementFailure).map((t) => t.id));
  const policyViolationIds = new Set(perTask
    .filter((task) => task.baselinePolicyViolation === true || task.harnessPolicyViolation === true)
    .map((task) => task.id));
  const harnessApplyFailedCount = perTask.filter((t) => t.harnessOutcome === "apply-failed").length;
  const harnessErrorCount = perTask.filter((t) => t.harnessOutcome === "error").length;
  const baselineErrorCount = perTask.filter((t) => t.baselineOutcome === "error").length;
  const measurementFailureCount = measurementFailureIds.size;
  const policyViolationCount = policyViolationIds.size;

  const extraNotes: string[] = [...(params.extraNotes ?? [])];
  if (measurementFailureCount > 0) {
    extraNotes.push(
      `${measurementFailureCount} of ${taskCount} task(s) hit a measurement failure rather than a genuine, ` +
        `oracle-scoreable quality result (harness: ${harnessApplyFailedCount} apply-failed, ${harnessErrorCount} ` +
        `error; baseline: ${baselineErrorCount} error) -- see the verdict note below for exactly how this run's ` +
        `pass/fail/inconclusive determination accounts for them.`,
    );
  }
  if (policyViolationCount > 0) {
    extraNotes.push(
      `${policyViolationCount} of ${taskCount} task(s) violated eval-v1 policy. ` +
        "Those rows are excluded from quality evidence and trigger the independent safety veto.",
    );
  }

  const cleanTasks = perTask.filter((t) =>
    !measurementFailureIds.has(t.id) && !policyViolationIds.has(t.id));
  const cleanBaselinePassed = cleanTasks.filter((t) => t.baselinePassed).length;
  const cleanHarnessPassed = cleanTasks.filter((t) => t.harnessPassed).length;
  const qualityHeldClean = cleanHarnessPassed >= cleanBaselinePassed;
  const measurementFailureFractionIsMaterial =
    taskCount > 0 && measurementFailureCount / taskCount >= MATERIAL_MEASUREMENT_FAILURE_FRACTION;

  let cleanBaselineCostTotal: number | null = null;
  let cleanHarnessCostTotal: number | null = null;
  for (const t of cleanTasks) {
    cleanBaselineCostTotal = addCost(cleanBaselineCostTotal, t.baselineUsd);
    cleanHarnessCostTotal = addCost(cleanHarnessCostTotal, t.harnessUsd);
  }
  const cleanSavingsPct =
    cleanBaselineCostTotal !== null && cleanHarnessCostTotal !== null && cleanBaselineCostTotal > 0
      ? (cleanBaselineCostTotal - cleanHarnessCostTotal) / cleanBaselineCostTotal
      : null;

  const cleanQualityGap = cleanBaselinePassed - cleanHarnessPassed;
  const qualityGapWithinNoise =
    cleanTasks.length === 0 || cleanQualityGap / cleanTasks.length <= QUALITY_NOISE_BAND;
  if (!qualityHeldClean && qualityGapWithinNoise) {
    extraNotes.push(
      `The harness scored below baseline on the clean subset, but the gap ` +
        `(${cleanBaselinePassed - cleanHarnessPassed}/${cleanTasks.length}) is within the ` +
        `${Math.round(QUALITY_NOISE_BAND * 100)}% single-run noise band -- treated as quality held, not an ETH hazard.`,
    );
  }

  let verdict: EvalsReportCard["verdict"];
  if (policyViolationCount > 0) {
    verdict = "fail";
  } else if (measurementFailureFractionIsMaterial) {
    verdict = "inconclusive";
    extraNotes.push(
      `${measurementFailureCount} of ${taskCount} task(s) (>= the ` +
        `${Math.round(MATERIAL_MEASUREMENT_FAILURE_FRACTION * 100)}% materiality threshold) hit a measurement ` +
        "failure -- this run is too corrupted to ground a \"pass\" or a \"fail\" verdict in either direction; " +
        "reported as inconclusive rather than trusting the raw pass counts.",
    );
  } else if (!qualityHeldClean && !qualityGapWithinNoise) {
    verdict = "fail";
    if (measurementFailureCount > 0) {
      extraNotes.push(
        "The quality gap above survives excluding every measurement failure -- the harness genuinely produced " +
          "worse fixes on the clean subset of tasks. Reported as an ETH-hazard fail.",
      );
    }
  } else if (cleanBaselinePassed === 0) {
    verdict = "inconclusive";
    extraNotes.push(
      measurementFailureCount > 0
        ? "The baseline solved 0 of the clean (non-measurement-failed) tasks in this run -- there is nothing to " +
            "measure quality against."
        : "The baseline solved 0 of the tasks in this run -- there is nothing to measure quality against.",
    );
  } else if (unpricedCalls > 0) {
    // C1 mixed-priced false-pass gate — required; see module header.
    verdict = "inconclusive";
    extraNotes.push(
      `${unpricedCalls} model call(s) were unpriced -- savings cannot be computed; run with priced models for ` +
        "a savings claim.",
    );
  } else if (
    (qualityHeldClean || qualityGapWithinNoise) &&
    cleanSavingsPct !== null &&
    cleanSavingsPct <= -COST_REGRESSION_FAIL_FRACTION &&
    taskCount >= MIN_TASK_COUNT_FOR_VERDICT
  ) {
    verdict = "fail";
    extraNotes.push(
      `The harness held quality but cost ${Math.round(-cleanSavingsPct * 100)}% MORE than the no-harness ` +
        `baseline on the clean subset (>= the ${Math.round(COST_REGRESSION_FAIL_FRACTION * 100)}% cost-regression ` +
        `threshold) -- reported as an ETH cost-hazard fail.`,
    );
  } else if (taskCount < MIN_TASK_COUNT_FOR_SAVINGS_PASS || cleanSavingsPct === null) {
    verdict = "inconclusive";
  } else if (cleanSavingsPct > 0) {
    verdict = "pass";
  } else {
    verdict = "inconclusive";
  }

  return {
    taskCount,
    baseline: { passed: baselinePassed, costUsd: baselineCostTotal },
    harness: { passed: harnessPassed, costUsd: harnessCostTotal, escalations },
    savingsPct,
    qualityHeld,
    verdict,
    pricingConfidence,
    perTask,
    note: buildEvalsNote({
      taskCount,
      pricingConfidence,
      sampleNote: params.sampleNote,
      extraNotes,
    }),
    cleanTaskCount: cleanTasks.length,
    cleanBaselinePassed,
    cleanHarnessPassed,
    cleanSavingsPct,
    measurementFailureCount,
    policyViolationCount,
    qualityGapWithinNoise,
    ...(params.harnessConfig !== undefined ? { harnessConfig: params.harnessConfig } : {}),
  };
}
