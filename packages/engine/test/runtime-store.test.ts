import Database from "better-sqlite3";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeContentLockedError, RuntimeContentTamperedError } from "../src/runtime/crypto.js";
import {
  MAX_ARTIFACT_BYTES,
  MAX_SESSION_ARTIFACT_BYTES,
  RuntimeArtifactLimitError,
  RuntimeStore,
  RuntimeVersionConflictError,
  runtimeDbPath,
} from "../src/runtime/store.js";
import { DEFAULT_RUNTIME_CONFIGURATION } from "../src/runtime/types.js";

let dir: string | undefined;
let store: RuntimeStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function makeProject(): string {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-runtime-store-"));
  return dir;
}

function key(byte = 7): Buffer {
  return Buffer.alloc(32, byte);
}

describe("RuntimeStore", () => {
  it("keeps the robust-harness artifact, session, and vault byte budgets", () => {
    expect(MAX_ARTIFACT_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_SESSION_ARTIFACT_BYTES).toBe(256 * 1024 * 1024);
    expect(DEFAULT_RUNTIME_CONFIGURATION.retentionBytes).toBe(2 * 1024 * 1024 * 1024);
  });

  it("keeps authoritative SQLite project-local and encrypted artifacts host-private", () => {
    const projectDir = makeProject();
    const storageDir = path.join(projectDir, "host-state");
    const worktreeRoot = path.join(storageDir, "worktrees");
    const worktree = path.join(worktreeRoot, "project", "task");
    mkdirSync(worktree, { recursive: true });
    store = new RuntimeStore({ projectDir, storageDir, worktreeRoot, key: key() });
    const created = store.createSession({ kind: "worker" });
    store.updateSession(created.id, created.version, { status: "running", worktreePath: worktree });
    const artifact = store.putArtifact(created.id, "tool-output", Buffer.from("private"));

    expect(store.dbPath).toBe(path.join(projectDir, ".openfusion", "cache", "runtime.db"));
    expect(existsSync(store.dbPath)).toBe(true);
    const db = new Database(store.dbPath, { readonly: true });
    const sessionRow = db.prepare("SELECT project_dir, worktree_path FROM sessions WHERE id = ?")
      .get(created.id) as { project_dir: string; worktree_path: string };
    const artifactRow = db.prepare("SELECT encrypted_path FROM artifacts WHERE id = ?")
      .get(artifact.id) as { encrypted_path: string };
    db.close();
    expect(sessionRow.project_dir).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(sessionRow.worktree_path).toMatch(/^worktree:/);
    expect(artifactRow.encrypted_path).toMatch(/^artifact:/);
    expect(JSON.stringify({ sessionRow, artifactRow })).not.toContain(projectDir);
    expect(store.requireSession(created.id).worktreePath).toBe(realpathSync(worktree));
  });

  it("opens runtime.db in WAL/FULL mode and applies forward-only migrations", () => {
    const projectDir = makeProject();
    store = new RuntimeStore({ projectDir, key: key() });

    expect(store.dbPath).toBe(runtimeDbPath(projectDir));
    expect(store.schemaVersion()).toBe(4);
    expect(store.integrityCheck()).toEqual({ ok: true, messages: ["ok"] });

    expect(store.durabilityStatus()).toEqual({ journalMode: "wal", synchronous: 2 });
  });

  it("encrypts content-bearing events and reports locked content without the key", () => {
    const projectDir = makeProject();
    const sentinel = "TASK_SENTINEL_NEVER_PLAINTEXT_86cf";
    store = new RuntimeStore({ projectDir, key: key() });
    store.configure({ traceEnabled: true });
    const session = store.createSession({ kind: "worker", initialPayload: { task: sentinel } });

    expect(store.listEvents(session.id)[0]?.payload).toEqual({
      state: "available",
      value: { task: sentinel },
    });
    store.close();
    store = undefined;

    const databaseBytes = readFileSync(runtimeDbPath(projectDir));
    expect(databaseBytes.includes(Buffer.from(sentinel))).toBe(false);

    store = new RuntimeStore({ projectDir });
    expect(store.requireSession(session.id).resumeCapability).toBe("locked");
    expect(store.listEvents(session.id)[0]?.payload).toEqual({ state: "locked" });
  });

  it("detects authenticated-record tampering", () => {
    const projectDir = makeProject();
    store = new RuntimeStore({ projectDir, key: key() });
    store.configure({ traceEnabled: true });
    const session = store.createSession({ kind: "worker", initialPayload: { task: "safe" } });

    const db = new Database(store.dbPath);
    db.prepare(
      "UPDATE events SET payload_ciphertext = zeroblob(length(payload_ciphertext)) WHERE session_id = ? AND seq = 1",
    ).run(session.id);
    db.close();

    expect(() => store!.listEvents(session.id)).toThrow(RuntimeContentTamperedError);
  });

  it("uses optimistic versions and rolls back a losing update", () => {
    store = new RuntimeStore({ projectDir: makeProject() });
    const created = store.createSession({ kind: "orchestrate" });
    const running = store.updateSession(created.id, created.version, { status: "running" });
    expect(running.version).toBe(2);

    expect(() =>
      store!.updateSession(created.id, created.version, { status: "cancelled" }),
    ).toThrow(RuntimeVersionConflictError);
    expect(store.requireSession(created.id).status).toBe("running");
  });

  it("classifies incomplete side effects as needs-recovery even without exact traces", () => {
    const projectDir = makeProject();
    store = new RuntimeStore({ projectDir });
    const created = store.createSession({ kind: "worker" });
    store.updateSession(created.id, created.version, { status: "running" });
    store.appendEvent(created.id, { type: "tool.started", metadata: { tool: "write_file" } });
    store.close();
    store = undefined;

    store = new RuntimeStore({ projectDir });
    expect(store.requireSession(created.id)).toMatchObject({
      status: "needs-recovery",
      outcome: "interrupted-nonresumable",
      resumeCapability: "worktree-only",
    });
  });

  it("keeps an ordinary in-flight session resumable after restart without replaying tools", () => {
    const projectDir = makeProject();
    store = new RuntimeStore({ projectDir, key: key() });
    store.configure({ traceEnabled: true });
    const created = store.createSession({ kind: "worker" });
    store.updateSession(created.id, created.version, { status: "running" });
    store.appendEvent(created.id, { type: "model.response", payload: { role: "assistant" } });
    store.close();
    store = undefined;

    store = new RuntimeStore({ projectDir, key: key() });
    const interrupted = store.requireSession(created.id);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.resumeCapability).toBe("exact");
  });

  it("writes encrypted artifacts atomically, pages them, and deduplicates plaintext", () => {
    store = new RuntimeStore({ projectDir: makeProject(), key: key() });
    store.configure({ traceEnabled: true });
    const session = store.createSession({ kind: "worker" });
    const bytes = Buffer.from("abcdefghijklmnopqrstuvwxyz", "utf8");
    const first = store.putArtifact(session.id, "tool-output", bytes);
    const second = store.putArtifact(session.id, "tool-output", bytes);

    expect(first.id).not.toBe(second.id);
    expect(store.readArtifact(second.id)).toEqual(bytes);
    expect(store.readArtifactPage(first.id, { offset: 5, limit: 4 })).toMatchObject({
      content: "fghi",
      offset: 5,
      nextOffset: 9,
      totalBytes: 26,
    });

    const db = new Database(store.dbPath, { readonly: true });
    const locations = db.prepare(
      "SELECT encrypted_path FROM artifacts ORDER BY created_at, id",
    ).all() as Array<{ encrypted_path: string }>;
    db.close();
    expect(new Set(locations.map((row) => row.encrypted_path)).size).toBe(1);
    expect(locations[0]!.encrypted_path).toMatch(/^artifact:/);
    const encryptedPath = path.join(
      store.artifactRoot,
      locations[0]!.encrypted_path.slice("artifact:".length),
    );
    expect(readFileSync(encryptedPath).includes(bytes)).toBe(false);
  });

  it("enforces the artifact byte ceiling without buffering beyond it", () => {
    store = new RuntimeStore({ projectDir: makeProject(), key: key() });
    store.configure({ traceEnabled: true });
    const session = store.createSession({ kind: "worker" });
    const writer = store.beginArtifact(session.id, "tool-output", { maxBytes: 8 });

    expect(writer.write("abcdef")).toEqual({ acceptedBytes: 6, limitReached: false });
    expect(writer.write("ghijkl")).toEqual({ acceptedBytes: 2, limitReached: true });
    const artifact = writer.finish();
    expect(artifact.size).toBe(8);
    expect(store.readArtifact(artifact.id).toString("utf8")).toBe("abcdefgh");
  });

  it("caps every artifact at 16 MiB and deletes transient content when a non-vault run terminates", () => {
    store = new RuntimeStore({ projectDir: makeProject(), key: key() });
    const created = store.createSession({ kind: "worker" });
    const running = store.updateSession(created.id, created.version, { status: "running" });
    expect(() => store!.putArtifact(
      created.id,
      "too-large",
      Buffer.alloc(MAX_ARTIFACT_BYTES + 1),
    )).toThrow(RuntimeArtifactLimitError);

    const artifact = store.putArtifact(created.id, "tool-output", Buffer.from("transient"));
    store.updateSession(created.id, running.version, { status: "completed" });
    expect(store.getArtifact(artifact.id)?.retentionState).toBe("expired");
    expect(() => store!.readArtifact(artifact.id)).toThrow("runtime artifact not found");
  });

  it("removes temporary and unreferenced artifact files on startup", () => {
    const projectDir = makeProject();
    store = new RuntimeStore({ projectDir, key: key() });
    const tmpDir = path.join(store.artifactRoot, ".tmp");
    const orphan = path.join(store.artifactRoot, "orphan.bin");
    writeFileSync(path.join(tmpDir, "interrupted.tmp"), "partial");
    writeFileSync(orphan, "orphan");

    expect(store.collectOrphanedArtifactFiles()).toEqual({ temporary: 1, unreferenced: 1 });
  });

  it("stores compressed checkpoint artifacts and reuses identical patch ciphertext", () => {
    store = new RuntimeStore({ projectDir: makeProject(), key: key() });
    store.configure({ traceEnabled: true });
    const session = store.createSession({ kind: "worker" });
    const input = {
      sessionId: session.id,
      baseSha: "a".repeat(40),
      worktreeFingerprint: "worktree-v1",
      patch: Buffer.from("diff --git a/a b/a\n", "utf8"),
    };
    const one = store.putCheckpoint(input);
    const two = store.putCheckpoint(input);
    expect(one.seq).toBe(1);
    expect(two.seq).toBe(2);

    const db = new Database(store.dbPath, { readonly: true });
    const locations = db.prepare(
      "SELECT encrypted_path FROM artifacts WHERE type = 'checkpoint-patch-gzip'",
    ).all() as Array<{ encrypted_path: string }>;
    db.close();
    expect(new Set(locations.map((row) => row.encrypted_path)).size).toBe(1);
  });

  it("persists approvals transactionally with the waiting session state", () => {
    store = new RuntimeStore({ projectDir: makeProject(), key: key() });
    store.configure({ traceEnabled: true });
    const created = store.createSession({ kind: "worker" });
    const running = store.updateSession(created.id, created.version, { status: "running" });
    const waiting = store.requestApproval(running.id, running.version, {
      policySource: "developer-default",
      scope: { capability: "network" },
      request: { host: "example.test" },
    });

    expect(waiting.session.status).toBe("waiting-approval");
    expect(store.getPendingApproval(running.id)?.request).toEqual({
      state: "available",
      value: { host: "example.test" },
    });
    const resumed = store.respondApproval(
      running.id,
      waiting.session.version,
      waiting.approval.id,
      true,
      { reason: "user-approved" },
    );
    expect(resumed.session.status).toBe("running");
    expect(resumed.approval.status).toBe("approved");
  });

  it("rebuilds JSONL projections from authoritative rows using atomic replacement", () => {
    const projectDir = makeProject();
    store = new RuntimeStore({ projectDir });
    store.recordProjection("runs.jsonl", { v: 1, kind: "apply", outcome: "succeeded" });
    store.recordProjection(path.join("runs", "r1", "events.jsonl"), {
      v: 1,
      runId: "r1",
      seq: 1,
      type: "run.started",
    });

    expect(store.rebuildProjections()).toEqual({ files: 2, records: 2 });
    expect(readFileSync(path.join(projectDir, ".openfusion", "cache", "runs.jsonl"), "utf8"))
      .toContain('"kind":"apply"');
  });

  it("rejects enabling encrypted traces until a memory-only project key is supplied", () => {
    store = new RuntimeStore({ projectDir: makeProject() });
    expect(() => store!.configure({ traceEnabled: true })).toThrow(RuntimeContentLockedError);
    store.setKey(key());
    expect(store.configure({ traceEnabled: true }).traceEnabled).toBe(true);
  });
});
