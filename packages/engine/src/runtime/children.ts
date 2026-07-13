import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { ModelMessage } from "ai";
import { tool, type Tool } from "ai";
import { DelegationRequestSchema } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { applyGitPatchFromMemory, type Worktree } from "../worker/worktree.js";
import type { RuntimeStore } from "./store.js";
import { toSessionChangedNotification, type RuntimeSession } from "./types.js";
import type { RunSupervisor } from "./supervisor.js";
import type { HarnessExperimentVariant } from "./evidence.js";
import { runtimeFingerprint } from "./context.js";
import {
  createToolInvocationClaim,
  ToolGateway,
  type ToolResourceClaim,
} from "../tools/gateway.js";
import {
  CLOSE_CHILD_TOOL_SPEC,
  IMPORT_CHILD_DIFF_TOOL_SPEC,
  LIST_CHILDREN_TOOL_SPEC,
  SEND_CHILD_TOOL_SPEC,
  SPAWN_CHILD_TOOL_SPEC,
  WAIT_CHILD_TOOL_SPEC,
} from "../tools/registry.js";
import { projectWorkerTool } from "../tools/projections.js";

const MAX_CHILDREN_PER_PARENT = 3;
const MAX_CHILDREN_GLOBAL = 6;
const DEFAULT_CHILD_STEPS = 20;
const DEFAULT_CHILD_DURATION_MS = 10 * 60_000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export interface SpawnChildInput {
  parentSessionId: string;
  task: string;
  providerId: string;
  model: string;
  dialectPack?: string;
  experimentVariant?: HarnessExperimentVariant;
  startTreeSha?: string;
  harnessGeneration?: string | null;
  harnessFingerprint?: string | null;
  taskWikiHeadSha?: string | null;
  taskWikiDigest?: string | null;
  /** In-memory parent run authority; never persisted in the delegation payload. */
  supervisor?: RunSupervisor;
}

export interface SafeChildResult {
  session: RuntimeSession;
  summaryAvailable: boolean;
  artifactId?: string;
  diffStat?: string;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  summary?: string;
}

export type ChildImportResult =
  | { imported: true; session: RuntimeSession; childSessionId: string }
  | { imported: false; reason: "parent-drift" | "conflict"; conflicts: string[] };

interface ChildTask {
  promise: Promise<void>;
}

function childBudget(parent: RuntimeSession): { steps: number; deadlineAt: string } {
  const remaining = parent.budgetSteps === undefined
    ? DEFAULT_CHILD_STEPS * 3
    : Math.max(1, parent.budgetSteps - parent.usedSteps);
  const steps = Math.max(1, Math.min(DEFAULT_CHILD_STEPS, Math.floor(remaining / 3)));
  const ownDeadline = Date.now() + DEFAULT_CHILD_DURATION_MS;
  const parentDeadline = parent.budgetDeadlineAt === undefined
    ? ownDeadline
    : Date.parse(parent.budgetDeadlineAt);
  return { steps, deadlineAt: new Date(Math.min(ownDeadline, parentDeadline)).toISOString() };
}

function conflictPaths(message: string): string[] {
  const paths = [...message.matchAll(/(?:patch failed|error):\s+([^:\n]+)/gi)]
    .map((match) => match[1]!.trim())
    .filter(Boolean);
  return [...new Set(paths)].slice(0, 64);
}

/** Bounded depth-one child runtime built on ordinary RuntimeSession rows. */
export class ChildSessionService {
  readonly #globalActiveCount: () => number;
  readonly #tasks = new Map<string, ChildTask>();
  readonly #mailboxes = new Map<string, ModelMessage[]>();
  readonly #mutationLocks = new Map<string, Promise<void>>();

  constructor(globalActiveCount: () => number) {
    this.#globalActiveCount = globalActiveCount;
  }

  async spawn(engine: Engine, store: RuntimeStore, input: SpawnChildInput): Promise<RuntimeSession> {
    const parent = store.requireSession(input.parentSessionId);
    if (!store.getConfiguration().childrenEnabled) throw new Error("child sessions are disabled for this project");
    if (parent.kind === "child") throw new Error("child sessions cannot spawn children");
    if (TERMINAL.has(parent.status)) throw new Error(`cannot spawn from terminal parent ${parent.id}`);
    const activeForParent = store.listChildren(parent.id)
      .filter((session) => session.kind === "child" && !TERMINAL.has(session.status)).length;
    if (activeForParent >= MAX_CHILDREN_PER_PARENT) {
      throw new Error(`parent already has ${MAX_CHILDREN_PER_PARENT} active children`);
    }
    if (this.#globalActiveCount() >= MAX_CHILDREN_GLOBAL) {
      throw new Error(`runtime already has ${MAX_CHILDREN_GLOBAL} active children`);
    }
    // Resolve the configured adapter target before reserving a worktree. The
    // model sees only spawn_child's task field; provider credentials remain in
    // the host registry and never enter the delegation request or child env.
    engine.models.registry.resolve(input.providerId, input.model);
    const budget = childBudget(parent);

    const checkpoint = store.latestCheckpoint(parent.id);
    const manager = await engine.worker.getManager(store.projectDir);
    const id = randomUUID();
    let worktree: Worktree;
    if (checkpoint === null) {
      worktree = await manager.create(id, parent.baseSha);
    } else {
      worktree = await manager.reconstruct(
        id,
        checkpoint.baseSha,
        gunzipSync(store.readArtifact(checkpoint.patchArtifactId)),
      );
    }
    const startTreeSha = await manager.snapshotTree(worktree);
    const delegationRequest = DelegationRequestSchema.parse({
      schemaVersion: 1,
      requestId: randomUUID(),
      parentSessionId: parent.id,
      task: input.task,
      target: {
        providerId: input.providerId,
        model: input.model,
        ...(input.dialectPack === undefined ? {} : { dialectPack: input.dialectPack }),
      },
      budget: { maxSteps: budget.steps, deadlineAt: budget.deadlineAt },
      baseSha: worktree.baseSha,
      authorityDigest: runtimeFingerprint({
        parentConfiguration: parent.configurationFingerprint ?? null,
        sandboxGrants: store.getConfiguration().sandboxGrants,
        extensionFingerprints: [...store.approvedExtensionFingerprints()].sort(),
      }),
    });
    let child: RuntimeSession;
    try {
      child = store.createSession({
        id,
        runId: randomUUID(),
        parentSessionId: parent.id,
        parentCheckpointSeq: checkpoint?.seq,
        kind: "child",
        worktreePath: worktree.path,
        baseSha: worktree.baseSha,
        budgetSteps: budget.steps,
        budgetDeadlineAt: budget.deadlineAt,
        initialPayload: {
          operation: "worker",
          delegationRequest,
          task: input.task,
          providerId: input.providerId,
          model: input.model,
          dialectPack: input.dialectPack,
          experimentVariant: input.experimentVariant,
          harnessGeneration: input.harnessGeneration,
          harnessFingerprint: input.harnessFingerprint,
          taskWikiHeadSha: input.taskWikiHeadSha,
          taskWikiDigest: input.taskWikiDigest,
          maxSteps: budget.steps,
          childStartTreeSha: startTreeSha,
        },
      });
      child = store.updateSession(child.id, child.version, {
        status: "running",
        worktreePath: worktree.path,
        baseSha: worktree.baseSha,
      });
      child = store.updateSession(child.id, child.version, { status: "interrupted" });
      store.appendEvent(child.id, {
        type: "delegation.accepted",
        metadata: {
          requestId: delegationRequest.requestId,
          parentSessionId: delegationRequest.parentSessionId,
          providerId: delegationRequest.target.providerId,
          maxSteps: delegationRequest.budget.maxSteps,
          authorityDigest: delegationRequest.authorityDigest,
        },
      });
    } catch (error) {
      await manager.remove(worktree).catch(() => {});
      throw error;
    }
    engine.notify("session.changed", toSessionChangedNotification(child));
    await engine.runtime.hooks.emit("child.changed", {
      parentSessionId: parent.id,
      childSessionId: child.id,
      status: child.status,
    });
    this.#launch(engine, store, child, { ...input, startTreeSha }, { bootstrap: true });
    return child;
  }

  resumeAfterApproval(
    engine: Engine,
    store: RuntimeStore,
    childSessionId: string,
    approvalResponse: { approvalId: string; approved: boolean; reason?: string },
  ): RuntimeSession {
    const child = store.requireSession(childSessionId);
    if (child.kind !== "child" || child.parentSessionId === undefined) {
      throw new Error(`not a resumable child session: ${childSessionId}`);
    }
    if (child.status !== "running") throw new Error(`child approval resume requires running state, got ${child.status}`);
    const created = store.listEvents(child.id, { limit: 1 })[0];
    if (created?.payload.state !== "available") throw new Error("child trace is locked");
    const payload = created.payload.value as Partial<{
      operation: "worker";
      task: string;
      providerId: string;
      model: string;
      dialectPack?: string;
      experimentVariant?: HarnessExperimentVariant;
      harnessGeneration?: string | null;
      harnessFingerprint?: string | null;
      taskWikiHeadSha?: string | null;
      taskWikiDigest?: string | null;
      childStartTreeSha?: string;
    }>;
    if (
      payload.operation !== "worker" ||
      typeof payload.task !== "string" ||
      typeof payload.providerId !== "string" ||
      typeof payload.model !== "string"
    ) {
      throw new Error("child has no resumable worker payload");
    }
    const launchInput: SpawnChildInput = {
      parentSessionId: child.parentSessionId,
      task: payload.task,
      providerId: payload.providerId,
      model: payload.model,
      dialectPack: payload.dialectPack,
      experimentVariant: payload.experimentVariant,
      harnessGeneration: payload.harnessGeneration,
      harnessFingerprint: payload.harnessFingerprint,
      taskWikiHeadSha: payload.taskWikiHeadSha,
      taskWikiDigest: payload.taskWikiDigest,
      startTreeSha: payload.childStartTreeSha,
    };
    const active = this.#tasks.get(child.id);
    if (active === undefined) {
      this.#launch(engine, store, child, launchInput, { bootstrap: false, approvalResponse });
    } else {
      void active.promise.then(() => {
        this.#launch(engine, store, store.requireSession(child.id), launchInput, {
          bootstrap: false,
          approvalResponse,
        });
      });
    }
    return child;
  }

  send(store: RuntimeStore, parentSessionId: string, childSessionId: string, message: unknown): RuntimeSession {
    const child = this.#requireChild(store, parentSessionId, childSessionId);
    if (TERMINAL.has(child.status)) throw new Error("cannot send to a terminal child");
    const serialized = JSON.stringify(message);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
      throw new Error("child message exceeds 64 KiB");
    }
    store.appendEvent(child.id, {
      type: "child.message",
      metadata: { source: "parent" },
      payload: message,
    });
    const queued = this.#mailboxes.get(child.id) ?? [];
    queued.push({ role: "user", content: `Parent message:\n${serialized}` });
    this.#mailboxes.set(child.id, queued);
    return store.requireSession(child.id);
  }

  drainMessages(childSessionId: string): ModelMessage[] {
    const queued = this.#mailboxes.get(childSessionId) ?? [];
    this.#mailboxes.delete(childSessionId);
    return queued;
  }

  async wait(store: RuntimeStore, parentSessionId: string, childSessionId: string, timeoutMs = 30_000): Promise<SafeChildResult> {
    this.#requireChild(store, parentSessionId, childSessionId);
    const task = this.#tasks.get(childSessionId)?.promise;
    if (task !== undefined) {
      await Promise.race([
        task,
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.min(timeoutMs, 60_000)))),
      ]);
    }
    return this.result(store, parentSessionId, childSessionId);
  }

  result(store: RuntimeStore, parentSessionId: string, childSessionId: string): SafeChildResult {
    const child = this.#requireChild(store, parentSessionId, childSessionId);
    const event = store.latestEvent(child.id, "child.result");
    const content = event?.payload.state === "available"
      ? event.payload.value as { summary?: unknown }
      : undefined;
    return {
      session: child,
      summaryAvailable: event !== null,
      ...(typeof event?.metadata.artifactId === "string" ? { artifactId: event.metadata.artifactId } : {}),
      ...(typeof event?.metadata.diffStat === "string" ? { diffStat: event.metadata.diffStat } : {}),
      costUsd: child.costUsd,
      inputTokens: child.inputTokens,
      outputTokens: child.outputTokens,
      ...(typeof content?.summary === "string" ? { summary: content.summary } : {}),
    };
  }

  close(engine: Engine, store: RuntimeStore, parentSessionId: string, childSessionId: string): RuntimeSession {
    let child = this.#requireChild(store, parentSessionId, childSessionId);
    if (TERMINAL.has(child.status)) return child;
    engine.cancelRegistry.cancel(child.runId);
    child = store.requireSession(child.id);
    if (!TERMINAL.has(child.status) && !this.#tasks.has(child.id)) {
      child = store.updateSession(child.id, child.version, { status: "cancelled", outcome: "parent-closed" });
      engine.notify("session.changed", toSessionChangedNotification(child));
    }
    return child;
  }

  async importDiff(
    engine: Engine,
    store: RuntimeStore,
    parentSessionId: string,
    expectedParentVersion: number,
    childSessionId: string,
  ): Promise<ChildImportResult> {
    return this.#withMutationLock(parentSessionId, async () => {
      const parent = store.requireSession(parentSessionId);
      if (parent.version !== expectedParentVersion) {
        return { imported: false, reason: "parent-drift", conflicts: [] };
      }
      const child = this.#requireChild(store, parentSessionId, childSessionId);
      const relation = store.getChildRelation(child.id)!;
      const latestParentCheckpoint = store.latestCheckpoint(parent.id);
      if (
        relation.parentVersionAtStart !== parent.version ||
        relation.parentCheckpointSeq !== latestParentCheckpoint?.seq
      ) {
        store.updateChildImportState(child.id, "rejected");
        return { imported: false, reason: "parent-drift", conflicts: [] };
      }
      if (child.status !== "completed") throw new Error("child must complete before import");
      if (parent.worktreePath === undefined || parent.baseSha === undefined) {
        throw new Error("parent has no isolated worktree to import into");
      }
      const resultEvent = store.latestEvent(child.id, "child.result");
      const artifactId = resultEvent?.metadata.artifactId;
      if (typeof artifactId !== "string") throw new Error("child has no patch artifact");
      const patch = store.readArtifact(artifactId);
      const manager = await engine.worker.getManager(store.projectDir);
      const parentWorktree: Worktree = {
        id: parent.id,
        path: parent.worktreePath,
        branch: "detached",
        base: store.projectDir,
        baseSha: parent.baseSha,
      };
      const beforePatch = await manager.checkpointPatch(parentWorktree);
      store.putCheckpoint({
        sessionId: parent.id,
        baseSha: parent.baseSha,
        worktreeFingerprint: "pre-child-import",
        patch: Buffer.from(beforePatch, "utf8"),
      });
      store.updateChildImportState(child.id, "pending");
      try {
        await applyGitPatchFromMemory(parent.worktreePath, patch, ["--check", "--binary"]);
      } catch (error) {
        store.updateChildImportState(child.id, "conflict");
        return {
          imported: false,
          reason: "conflict",
          conflicts: conflictPaths(error instanceof Error ? error.message : String(error)),
        };
      }
      try {
        await applyGitPatchFromMemory(parent.worktreePath, patch, ["--binary"]);
      } catch (error) {
        const replacement = await manager.reconstruct(
          `rollback-${parent.id.slice(0, 8)}-${randomUUID()}`,
          parent.baseSha,
          Buffer.from(beforePatch, "utf8"),
        );
        await manager.remove(parentWorktree).catch(() => {});
        const latest = store.requireSession(parent.id);
        store.updateSession(latest.id, latest.version, { worktreePath: replacement.path });
        store.updateChildImportState(child.id, "conflict");
        return {
          imported: false,
          reason: "conflict",
          conflicts: conflictPaths(error instanceof Error ? error.message : String(error)),
        };
      }
      store.updateChildImportState(child.id, "imported");
      const updated = store.updateSession(parent.id, expectedParentVersion, {
        worktreePath: parent.worktreePath,
        outcome: "child-imported",
      });
      const importedPatch = await manager.checkpointPatch(parentWorktree);
      store.putCheckpoint({
        sessionId: parent.id,
        baseSha: parent.baseSha,
        worktreeFingerprint: "post-child-import",
        patch: Buffer.from(importedPatch, "utf8"),
      });
      engine.notify("session.changed", toSessionChangedNotification(updated));
      return { imported: true, session: updated, childSessionId: child.id };
    });
  }

  refreshParentStartPoint(store: RuntimeStore, parentSessionId: string): void {
    const parent = store.requireSession(parentSessionId);
    store.refreshChildStartPoints(parent.id, parent.version, store.latestCheckpoint(parent.id)?.seq);
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.#tasks.values()].map((task) => task.promise));
    this.#tasks.clear();
    this.#mailboxes.clear();
  }

  #launch(
    engine: Engine,
    store: RuntimeStore,
    child: RuntimeSession,
    input: SpawnChildInput,
    options: {
      bootstrap: boolean;
      approvalResponse?: { approvalId: string; approved: boolean; reason?: string };
    },
  ): void {
    if (this.#tasks.has(child.id)) throw new Error(`child session is already active: ${child.id}`);
    const controller = engine.cancelRegistry.register(child.runId);
    const parentContext = store.latestEvent(child.parentSessionId!, "session.context-frozen");
    const frozen = parentContext?.payload.state === "available"
      ? parentContext.payload.value as { policy?: { sandboxGrants?: string[]; experimentVariant?: HarnessExperimentVariant }; skills?: Array<{ fingerprint: string }>; mcpServers?: Array<{ fingerprint: string }>; hooks?: Array<{ fingerprint: string }> }
      : undefined;
    const inheritedFingerprints = [
      ...(frozen?.skills ?? []),
      ...(frozen?.mcpServers ?? []),
      ...(frozen?.hooks ?? []),
    ].map((entry) => entry.fingerprint);
    const promise = engine.worker.run(engine, {
        projectDir: store.projectDir,
        task: input.task,
        providerId: input.providerId,
        model: input.model,
        dialectPack: input.dialectPack,
        experimentVariant: input.experimentVariant ?? frozen?.policy?.experimentVariant,
        maxSteps: child.budgetSteps,
        timeoutMs: Math.max(1_000, Date.parse(child.budgetDeadlineAt!) - Date.now()),
        runId: child.runId,
        parentSessionId: child.parentSessionId,
        resumeSessionId: child.id,
        bootstrapExistingSession: options.bootstrap,
        approvalResponse: options.approvalResponse,
        interactive: true,
        inheritedSandboxGrants: frozen?.policy?.sandboxGrants ?? [],
        inheritedExtensionFingerprints: inheritedFingerprints,
        childStartTreeSha: input.startTreeSha,
        harnessGeneration: input.harnessGeneration,
        harnessFingerprint: input.harnessFingerprint,
        taskWikiHeadSha: input.taskWikiHeadSha,
        taskWikiDigest: input.taskWikiDigest,
      }, input.supervisor).then(() => undefined).catch(() => {
      // The worker handler durably records its own failure/cancellation.
    }).finally(async () => {
      engine.cancelRegistry.deregister(child.runId);
      this.#tasks.delete(child.id);
      const latest = store.requireSession(child.id);
      await engine.runtime.hooks.emit("child.changed", {
        parentSessionId: child.parentSessionId!,
        childSessionId: child.id,
        status: latest.status,
      });
    });
    // Keep the controller reachable through CancelRegistry; the variable is
    // intentionally used to make ownership explicit.
    void controller;
    this.#tasks.set(child.id, { promise });
  }

  #requireChild(store: RuntimeStore, parentSessionId: string, childSessionId: string): RuntimeSession {
    const child = store.requireSession(childSessionId);
    if (child.kind !== "child" || child.parentSessionId !== parentSessionId) {
      throw new Error(`session ${childSessionId} is not a child of ${parentSessionId}`);
    }
    return child;
  }

  async #withMutationLock<T>(parentSessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationLocks.get(parentSessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#mutationLocks.set(parentSessionId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#mutationLocks.get(parentSessionId) === queued) this.#mutationLocks.delete(parentSessionId);
    }
  }
}

function publicSession(session: RuntimeSession): Record<string, unknown> {
  return {
    id: session.id,
    status: session.status,
    version: session.version,
    budgetSteps: session.budgetSteps,
    budgetDeadlineAt: session.budgetDeadlineAt,
    usedSteps: session.usedSteps,
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    costUsd: session.costUsd,
    outcome: session.outcome,
  };
}

/** Parent-facing model tools. Child runtimes never receive this toolset. */
export function createChildTools(input: {
  engine: Engine;
  store: RuntimeStore;
  parentSessionId: string;
  providerId: string;
  model: string;
  dialectPack?: string;
  experimentVariant?: HarnessExperimentVariant;
  supervisor?: RunSupervisor;
  toolGateway?: ToolGateway;
  sandboxCertified?: boolean;
  harnessGeneration?: string | null;
  harnessFingerprint?: string | null;
  taskWikiHeadSha?: string | null;
  taskWikiDigest?: string | null;
}): Record<string, Tool> {
  const { engine, store, parentSessionId } = input;
  const gateway = input.toolGateway ?? new ToolGateway();
  const delegationClaims: ToolResourceClaim[] = [{ kind: "process", resource: "runtime:delegation" }];
  const authorize = (toolId: string, claims: ToolResourceClaim[]) => gateway.authorize({
    invocation: createToolInvocationClaim(toolId, claims),
    policies: [
      { policyId: "runtime-parent-v1", claims },
      { policyId: "child-role-v1", claims },
      { policyId: `tool:${toolId}`, claims },
    ],
    sandboxed: input.sandboxCertified === true,
  });
  const denied = () => ({ error: "child invocation denied by policy", errorKind: "policy_denied" });
  return {
    spawn_child: tool({
      ...projectWorkerTool(SPAWN_CHILD_TOOL_SPEC),
      execute: async ({ task }) => {
        if (authorize(SPAWN_CHILD_TOOL_SPEC.id, delegationClaims).decision !== "allow") return denied();
        return publicSession(await engine.runtime.children.spawn(engine, store, {
          parentSessionId,
          task,
          providerId: input.providerId,
          model: input.model,
          dialectPack: input.dialectPack,
          experimentVariant: input.experimentVariant,
          harnessGeneration: input.harnessGeneration,
          harnessFingerprint: input.harnessFingerprint,
          taskWikiHeadSha: input.taskWikiHeadSha,
          taskWikiDigest: input.taskWikiDigest,
          supervisor: input.supervisor,
        }));
      },
    }),
    send_child: tool({
      ...projectWorkerTool(SEND_CHILD_TOOL_SPEC),
      execute: async ({ childSessionId, message }) => {
        if (authorize(SEND_CHILD_TOOL_SPEC.id, delegationClaims).decision !== "allow") return denied();
        return publicSession(engine.runtime.children.send(store, parentSessionId, childSessionId, message));
      },
    }),
    list_children: tool({
      ...projectWorkerTool(LIST_CHILDREN_TOOL_SPEC),
      execute: async () => authorize(LIST_CHILDREN_TOOL_SPEC.id, []).decision !== "allow"
        ? denied()
        : {
            children: store.listChildren(parentSessionId)
              .filter((session) => session.kind === "child")
              .map(publicSession),
          },
    }),
    wait_child: tool({
      ...projectWorkerTool(WAIT_CHILD_TOOL_SPEC),
      execute: async ({ childSessionId, timeoutMs }) => {
        if (authorize(WAIT_CHILD_TOOL_SPEC.id, []).decision !== "allow") return denied();
        const result = await engine.runtime.children.wait(
          store,
          parentSessionId,
          childSessionId,
          timeoutMs,
        );
        return { ...result, session: publicSession(result.session) };
      },
    }),
    close_child: tool({
      ...projectWorkerTool(CLOSE_CHILD_TOOL_SPEC),
      execute: async ({ childSessionId }) => {
        if (authorize(CLOSE_CHILD_TOOL_SPEC.id, delegationClaims).decision !== "allow") return denied();
        return publicSession(engine.runtime.children.close(engine, store, parentSessionId, childSessionId));
      },
    }),
    import_child_diff: tool({
      ...projectWorkerTool(IMPORT_CHILD_DIFF_TOOL_SPEC),
      execute: async ({ childSessionId }) => {
        const parent = store.requireSession(parentSessionId);
        if (parent.worktreePath === undefined) return denied();
        const claims: ToolResourceClaim[] = [{ kind: "filesystem-write", resource: parent.worktreePath }];
        if (authorize(IMPORT_CHILD_DIFF_TOOL_SPEC.id, claims).decision !== "allow") return denied();
        const result = await engine.runtime.children.importDiff(
          engine,
          store,
          parentSessionId,
          parent.version,
          childSessionId,
        );
        return result.imported ? { ...result, session: publicSession(result.session) } : result;
      },
    }),
  };
}
