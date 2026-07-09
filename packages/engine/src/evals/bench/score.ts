// Official scoring via sb-cli (default) or local Docker harness fallback.
// Never re-implements the SWE-bench oracle.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { defaultDatasetPath, loadBenchDataset } from "./dataset.js";

const execFileAsync = promisify(execFile);

export interface ScoreArmResult {
  instance_id: string;
  resolved: boolean;
  /** Raw report fragment if available. */
  detail?: unknown;
}

export interface ScoreResult {
  arm: "baseline" | "harness";
  resolved: ScoreArmResult[];
  resolvedCount: number;
  instanceCount: number;
  /** Always resolvedCount / instanceCount (never /500). */
  resolvedRate: number;
  reportPath: string;
  method: "sb-cli" | "fixture" | "local-docker";
}

export interface ScoreOptions {
  predictionsPath: string;
  /** All instance ids in this run (denominator N). */
  instanceIds: string[];
  arm: "baseline" | "harness";
  runId: string;
  outputDir: string;
  /** Parse a pre-recorded sb-cli report JSON instead of calling the CLI. */
  fixtureReportPath?: string;
  /** Use local docker harness (not implemented as full runner — reserved). */
  localDocker?: boolean;
  log?: (msg: string) => void;
  /** Inject exec for tests. */
  execSbCli?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Build sb-cli submit argv. Mini has no dedicated subset — use
 * swe-bench_verified + --instance_ids.
 */
export function buildSbCliSubmitArgs(opts: {
  predictionsPath: string;
  instanceIds: string[];
  runId: string;
  outputDir: string;
}): string[] {
  return [
    "submit",
    "swe-bench_verified",
    "test",
    "--predictions_path",
    opts.predictionsPath,
    "--instance_ids",
    opts.instanceIds.join(","),
    "--run_id",
    opts.runId,
    "--output_dir",
    opts.outputDir,
    "--wait_for_evaluation",
    "1",
    "--gen_report",
    "1",
  ];
}

/**
 * Parse sb-cli / harness report into per-instance resolved flags.
 * Accepts common shapes:
 * - { resolved_ids: string[] }
 * - { resolved: Record<string, boolean> }
 * - { results: Array<{ instance_id, resolved }> }
 */
export function parseScoreReport(
  report: unknown,
  instanceIds: string[],
): ScoreArmResult[] {
  const idSet = new Set(instanceIds);
  const resolvedMap = new Map<string, boolean>();

  if (report !== null && typeof report === "object") {
    const obj = report as Record<string, unknown>;

    if (Array.isArray(obj.resolved_ids)) {
      for (const id of obj.resolved_ids) {
        if (typeof id === "string" && idSet.has(id)) resolvedMap.set(id, true);
      }
    }

    if (obj.resolved !== null && typeof obj.resolved === "object" && !Array.isArray(obj.resolved)) {
      for (const [id, val] of Object.entries(obj.resolved as Record<string, unknown>)) {
        if (idSet.has(id)) resolvedMap.set(id, Boolean(val));
      }
    }

    // SWE-bench style: submitted_ids + resolved_ids
    if (Array.isArray(obj.resolved)) {
      for (const id of obj.resolved) {
        if (typeof id === "string" && idSet.has(id)) resolvedMap.set(id, true);
      }
    }

    if (Array.isArray(obj.results)) {
      for (const row of obj.results) {
        if (row !== null && typeof row === "object") {
          const r = row as Record<string, unknown>;
          const id = r.instance_id;
          if (typeof id === "string" && idSet.has(id)) {
            const res =
              r.resolved === true ||
              r.resolved === "resolved" ||
              r.status === "resolved";
            resolvedMap.set(id, res);
          }
        }
      }
    }
  }

  return instanceIds.map((instance_id) => ({
    instance_id,
    resolved: resolvedMap.get(instance_id) ?? false,
  }));
}

export async function scorePredictions(opts: ScoreOptions): Promise<ScoreResult> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  mkdirSync(opts.outputDir, { recursive: true });
  const reportPath = path.join(opts.outputDir, `score-${opts.arm}.json`);

  let report: unknown;
  let method: ScoreResult["method"];

  if (opts.fixtureReportPath !== undefined) {
    log(`scoring ${opts.arm} from fixture ${opts.fixtureReportPath}`);
    report = JSON.parse(readFileSync(opts.fixtureReportPath, "utf8"));
    method = "fixture";
  } else if (opts.localDocker) {
    throw new Error(
      "local-docker scoring is reserved for v1 fallback operators; use sb-cli by default or --fixture for tests",
    );
  } else {
    const args = buildSbCliSubmitArgs({
      predictionsPath: opts.predictionsPath,
      instanceIds: opts.instanceIds,
      runId: `${opts.runId}-${opts.arm}`,
      outputDir: opts.outputDir,
    });
    log(`sb-cli ${args.join(" ")}`);
    const exec =
      opts.execSbCli ??
      (async (a: string[]) => {
        const { stdout, stderr } = await execFileAsync("sb-cli", a, {
          maxBuffer: 64 * 1024 * 1024,
          env: process.env,
        });
        return { stdout, stderr };
      });
    try {
      const { stdout, stderr } = await exec(args);
      if (stderr) log(stderr.trim());
      // Prefer a report file sb-cli wrote; fall back to stdout JSON.
      const candidates = [
        path.join(opts.outputDir, `${opts.runId}-${opts.arm}.json`),
        path.join(opts.outputDir, "report.json"),
      ];
      let loaded: unknown | null = null;
      for (const c of candidates) {
        if (existsSync(c)) {
          loaded = JSON.parse(readFileSync(c, "utf8"));
          break;
        }
      }
      if (loaded === null && stdout.trim().startsWith("{")) {
        loaded = JSON.parse(stdout);
      }
      if (loaded === null) {
        throw new Error(
          "sb-cli finished but no JSON report was found; save the report under the run output dir and re-run with --fixture",
        );
      }
      report = loaded;
      method = "sb-cli";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`sb-cli scoring failed: ${message}`);
    }
  }

  const resolved = parseScoreReport(report, opts.instanceIds);
  const resolvedCount = resolved.filter((r) => r.resolved).length;
  const instanceCount = opts.instanceIds.length;
  const result: ScoreResult = {
    arm: opts.arm,
    resolved,
    resolvedCount,
    instanceCount,
    resolvedRate: instanceCount === 0 ? 0 : resolvedCount / instanceCount,
    reportPath,
    method,
  };
  writeFileSync(reportPath, `${JSON.stringify({ report, result }, null, 2)}\n`);
  return result;
}

export function defaultMiniInstanceIds(datasetPath?: string): string[] {
  return loadBenchDataset(datasetPath ?? defaultDatasetPath()).instanceIds;
}
