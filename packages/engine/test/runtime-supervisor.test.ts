import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { RpcErrorCodes, RunSpanEventV2Schema } from "@openfusion/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import {
  MAX_ACTIVE_TOP_LEVEL_RUNS,
  MAX_QUEUED_TOP_LEVEL_RUNS,
  recoverInterruptedRunJournals,
  RunSupervisor,
} from "../src/runtime/supervisor.js";

const cleanupRoots: string[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupRoots.push(root);
  return root;
}

function makeRepo(): string {
  const root = tempRoot("of-supervisor-repo-");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "OpenFusion Test"]);
  writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return root;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before the test deadline");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function journalFiles(root: string): string[] {
  if (!statSync(root, { throwIfNoEntry: false })) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const child = path.join(root, entry);
    if (statSync(child).isDirectory()) result.push(...journalFiles(child));
    else if (entry === "journal.v2.jsonl") result.push(child);
  }
  return result;
}

describe("RunSupervisor cost estimates", () => {
  function supervisor(): RunSupervisor {
    const appStorageDir = tempRoot("of-supervisor-cost-");
    const engine = { appStorageDir, log: () => {} } as unknown as Engine;
    return new RunSupervisor(
      engine,
      { projectDir: appStorageDir, kind: "verify", writer: false },
      new AbortController(),
    );
  }

  it("distinguishes no calls, zero-cost priced calls, and partial pricing", () => {
    const run = supervisor();
    expect(run.costEstimate()).toMatchObject({
      knownUsd: 0,
      completeness: "none",
      unpricedCalls: 0,
      confidence: "unpriced",
    });

    run.recordCost(0, "verified");
    expect(run.costEstimate()).toMatchObject({
      knownUsd: 0,
      completeness: "complete",
      unpricedCalls: 0,
      confidence: "verified",
    });

    run.recordCost(null, "unpriced");
    expect(run.costEstimate()).toMatchObject({
      knownUsd: 0,
      completeness: "partial",
      unpricedCalls: 1,
      confidence: "mixed",
    });
  });

  it("reports mixed confidence when priced sources disagree", () => {
    const run = supervisor();
    run.recordCost(0.1, "verified");
    run.recordCost(0.2, "estimated");
    const estimate = run.costEstimate();
    expect(estimate).toMatchObject({
      completeness: "complete",
      confidence: "mixed",
    });
    expect(estimate.knownUsd).toBeCloseTo(0.3);
  });
});

describe("RunKernel admission and journal invariants", () => {
  it("caps active and queued runs and returns the stable BUSY error", async () => {
    const appStorageDir = tempRoot("of-kernel-storage-");
    const projectDir = makeRepo();
    const engine = createEngine({ appStorageDir });
    engines.push(engine);
    const gate = deferred();
    const admitted = Array.from(
      { length: MAX_ACTIVE_TOP_LEVEL_RUNS + MAX_QUEUED_TOP_LEVEL_RUNS },
      () => engine.runKernel.run(
        { projectDir, kind: "verify", writer: false },
        async () => gate.promise,
      ),
    );

    await waitUntil(() =>
      engine.runKernel.activeCount() === MAX_ACTIVE_TOP_LEVEL_RUNS
      && engine.runKernel.queuedCount() === MAX_QUEUED_TOP_LEVEL_RUNS
    );
    const rejected = engine.runKernel.run(
      { projectDir, kind: "verify", writer: false },
      async () => undefined,
    );
    await expect(rejected).rejects.toMatchObject({
      code: RpcErrorCodes.BUSY,
      data: expect.objectContaining({ reasonCode: "queue-full", retryAfterMs: 1_000 }),
    });

    gate.resolve();
    await Promise.all(admitted);
    expect(engine.runKernel.activeCount()).toBe(0);
    expect(engine.runKernel.queuedCount()).toBe(0);
  });

  it("serializes writers for one project and emits one root terminal event", async () => {
    const appStorageDir = tempRoot("of-kernel-writer-");
    const projectDir = makeRepo();
    const engine = createEngine({ appStorageDir });
    engines.push(engine);
    const firstGate = deferred();
    const secondGate = deferred();
    const sequence: string[] = [];

    const first = engine.runKernel.run(
      { runId: "writer-one", projectDir, kind: "orchestrate", writer: true },
      async () => {
        sequence.push("first-start");
        await firstGate.promise;
        sequence.push("first-end");
      },
    );
    const second = engine.runKernel.run(
      { runId: "writer-two", projectDir, kind: "orchestrate", writer: true },
      async () => {
        sequence.push("second-start");
        await secondGate.promise;
        sequence.push("second-end");
      },
    );

    await waitUntil(() => sequence.includes("first-start"));
    expect(sequence).not.toContain("second-start");
    expect(engine.runKernel.activeCount()).toBe(1);
    firstGate.resolve();
    await first;
    await waitUntil(() => sequence.includes("second-start"));
    secondGate.resolve();
    await second;
    expect(sequence).toEqual(["first-start", "first-end", "second-start", "second-end"]);

    const journals = journalFiles(path.join(appStorageDir, "runs"));
    expect(journals).toHaveLength(2);
    for (const journal of journals) {
      const events = readFileSync(journal, "utf8")
        .trim()
        .split("\n")
        .map((line) => RunSpanEventV2Schema.parse(JSON.parse(line)));
      expect(events.filter((event) => event.parentSpanId === null && event.terminal)).toHaveLength(1);
    }
  });

  it("forces supervisor cleanup after the shutdown deadline and keeps cancellation authoritative", async () => {
    const appStorageDir = tempRoot("of-kernel-shutdown-");
    const projectDir = makeRepo();
    const engine = createEngine({ appStorageDir });
    engines.push(engine);
    const runGate = deferred();
    const cleanupCalled = deferred();
    const run = engine.runKernel.run(
      { runId: "uncooperative-run", projectDir, kind: "verify", writer: false },
      async (supervisor) => {
        supervisor.addCleanup(() => cleanupCalled.resolve());
        await runGate.promise;
      },
    );
    await waitUntil(() => engine.runKernel.activeCount() === 1);

    await engine.runKernel.close(20);
    await cleanupCalled.promise;
    runGate.resolve();
    await expect(run).rejects.toThrow("run cancelled");
  });
});

describe("interrupted journal recovery", () => {
  function writeStartedJournal(appStorageDir: string, runId: string, ownerPid?: number): string {
    const runDir = path.join(appStorageDir, "runs", "project", runId);
    mkdirSync(runDir, { recursive: true });
    const journal = path.join(runDir, "journal.v2.jsonl");
    const started = RunSpanEventV2Schema.parse({
      schemaVersion: 2,
      runId,
      spanId: `${runId}-root`,
      parentSpanId: null,
      attemptId: null,
      seq: 1,
      at: new Date().toISOString(),
      type: "run.started",
      terminal: false,
      metadata: ownerPid === undefined ? {} : { ownerPid },
    });
    writeFileSync(journal, `${JSON.stringify(started)}\n`);
    return journal;
  }

  it("truthfully finalizes an ownerless journal once and skips a live owner", () => {
    const appStorageDir = tempRoot("of-recovery-");
    const interrupted = writeStartedJournal(appStorageDir, "interrupted-run");
    writeStartedJournal(appStorageDir, "active-run", process.pid);

    expect(recoverInterruptedRunJournals(appStorageDir)).toEqual({
      recovered: 1,
      skippedActive: 1,
      malformed: 0,
    });
    expect(recoverInterruptedRunJournals(appStorageDir)).toEqual({
      recovered: 0,
      skippedActive: 1,
      malformed: 0,
    });

    const events = readFileSync(interrupted, "utf8")
      .trim()
      .split("\n")
      .map((line) => RunSpanEventV2Schema.parse(JSON.parse(line)));
    expect(events.filter((event) => event.terminal)).toEqual([
      expect.objectContaining({ type: "run.interrupted", reasonCode: "interrupted-nonresumable" }),
    ]);
  });

  it("does not throw when a journal cannot be read as a file", () => {
    const appStorageDir = tempRoot("of-recovery-damaged-");
    const damaged = path.join(appStorageDir, "runs", "project", "damaged", "journal.v2.jsonl");
    mkdirSync(damaged, { recursive: true });
    expect(recoverInterruptedRunJournals(appStorageDir)).toEqual({
      recovered: 0,
      skippedActive: 0,
      malformed: 1,
    });
  });
});
