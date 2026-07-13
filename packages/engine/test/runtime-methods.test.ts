import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";

let dir: string | undefined;
let engine: Engine | undefined;
let appStorageDir: string | undefined;

afterEach(async () => {
  await engine?.close();
  engine = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  if (appStorageDir !== undefined) rmSync(appStorageDir, { recursive: true, force: true });
  dir = undefined;
  appStorageDir = undefined;
});

function project(): string {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-runtime-rpc-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.test"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Runtime Test"]);
  execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-qm", "base"]);
  return dir;
}

async function rpc(method: string, params: unknown): Promise<any> {
  return engine!.dispatcher.dispatch({ jsonrpc: "2.0", id: "test", method, params });
}

describe("runtime RPC", () => {
  it("configures the host key memory-only and reports the durable store/sandbox status", async () => {
    const projectDir = project();
    engine = createEngine();
    const configured = await rpc("engine.runtime.configure", {
      projectDir,
      traceKey: Buffer.alloc(32, 3).toString("base64"),
      traceEnabled: true,
      retentionDays: 9,
    });
    expect(configured.error).toBeUndefined();
    expect(configured.result.configuration).toMatchObject({ traceEnabled: true, retentionDays: 9 });

    const status = await rpc("engine.runtime.status", { projectDir });
    expect(status.error).toBeUndefined();
    expect(status.result.keyState).toBe("host");
    expect(status.result.database).toMatchObject({ schemaVersion: 4, integrity: "ok" });
    expect(status.result.sandbox).toMatchObject({ backend: "openfusion-sandbox", provisional: false });
  });

  it("returns immediately from orchestrate.start and persists terminal failure asynchronously", async () => {
    const projectDir = project();
    const notifications: Array<{ method: string; params: any }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    await rpc("engine.runtime.configure", {
      projectDir,
      traceKey: Buffer.alloc(32, 4).toString("base64"),
      traceEnabled: true,
    });

    const sentinel = "TASK_TEXT_MUST_NOT_ENTER_NOTIFICATION_48ad";
    const started = await rpc("engine.orchestrate.start", { projectDir, task: sentinel });
    expect(started.error).toBeUndefined();
    expect(started.result).toMatchObject({ status: "created", version: 1 });

    let session: any;
    for (let index = 0; index < 100; index += 1) {
      const response = await rpc("engine.sessions.get", {
        projectDir,
        sessionId: started.result.sessionId,
        includeEvents: true,
      });
      session = response.result.session;
      if (["completed", "failed", "cancelled"].includes(session.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(session.status).toBe("failed");
    expect(JSON.stringify(notifications)).not.toContain(sentinel);
    expect(notifications.some((entry) => entry.method === "session.changed")).toBe(true);
  });

  it("rejects stale session actions with the current version", async () => {
    const projectDir = project();
    engine = createEngine();
    const store = engine.runtime.getStore(projectDir);
    const created = store.createSession({ kind: "worker" });
    const running = store.updateSession(created.id, created.version, { status: "running" });

    const stale = await rpc("engine.sessions.action", {
      projectDir,
      sessionId: running.id,
      expectedVersion: created.version,
      action: { type: "cancel" },
    });
    expect(stale.error).toMatchObject({
      code: -32001,
      data: { expectedVersion: created.version, actualVersion: running.version },
    });
  });

  it("lists metadata without exposing encrypted content unless get explicitly requests events", async () => {
    const projectDir = project();
    engine = createEngine();
    engine.runtime.configure(projectDir, {
      traceKey: Buffer.alloc(32, 5).toString("base64"),
      traceEnabled: true,
    });
    const store = engine.runtime.getStore(projectDir);
    const session = store.createSession({ kind: "worker", initialPayload: { task: "private" } });

    const listed = await rpc("engine.sessions.list", { projectDir });
    expect(listed.error).toBeUndefined();
    expect(listed.result.sessions[0]).not.toHaveProperty("events");
    expect(JSON.stringify(listed.result)).not.toContain("private");

    const fetched = await rpc("engine.sessions.get", {
      projectDir,
      sessionId: session.id,
      includeEvents: true,
    });
    expect(fetched.result.events[0].payload).toEqual({
      state: "available",
      value: { task: "private" },
    });
  });

  it("reconstructs a fresh worktree from the last encrypted checkpoint", async () => {
    const projectDir = project();
    appStorageDir = mkdtempSync(path.join(os.tmpdir(), "of-runtime-recovery-"));
    engine = createEngine({ appStorageDir });
    engine.runtime.configure(projectDir, {
      traceKey: Buffer.alloc(32, 6).toString("base64"),
      traceEnabled: true,
    });
    const store = engine.runtime.getStore(projectDir);
    const created = store.createSession({ kind: "worker" });
    const manager = await engine.worker.getManager(projectDir);
    const worktree = await manager.create(created.id);
    let session = store.updateSession(created.id, created.version, {
      status: "running",
      worktreePath: worktree.path,
      baseSha: worktree.baseSha,
    });
    writeFileSync(path.join(worktree.path, "recovered.txt"), "checkpointed\n", "utf8");
    const patch = await manager.checkpointPatch(worktree);
    store.putCheckpoint({
      sessionId: session.id,
      baseSha: worktree.baseSha,
      worktreeFingerprint: "worktree-v1",
      patch: Buffer.from(patch, "utf8"),
    });
    await manager.remove(worktree);
    session = store.updateSession(session.id, session.version, { status: "needs-recovery" });

    const recovered = await rpc("engine.sessions.action", {
      projectDir,
      sessionId: session.id,
      expectedVersion: session.version,
      action: { type: "recover-checkpoint" },
    });
    expect(recovered.error).toBeUndefined();
    expect(recovered.result.session.status).toBe("interrupted");
    expect(recovered.result.session.worktreePath).not.toBe(worktree.path);
    expect(existsSync(recovered.result.session.worktreePath)).toBe(true);
    expect(readFileSync(path.join(recovered.result.session.worktreePath, "recovered.txt"), "utf8"))
      .toBe("checkpointed\n");
  });
});
