// bench prepare: clone distinct repos, generate harness once per repo,
// interactive card approval (or --approve-from / already-approved skip).

import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, cpSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Engine } from "../../engine.js";
import type { FrontierSelection } from "../../engines/selection.js";
import { generateHarness } from "../../harness/generate.js";
import { CARD_SLUG } from "../../harness/schema.js";
import { loadHarness, setCardState, writeHarness } from "../../harness/store.js";
import { requireGitRepo } from "../../rpc/guards.js";
import {
  defaultDatasetPath,
  distinctRepos,
  loadBenchDataset,
  type BenchDataset,
  type BenchInstance,
} from "./dataset.js";
import { clonePath, defaultBenchRoot, harnessBundlePath } from "./paths.js";
import { materializeBaseCommit } from "./archive.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";

const execFileAsync = promisify(execFile);

export interface PrepareOptions {
  benchRoot?: string;
  datasetPath?: string;
  /** Path to a previously human-approved harness directory to copy for a repo. */
  approveFrom?: string;
  /** Skip interactive generate when harness already approved on disk. */
  skipIfApproved?: boolean;
  log?: (msg: string) => void;
  /** Injected for tests — defaults to stdin/stdout readline. */
  promptYes?: (question: string) => Promise<boolean>;
  /** When true, only clone + record; do not call generateHarness. */
  clonesOnly?: boolean;
  planningFrontier?: FrontierSelection;
}

export interface PrepareResult {
  benchRoot: string;
  repos: string[];
  clones: Record<string, string>;
  harness: Record<string, { path: string; card: "draft" | "approved" | null }>;
}

async function gitClone(repo: string, dest: string, log: (m: string) => void): Promise<void> {
  mkdirSync(path.dirname(dest), { recursive: true });
  if (existsSync(path.join(dest, ".git"))) {
    log(`clone exists: ${repo} -> ${dest} (fetch)`);
    await execFileAsync("git", ["-C", dest, "fetch", "--all", "--tags", "--prune"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return;
  }
  const url = `https://github.com/${repo}.git`;
  log(`cloning ${url} -> ${dest}`);
  await execFileAsync("git", ["clone", url, dest], { maxBuffer: 64 * 1024 * 1024 });
}

function cardDigest(projectDir: string): string | null {
  const bundle = loadHarness(projectDir);
  if (bundle === null) return null;
  const page = bundle.pages.find((p) => p.slug === CARD_SLUG);
  return page?.digest ?? null;
}

async function defaultPromptYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function latestBaseCommit(instances: BenchInstance[], repo: string): string {
  // Vendored order is stable; last occurrence is a reasonable proxy when
  // created_at is not on run-side types. Prefer raw file if available.
  const forRepo = instances.filter((i) => i.repo === repo);
  if (forRepo.length === 0) throw new Error(`no instances for repo ${repo}`);
  return forRepo[forRepo.length - 1]!.base_commit;
}

function tryLatestFromRaw(datasetPath: string, repo: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(datasetPath, "utf8")) as {
      instances?: Array<{ repo: string; base_commit: string; created_at?: string }>;
    };
    const rows = (raw.instances ?? []).filter((i) => i.repo === repo);
    if (rows.length === 0) return null;
    rows.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
    return rows[rows.length - 1]!.base_commit;
  } catch {
    return null;
  }
}

/**
 * Idempotent prepare. Clones django + sphinx for mini. Optionally generates
 * and interactively approves harness cards once per repo.
 */
export async function prepareBench(
  engine: Engine | null,
  opts: PrepareOptions = {},
): Promise<PrepareResult> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const benchRoot = opts.benchRoot ?? defaultBenchRoot();
  const datasetPath = opts.datasetPath ?? defaultDatasetPath();
  const dataset: BenchDataset = loadBenchDataset(datasetPath);
  const repos = distinctRepos(dataset.instances);
  const promptYes = opts.promptYes ?? defaultPromptYes;

  mkdirSync(benchRoot, { recursive: true });
  const clones: Record<string, string> = {};
  const harness: PrepareResult["harness"] = {};

  for (const repo of repos) {
    const dest = clonePath(benchRoot, repo);
    await gitClone(repo, dest, log);
    clones[repo] = dest;

    if (opts.clonesOnly) {
      harness[repo] = { path: harnessBundlePath(benchRoot, repo), card: null };
      continue;
    }

    const hPath = harnessBundlePath(benchRoot, repo);
    mkdirSync(hPath, { recursive: true });

    // Already-approved skip (idempotent re-prepare).
    if (opts.skipIfApproved !== false && existsSync(path.join(hPath, "manifest.json"))) {
      try {
        const existing = loadHarness(hPath);
        if (existing?.manifest.verification.card === "approved") {
          log(`harness already approved for ${repo} at ${hPath}; skipping`);
          harness[repo] = { path: hPath, card: "approved" };
          continue;
        }
      } catch {
        // regenerate below
      }
    }

    if (opts.approveFrom !== undefined) {
      log(`copying approved harness from ${opts.approveFrom} -> ${hPath}`);
      cpSync(opts.approveFrom, hPath, { recursive: true });
      await setCardState(hPath, "approved");
      harness[repo] = { path: hPath, card: "approved" };
      continue;
    }

    if (engine === null) {
      throw new Error(
        "prepare requires an Engine for harness generation (or pass --approve-from / clonesOnly)",
      );
    }

    const baseCommit =
      tryLatestFromRaw(datasetPath, repo) ?? latestBaseCommit(dataset.instances, repo);
    log(`generating harness for ${repo} at base_commit ${baseCommit.slice(0, 12)}…`);

    // Generate against a materialised checkout of base_commit, then copy
    // the .openfusion bundle into the durable harness store path.
    const scratch = mkdtempSync(path.join(os.tmpdir(), "of-bench-prep-"));
    try {
      await materializeBaseCommit(dest, baseCommit, scratch);
      requireGitRepo(scratch);
      await generateHarness(engine, scratch, opts.planningFrontier);
      const digest = cardDigest(scratch);
      log(`draft card digest for ${repo}:\n${digest ?? "(no card page)"}\n`);
      const ok = await promptYes(`Approve harness card for ${repo}? [y/N] `);
      if (!ok) {
        throw new Error(`card approval declined for ${repo}; prepare aborted`);
      }
      await setCardState(scratch, "approved");
      const bundle = loadHarness(scratch);
      if (bundle === null) throw new Error(`generate produced no harness for ${repo}`);
      await writeHarness(hPath, bundle);
      writeFileSync(
        path.join(hPath, "prepare-meta.json"),
        `${JSON.stringify({ repo, baseCommit, approvedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      harness[repo] = { path: hPath, card: "approved" };
      log(`approved harness stored at ${hPath}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  writeFileSync(
    path.join(benchRoot, "prepare-state.json"),
    `${JSON.stringify({ repos, clones, harness, datasetHash: dataset.snapshotHash }, null, 2)}\n`,
  );

  return { benchRoot, repos, clones, harness };
}
