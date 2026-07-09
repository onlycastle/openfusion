#!/usr/bin/env node
// openfusion-bench — SWE-bench Verified Mini paired eval CLI.
//
// Subcommands: prepare | run | score | report | help
// Desktop app and RPC surface are untouched; this is a second bin.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createEngine } from "../../engine.js";
import { ENGINE_VERSION } from "../../version.js";
import { defaultDatasetPath, loadBenchDataset } from "./dataset.js";
import { defaultBenchRoot, runDir } from "./paths.js";
import { prepareBench } from "./prepare.js";
import { runBench, type BenchInstanceRow } from "./runner.js";
import { scorePredictions } from "./score.js";
import { buildBenchReport, writeBenchReport } from "./report.js";
import { configureBenchProviders } from "./providerConfig.js";
import type { PricingConfidence } from "../../models/meter.js";

function usage(): string {
  return `openfusion-bench — SWE-bench Verified Mini paired harness eval

Usage:
  openfusion-bench prepare [--clones-only] [--approve-from <path>] [--bench-root <dir>] [--providers <path>]
  openfusion-bench run [--limit N] [--instance <id>] [--run-id <id>] [--bench-root <dir>] [--providers <path>]
  openfusion-bench score --run-id <id> [--fixture-baseline <path>] [--fixture-harness <path>]
  openfusion-bench report --run-id <id>
  openfusion-bench help

Environment:
  OPENFUSION_BENCH_PROVIDERS  path to gitignored ProviderConfig JSON (workers)
  OPENFUSION_BENCH_ROOT       override ~/.openfusion/bench
  OPENFUSION_BENCH_SMOKE=1    reserved for operator smoke docs

Notes:
  - Scoring uses sb-cli submit swe-bench_verified test --instance_ids <mini ids>
  - Resolved rates use denominator N (this run), never 500
  - Predictions are JSON (not JSONL) for sb-cli
  - Provider JSON may be one ProviderConfig, an array, or { "providers": [...] }
`;
}

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean> } {
  const [cmd = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--clones-only") {
      flags.clonesOnly = true;
      continue;
    }
    if (a === "--local-docker") {
      flags.localDocker = true;
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { cmd, flags };
}

function benchRootFrom(flags: Record<string, string | boolean>): string {
  if (typeof flags.benchRoot === "string") return flags.benchRoot;
  if (process.env.OPENFUSION_BENCH_ROOT) return process.env.OPENFUSION_BENCH_ROOT;
  return defaultBenchRoot();
}

function providersPathFrom(flags: Record<string, string | boolean>): string | undefined {
  if (typeof flags.providers === "string") return flags.providers;
  return process.env.OPENFUSION_BENCH_PROVIDERS;
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  const log = (m: string) => process.stderr.write(`${m}\n`);

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    process.stdout.write(usage());
    return;
  }

  if (cmd === "prepare") {
    const engine =
      flags.clonesOnly === true
        ? null
        : createEngine({ log: (m) => process.stderr.write(`${m}\n`) });
    try {
      if (engine !== null) configureBenchProviders(engine, providersPathFrom(flags), log);
      const result = await prepareBench(engine, {
        benchRoot: benchRootFrom(flags),
        clonesOnly: flags.clonesOnly === true,
        approveFrom: typeof flags.approveFrom === "string" ? flags.approveFrom : undefined,
        log,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      if (engine) await engine.close();
    }
    return;
  }

  if (cmd === "run") {
    const engine = createEngine({ log: (m) => process.stderr.write(`${m}\n`) });
    try {
      configureBenchProviders(engine, providersPathFrom(flags), log);
      const result = await runBench(engine, {
        benchRoot: benchRootFrom(flags),
        limit: typeof flags.limit === "string" ? Number(flags.limit) : undefined,
        instanceId: typeof flags.instance === "string" ? flags.instance : undefined,
        runId: typeof flags.runId === "string" ? flags.runId : undefined,
        log,
      });
      process.stdout.write(
        `${JSON.stringify(
          {
            runId: result.runId,
            runDir: result.runDir,
            instanceCount: result.instanceCount,
            predictionsBaselinePath: result.predictionsBaselinePath,
            predictionsHarnessPath: result.predictionsHarnessPath,
            unpricedCalls: result.unpricedCalls,
            pricingConfidence: result.pricingConfidence,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await engine.close();
    }
    return;
  }

  if (cmd === "score") {
    const runId = flags.runId;
    if (typeof runId !== "string") {
      throw new Error("score requires --run-id");
    }
    const root = benchRootFrom(flags);
    const dir = runDir(root, runId);
    const rowsPath = path.join(dir, "rows.json");
    if (!existsSync(rowsPath)) throw new Error(`missing ${rowsPath}; run bench run first`);
    const rows = JSON.parse(readFileSync(rowsPath, "utf8")) as BenchInstanceRow[];
    const instanceIds = rows.map((r) => r.instance_id);
    const scoreDir = path.join(dir, "score");

    const baselineScore = await scorePredictions({
      predictionsPath: path.join(dir, "predictions-baseline.json"),
      instanceIds,
      arm: "baseline",
      runId,
      outputDir: scoreDir,
      fixtureReportPath:
        typeof flags.fixtureBaseline === "string" ? flags.fixtureBaseline : undefined,
      localDocker: flags.localDocker === true,
      log,
    });
    const harnessScore = await scorePredictions({
      predictionsPath: path.join(dir, "predictions-harness.json"),
      instanceIds,
      arm: "harness",
      runId,
      outputDir: scoreDir,
      fixtureReportPath:
        typeof flags.fixtureHarness === "string" ? flags.fixtureHarness : undefined,
      localDocker: flags.localDocker === true,
      log,
    });

    writeFileSync(
      path.join(dir, "score-summary.json"),
      `${JSON.stringify({ baselineScore, harnessScore }, null, 2)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          baseline: {
            resolved: baselineScore.resolvedCount,
            n: baselineScore.instanceCount,
            rate: baselineScore.resolvedRate,
          },
          harness: {
            resolved: harnessScore.resolvedCount,
            n: harnessScore.instanceCount,
            rate: harnessScore.resolvedRate,
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (cmd === "report") {
    const runId = flags.runId;
    if (typeof runId !== "string") throw new Error("report requires --run-id");
    const root = benchRootFrom(flags);
    const dir = runDir(root, runId);
    const rows = JSON.parse(readFileSync(path.join(dir, "rows.json"), "utf8")) as BenchInstanceRow[];
    const summary = JSON.parse(readFileSync(path.join(dir, "score-summary.json"), "utf8")) as {
      baselineScore: import("./score.js").ScoreResult;
      harnessScore: import("./score.js").ScoreResult;
    };
    // Prefer meta written by run; fall back to zeros.
    let unpricedCalls = 0;
    let pricingConfidence: PricingConfidence = "verified";
    let escalations = 0;
    let datasetSnapshotHash = loadBenchDataset(defaultDatasetPath()).snapshotHash;
    const metaPath = path.join(dir, "run-meta.json");
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
        unpricedCalls?: number;
        pricingConfidence?: PricingConfidence;
        escalations?: number;
        datasetSnapshotHash?: string;
      };
      unpricedCalls = meta.unpricedCalls ?? 0;
      pricingConfidence = meta.pricingConfidence ?? "verified";
      escalations = meta.escalations ?? 0;
      datasetSnapshotHash = meta.datasetSnapshotHash ?? datasetSnapshotHash;
    }

    const input = {
      runId,
      rows,
      baselineScore: summary.baselineScore,
      harnessScore: summary.harnessScore,
      unpricedCalls,
      pricingConfidence,
      escalations,
      datasetSnapshotHash,
      environment: {
        node: process.version,
        engine: ENGINE_VERSION,
        platform: process.platform,
      },
    };
    const report = buildBenchReport(input);
    const paths = writeBenchReport(dir, report, input);
    // Also copy under repo benchmarks/results when present
    const repoResults = path.resolve(
      path.dirname(defaultDatasetPath()),
      "results",
      runId,
    );
    try {
      writeBenchReport(repoResults, report, input);
      log(`also wrote ${repoResults}`);
    } catch {
      // optional
    }
    process.stdout.write(`${JSON.stringify({ ...paths, verdict: report.verdict.verdict }, null, 2)}\n`);
    return;
  }

  process.stderr.write(`unknown command: ${cmd}\n\n${usage()}`);
  process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
