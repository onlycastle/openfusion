// Combine scored resolved flags + metered rows into M6.1 verdict + markdown.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { PricingConfidence } from "../../models/meter.js";
import { computeEvalsVerdict } from "../verdict.js";
import type { BenchInstanceRow } from "./runner.js";
import { rowsToPerTask } from "./runner.js";
import type { ScoreResult } from "./score.js";

export interface BenchReportInput {
  runId: string;
  rows: BenchInstanceRow[];
  baselineScore: ScoreResult;
  harnessScore: ScoreResult;
  unpricedCalls: number;
  pricingConfidence: PricingConfidence;
  escalations: number;
  datasetSnapshotHash: string;
  environment?: Record<string, string>;
  sampleNote?: string;
}

export interface BenchReport {
  runId: string;
  instanceCount: number;
  baselineResolvedRate: number;
  harnessResolvedRate: number;
  baselineResolvedCount: number;
  harnessResolvedCount: number;
  verdict: ReturnType<typeof computeEvalsVerdict>;
  caveats: string[];
  jsonPath?: string;
  mdPath?: string;
}

const DEFAULT_CAVEATS = [
  "Absolute resolved rates are directional only (plain local checkouts, not container-native scaffolds); do not claim HAL parity.",
  "SWE-bench Verified Mini is 50 instances across 2 repos (django, sphinx), not full Verified's 12-repo mix.",
  "Per-repo harness generation may be stale on old base commits.",
  "v1 prompts use problem_statement only (no hints_text).",
  "Resolved-rate denominator is N (this run), never 500.",
];

export function buildBenchReport(input: BenchReportInput): BenchReport {
  const resolved = new Map<string, { baseline: boolean; harness: boolean }>();
  for (const r of input.baselineScore.resolved) {
    const cur = resolved.get(r.instance_id) ?? { baseline: false, harness: false };
    cur.baseline = r.resolved;
    resolved.set(r.instance_id, cur);
  }
  for (const r of input.harnessScore.resolved) {
    const cur = resolved.get(r.instance_id) ?? { baseline: false, harness: false };
    cur.harness = r.resolved;
    resolved.set(r.instance_id, cur);
  }

  const perTask = rowsToPerTask(input.rows, resolved);
  const verdict = computeEvalsVerdict({
    perTask,
    unpricedCalls: input.unpricedCalls,
    pricingConfidence: input.pricingConfidence,
    escalations: input.escalations,
    sampleNote: input.sampleNote,
    extraNotes: [
      `SWE-bench official oracle: baseline ${input.baselineScore.resolvedCount}/${input.baselineScore.instanceCount} ` +
        `(${(input.baselineScore.resolvedRate * 100).toFixed(1)}%), harness ` +
        `${input.harnessScore.resolvedCount}/${input.harnessScore.instanceCount} ` +
        `(${(input.harnessScore.resolvedRate * 100).toFixed(1)}%). Method: ${input.baselineScore.method}/${input.harnessScore.method}.`,
    ],
  });

  return {
    runId: input.runId,
    instanceCount: input.rows.length,
    baselineResolvedRate: input.baselineScore.resolvedRate,
    harnessResolvedRate: input.harnessScore.resolvedRate,
    baselineResolvedCount: input.baselineScore.resolvedCount,
    harnessResolvedCount: input.harnessScore.resolvedCount,
    verdict,
    caveats: DEFAULT_CAVEATS,
  };
}

export function formatBenchReportMarkdown(report: BenchReport, input: BenchReportInput): string {
  const v = report.verdict;
  const lines: string[] = [
    `# OpenFusion Bench Report — ${report.runId}`,
    "",
    "## Summary",
    "",
    `- **Instances (N):** ${report.instanceCount}`,
    `- **Baseline resolved:** ${report.baselineResolvedCount}/${report.instanceCount} (${(report.baselineResolvedRate * 100).toFixed(1)}%)`,
    `- **Harness resolved:** ${report.harnessResolvedCount}/${report.instanceCount} (${(report.harnessResolvedRate * 100).toFixed(1)}%)`,
    `- **Verdict:** ${v.verdict}`,
    `- **Savings % (raw):** ${v.savingsPct === null ? "null" : (v.savingsPct * 100).toFixed(1) + "%"}`,
    `- **Clean savings %:** ${v.cleanSavingsPct === null ? "null" : (v.cleanSavingsPct * 100).toFixed(1) + "%"}`,
    `- **Quality held (raw):** ${v.qualityHeld}`,
    `- **Unpriced calls:** ${input.unpricedCalls}`,
    `- **Pricing confidence:** ${v.pricingConfidence}`,
    `- **Dataset snapshot hash:** ${input.datasetSnapshotHash}`,
    "",
    "## Per-instance",
    "",
    "| instance_id | baseline resolved | harness resolved | baseline USD | harness USD | measurement failure |",
    "|---|---|---|---|---|---|",
  ];
  for (const t of v.perTask) {
    const row = input.rows.find((r) => r.instance_id === t.id);
    lines.push(
      `| ${t.id} | ${t.baselinePassed} | ${t.harnessPassed} | ${t.baselineUsd ?? "null"} | ${t.harnessUsd ?? "null"} | ${row?.measurementFailure ?? false} |`,
    );
  }
  lines.push("", "## Verdict note", "", v.note, "", "## Caveats", "");
  for (const c of report.caveats) lines.push(`- ${c}`);
  if (input.environment && Object.keys(input.environment).length > 0) {
    lines.push("", "## Environment", "");
    for (const [k, val] of Object.entries(input.environment)) {
      lines.push(`- **${k}:** ${val}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function writeBenchReport(
  outDir: string,
  report: BenchReport,
  input: BenchReportInput,
): { jsonPath: string; mdPath: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "report.json");
  const mdPath = path.join(outDir, "report.md");
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ report, input: { ...input, rows: input.rows } }, null, 2)}\n`,
  );
  writeFileSync(mdPath, formatBenchReportMarkdown(report, input));
  report.jsonPath = jsonPath;
  report.mdPath = mdPath;
  return { jsonPath, mdPath };
}
