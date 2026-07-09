// SWE-bench Verified Mini dataset loader.
//
// Run-side types deliberately omit gold patch, test_patch, and hints_text
// so agents never receive answer leakage / free PR discussion hints through
// the typed API. Vendored JSON may still store those fields for offline
// harness tooling; loadBenchDataset strips them from the public surface.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const StoredInstanceSchema = z
  .object({
    instance_id: z.string().min(1),
    repo: z.string().min(1),
    base_commit: z.string().min(1),
    problem_statement: z.string().min(1),
    // Stored-only fields (may be present in vendored JSON; never exported
    // on BenchInstance):
    patch: z.string().optional(),
    test_patch: z.string().optional(),
    hints_text: z.string().optional(),
    FAIL_TO_PASS: z.union([z.string(), z.array(z.string())]).optional(),
    PASS_TO_PASS: z.union([z.string(), z.array(z.string())]).optional(),
    environment_setup_commit: z.string().optional(),
    version: z.string().optional(),
    created_at: z.string().optional(),
  })
  .passthrough();

const VendoredFileSchema = z.object({
  dataset: z.string(),
  version: z.number().int().positive(),
  instances: z.array(StoredInstanceSchema).min(1),
});

/** Run-side instance — no gold patch / test_patch / hints_text. */
export interface BenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  environment_setup_commit?: string;
  version?: string;
}

export interface BenchDataset {
  dataset: string;
  version: number;
  instances: BenchInstance[];
  /** SHA-256 of the raw vendored file bytes (reproducibility record). */
  snapshotHash: string;
  instanceIds: string[];
}

/** Fields that must never appear on BenchInstance. */
export const FORBIDDEN_RUN_SIDE_FIELDS = ["patch", "test_patch", "hints_text"] as const;

export function defaultDatasetPath(): string {
  // packages/engine/src/evals/bench -> repo root benchmarks/
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../../benchmarks/swe-bench-verified-mini.json");
}

export function loadBenchDataset(filePath?: string): BenchDataset {
  const resolved = filePath ?? defaultDatasetPath();
  if (!existsSync(resolved)) {
    throw new Error(
      `bench dataset not found at ${resolved}. Vendor benchmarks/swe-bench-verified-mini.json first.`,
    );
  }
  const raw = readFileSync(resolved);
  const snapshotHash = createHash("sha256").update(raw).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throw new Error(`bench dataset is not valid JSON: ${resolved}: ${err}`);
  }

  const file = VendoredFileSchema.parse(parsed);
  const instances: BenchInstance[] = file.instances.map((row) => {
    // Explicit pick — never spread stored row (would leak patch/test_patch).
    const inst: BenchInstance = {
      instance_id: row.instance_id,
      repo: row.repo,
      base_commit: row.base_commit,
      problem_statement: row.problem_statement,
    };
    if (row.environment_setup_commit !== undefined) {
      inst.environment_setup_commit = row.environment_setup_commit;
    }
    if (row.version !== undefined) inst.version = row.version;
    return inst;
  });

  // Defense-in-depth: assert no forbidden keys on run-side objects.
  for (const inst of instances) {
    for (const key of FORBIDDEN_RUN_SIDE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(inst, key)) {
        throw new Error(`bench dataset leak: run-side instance has forbidden field ${key}`);
      }
    }
  }

  return {
    dataset: file.dataset,
    version: file.version,
    instances,
    snapshotHash,
    instanceIds: instances.map((i) => i.instance_id),
  };
}

export function selectInstances(
  dataset: BenchDataset,
  opts: { limit?: number; instanceId?: string } = {},
): BenchInstance[] {
  if (opts.instanceId !== undefined) {
    const found = dataset.instances.find((i) => i.instance_id === opts.instanceId);
    if (found === undefined) {
      throw new Error(`unknown instance_id: ${opts.instanceId}`);
    }
    return [found];
  }
  if (opts.limit !== undefined) {
    if (opts.limit < 1) throw new Error(`--limit must be >= 1, got ${opts.limit}`);
    return dataset.instances.slice(0, opts.limit);
  }
  return [...dataset.instances];
}

/** Distinct repos in the dataset (mini → django + sphinx). */
export function distinctRepos(instances: BenchInstance[]): string[] {
  return [...new Set(instances.map((i) => i.repo))].sort();
}

/**
 * For each repo, the instance with the newest created_at is preferred when
 * present in the raw file; otherwise the last occurrence in vendored order.
 * Used to pick the harness-generation base_commit.
 */
export function latestBaseCommitByRepo(
  storedInstances: Array<{ repo: string; base_commit: string; created_at?: string }>,
): Map<string, string> {
  const best = new Map<string, { base_commit: string; created_at: string }>();
  for (const row of storedInstances) {
    const prev = best.get(row.repo);
    const created = row.created_at ?? "";
    if (prev === undefined || created >= prev.created_at) {
      best.set(row.repo, { base_commit: row.base_commit, created_at: created });
    }
  }
  return new Map([...best.entries()].map(([repo, v]) => [repo, v.base_commit]));
}
