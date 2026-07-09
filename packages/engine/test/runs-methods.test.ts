import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { createEngine, type Engine } from "../src/engine.js";
import { appendRun, type RunRecord } from "../src/runs/ledger.js";

let dir: string;
let engine: Engine;

afterEach(async () => {
  if (engine !== undefined) await engine.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

function makeDir(prefix = "of-runs-methods-"): string {
  dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
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

function cardRecord(action: "update" | "approve" = "update"): RunRecord {
  return { v: 1, kind: "card", at: new Date().toISOString(), action };
}

describe("engine.runs.list", () => {
  it("returns appended records newest-first", async () => {
    engine = createEngine();
    makeDir();
    await appendRun(dir, orchestrateRecord("a"));
    await appendRun(dir, orchestrateRecord("b"));

    const res = await call("engine.runs.list", { projectDir: dir });

    expect(res.error).toBeUndefined();
    expect(res.result.skipped).toBe(0);
    expect(res.result.records).toHaveLength(2);
    expect(res.result.records[0]).toMatchObject({ taskClass: "b" });
    expect(res.result.records[1]).toMatchObject({ taskClass: "a" });
  });

  it("respects the kind param", async () => {
    engine = createEngine();
    makeDir();
    await appendRun(dir, orchestrateRecord("a"));
    await appendRun(dir, cardRecord());

    const res = await call("engine.runs.list", { projectDir: dir, kind: "card" });

    expect(res.error).toBeUndefined();
    expect(res.result.records).toHaveLength(1);
    expect(res.result.records[0]?.kind).toBe("card");
  });

  it("respects the limit param", async () => {
    engine = createEngine();
    makeDir();
    await appendRun(dir, orchestrateRecord("a"));
    await appendRun(dir, orchestrateRecord("b"));
    await appendRun(dir, orchestrateRecord("c"));

    const res = await call("engine.runs.list", { projectDir: dir, limit: 2 });

    expect(res.error).toBeUndefined();
    expect(res.result.records.map((r: RunRecord) => (r.kind === "orchestrate" ? r.taskClass : undefined))).toEqual([
      "c",
      "b",
    ]);
  });

  it("returns an empty result for a directory with no ledger, no git guard", async () => {
    engine = createEngine();
    makeDir();

    const res = await call("engine.runs.list", { projectDir: dir });

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ records: [], skipped: 0 });
  });

  it("rejects limit: 0 at the schema level", async () => {
    engine = createEngine();
    makeDir();

    const res = await call("engine.runs.list", { projectDir: dir, limit: 0 });

    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.INVALID_PARAMS);
  });
});
