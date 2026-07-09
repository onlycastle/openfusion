// bench run: paired baseline + harness arms → predictions JSON + metered rows.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Engine } from "../../engine.js";
import type { FrontierSession } from "../../engines/types.js";
import type { PricingConfidence } from "../../models/meter.js";
import { loadHarness, writeHarness } from "../../harness/store.js";
import { orchestrate, type OrchestrateResult } from "../../orchestrate/orchestrate.js";
import { RunCancelledError } from "../../rpc/cancel-registry.js";
import { RpcMethodError } from "../../rpc/errors.js";
import { RpcErrorCodes } from "@openfusion/shared";
import type { PerTaskResult } from "../run.js";
import { materializeBaseCommit } from "./archive.js";
import {
  defaultDatasetPath,
  loadBenchDataset,
  selectInstances,
  type BenchInstance,
} from "./dataset.js";
import { exportModelPatch } from "./patchExport.js";
import { clonePath, defaultBenchRoot, harnessBundlePath, runDir } from "./paths.js";

const FRONTIER_KIND = "claude-code";
const DEFAULT_BASELINE_TIMEOUT_MS = 600_000;
const CONFIDENCE_RANK: Record<PricingConfidence, number> = {
  unpriced: 0,
  unverified: 1,
  secondary: 2,
  verified: 3,
  "provider-reported": 3,
};

export interface BenchPrediction {
  instance_id: string;
  model_name_or_path: string;
  model_patch: string;
}

export interface BenchInstanceRow {
  instance_id: string;
  baselineOutcome: PerTaskResult["baselineOutcome"];
  harnessOutcome: PerTaskResult["harnessOutcome"];
  baselineUsd: number | null;
  harnessUsd: number | null;
  routeId: string | null;
  family: string | null;
  dialectPack: string | null;
  workerModel: string | null;
  baselinePatch: string;
  harnessPatch: string;
  measurementFailure: boolean;
}

export interface BenchRunResult {
  runId: string;
  runDir: string;
  instanceCount: number;
  predictionsBaselinePath: string;
  predictionsHarnessPath: string;
  rowsPath: string;
  rows: BenchInstanceRow[];
  unpricedCalls: number;
  pricingConfidence: PricingConfidence;
  datasetSnapshotHash: string;
  escalations: number;
  meterStartIndex: number;
}

export interface BenchRunOptions {
  benchRoot?: string;
  datasetPath?: string;
  limit?: number;
  instanceId?: string;
  runId?: string;
  modelNameBaseline?: string;
  modelNameHarness?: string;
  log?: (msg: string) => void;
}

function addCost(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}

function orchestrationProvenance(
  result: OrchestrateResult | null,
): Pick<BenchInstanceRow, "routeId" | "family" | "dialectPack" | "workerModel"> {
  if (result === null) {
    return { routeId: null, family: null, dialectPack: null, workerModel: null };
  }
  return {
    routeId: result.routeId,
    family: result.family ?? null,
    dialectPack: result.dialectPack ?? null,
    workerModel: result.resolution === "frontier" ? "frontier" : result.resolution.model,
  };
}

async function drainFrontierTurn(
  session: FrontierSession,
  prompt: string,
  timeoutMs: number,
): Promise<{ costUsd: number | null }> {
  const handle = session.prompt(prompt, { timeoutMs });
  let costUsd: number | null = null;
  try {
    for await (const event of handle.events) {
      switch (event.type) {
        case "result":
          costUsd = addCost(costUsd, event.costUsd);
          break;
        case "error":
          throw new Error(`frontier session error: ${event.message}`);
        default:
          break;
      }
    }
  } catch (err) {
    handle.abort();
    throw err;
  }
  return { costUsd };
}

async function runBaselineArm(
  engine: Engine,
  dir: string,
  problemStatement: string,
): Promise<{ costUsd: number | null; outcome: PerTaskResult["baselineOutcome"] }> {
  let costUsd: number | null = null;
  try {
    const adapter = engine.frontier.getAdapter(FRONTIER_KIND);
    if (adapter === undefined) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown frontier engine: ${FRONTIER_KIND}`);
    }
    const session = await adapter.createSession({
      projectDir: dir,
      wikiMcpUrl: null,
      log: engine.log,
      toolPolicy: { writeScope: [dir] },
      resultLabel: "eval-baseline",
    });
    const untrack = engine.frontier.track(session);
    try {
      const turn = await drainFrontierTurn(session, problemStatement, DEFAULT_BASELINE_TIMEOUT_MS);
      costUsd = turn.costUsd;
    } finally {
      await session.close().catch(() => {});
      untrack();
    }
    return { costUsd, outcome: "completed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    engine.log(`bench: baseline failed: ${message}`);
    return { costUsd: null, outcome: "error" };
  }
}

async function runHarnessArm(
  engine: Engine,
  harnessDir: string,
  problemStatement: string,
): Promise<{
  costUsd: number | null;
  outcome: PerTaskResult["harnessOutcome"];
} & Pick<BenchInstanceRow, "routeId" | "family" | "dialectPack" | "workerModel">> {
  let result: OrchestrateResult | null = null;
  try {
    result = await orchestrate(engine, {
      projectDir: harnessDir,
      task: problemStatement,
    });
    const provenance = orchestrationProvenance(result);
    if (result.diff.trim().length === 0) {
      return { costUsd: result.cost.totalUsd, outcome: result.outcome, ...provenance };
    }
    try {
      const response = await engine.dispatcher.dispatch({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "engine.orchestrate.apply",
        params: { projectDir: harnessDir, diff: result.diff },
      });
      if (response !== null && response.error !== undefined) {
        engine.log(`bench: apply failed: ${response.error.message}`);
        return { costUsd: result.cost.totalUsd, outcome: "apply-failed", ...provenance };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      engine.log(`bench: apply failed: ${message}`);
      return { costUsd: result.cost.totalUsd, outcome: "apply-failed", ...provenance };
    }
    return { costUsd: result.cost.totalUsd, outcome: result.outcome, ...provenance };
  } catch (err) {
    if (err instanceof RunCancelledError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    engine.log(`bench: orchestrate failed: ${message}`);
    return { costUsd: null, outcome: "error", ...orchestrationProvenance(result) };
  }
}

function writePredictionsJson(
  filePath: string,
  preds: BenchPrediction[],
): void {
  // sb-cli accepts dict or list; use dict keyed by instance_id.
  const dict: Record<string, { model_patch: string; model_name_or_path: string }> = {};
  for (const p of preds) {
    dict[p.instance_id] = {
      model_patch: p.model_patch,
      model_name_or_path: p.model_name_or_path,
    };
  }
  writeFileSync(filePath, `${JSON.stringify(dict, null, 2)}\n`);
}

function loadExistingRows(rowsPath: string): BenchInstanceRow[] {
  if (!existsSync(rowsPath)) return [];
  try {
    return JSON.parse(readFileSync(rowsPath, "utf8")) as BenchInstanceRow[];
  } catch {
    return [];
  }
}

function worsePricingConfidence(a: PricingConfidence, b: PricingConfidence): PricingConfidence {
  const aRank = CONFIDENCE_RANK[a];
  const bRank = CONFIDENCE_RANK[b];
  if (aRank < bRank) return a;
  if (bRank < aRank) return b;
  if (a === "verified" || b === "verified") return "verified";
  return a;
}

function loadExistingMeta(metaPath: string): {
  hasMeta: boolean;
  unpricedCalls: number;
  pricingConfidence: PricingConfidence;
  escalations: number;
} {
  if (!existsSync(metaPath)) {
    return { hasMeta: false, unpricedCalls: 0, pricingConfidence: "verified", escalations: 0 };
  }
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      unpricedCalls?: number;
      pricingConfidence?: PricingConfidence;
      escalations?: number;
    };
    return {
      hasMeta: true,
      unpricedCalls: meta.unpricedCalls ?? 0,
      pricingConfidence: meta.pricingConfidence ?? "verified",
      escalations: meta.escalations ?? 0,
    };
  } catch {
    return { hasMeta: false, unpricedCalls: 0, pricingConfidence: "verified", escalations: 0 };
  }
}

/**
 * Run paired arms for selected instances. Resumes by skipping instance_ids
 * already present in rows.json with both arms recorded.
 */
export async function runBench(engine: Engine, opts: BenchRunOptions = {}): Promise<BenchRunResult> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const benchRoot = opts.benchRoot ?? defaultBenchRoot();
  const dataset = loadBenchDataset(opts.datasetPath ?? defaultDatasetPath());
  const selected = selectInstances(dataset, {
    limit: opts.limit,
    instanceId: opts.instanceId,
  });
  const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = runDir(benchRoot, runId);
  mkdirSync(outDir, { recursive: true });

  const predictionsBaselinePath = path.join(outDir, "predictions-baseline.json");
  const predictionsHarnessPath = path.join(outDir, "predictions-harness.json");
  const rowsPath = path.join(outDir, "rows.json");
  const metaPath = path.join(outDir, "run-meta.json");

  const existing = loadExistingRows(rowsPath);
  const existingMeta = loadExistingMeta(metaPath);
  const doneIds = new Set(existing.map((r) => r.instance_id));
  const rows: BenchInstanceRow[] = [...existing];
  const baselinePreds: BenchPrediction[] = existing.map((r) => ({
    instance_id: r.instance_id,
    model_name_or_path: opts.modelNameBaseline ?? "openfusion-baseline",
    model_patch: r.baselinePatch,
  }));
  const harnessPreds: BenchPrediction[] = existing.map((r) => ({
    instance_id: r.instance_id,
    model_name_or_path: opts.modelNameHarness ?? "openfusion-harness",
    model_patch: r.harnessPatch,
  }));

  let escalations = 0;
  const meterStartIndex = engine.models.meter.recordCount();

  for (const inst of selected) {
    if (doneIds.has(inst.instance_id)) {
      log(`skip (already done): ${inst.instance_id}`);
      continue;
    }
    log(`instance ${inst.instance_id} (${inst.repo} @ ${inst.base_commit.slice(0, 12)})`);

    const clone = clonePath(benchRoot, inst.repo);
    if (!existsSync(path.join(clone, ".git"))) {
      throw new Error(`clone missing for ${inst.repo}; run bench prepare first (${clone})`);
    }
    const hBundlePath = harnessBundlePath(benchRoot, inst.repo);
    const harnessBundle = loadHarness(hBundlePath);
    if (harnessBundle === null) {
      throw new Error(
        `approved harness missing for ${inst.repo}; run bench prepare first (${hBundlePath})`,
      );
    }

    const baselineDir = await mkdtemp(path.join(os.tmpdir(), "of-bench-b-"));
    const harnessDir = await mkdtemp(path.join(os.tmpdir(), "of-bench-h-"));
    let row: BenchInstanceRow;
    try {
      const { baselineSha: bSha } = await materializeBaseCommit(clone, inst.base_commit, baselineDir);
      const { baselineSha: hSha } = await materializeBaseCommit(clone, inst.base_commit, harnessDir);

      log(`  baseline arm…`);
      const baseline = await runBaselineArm(engine, baselineDir, inst.problem_statement);
      const baselinePatch =
        baseline.outcome === "error" ? "" : await exportModelPatch(baselineDir, { baselineSha: bSha });

      log(`  harness arm…`);
      await writeHarness(harnessDir, harnessBundle);
      const harness = await runHarnessArm(engine, harnessDir, inst.problem_statement);
      if (harness.outcome === "escalated") escalations += 1;
      const harnessPatch =
        harness.outcome === "error" || harness.outcome === "apply-failed"
          ? ""
          : await exportModelPatch(harnessDir, { baselineSha: hSha });

      const measurementFailure =
        baseline.outcome === "error" ||
        harness.outcome === "error" ||
        harness.outcome === "apply-failed";

      row = {
        instance_id: inst.instance_id,
        baselineOutcome: baseline.outcome,
        harnessOutcome: harness.outcome,
        baselineUsd: baseline.costUsd,
        harnessUsd: harness.costUsd,
        routeId: harness.routeId,
        family: harness.family,
        dialectPack: harness.dialectPack,
        workerModel: harness.workerModel,
        baselinePatch,
        harnessPatch,
        measurementFailure,
      };
    } finally {
      await rm(baselineDir, { recursive: true, force: true });
      await rm(harnessDir, { recursive: true, force: true });
    }

    rows.push(row);
    baselinePreds.push({
      instance_id: inst.instance_id,
      model_name_or_path: opts.modelNameBaseline ?? "openfusion-baseline",
      model_patch: row.baselinePatch,
    });
    harnessPreds.push({
      instance_id: inst.instance_id,
      model_name_or_path: opts.modelNameHarness ?? "openfusion-harness",
      model_patch: row.harnessPatch,
    });

    // Durable after each instance — resume-safe.
    writeFileSync(rowsPath, `${JSON.stringify(rows, null, 2)}\n`);
    writePredictionsJson(predictionsBaselinePath, baselinePreds);
    writePredictionsJson(predictionsHarnessPath, harnessPreds);
    log(
      `  done baseline=${row.baselineOutcome} harness=${row.harnessOutcome} ` +
        `usdB=${row.baselineUsd ?? "null"} usdH=${row.harnessUsd ?? "null"}`,
    );
  }

  writePredictionsJson(predictionsBaselinePath, baselinePreds);
  writePredictionsJson(predictionsHarnessPath, harnessPreds);
  writeFileSync(rowsPath, `${JSON.stringify(rows, null, 2)}\n`);

  const meter = engine.models.meter.totals(meterStartIndex);
  const cumulativeUnpricedCalls = existingMeta.unpricedCalls + meter.unpricedCalls;
  const cumulativePricingConfidence = existingMeta.hasMeta
    ? meter.calls === 0
      ? existingMeta.pricingConfidence
      : worsePricingConfidence(existingMeta.pricingConfidence, meter.pricingConfidence)
    : meter.pricingConfidence;
  const cumulativeEscalations = existingMeta.escalations + escalations;
  writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        runId,
        unpricedCalls: cumulativeUnpricedCalls,
        pricingConfidence: cumulativePricingConfidence,
        escalations: cumulativeEscalations,
        datasetSnapshotHash: dataset.snapshotHash,
        instanceCount: rows.length,
      },
      null,
      2,
    )}\n`,
  );
  return {
    runId,
    runDir: outDir,
    instanceCount: rows.length,
    predictionsBaselinePath,
    predictionsHarnessPath,
    rowsPath,
    rows,
    unpricedCalls: cumulativeUnpricedCalls,
    pricingConfidence: cumulativePricingConfidence,
    datasetSnapshotHash: dataset.snapshotHash,
    escalations: cumulativeEscalations,
    meterStartIndex,
  };
}

/** Map bench rows to PerTaskResult for computeEvalsVerdict (resolved flags filled later by score). */
export function rowsToPerTask(
  rows: BenchInstanceRow[],
  resolved: Map<string, { baseline: boolean; harness: boolean }>,
): PerTaskResult[] {
  return rows.map((r) => {
    const res = resolved.get(r.instance_id);
    return {
      id: r.instance_id,
      baselinePassed: res?.baseline ?? false,
      baselineOutcome: r.baselineOutcome,
      harnessPassed: res?.harness ?? false,
      harnessOutcome: r.harnessOutcome,
      baselineUsd: r.baselineUsd,
      harnessUsd: r.harnessUsd,
      routeId: r.routeId ?? null,
      family: r.family ?? null,
      dialectPack: r.dialectPack ?? null,
      workerModel: r.workerModel ?? null,
    };
  });
}
