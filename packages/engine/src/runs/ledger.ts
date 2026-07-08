import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Engine } from "../engine.js";

// Run Ledger v1 — see docs/superpowers/specs/2026-07-08-run-ledger-design.md.
//
// A durable, per-project, append-only JSONL record of orchestrate/eval/
// generation/card actions (`<projectDir>/.openfusion/cache/runs.jsonl`),
// written to be the data substrate a planned self-improvement loop
// (weakness mining -> GEPA proposals -> eval-gated validation) reads from.
// Today OpenFusion discards everything each run learns except a one-word
// eval verdict; this module is what stops that.
//
// The ledger OBSERVES the harness; it is never load-bearing. `recordRun` —
// the ONLY coupling any pipeline has to this module — never throws and
// never rejects: on any append failure it logs a single line (the record's
// `kind` only) so the calling pipeline proceeds exactly as if the ledger
// did not exist. It RETURNS its settled-when-durable promise so a caller
// can choose to await completion (see recordRun's own doc comment for why
// the orchestrate write point does) — awaiting is about ORDERING only,
// never failure exposure: the promise cannot reject.
//
// The content line: records carry outcome metadata and verifier-level
// failure signals (review-rejection reasons, error categories) needed for
// weakness mining — never task text, diffs, prompts, or file content. The
// one deliberate exception is review "reasons" text: model-generated prose
// ABOUT an attempt (not the attempt's own content), admitted because mining
// needs it. Callers are responsible for never constructing a record from
// raw task/prompt/diff/file content in the first place.
//
// Reads (`readRuns`) are corrupt-line-tolerant: any line that fails
// JSON.parse or schema validation is skipped and counted, never thrown — a
// crash mid-write must not poison the rest of history.
//
// v1 concurrency: `appendRun` does one `appendFile` call per record
// (O_APPEND, single line, no locking). Two engine processes appending to the
// same project's ledger concurrently could in theory interleave mid-line on
// some filesystems; corrupt-line-tolerant reads make that harmless.
// Documented, not solved, in v1 (spec §8).

export const RunRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    v: z.literal(1),
    kind: z.literal("orchestrate"),
    at: z.iso.datetime(),
    taskClass: z.string(),
    agent: z.string(),
    workerModel: z.string(), // model id or "frontier"
    attempts: z.number().int().min(0),
    outcome: z.enum(["worker-approved", "escalated", "failed", "error"]),
    escalated: z.boolean(),
    reviews: z.array(z.object({ decision: z.enum(["approve", "request-changes"]), reasons: z.array(z.string()) })),
    contextBranch: z.enum(["approved-card", "build-and-test-fallback", "none"]),
    toolCallCounts: z.record(z.string(), z.number().int()).optional(),
    cost: z.object({
      workerUsd: z.number().nullable(),
      reviewUsd: z.number().nullable(),
      escalateUsd: z.number().nullable(),
      totalUsd: z.number().nullable(),
    }),
    durationMs: z.number().int().min(0),
    runId: z.string().optional(),
    errorCategory: z.enum(["no-harness", "load-failed", "cancelled", "unknown"]).optional(), // set ONLY with outcome "error"
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

// Single source of truth for where a project's run ledger lives, so callers
// that only need the path don't duplicate this join and risk drifting from
// what appendRun/readRuns actually use. Sibling of wikiDbPath (wiki/store.ts
// :205); same cache/ semantics (auto-gitignored by writeHarness's
// ensureGitignoreGuard, never pruned by regeneration).
export function runsLedgerPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), ".openfusion", "cache", "runs.jsonl");
}

// Validates BEFORE writing — a malformed record is a caller bug, so this
// throws rather than ever writing garbage to the ledger. Callers that want
// fire-and-forget semantics (every real pipeline) go through `recordRun`
// below, which catches this throw too.
export async function appendRun(projectDir: string, record: RunRecord): Promise<void> {
  const validated = RunRecordSchema.parse(record);
  const filePath = runsLedgerPath(projectDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(validated) + "\n");
}

function parseLine(line: string): RunRecord | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const result = RunRecordSchema.safeParse(json);
  return result.success ? result.data : null;
}

// Sync (callers are RPC handlers reading a small, human-paced-volume file;
// see spec §8 on unbounded growth being a later concern). Absent file reads
// as empty history, not an error. Corrupt lines are skipped and counted, not
// thrown, so a crash mid-write never poisons the rest of history.
export function readRuns(
  projectDir: string,
  opts: { kind?: RunRecord["kind"]; limit?: number } = {},
): { records: RunRecord[]; skipped: number } {
  const filePath = runsLedgerPath(projectDir);
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { records: [], skipped: 0 };
    throw err;
  }

  const parsed: RunRecord[] = [];
  let skipped = 0;
  for (const line of content.split("\n")) {
    if (line.length === 0) continue;
    const record = parseLine(line);
    if (record) parsed.push(record);
    else skipped++;
  }

  // File order is oldest-first (append-only); reverse for newest-first,
  // THEN filter by kind, THEN apply the limit — so `limit` always caps the
  // most-recent matching records, not an arbitrary file-order prefix.
  let records = parsed.reverse();
  if (opts.kind) records = records.filter((r) => r.kind === opts.kind);
  const limit = opts.limit ?? 50;
  return { records: records.slice(0, limit), skipped };
}

// The only coupling any pipeline (orchestrate/evals/generate/card) has to
// this module. Wraps the whole appendRun call — including its synchronous
// RunRecordSchema.parse throw — in a promise chain so ANY failure
// (schema-invalid record, disk full, permission error, ENOTDIR, whatever)
// is caught here and never propagates to the caller. On failure, logs the
// record's `kind` only — never its contents.
//
// Returns the never-rejecting promise (rather than `void`, its original
// Task 1 signature) so a write point can AWAIT the append having settled
// before its own RPC response resolves. Callers that don't care about
// ordering may still ignore the return value — error isolation is identical
// either way. The orchestrate write point (orchestrate/methods.ts) awaits
// for two reasons: (1) read-after-write consistency — a client that calls
// engine.orchestrate then engine.runs.list must see the run it just made;
// (2) a write left dangling past the RPC response races the caller's
// subsequent actions against `mkdir`/`appendFile` still in flight on the
// libuv threadpool — concretely, the test suite's per-test temp-project
// teardown (`rmSync(dir, {recursive})`) intermittently threw ENOTEMPTY when
// the unawaited append re-created `.openfusion/cache/runs.jsonl` mid-walk
// (Node's C++ rmSync does not re-scan on concurrent creation).
export function recordRun(engine: Pick<Engine, "log">, projectDir: string, record: RunRecord): Promise<void> {
  return (async () => appendRun(projectDir, record))().catch(() => {
    engine.log(`run-ledger: append failed (${record.kind})`);
  });
}
