import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Copied from orchestrate.test.ts's own makeRepo helper (final-review Fix 1's
// regression test needs a real git repo to exercise `git check-ignore`
// against, not just a bare tmpdir).
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(prefix = "of-ledger-repo-"): string {
  const base = mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", base]);
  git(base, "config", "user.email", "t@t");
  git(base, "config", "user.name", "t");
  writeFileSync(path.join(base, "README.md"), "hello\n");
  git(base, "add", "-A");
  git(base, "commit", "-qm", "init");
  return base;
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

  it("rejects an invalid record and writes nothing — not even a .gitignore", async () => {
    makeDir();
    const invalid = { v: 1, kind: "card", action: "update" } as unknown as RunRecord; // missing `at`
    await expect(appendRun(dir, invalid)).rejects.toThrow();
    expect(existsSync(runsLedgerPath(dir))).toBe(false);
    // Fix 1 (final review): the gitignore self-guard sits AFTER the schema
    // parse, so a caller bug that never should have written anything to the
    // ledger also never creates the guard file — validate-before-disk holds
    // for the guard too, not just the record itself.
    expect(existsSync(path.join(dir, ".openfusion", ".gitignore"))).toBe(false);
    expect(existsSync(path.join(dir, ".openfusion"))).toBe(false);
  });

  it("skips a valid-JSON-but-unknown-kind line and a version-mismatched line hand-appended between two valid records, counting both (read-path forward-compat, Fix 2)", async () => {
    makeDir();
    await appendRun(dir, orchestrateRecord("a"));
    // A structurally-valid JSON line whose `kind` doesn't exist in the
    // discriminated union at all — e.g. a record written by some future
    // engine version this build has never heard of.
    appendFileSync(runsLedgerPath(dir), JSON.stringify({ v: 1, kind: "v2future", at: "2026-01-01T00:00:00.000Z" }) + "\n");
    // A structurally-valid JSON line for a KNOWN kind but the WRONG schema
    // version (and missing that kind's required fields) — e.g. a future
    // engine version's v2 orchestrate record shape.
    appendFileSync(
      runsLedgerPath(dir),
      JSON.stringify({ v: 2, kind: "orchestrate", at: "2026-01-01T00:00:00.000Z" }) + "\n",
    );
    await appendRun(dir, orchestrateRecord("b"));

    const { records, skipped } = readRuns(dir);
    expect(skipped).toBe(2);
    expect(records).toHaveLength(2);
    expect(records.map((r) => (r.kind === "orchestrate" ? r.taskClass : undefined))).toEqual(["b", "a"]);
  });
});

describe("appendRun — gitignore self-guard (final-review Fix 1)", () => {
  it("creates .openfusion/.gitignore covering cache/ on a fresh git repo where nothing has written .openfusion yet, so runs.jsonl is actually git-ignored", async () => {
    dir = makeRepo();
    expect(existsSync(path.join(dir, ".openfusion"))).toBe(false);

    await appendRun(dir, orchestrateRecord("a"));

    const gitignorePath = path.join(dir, ".openfusion", ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, "utf8")).toContain("cache/");

    // git check-ignore exits 0 (and execFileSync throws on any nonzero exit)
    // when the path IS ignored — this is the empirical repro from the
    // reviewer's report: pre-fix, `git status` on a repo like this shows
    // `?? .openfusion/` (the whole ledger, `runs.jsonl` included) as
    // committable; post-fix, the ledger file itself is ignored.
    expect(() =>
      execFileSync("git", ["-C", dir, "check-ignore", path.join(".openfusion", "cache", "runs.jsonl")]),
    ).not.toThrow();

    // The invariant the reviewer's repro actually cares about: `git status`
    // never lists the ledger file as untracked/committable (the guard's own
    // `.gitignore` legitimately DOES still show as untracked here, same as
    // every other ensureGitignoreGuard call site — that file is meant to be
    // committed alongside a generated harness, just like harness/store.ts's
    // and worker/worktree.ts's own guard writes).
    const status = git(dir, "status", "--porcelain");
    expect(status).not.toContain("runs.jsonl");
    expect(status).not.toContain("cache/");
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

  it("never throws and logs a kind-only message — no record field values — on an fs failure", async () => {
    makeDir();
    // Make .openfusion an existing FILE so ensureGitignoreGuard's own
    // mkdirSync(.openfusion) (Fix 1's self-guard, now the first thing
    // appendRun does past schema validation) fails with EEXIST/ENOTDIR.
    writeFileSync(path.join(dir, ".openfusion"), "not a directory");
    const log = vi.fn();
    const action = "approve" as const;
    const record = cardRecord(action);

    expect(() => recordRun({ log }, dir, record)).not.toThrow();

    await vi.waitFor(() => {
      expect(log).toHaveBeenCalledTimes(1);
    });
    const logged = log.mock.calls[0]?.[0] as string;
    // Fix 4 (final review): pin the EXACT kind-only shape — `(card)`, this
    // fixture's kind — so there's no room for a field value to have snuck in
    // anywhere else in the string either.
    expect(logged).toBe("run-ledger: append failed (card)");
    // And explicitly assert none of the record's own field VALUES (as
    // opposed to `kind`, which the message format deliberately includes)
    // leak into the log line.
    expect(logged).not.toContain(action);
    expect(logged).not.toContain(record.at);
  });
});
