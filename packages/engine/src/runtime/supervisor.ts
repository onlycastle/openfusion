import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  CostEstimateSchema,
  RunEnvelopeV2Schema,
  RunSpanEventV2Schema,
  type CostEstimate,
  type RunEnvelopeV2,
  type RunSpanEventV2,
  type TaskSnapshotRef,
} from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { RunCancelledError } from "../rpc/cancel-registry.js";
import { captureTaskSnapshot } from "./snapshot.js";

export const MAX_ACTIVE_TOP_LEVEL_RUNS = 2;
export const MAX_QUEUED_TOP_LEVEL_RUNS = 8;

export interface RunBudget {
  maxModelCalls: number;
  maxToolCalls: number;
  deadlineAt: string;
  maxKnownUsd?: number;
}

export interface SupervisedRunOptions {
  runId?: string;
  projectDir: string;
  kind: RunEnvelopeV2["kind"];
  writer: boolean;
  budget?: Partial<RunBudget>;
  sandboxPolicyId?: string;
}

type Cleanup = () => void | Promise<void>;

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function journalPath(appStorageDir: string, projectDir: string, runId: string): string {
  return path.join(appStorageDir, "runs", sha256(path.resolve(projectDir)).slice(7), runId, "journal.v2.jsonl");
}

function appendDurably(file: string, line: string): void {
  const fd = openSync(file, "a", 0o600);
  try {
    writeSync(fd, line, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Finalizes journals whose owning engine process died without a terminal event. */
export function recoverInterruptedRunJournals(appStorageDir: string): {
  recovered: number;
  skippedActive: number;
  malformed: number;
} {
  const runsRoot = path.join(path.resolve(appStorageDir), "runs");
  if (!existsSync(runsRoot)) return { recovered: 0, skippedActive: 0, malformed: 0 };
  let recovered = 0;
  let skippedActive = 0;
  let malformed = 0;
  let projectIds: string[];
  try {
    projectIds = readdirSync(runsRoot);
  } catch {
    return { recovered, skippedActive, malformed: malformed + 1 };
  }
  for (const projectId of projectIds) {
    const projectRoot = path.join(runsRoot, projectId);
    let runIds: string[];
    try {
      runIds = readdirSync(projectRoot);
    } catch {
      malformed += 1;
      continue;
    }
    for (const runId of runIds) {
      const file = path.join(projectRoot, runId, "journal.v2.jsonl");
      if (!existsSync(file)) continue;
      const events: RunSpanEventV2[] = [];
      let contents: string;
      try {
        contents = readFileSync(file, "utf8");
      } catch {
        malformed += 1;
        continue;
      }
      for (const line of contents.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          events.push(RunSpanEventV2Schema.parse(JSON.parse(line)));
        } catch {
          malformed += 1;
        }
      }
      const started = events.find((event) =>
        event.type === "run.started" && event.parentSpanId === null && event.spanId.length > 0
      );
      if (started === undefined || events.some((event) => event.spanId === started.spanId && event.terminal)) {
        continue;
      }
      const ownerPid = started.metadata.ownerPid;
      if (typeof ownerPid === "number" && Number.isInteger(ownerPid) && processIsAlive(ownerPid)) {
        skippedActive += 1;
        continue;
      }
      const terminal = RunSpanEventV2Schema.parse({
        schemaVersion: 2,
        runId: started.runId,
        spanId: started.spanId,
        parentSpanId: null,
        attemptId: null,
        seq: Math.max(...events.map((event) => event.seq), 0) + 1,
        at: new Date().toISOString(),
        type: "run.interrupted",
        terminal: true,
        reasonCode: "interrupted-nonresumable",
        metadata: {},
      });
      try {
        appendDurably(file, `${JSON.stringify(terminal)}\n`);
        recovered += 1;
      } catch {
        malformed += 1;
      }
    }
  }
  return { recovered, skippedActive, malformed };
}

export class RunSupervisor {
  readonly runId: string;
  readonly projectDir: string;
  readonly kind: RunEnvelopeV2["kind"];
  readonly rootSpanId = randomUUID();
  readonly signal: AbortSignal;
  readonly budget: RunBudget;
  taskSnapshot!: TaskSnapshotRef;
  envelope!: RunEnvelopeV2;

  readonly #controller: AbortController;
  readonly #log: (message: string) => void;
  readonly #journalFile: string;
  readonly #cleanup = new Set<Cleanup>();
  #seq = 0;
  #rootTerminal = false;
  #modelCalls = 0;
  #toolCalls = 0;
  #knownUsd = 0;
  #pricedCalls = 0;
  #unpricedCalls = 0;
  #pricingConfidence: CostEstimate["confidence"] = "unpriced";

  constructor(
    engine: Engine,
    options: SupervisedRunOptions,
    controller: AbortController,
  ) {
    this.runId = options.runId ?? randomUUID();
    this.projectDir = path.resolve(options.projectDir);
    this.kind = options.kind;
    this.#controller = controller;
    this.signal = controller.signal;
    this.#log = engine.log;
    this.#journalFile = journalPath(engine.appStorageDir, this.projectDir, this.runId);
    mkdirSync(path.dirname(this.#journalFile), { recursive: true, mode: 0o700 });
    const deadline = options.budget?.deadlineAt ?? new Date(Date.now() + 30 * 60_000).toISOString();
    this.budget = {
      maxModelCalls: options.budget?.maxModelCalls ?? 128,
      maxToolCalls: options.budget?.maxToolCalls ?? 512,
      deadlineAt: deadline,
      ...(options.budget?.maxKnownUsd === undefined
        ? {}
        : { maxKnownUsd: options.budget.maxKnownUsd }),
    };
  }

  async initialize(engine: Engine, sandboxPolicyId?: string): Promise<void> {
    this.throwIfAborted();
    this.taskSnapshot = await captureTaskSnapshot(engine, this.projectDir, sandboxPolicyId);
    this.envelope = RunEnvelopeV2Schema.parse({
      schemaVersion: 2,
      runId: this.runId,
      kind: this.kind,
      taskSnapshot: this.taskSnapshot,
      rootSpanId: this.rootSpanId,
      budget: this.budget,
      createdAt: new Date().toISOString(),
    });
    this.record({
      spanId: this.rootSpanId,
      parentSpanId: null,
      attemptId: null,
      type: "run.started",
      terminal: false,
      metadata: {
        kind: this.kind,
        ownerPid: process.pid,
        snapshotId: this.taskSnapshot.snapshotId,
        snapshotDigest: sha256(JSON.stringify(this.taskSnapshot)),
      },
    });
  }

  record(
    input: Omit<RunSpanEventV2, "schemaVersion" | "runId" | "seq" | "at">,
  ): RunSpanEventV2 {
    if (input.spanId === this.rootSpanId && input.terminal) {
      if (this.#rootTerminal) throw new Error(`run ${this.runId} already has a terminal event`);
      this.#rootTerminal = true;
    }
    const event = RunSpanEventV2Schema.parse({
      schemaVersion: 2,
      runId: this.runId,
      seq: ++this.#seq,
      at: new Date().toISOString(),
      ...input,
    });
    appendDurably(this.#journalFile, `${JSON.stringify(event)}\n`);
    return event;
  }

  terminal(outcome: "succeeded" | "failed" | "cancelled", reasonCode?: string): void {
    if (this.#rootTerminal) return;
    this.record({
      spanId: this.rootSpanId,
      parentSpanId: null,
      attemptId: null,
      type: `run.${outcome}`,
      terminal: true,
      ...(reasonCode === undefined ? {} : { reasonCode }),
      metadata: {},
    });
  }

  addCleanup(cleanup: Cleanup): () => void {
    this.#cleanup.add(cleanup);
    return () => this.#cleanup.delete(cleanup);
  }

  async cleanup(): Promise<void> {
    const cleanups = [...this.#cleanup].reverse();
    this.#cleanup.clear();
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch {
        this.#log(`run-supervisor: cleanup failed (${this.kind})`);
      }
    }
  }

  abort(reason: "user" | "timeout" | "shutdown" | "unknown" = "unknown"): void {
    if (!this.signal.aborted) this.#controller.abort(new RunCancelledError());
    this.terminal("cancelled", reason);
  }

  throwIfAborted(): void {
    if (this.signal.aborted) throw new RunCancelledError();
    if (Date.now() >= Date.parse(this.budget.deadlineAt)) {
      this.abort("timeout");
      throw new RunCancelledError();
    }
  }

  reserveModelCall(): void {
    this.throwIfAborted();
    this.#modelCalls += 1;
    if (this.#modelCalls > this.budget.maxModelCalls) {
      this.abort("unknown");
      throw new Error("run model-call budget exhausted");
    }
  }

  reserveToolCall(): void {
    this.throwIfAborted();
    this.#toolCalls += 1;
    if (this.#toolCalls > this.budget.maxToolCalls) {
      this.abort("unknown");
      throw new Error("run tool-call budget exhausted");
    }
  }

  recordCost(costUsd: number | null, confidence: CostEstimate["confidence"]): void {
    if (costUsd === null) this.#unpricedCalls += 1;
    else {
      this.#knownUsd += costUsd;
      this.#pricedCalls += 1;
      if (this.#pricedCalls === 1) {
        this.#pricingConfidence = confidence;
      } else if (confidence !== this.#pricingConfidence) {
        this.#pricingConfidence = "mixed";
      }
    }
    if (this.budget.maxKnownUsd !== undefined && this.#knownUsd > this.budget.maxKnownUsd) {
      this.abort("unknown");
      throw new Error("run cost budget exhausted");
    }
  }

  costEstimate(): CostEstimate {
    return CostEstimateSchema.parse({
      knownUsd: this.#knownUsd,
      completeness: this.#pricedCalls === 0
        ? "none"
        : this.#unpricedCalls === 0
          ? "complete"
          : "partial",
      unpricedCalls: this.#unpricedCalls,
      pricingVersion: "pricing-v1",
      confidence: this.#unpricedCalls > 0 && this.#pricedCalls > 0 ? "mixed" : this.#pricingConfidence,
    });
  }
}

interface QueueEntry<T> {
  options: SupervisedRunOptions;
  projectKey: string;
  controller: AbortController;
  execute: (supervisor: RunSupervisor) => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  onAbort: () => void;
}

/** Global bounded admission plus ownership of every live top-level run. */
export class RunKernel {
  readonly #engine: Engine;
  #accepting = true;
  #active = new Map<string, { supervisor: RunSupervisor; writer: boolean; projectKey: string }>();
  #writers = new Set<string>();
  #queue: QueueEntry<unknown>[] = [];

  constructor(engine: Engine) {
    this.#engine = engine;
  }

  activeCount(): number {
    return this.#active.size;
  }

  queuedCount(): number {
    return this.#queue.length;
  }

  run<T>(
    options: SupervisedRunOptions,
    execute: (supervisor: RunSupervisor) => Promise<T>,
  ): Promise<T> {
    if (!this.#accepting) return Promise.reject(this.#busy("admission-stopped"));
    if (this.#queue.length >= MAX_QUEUED_TOP_LEVEL_RUNS) {
      return Promise.reject(this.#busy("queue-full"));
    }
    const runId = options.runId ?? randomUUID();
    const normalized = { ...options, runId };
    const controller = this.#engine.cancelRegistry.register(runId);
    const projectKey = sha256(path.resolve(options.projectDir));

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        options: normalized,
        projectKey,
        controller,
        execute,
        resolve,
        reject,
        onAbort: () => {},
      };
      entry.onAbort = () => {
        const index = this.#queue.indexOf(entry as QueueEntry<unknown>);
        if (index >= 0) {
          this.#queue.splice(index, 1);
          this.#engine.cancelRegistry.deregister(runId);
          reject(new RunCancelledError());
        }
      };
      controller.signal.addEventListener("abort", entry.onAbort, { once: true });
      this.#queue.push(entry as QueueEntry<unknown>);
      this.#dispatch();
    });
  }

  stopAdmission(): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    for (const entry of this.#queue.splice(0)) {
      entry.controller.signal.removeEventListener("abort", entry.onAbort);
      this.#engine.cancelRegistry.deregister(entry.options.runId!);
      entry.reject(this.#busy("shutdown"));
    }
  }

  abortAll(): void {
    this.stopAdmission();
    for (const { supervisor } of this.#active.values()) supervisor.abort("shutdown");
  }

  async close(deadlineMs = 5_000): Promise<void> {
    this.abortAll();
    const waitUntil = Date.now() + deadlineMs;
    while (this.#active.size > 0 && Date.now() < waitUntil) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (this.#active.size === 0) return;
    // A model adapter that ignored cancellation must not retain its
    // supervisor-owned process/session resources indefinitely. cleanup() is
    // idempotent because it clears its set before awaiting callbacks.
    const forced = Promise.allSettled(
      [...this.#active.values()].map(({ supervisor }) => supervisor.cleanup()),
    );
    await Promise.race([
      forced,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  #busy(reasonCode: string): RpcMethodError {
    return new RpcMethodError(-32001, "engine busy; retry later", {
      reasonCode,
      retryAfterMs: 1_000,
      active: this.#active.size,
      queued: this.#queue.length,
    });
  }

  #canStart(entry: QueueEntry<unknown>): boolean {
    if (this.#active.size >= MAX_ACTIVE_TOP_LEVEL_RUNS) return false;
    return !entry.options.writer || !this.#writers.has(entry.projectKey);
  }

  #dispatch(): void {
    while (this.#active.size < MAX_ACTIVE_TOP_LEVEL_RUNS) {
      const index = this.#queue.findIndex((entry) => this.#canStart(entry));
      if (index < 0) return;
      const entry = this.#queue.splice(index, 1)[0]!;
      entry.controller.signal.removeEventListener("abort", entry.onAbort);
      void this.#start(entry);
    }
  }

  async #start(entry: QueueEntry<unknown>): Promise<void> {
    const runId = entry.options.runId!;
    const supervisor = new RunSupervisor(this.#engine, entry.options, entry.controller);
    this.#active.set(runId, {
      supervisor,
      writer: entry.options.writer,
      projectKey: entry.projectKey,
    });
    if (entry.options.writer) this.#writers.add(entry.projectKey);
    try {
      await supervisor.initialize(this.#engine, entry.options.sandboxPolicyId);
      const result = await entry.execute(supervisor);
      // An uncooperative adapter may return only after shutdown already
      // cancelled the run. Cancellation remains authoritative; never resolve
      // such a request as a success after its terminal event says cancelled.
      supervisor.throwIfAborted();
      supervisor.terminal("succeeded");
      entry.resolve(result);
    } catch (error) {
      if (entry.controller.signal.aborted || error instanceof RunCancelledError) {
        supervisor.terminal("cancelled", "aborted");
      } else {
        supervisor.terminal("failed", "run-failed");
      }
      entry.reject(error);
    } finally {
      await supervisor.cleanup();
      this.#active.delete(runId);
      if (entry.options.writer) this.#writers.delete(entry.projectKey);
      this.#engine.cancelRegistry.deregister(runId);
      this.#dispatch();
    }
  }
}
