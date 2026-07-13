import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendRun,
  readRuns,
  recordRun,
  runsLedgerPath,
  type RunRecord,
} from "../src/runs/ledger.js";

let dir: string;
afterEach(() => {
  // best-effort cleanup
  try {
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeDir(): string {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-ledger-"));
  return dir;
}

function orchestrateRec(overrides: Partial<Extract<RunRecord, { kind: "orchestrate" }>> = {}): RunRecord {
  return {
    v: 1,
    kind: "orchestrate",
    at: "2026-07-09T12:00:00.000Z",
    taskClass: "codegen",
    agent: "coder",
    workerModel: "deepseek-v4-flash",
    attempts: 1,
    outcome: "worker-approved",
    escalated: false,
    reviews: [{ decision: "approve", reasonCount: 1 }],
    contextBranch: "approved-card",
    cost: { workerUsd: 0.01, reviewUsd: 0.02, escalateUsd: null, totalUsd: 0.03 },
    durationMs: 100,
    ...overrides,
  };
}

describe("runs ledger", () => {
  it("paths under .openfusion/cache/runs.jsonl", () => {
    makeDir();
    expect(runsLedgerPath(dir).endsWith(path.join(".openfusion", "cache", "runs.jsonl"))).toBe(true);
  });

  it("append → read newest-first with limit and kind filter", async () => {
    makeDir();
    await appendRun(dir, orchestrateRec({ at: "2026-07-09T12:00:00.000Z", agent: "a" }));
    await appendRun(dir, orchestrateRec({ at: "2026-07-09T12:01:00.000Z", agent: "b" }));
    await appendRun(dir, { v: 1, kind: "card", at: "2026-07-09T12:02:00.000Z", action: "approve" });
    await appendRun(dir, {
      v: 1,
      kind: "apply",
      at: "2026-07-09T12:03:00.000Z",
      outcome: "succeeded",
      durationMs: 12,
      runId: "run-1",
    });

    const all = readRuns(dir, { limit: 10 });
    expect(all.records[0]?.kind).toBe("apply");
    expect(all.records[1]?.kind).toBe("card");
    expect(all.records[2]).toMatchObject({ kind: "orchestrate", agent: "b" });
    expect(all.records[3]).toMatchObject({ kind: "orchestrate", agent: "a" });

    const cards = readRuns(dir, { kind: "card" });
    expect(cards.records).toHaveLength(1);
    expect(cards.records[0]?.kind).toBe("card");

    const applies = readRuns(dir, { kind: "apply" });
    expect(applies.records).toEqual([
      expect.objectContaining({ kind: "apply", outcome: "succeeded", runId: "run-1" }),
    ]);

    const limited = readRuns(dir, { limit: 1 });
    expect(limited.records).toHaveLength(1);
    expect(limited.records[0]?.kind).toBe("apply");
  });

  it("tolerates corrupt lines", async () => {
    makeDir();
    await appendRun(dir, orchestrateRec({ agent: "a" }));
    const p = runsLedgerPath(dir);
    writeFileSync(p, `${readFileSyncSafe(p)}not-json\n`, "utf8");
    await appendRun(dir, orchestrateRec({ agent: "b", at: "2026-07-09T13:00:00.000Z" }));

    const result = readRuns(dir);
    expect(result.records).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it("absent file → empty", () => {
    makeDir();
    expect(readRuns(dir)).toEqual({ records: [], skipped: 0 });
  });

  it("recordRun never throws on failure", async () => {
    // Point projectDir at a path where .openfusion is a FILE so mkdir fails.
    makeDir();
    const broken = path.join(dir, "broken-proj");
    mkdirSync(broken);
    writeFileSync(path.join(broken, ".openfusion"), "not-a-dir", "utf8");
    const logs: string[] = [];
    recordRun({ log: (m) => logs.push(m) }, broken, orchestrateRec());
    // Allow microtask queue to flush the fire-and-forget promise.
    await new Promise((r) => setTimeout(r, 50));
    expect(logs.some((l) => l.includes("run-ledger: append failed"))).toBe(true);
  });

  it("stores review counts without model-authored review text", async () => {
    makeDir();
    const rec = orchestrateRec();
    await appendRun(dir, rec);
    const raw = readFileSyncSafe(runsLedgerPath(dir));
    expect(raw).not.toContain("UNIQUE-TASK-MARKER");
    expect(raw).toContain('"reasonCount":1');
    expect(raw).not.toContain("looks good");
  });
});

function readFileSyncSafe(p: string): string {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}
