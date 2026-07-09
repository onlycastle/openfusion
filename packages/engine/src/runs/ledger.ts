// Run ledger v1: durable per-project JSONL of orchestrate/evals/generate/card
// outcomes. Observes only — never load-bearing. Spec:
// docs/superpowers/specs/2026-07-08-run-ledger-design.md
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const RunRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    v: z.literal(1),
    kind: z.literal("orchestrate"),
    at: z.iso.datetime(),
    taskClass: z.string(),
    agent: z.string(),
    workerModel: z.string(),
    attempts: z.number().int().min(0),
    outcome: z.enum(["worker-approved", "escalated", "failed", "error"]),
    escalated: z.boolean(),
    reviews: z.array(
      z.object({
        decision: z.enum(["approve", "request-changes"]),
        reasons: z.array(z.string()),
      }),
    ),
    contextBranch: z.enum(["approved-card", "build-and-test-fallback", "none"]),
    toolCallCounts: z.record(z.string(), z.number().int()).optional(),
    toolErrorCounts: z.record(z.string(), z.number().int()).optional(),
    editFailCount: z.number().int().optional(),
    family: z.string().optional(),
    dialectPack: z.string().optional(),
    routeId: z.string().optional(),
    cost: z.object({
      workerUsd: z.number().nullable(),
      reviewUsd: z.number().nullable(),
      escalateUsd: z.number().nullable(),
      totalUsd: z.number().nullable(),
    }),
    durationMs: z.number().int().min(0),
    runId: z.string().optional(),
    errorCategory: z.enum(["no-harness", "load-failed", "cancelled", "unknown"]).optional(),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("evals"),
    at: z.iso.datetime(),
    taskCount: z.number().int(),
    verdict: z.enum(["pass", "fail", "inconclusive"]),
    savingsPct: z.number().nullable(),
    cleanSavingsPct: z.number().nullable(),
    qualityHeld: z.boolean(),
    qualityGapWithinNoise: z.boolean(),
    pricingConfidence: z.string(),
    measurementFailureCount: z.number().int(),
    perTask: z.array(
      z.object({
        id: z.string(),
        baselinePassed: z.boolean(),
        harnessPassed: z.boolean(),
        harnessOutcome: z.string(),
        baselineOutcome: z.string(),
        routeId: z.string().nullable(),
        family: z.string().nullable(),
        dialectPack: z.string().nullable(),
        workerModel: z.string().nullable(),
      }),
    ),
    note: z.string(),
    durationMs: z.number().int().min(0),
    runId: z.string().optional(),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("generate"),
    at: z.iso.datetime(),
    pages: z.number().int(),
    agents: z.number().int(),
    estimatedCostUsd: z.number().nullable(),
    headSha: z.string(),
    cardStripped: z.array(z.object({ item: z.string(), reason: z.string() })),
    durationMs: z.number().int().min(0),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("card"),
    at: z.iso.datetime(),
    action: z.enum(["update", "approve"]),
  }),
]);
export type RunRecord = z.infer<typeof RunRecordSchema>;

export function runsLedgerPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), ".openfusion", "cache", "runs.jsonl");
}

export async function appendRun(projectDir: string, record: RunRecord): Promise<void> {
  // Validate before any write — malformed records are caller bugs.
  const parsed = RunRecordSchema.parse(record);
  const filePath = runsLedgerPath(projectDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
}

export function readRuns(
  projectDir: string,
  opts?: { kind?: RunRecord["kind"]; limit?: number },
): { records: RunRecord[]; skipped: number } {
  const filePath = runsLedgerPath(projectDir);
  if (!existsSync(filePath)) return { records: [], skipped: 0 };

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { records: [], skipped: 0 };
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const records: RunRecord[] = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      const json: unknown = JSON.parse(line);
      const result = RunRecordSchema.safeParse(json);
      if (!result.success) {
        skipped += 1;
        continue;
      }
      if (opts?.kind !== undefined && result.data.kind !== opts.kind) continue;
      records.push(result.data);
    } catch {
      skipped += 1;
    }
  }

  // Newest-first = reverse of append order.
  records.reverse();
  const limit = opts?.limit ?? 50;
  return { records: records.slice(0, limit), skipped };
}

/**
 * Fire-and-forget observer. Ledger failures never throw to the pipeline.
 */
export function recordRun(
  engine: { log: (message: string) => void },
  projectDir: string,
  record: RunRecord,
): void {
  void (async () => {
    await appendRun(projectDir, record);
  })().catch(() => {
    engine.log(`run-ledger: append failed (${record.kind})`);
  });
}
