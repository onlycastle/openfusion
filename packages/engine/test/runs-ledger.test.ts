import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendRun, readRuns, recordRun, runsLedgerPath, type RunRecord } from "../src/runs/ledger.js";

let dir: string;
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix = "of-ledger-"): string {
  dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

function cardRecord(action: "update" | "approve" = "update"): RunRecord {
  return { v: 1, kind: "card", at: new Date().toISOString(), action };
}

function orchestrateRecord(taskClass: string): RunRecord {
  return {
    v: 1,
    kind: "orchestrate",
    at: new Date().toISOString(),
    taskClass,
    agent: "coder",
    workerModel: "frontier",
    attempts: 1,
    outcome: "worker-approved",
    escalated: false,
    reviews: [],
    contextBranch: "none",
    cost: { workerUsd: null, reviewUsd: null, escalateUsd: null, totalUsd: null },
    durationMs: 100,
  };
}

describe("runsLedgerPath", () => {
  it("ends with .openfusion/cache/runs.jsonl", () => {
    makeDir();
    const p = runsLedgerPath(dir);
    expect(p).toBe(path.join(path.resolve(dir), ".openfusion", "cache", "runs.jsonl"));
    expect(p.endsWith(path.join(".openfusion", "cache", "runs.jsonl"))).toBe(true);
  });
});

describe("appendRun + readRuns", () => {
  it("roundtrips append -> read, newest first", async () => {
    makeDir();
    await appendRun(dir, orchestrateRecord("a"));
    await appendRun(dir, orchestrateRecord("b"));

    const { records, skipped } = readRuns(dir);
    expect(skipped).toBe(0);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ taskClass: "b" });
    expect(records[1]).toMatchObject({ taskClass: "a" });
  });

  it("applies limit after reversal", async () => {
    makeDir();
    await appendRun(dir, orchestrateRecord("a"));
    await appendRun(dir, orchestrateRecord("b"));
    await appendRun(dir, orchestrateRecord("c"));

    const { records, skipped } = readRuns(dir, { limit: 2 });
    expect(skipped).toBe(0);
    expect(records.map((r) => (r.kind === "orchestrate" ? r.taskClass : undefined))).toEqual(["c", "b"]);
  });

  it("filters by kind", async () => {
    makeDir();
    await appendRun(dir, orchestrateRecord("a"));
    await appendRun(dir, cardRecord());

    const { records, skipped } = readRuns(dir, { kind: "card" });
    expect(skipped).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("card");
  });

  it("skips a corrupt line hand-appended between two valid lines, counting it", async () => {
    makeDir();
    await appendRun(dir, orchestrateRecord("a"));
    appendFileSync(runsLedgerPath(dir), "not valid json garbage\n");
    await appendRun(dir, orchestrateRecord("b"));

    const { records, skipped } = readRuns(dir);
    expect(records).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  it("returns empty with 0 skipped when the file does not exist", () => {
    makeDir();
    expect(readRuns(dir)).toEqual({ records: [], skipped: 0 });
  });

  it("rejects an invalid record and writes nothing", async () => {
    makeDir();
    const invalid = { v: 1, kind: "card", action: "update" } as unknown as RunRecord; // missing `at`
    await expect(appendRun(dir, invalid)).rejects.toThrow();
    expect(existsSync(runsLedgerPath(dir))).toBe(false);
  });
});

describe("recordRun", () => {
  it("fire-and-forget: appends silently on a valid record, never calling log", async () => {
    makeDir();
    const log = vi.fn();
    recordRun({ log }, dir, cardRecord());

    await vi.waitFor(() => {
      expect(readRuns(dir).records).toHaveLength(1);
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("never throws and logs a kind-only message on an fs failure", async () => {
    makeDir();
    // Make .openfusion an existing FILE so mkdir(.openfusion/cache) fails with ENOTDIR.
    writeFileSync(path.join(dir, ".openfusion"), "not a directory");
    const log = vi.fn();

    expect(() => recordRun({ log }, dir, cardRecord())).not.toThrow();

    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledTimes(1);
    });
    expect(log.mock.calls[0]?.[0]).toContain("run-ledger: append failed");
  });
});
