import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { Engine } from "../engine.js";
import {
  orchestrate,
  OrchestrateApprovalPause,
  type OrchestrateApprovalPauseState,
  type OrchestrateParams,
  type OrchestrateResult,
} from "../orchestrate/orchestrate.js";
import { RuntimeContentLockedError, decodeRuntimeKey } from "./crypto.js";
import { MacOsSandboxBackend, type SandboxBackend } from "./sandbox.js";
import { RuntimeHookBus } from "./hooks.js";
import { McpManager } from "./mcp.js";
import { ChildSessionService } from "./children.js";
import { EvidenceService } from "./evidence.js";
import type { RunSupervisor } from "./supervisor.js";
import {
  RuntimeInvalidTransitionError,
  RuntimeStore,
  RuntimeVersionConflictError,
} from "./store.js";
import {
  toSessionChangedNotification,
  type RuntimeConfiguration,
  type RuntimeSession,
} from "./types.js";

interface ProjectRuntime {
  key: Buffer;
  keySource: "ephemeral" | "host";
  store: RuntimeStore;
}

interface StoredOrchestratePayload {
  operation: "orchestrate";
  params: OrchestrateParams;
}

interface StoredApprovalPausePayload {
  operation: "approval-pause";
  state: OrchestrateApprovalPauseState;
}

interface StoredWorkerPayload {
  operation: "worker";
  task: string;
  providerId: string;
  model: string;
  wikiDigest?: string;
  dialectPack?: string;
  harnessGeneration?: string | null;
  harnessFingerprint?: string | null;
  taskWikiHeadSha?: string | null;
  taskWikiDigest?: string | null;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function safeFailureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancel/i.test(message)) return "cancelled";
  if (/timeout/i.test(message)) return "timeout";
  if (/harness/i.test(message)) return "harness";
  if (/provider|model/i.test(message)) return "model";
  return "runtime";
}

function safeResultMetadata(result: OrchestrateResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    taskClass: result.taskClass,
    agent: result.agent,
    routeId: result.routeId,
    attempts: result.attempts.length,
    hasDiff: result.diff.length > 0,
    costUsd: result.cost.totalUsd,
  };
}

/** Owns per-project stores, memory-only keys, and background async sessions. */
export class RuntimeService {
  readonly sandbox: SandboxBackend;
  readonly hooks = new RuntimeHookBus();
  readonly mcp = new McpManager();
  readonly children: ChildSessionService;
  readonly evidence = new EvidenceService();
  readonly #appStorageDir: string;
  readonly #projects = new Map<string, ProjectRuntime>();
  readonly #tasks = new Map<string, Promise<void>>();
  readonly #credentials = new Map<string, string>();
  #closing = false;

  constructor(options: { appStorageDir?: string; sandbox?: SandboxBackend } = {}) {
    this.sandbox = options.sandbox ?? new MacOsSandboxBackend();
    this.#appStorageDir = path.resolve(
      options.appStorageDir
        ?? process.env.OPENFUSION_APP_STORAGE_DIR
        ?? path.join(os.tmpdir(), "openfusion-app-storage"),
    );
    this.children = new ChildSessionService(() => this.#activeChildCount());
  }

  get shuttingDown(): boolean {
    return this.#closing;
  }

  beginShutdown(): void {
    this.#closing = true;
  }

  configureCredential(reference: string, value: string | undefined): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(reference)) {
      throw new Error("credential reference is invalid");
    }
    if (value === undefined) this.#credentials.delete(reference);
    else this.#credentials.set(reference, value);
  }

  resolveCredential(reference: string): string | undefined {
    return this.#credentials.get(reference);
  }

  #createStore(projectDir: string, key: Buffer): RuntimeStore {
    const digest = createHash("sha256").update(projectDir).digest("hex");
    return new RuntimeStore({
      projectDir,
      storageDir: path.join(this.#appStorageDir, "runtime", digest),
      worktreeRoot: path.join(this.#appStorageDir, "worktrees"),
      key,
    });
  }

  getStore(projectDir: string): RuntimeStore {
    const key = path.resolve(projectDir);
    const existing = this.#projects.get(key);
    if (existing !== undefined) return existing.store;
    // Compatibility/headless calls still need encrypted transient artifacts;
    // not durable, so exact restart resume needs a host-supplied Keychain key.
    const runtimeKey = randomBytes(32);
    const store = this.#createStore(key, runtimeKey);
    const runtime = { key: runtimeKey, keySource: "ephemeral" as const, store };
    this.#projects.set(key, runtime);
    return store;
  }

  configure(
    projectDir: string,
    input: Partial<RuntimeConfiguration> & { traceKey?: string },
  ): RuntimeConfiguration {
    const key = path.resolve(projectDir);
    let runtime = this.#projects.get(key);
    if (input.traceKey !== undefined) {
      const decoded = decodeRuntimeKey(input.traceKey);
      if (runtime !== undefined && this.#hasActiveProject(key)) {
        throw new Error("cannot replace a runtime trace key while a project session is active");
      }
      if (runtime === undefined) {
        const store = this.#createStore(key, decoded);
        runtime = { key: decoded, keySource: "host", store };
        this.#projects.set(key, runtime);
      } else {
        runtime.key = decoded;
        runtime.keySource = "host";
        runtime.store.setKey(decoded);
      }
    }
    const store = runtime?.store ?? this.getStore(key);
    const { traceKey: _traceKey, ...configuration } = input;
    return store.configure(configuration);
  }

  async status(projectDir: string): Promise<{
    configuration: RuntimeConfiguration;
    database: { path: string; schemaVersion: number; integrity: "ok" | "failed" };
    keyState: "host" | "ephemeral" | "locked";
    sandbox: Awaited<ReturnType<SandboxBackend["status"]>>;
  }> {
    const projectKey = path.resolve(projectDir);
    const store = this.getStore(projectKey);
    const runtime = this.#projects.get(projectKey)!;
    const integrity = store.integrityCheck();
    return {
      configuration: store.getConfiguration(),
      database: {
        path: store.dbPath,
        schemaVersion: store.schemaVersion(),
        integrity: integrity.ok ? "ok" : "failed",
      },
      keyState: store.keyAvailable ? runtime.keySource : "locked",
      sandbox: await this.sandbox.status(),
    };
  }

  startOrchestrate(
    engine: Engine,
    params: OrchestrateParams,
  ): RuntimeSession {
    const store = this.getStore(params.projectDir);
    const runId = params.runId ?? randomUUID();
    const payload: StoredOrchestratePayload = {
      operation: "orchestrate",
      params: { ...params, runId, interactive: true },
    };
    const session = store.createSession({
      runId,
      kind: "orchestrate",
      initialPayload: payload,
    });
    this.#notify(engine, session);
    this.#launchOrchestrate(engine, store, session.id, payload.params);
    return session;
  }

  /**
   * Executes one orchestration under an existing RunKernel admission. SQLite
   * owns lifecycle/content; RunSupervisor contributes bounded admission,
   * cancellation, the snapshot, and a rebuildable observer journal. Blocking
   * compatibility RPCs and async sessions both use this method for that reason.
   */
  async runOrchestrate(
    engine: Engine,
    params: OrchestrateParams,
    supervisor: RunSupervisor,
    sessionId?: string,
  ): Promise<
    | { session: RuntimeSession; result: OrchestrateResult }
    | { session: RuntimeSession; paused: true }
  > {
    const store = this.getStore(params.projectDir);
    let current = sessionId === undefined
      ? store.createSession({
          runId: supervisor.runId,
          kind: "orchestrate",
          initialPayload: {
            operation: "orchestrate",
            params: { ...params, runId: supervisor.runId },
          } satisfies StoredOrchestratePayload,
        })
      : store.requireSession(sessionId);
    if (sessionId === undefined) this.#notify(engine, current);
    if (current.runId !== supervisor.runId) {
      throw new Error("runtime session runId does not match its supervisor");
    }
    if (current.status === "created" || current.status === "interrupted" || current.status === "needs-recovery") {
      current = store.updateSession(current.id, current.version, { status: "running" });
      this.#notify(engine, current);
    } else if (current.status !== "running") {
      throw new RuntimeInvalidTransitionError(current.status, "running");
    }

    try {
      const result = await orchestrate(engine, {
        ...params,
        runId: supervisor.runId,
        runtimeSessionId: current.id,
        taskSnapshot: supervisor.taskSnapshot,
        supervisor,
      });
      store.appendEvent(current.id, {
        type: "orchestrate.completed",
        metadata: safeResultMetadata(result),
        payload: result,
      });
      const latest = store.requireSession(current.id);
      const completed = TERMINAL.has(latest.status)
        ? latest
        : store.updateSession(latest.id, latest.version, {
            status: "completed",
            outcome: result.outcome,
            worktreePath: result.worktree?.path ?? null,
            costUsd: result.cost.totalUsd,
          });
      if (completed !== latest) this.#notify(engine, completed);
      this.#recordSessionProjection(store, completed, "completed");
      return { session: completed, result };
    } catch (error) {
      if (error instanceof OrchestrateApprovalPause) {
        store.appendEvent(current.id, {
          type: "orchestrate.approval-pause",
          metadata: {
            workerSessionId: error.state.workerSessionId,
            approvalId: error.state.approvalId,
          },
          payload: {
            operation: "approval-pause",
            state: error.state,
          } satisfies StoredApprovalPausePayload,
        });
        const latest = store.requireSession(current.id);
        const waiting = store.updateSession(latest.id, latest.version, {
          status: "waiting-approval",
        });
        this.#notify(engine, waiting);
        return { session: waiting, paused: true };
      }
      const latest = store.requireSession(current.id);
      if (this.#closing && !TERMINAL.has(latest.status)) {
        store.appendEvent(current.id, {
          type: "orchestrate.interrupted",
          metadata: { category: "shutdown" },
        });
        const interrupted = store.updateSession(latest.id, latest.version, {
          status: "interrupted",
          outcome: "shutdown",
        });
        this.#notify(engine, interrupted);
        throw error;
      }
      if (latest.status !== "cancelled") {
        store.appendEvent(current.id, {
          type: "orchestrate.failed",
          metadata: { category: safeFailureCategory(error) },
          payload: { message: error instanceof Error ? error.message : String(error) },
        });
        const failed = store.updateSession(latest.id, latest.version, {
          status: "failed",
          outcome: safeFailureCategory(error),
        });
        this.#notify(engine, failed);
        this.#recordSessionProjection(store, failed, "failed");
      } else {
        this.#recordSessionProjection(store, latest, "cancelled");
      }
      throw error;
    }
  }

  resumeOrchestrate(engine: Engine, store: RuntimeStore, sessionId: string): RuntimeSession {
    const current = store.requireSession(sessionId);
    if (current.resumeCapability !== "exact") {
      throw new RuntimeContentLockedError();
    }
    if (current.status !== "interrupted") {
      throw new RuntimeInvalidTransitionError(current.status, "running");
    }
    const payload = this.#loadOrchestratePayload(store, sessionId);
    const child = [...store.listChildren(sessionId)]
      .reverse()
      .find((candidate) => candidate.kind === "worker" && candidate.status === "interrupted");
    const params: OrchestrateParams = child === undefined
      ? payload.params
      : {
          ...payload.params,
          resumeWorker: {
            sessionId: child.id,
            ...this.#loadWorkerPayload(store, child.id),
          },
        };
    const running = store.updateSession(sessionId, current.version, { status: "running" });
    this.#notify(engine, running);
    this.#launchOrchestrate(engine, store, sessionId, params);
    return running;
  }

  recoverCurrentState(
    engine: Engine,
    store: RuntimeStore,
    sessionId: string,
    expectedVersion: number,
  ): RuntimeSession {
    const current = store.requireSession(sessionId);
    if (current.version !== expectedVersion) {
      throw new RuntimeVersionConflictError(sessionId, expectedVersion, current.version);
    }
    if (current.status !== "needs-recovery") {
      throw new RuntimeInvalidTransitionError(current.status, "interrupted");
    }
    const recovered = store.updateSession(sessionId, expectedVersion, {
      status: "interrupted",
      outcome: "recover-current-state",
    });
    store.appendEvent(sessionId, {
      type: "session.recovery-selected",
      metadata: { strategy: "current-state" },
    });
    this.#notify(engine, recovered);
    return this.resumeOrchestrate(engine, store, sessionId);
  }

  respondApproval(
    engine: Engine,
    store: RuntimeStore,
    addressedSessionId: string,
    expectedVersion: number,
    approvalId: string,
    approved: boolean,
    response?: unknown,
  ) {
    const addressed = store.requireSession(addressedSessionId);
    if (addressed.version !== expectedVersion) {
      throw new RuntimeVersionConflictError(addressedSessionId, expectedVersion, addressed.version);
    }
    const pending = store.getApproval(approvalId);
    if (pending === null || pending.status !== "pending") {
      throw new Error(`pending approval not found: ${approvalId}`);
    }
    const target = store.requireSession(pending.sessionId);
    const parentId = target.parentSessionId;
    if (parentId === undefined) {
      const responded = store.respondApproval(
        target.id,
        target.version,
        approvalId,
        approved,
        response,
      );
      this.#notify(engine, responded.session);
      return responded;
    }
    const parent = store.requireSession(parentId);
    if (target.kind === "child") {
      const responded = store.respondChildApproval(
        addressedSessionId,
        expectedVersion,
        approvalId,
        approved,
        response,
        { resumeParent: false },
      );
      this.#notify(engine, responded.child);
      this.#notify(engine, responded.parent);
      this.children.resumeAfterApproval(engine, store, target.id, {
        approvalId,
        approved,
        ...(typeof response === "object" && response !== null && "reason" in response &&
        typeof (response as { reason?: unknown }).reason === "string"
          ? { reason: (response as { reason: string }).reason }
          : {}),
      });
      return {
        session: addressedSessionId === target.id ? responded.child : responded.parent,
        approval: responded.approval,
      };
    }
    if (parent.status !== "waiting-approval") {
      throw new RuntimeInvalidTransitionError(parent.status, "running");
    }
    const pause = store.latestEvent(parent.id, "orchestrate.approval-pause");
    if (pause?.payload.state !== "available") throw new RuntimeContentLockedError();
    const pausePayload = pause.payload.value as Partial<StoredApprovalPausePayload>;
    if (
      pausePayload.operation !== "approval-pause" ||
      pausePayload.state === undefined ||
      pausePayload.state.approvalId !== approvalId ||
      pausePayload.state.workerSessionId !== target.id
    ) {
      throw new Error("approval does not match the parent's durable pause state");
    }
    const responded = store.respondChildApproval(
      addressedSessionId,
      expectedVersion,
      approvalId,
      approved,
      response,
    );
    this.#notify(engine, responded.child);
    this.#notify(engine, responded.parent);
    const initial = this.#loadOrchestratePayload(store, parent.id);
    const resumeParams: OrchestrateParams = {
      ...initial.params,
      interactive: true,
      resumeWorker: {
        sessionId: target.id,
        approvalResponse: {
          approvalId,
          approved,
          ...(typeof response === "object" && response !== null && "reason" in response &&
          typeof (response as { reason?: unknown }).reason === "string"
            ? { reason: (response as { reason: string }).reason }
            : {}),
        },
        ...pausePayload.state.worker,
      },
    };
    this.#launchOrchestrateAfterCurrent(engine, store, parent.id, resumeParams);
    return { session: responded.parent, approval: responded.approval };
  }

  cancel(engine: Engine, store: RuntimeStore, sessionId: string, expectedVersion: number): RuntimeSession {
    const current = store.requireSession(sessionId);
    if (current.version !== expectedVersion) {
      throw new RuntimeVersionConflictError(sessionId, expectedVersion, current.version);
    }
    engine.cancelRegistry.cancel(current.runId);
    for (const child of store.listChildren(sessionId)) {
      if (child.kind === "child" && !TERMINAL.has(child.status)) {
        this.children.close(engine, store, sessionId, child.id);
      }
    }
    const cancelled = store.updateSession(sessionId, expectedVersion, {
      status: "cancelled",
      outcome: "cancelled",
    });
    store.appendEvent(sessionId, { type: "session.cancelled", metadata: { source: "user" } });
    this.#notify(engine, cancelled);
    return cancelled;
  }

  async recoverCheckpoint(
    engine: Engine,
    store: RuntimeStore,
    sessionId: string,
    expectedVersion: number,
  ): Promise<RuntimeSession> {
    const current = store.requireSession(sessionId);
    if (current.version !== expectedVersion) {
      throw new RuntimeVersionConflictError(sessionId, expectedVersion, current.version);
    }
    if (current.status !== "interrupted" && current.status !== "needs-recovery") {
      throw new RuntimeInvalidTransitionError(current.status, "interrupted");
    }
    const checkpoint = store.latestCheckpoint(sessionId);
    if (checkpoint === null) throw new Error("session has no durable checkpoint");
    const compressed = store.readArtifact(checkpoint.patchArtifactId);
    const patch = gunzipSync(compressed);
    const manager = await engine.worker.getManager(store.projectDir);
    const recovered = await manager.reconstruct(
      `recover-${sessionId.slice(0, 8)}-${randomUUID()}`,
      checkpoint.baseSha,
      patch,
    );
    const updated = store.updateSession(sessionId, expectedVersion, {
      status: "interrupted",
      worktreePath: recovered.path,
      baseSha: recovered.baseSha,
      outcome: "checkpoint-recovered",
    });
    store.appendEvent(sessionId, {
      type: "checkpoint.recovered",
      metadata: { checkpointSeq: checkpoint.seq },
    });
    this.#notify(engine, updated);
    return updated;
  }

  async close(engine: Engine): Promise<void> {
    this.#closing = true;
    for (const runtime of this.#projects.values()) {
      for (const session of runtime.store.listSessions({ limit: 500 })) {
        if (!TERMINAL.has(session.status)) engine.cancelRegistry.cancel(session.runId);
      }
    }
    await Promise.allSettled(this.#tasks.values());
    await this.children.closeAll();
    await this.mcp.close();
    for (const runtime of this.#projects.values()) runtime.store.close();
    this.#projects.clear();
    this.#tasks.clear();
    this.#credentials.clear();
  }

  #launchOrchestrate(
    engine: Engine,
    store: RuntimeStore,
    sessionId: string,
    params: OrchestrateParams,
  ): void {
    if (this.#tasks.has(sessionId)) throw new Error(`runtime session already active: ${sessionId}`);
    const task = this.#runOrchestrate(engine, store, sessionId, params)
      .finally(() => this.#tasks.delete(sessionId));
    this.#tasks.set(sessionId, task);
    void task;
  }

  #launchOrchestrateAfterCurrent(
    engine: Engine,
    store: RuntimeStore,
    sessionId: string,
    params: OrchestrateParams,
  ): void {
    const active = this.#tasks.get(sessionId);
    if (active === undefined) {
      this.#launchOrchestrate(engine, store, sessionId, params);
      return;
    }
    void active.finally(() => {
      this.#launchOrchestrate(engine, store, sessionId, params);
    });
  }

  async #runOrchestrate(
    engine: Engine,
    store: RuntimeStore,
    sessionId: string,
    params: OrchestrateParams,
  ): Promise<void> {
    const current = store.requireSession(sessionId);
    try {
      await engine.runKernel.run(
        {
          runId: current.runId,
          projectDir: params.projectDir,
          kind: "orchestrate",
          writer: true,
        },
        async (supervisor) => {
          await this.runOrchestrate(engine, params, supervisor, sessionId);
        },
      );
    } catch (error) {
      // Fix 3 (final review): RunKernel.run can reject before this ever runs (admission-stopped, queue-full, dup runId) -- else a zombie "created" session.
      const latest = store.requireSession(sessionId);
      if (latest.status !== "created" && latest.status !== "running") return;
      store.appendEvent(sessionId, { type: "orchestrate.failed", metadata: { category: safeFailureCategory(error) }, payload: { message: error instanceof Error ? error.message : String(error) } });
      this.#notify(engine, store.updateSession(latest.id, latest.version, { status: "failed", outcome: safeFailureCategory(error) }));
    }
  }

  #notify(engine: Engine, session: RuntimeSession): void {
    engine.notify("session.changed", toSessionChangedNotification(session));
  }

  #loadOrchestratePayload(store: RuntimeStore, sessionId: string): StoredOrchestratePayload {
    const created = store.listEvents(sessionId, { limit: 1 })[0];
    if (created?.payload.state !== "available") throw new RuntimeContentLockedError();
    const payload = created.payload.value as Partial<StoredOrchestratePayload>;
    if (payload.operation !== "orchestrate" || payload.params === undefined) {
      throw new Error("session has no resumable orchestrate payload");
    }
    return payload as StoredOrchestratePayload;
  }

  #loadWorkerPayload(store: RuntimeStore, sessionId: string): StoredWorkerPayload {
    const created = store.listEvents(sessionId, { limit: 1 })[0];
    if (created?.payload.state !== "available") throw new RuntimeContentLockedError();
    const payload = created.payload.value as Partial<StoredWorkerPayload>;
    if (
      payload.operation !== "worker" ||
      typeof payload.task !== "string" ||
      typeof payload.providerId !== "string" ||
      typeof payload.model !== "string"
    ) {
      throw new Error("worker session has no resumable payload");
    }
    return payload as StoredWorkerPayload;
  }

  #recordSessionProjection(
    store: RuntimeStore,
    session: RuntimeSession,
    outcome: "completed" | "failed" | "cancelled",
  ): void {
    const payload = {
      v: 1,
      kind: session.kind,
      runId: session.runId,
      sessionId: session.id,
      at: session.updatedAt,
      outcome,
      status: session.status,
      usedSteps: session.usedSteps,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      costUsd: session.costUsd,
    };
    store.recordProjection("runs.jsonl", payload);
    store.recordProjection(`runs/${session.runId}/events.jsonl`, payload);
  }

  #hasActiveProject(projectDir: string): boolean {
    const runtime = this.#projects.get(projectDir);
    if (runtime === undefined) return false;
    return runtime.store.listSessions({ limit: 500 }).some((session) => !TERMINAL.has(session.status));
  }

  #activeChildCount(): number {
    let count = 0;
    for (const runtime of this.#projects.values()) {
      count += runtime.store.listSessions({ kind: "child", limit: 500 })
        .filter((session) => !TERMINAL.has(session.status)).length;
    }
    return count;
  }
}
