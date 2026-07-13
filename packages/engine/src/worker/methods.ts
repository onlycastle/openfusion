// WorkerRunner plus the engine.worker.* transport adapters compose
// WorktreeManager (isolation), createWorkerTools (path-scoped bash/read/
// write/edit), and runWorkerLoop (the AI SDK v7 multi-step tool loop) into
// one metered, reviewable worker run. Internal callers use the typed service;
// JSON-RPC is only the external transport adapter. WorkerService also owns the
// per-project WorktreeManager cache (keyed by the base repo's realpath via
// rpc/guards.js's shared resolveProjectKey).
//
// Public engine.worker.run calls enter RunKernel and receive one immutable
// task snapshot and supervisor. Typed nested calls reuse their parent's
// supervisor. WorkerService itself does not coalesce: every admitted call
// owns an isolated worktree, while RunKernel supplies global/project writer
// admission and the owning supervisor supplies model/tool/cost budgets.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Tool } from "ai";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import type { WikiPage } from "../harness/schema.js";
import { HarnessValidationError, loadHarnessSnapshot } from "../harness/store.js";
import { estimateCostUsd, lookupPricing, type NormalizedUsage } from "../models/pricing.js";
import { RpcMethodError } from "../rpc/errors.js";
import { providerKindOf, requireGitRepo, resolveProjectKey } from "../rpc/guards.js";
import { registerMethod } from "../rpc/register.js";
import { RunEventRecorder } from "../runs/events.js";
import { PolicyEvaluator } from "../runtime/policy.js";
import { RuntimeReadCache } from "../runtime/read-cache.js";
import {
  freezeRuntimeContext,
  runtimeFingerprint,
  type FrozenRuntimeContext,
} from "../runtime/context.js";
import { ContextCompiler } from "../runtime/context-compiler.js";
import {
  activateSkills,
  createSkillTool,
  discoverSkills,
  type NormalizedSkill,
} from "../runtime/skills.js";
import { mcpTransportClaims, type McpServerConfiguration } from "../runtime/mcp.js";
import { runProcessHook, type ProcessHookDefinition } from "../runtime/hooks.js";
import { createChildTools } from "../runtime/children.js";
import { HARNESS_EXPERIMENT_VARIANTS } from "../runtime/evidence.js";
import { wikiSourceIdentityDigest } from "../runtime/snapshot.js";
import type { RuntimeStore } from "../runtime/store.js";
import type { RunSupervisor } from "../runtime/supervisor.js";
import { toSessionChangedNotification, type RuntimeSession } from "../runtime/types.js";
import { ToolGateway } from "../tools/gateway.js";
import { wikiDbPath, type WikiStore } from "../wiki/store.js";
import { renderMap } from "../wiki/query.js";
import { resolveDialectPackId, resolveFamily } from "../models/catalog.js";
import { runWorkerLoop } from "./loop.js";
import { createWorkerRuntime } from "./runtime.js";
import type { ToolContext } from "./tools.js";
import { WorktreeManager, type Worktree } from "./worktree.js";

const RunParamsSchema = z.object({
  projectDir: z.string().min(1),
  task: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  wikiDigest: z.string().optional(),
  maxSteps: z.number().int().min(1).max(100).optional(),
  bashTimeoutMs: z.number().int().min(1000).max(600000).optional(),
  // Phase 1: dialect pack id. When omitted, resolved from (provider kind,
  // model) via the bundled family catalog's default pack.
  dialectPack: z.string().min(1).optional(),
  /** Internal protected-evaluation variant; never selected by the worker model. */
  experimentVariant: z.enum(HARNESS_EXPERIMENT_VARIANTS).optional(),
  // Whole-run deadline for the model loop (NOT a per-tool-call budget --
  // that's bashTimeoutMs above). Ceiling is 30 minutes, well above
  // engine.models.complete's own 10-minute timeoutMs ceiling: a worker run
  // is a full multi-step tool loop (up to maxSteps model calls), not one
  // completion, so it legitimately needs more room. Mirrors the M3 pattern
  // (models/methods.ts's own timeoutMs -> AbortSignal.timeout()).
  timeoutMs: z.number().int().min(1000).max(1_800_000).optional(),
  // M7b Task 2: when this run is itself a sub-call of engine.orchestrate (or
  // evals.run's nested orchestrate() call), the SAME runId that call's own
  // outermost handler registered is forwarded here verbatim -- this handler
  // only ever get()s it (READ-ONLY; never register()s/deregister()s its
  // own entry -- see cancel-registry.ts's header comment), so
  // engine.cancel({runId}) reaches a worker attempt exactly as it would a
  // review/escalation turn.
  runId: z.string().min(1).optional(),
  /** Captured task-snapshot base. Every retry must pass the same SHA. */
  baseSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional(),
  harnessGeneration: z.string().nullable().optional(),
  harnessFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable().optional(),
  taskWikiHeadSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).nullable().optional(),
  taskWikiDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable().optional(),
  parentSessionId: z.string().min(1).optional(),
  /** Internal async-session mode. Public blocking calls omit this. */
  interactive: z.boolean().optional(),
  /** Internal exact-resume target; content is loaded from RuntimeStore. */
  resumeSessionId: z.string().uuid().optional(),
  bootstrapExistingSession: z.boolean().optional(),
  inheritedSandboxGrants: z.array(z.string()).optional(),
  inheritedExtensionFingerprints: z.array(z.string()).optional(),
  childStartTreeSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).optional(),
  approvalResponse: z.object({
    approvalId: z.string().min(1),
    approved: z.boolean(),
    reason: z.string().optional(),
  }).optional(),
}).superRefine((params, ctx) => {
  const headState = params.taskWikiHeadSha === undefined
    ? "unset"
    : params.taskWikiHeadSha === null
      ? "null"
      : "value";
  const digestState = params.taskWikiDigest === undefined
    ? "unset"
    : params.taskWikiDigest === null
      ? "null"
      : "value";
  if (headState !== digestState) {
    ctx.addIssue({
      code: "custom",
      path: ["taskWikiDigest"],
      message: "taskWikiHeadSha and taskWikiDigest must be supplied as one matching pair",
    });
  }
});

export type WorkerRunParams = z.infer<typeof RunParamsSchema>;

export interface WorkerRunResult {
  sessionId: string;
  runId: string;
  paused?: true;
  approvalId?: string;
  diff?: string;
  diffStat?: string;
  summary: string;
  steps: number;
  toolCallCount: number;
  usage: NormalizedUsage;
  costUsd: number | null;
  worktree: { path: string; branch: string };
  dialectPack: string;
  dialectPackVersion: string;
  editDialect: string;
  toolCallCounts: Record<string, number>;
  toolErrorCounts: Record<string, number>;
  editFailCount: number;
}

export interface WorkerRunner {
  run(engine: Engine, params: WorkerRunParams, supervisor?: RunSupervisor): Promise<WorkerRunResult>;
}

const DEFAULT_RUN_TIMEOUT_MS = 600_000;

function jsonSchemaForTool(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("inputSchema" in value)) {
    return { type: "unknown" };
  }
  try {
    return z.toJSONSchema((value as { inputSchema: z.ZodType }).inputSchema);
  } catch {
    return { type: "opaque-standard-schema" };
  }
}

function withToolBudget(tool: Tool, supervisor: RunSupervisor | undefined): Tool {
  if (supervisor === undefined || tool.execute === undefined) return tool;
  const execute = tool.execute;
  return {
    ...tool,
    execute: (async (...args: Parameters<typeof execute>) => {
      supervisor.reserveToolCall();
      return execute(...args);
    }) as typeof execute,
  };
}

const CleanupParamsSchema = z.object({
  projectDir: z.string().min(1),
  worktreePath: z.string().min(1),
  deleteBranch: z.boolean().optional(),
});

const ListParamsSchema = z.object({
  projectDir: z.string().min(1),
});

const GcParamsSchema = z.object({
  projectDir: z.string().min(1),
  keep: z.array(z.string()).optional(),
});

// Holds one WorktreeManager per base repo, cached by realpath so distinct
// spellings of the same project share one manager (and its prune()), PLUS
// the set of in-flight worker-run AbortControllers (see beginRun/endRun/
// close below) — the one piece of run-lifecycle state that has to live
// somewhere Engine.close() can reach without engine.worker.run's handler
// needing to expose anything beyond the RPC surface itself.
export class WorkerService implements WorkerRunner {
  #managers = new Map<string, WorktreeManager>();
  #pruned = new Set<string>();
  #inFlight = new Map<AbortController, { promise: Promise<void>; resolve: () => void }>();
  #closing = false;

  constructor(private readonly storageRoot?: string) {}

  run(
    engine: Engine,
    params: WorkerRunParams,
    supervisor?: RunSupervisor,
  ): Promise<WorkerRunResult> {
    return runWorker(engine, params, supervisor);
  }

  async cleanup(
    projectDir: string,
    worktreePath: string,
    options: { deleteBranch?: boolean } = {},
  ): Promise<{ removed: boolean }> {
    requireGitRepo(projectDir);
    const manager = await this.getManager(projectDir);
    const resolvedTarget = path.resolve(worktreePath);
    const worktrees = await manager.list();
    const found = worktrees.find((worktree) => path.resolve(worktree.path) === resolvedTarget);
    if (found === undefined) return { removed: false };
    await manager.remove(found, { deleteBranch: options.deleteBranch });
    return { removed: true };
  }

  // Lazily creates (and caches) the WorktreeManager for a project, running
  // WorktreeManager.prune() once per manager the first time it's needed —
  // the task brief's "startup WorktreeManager.prune-on-first-use is fine" —
  // rather than at Engine construction time, since Engine has no project
  // path to prune against until the first worker.run/cleanup call arrives.
  async getManager(projectDir: string): Promise<WorktreeManager> {
    const key = resolveProjectKey(projectDir);
    let manager = this.#managers.get(key);
    if (manager === undefined) {
      manager = new WorktreeManager(projectDir, { storageRoot: this.storageRoot });
      this.#managers.set(key, manager);
    }
    if (!this.#pruned.has(key)) {
      this.#pruned.add(key);
      await manager.prune();
    }
    return manager;
  }

  // Registers the entire worker RPC before its first setup await, so close()
  // cannot race past worktree/context setup and tear down RuntimeStore while
  // the handler is still using it. Paired with endRun() in the handler's
  // outermost `finally`. False means shutdown already stopped admission.
  beginRun(controller: AbortController): boolean {
    if (this.#closing) return false;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.#inFlight.set(controller, { promise, resolve });
    return true;
  }

  endRun(controller: AbortController): void {
    const run = this.#inFlight.get(controller);
    if (run === undefined) return;
    this.#inFlight.delete(controller);
    run.resolve();
  }

  // Aborts every in-flight worker run so Engine.close() can never hang
  // behind a wedged one (a stuck model call has no other way to be
  // interrupted). It waits for each run's try/finally to durably record the
  // interruption before RuntimeStore is closed.
  async close(): Promise<void> {
    this.#closing = true;
    const runs = [...this.#inFlight.entries()];
    for (const [controller] of runs) {
      controller.abort(new Error("worker run aborted"));
    }
    await Promise.allSettled(runs.map(([, run]) => run.promise));
  }
}

export async function runWorker(
  engine: Engine,
  params: WorkerRunParams,
  supervisor?: RunSupervisor,
): Promise<WorkerRunResult> {
  const controller = new AbortController();
  let pinnedWikiStore: WikiStore | undefined;
  let failureStore: RuntimeStore | undefined;
  let failureSessionId: string | undefined;
  let failureWorktree: Worktree | undefined;
  let failureEvents: RunEventRecorder | undefined;
  if (!engine.worker.beginRun(controller)) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "worker service is shutting down");
    }
    try {
      // Flow: git guard -> resolve model -> worktree -> tools -> loop -> diff
      // -> meter -> return.
      //
      // The git guard, model resolution, and worktree creation are wrapped in
      // their own try/catch below: `requireGitRepo`/`registry.resolve`
      // already throw a properly-coded `RpcMethodError` (SERVER_ERROR /
      // INVALID_PARAMS) and pass through unchanged, but `getManager`/
      // `manager.create` can fail with a raw `Error` (e.g. a `git worktree
      // add` failure) that would otherwise fall through to the dispatcher's
      // generic INTERNAL_ERROR (-32603) -- inconsistent with every other
      // failure mode of this method, which is SERVER_ERROR (-32000). No
      // worktree data is attached on this path (unlike the main try/catch
      // below): by construction nothing here can fail after a worktree
      // exists.
      requireGitRepo(params.projectDir);
      const taskId = params.resumeSessionId ?? randomUUID();
      const runtimeStore = engine.runtime.getStore(params.projectDir);
      failureStore = runtimeStore;
      let runtimeSession: RuntimeSession;
      const existingSession = params.resumeSessionId !== undefined;
      const resuming = existingSession && params.bootstrapExistingSession !== true;
      if (existingSession) {
        runtimeSession = runtimeStore.requireSession(taskId);
        if (
          (runtimeSession.kind !== "worker" && runtimeSession.kind !== "child") ||
          runtimeSession.parentSessionId !== params.parentSessionId
        ) {
          throw new RpcMethodError(RpcErrorCodes.INVALID_PARAMS, "worker resume session does not match its parent");
        }
      } else {
        try {
          runtimeSession = runtimeStore.createSession({
            id: taskId,
            runId: params.runId ?? taskId,
            parentSessionId: params.parentSessionId,
            kind: "worker",
            initialPayload: {
              operation: "worker",
              task: params.task,
              providerId: params.providerId,
              model: params.model,
              wikiDigest: params.wikiDigest,
              harnessGeneration: params.harnessGeneration,
              harnessFingerprint: params.harnessFingerprint,
              taskWikiHeadSha: params.taskWikiHeadSha,
              taskWikiDigest: params.taskWikiDigest,
              dialectPack: params.dialectPack,
              maxSteps: params.maxSteps,
            },
          });
          engine.notify("session.changed", toSessionChangedNotification(runtimeSession));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `worker session setup failed: ${message}`);
        }
      }
      failureSessionId = runtimeSession.id;
      const eventRunId = runtimeSession.runId;

      let languageModel: ReturnType<typeof engine.models.registry.resolve>;
      let kind: string;
      let manager: WorktreeManager;
      let worktree: Worktree;
      try {
        // Resolved BEFORE the worktree is created: an unconfigured provider
        // (or any other resolve()-time failure) must never leave an orphaned
        // worktree behind.
        languageModel = engine.models.registry.resolve(params.providerId, params.model);
        kind = providerKindOf(engine.models.registry, params.providerId);

        manager = await engine.worker.getManager(params.projectDir);
        if (existingSession) {
          if (runtimeSession.worktreePath === undefined || runtimeSession.baseSha === undefined) {
            throw new Error("worker resume session has no recoverable worktree");
          }
          if (!existsSync(runtimeSession.worktreePath)) {
            throw new Error("worker resume worktree is missing; recover a checkpoint first");
          }
          worktree = {
            id: runtimeSession.id,
            path: runtimeSession.worktreePath,
            branch: "detached",
            base: path.resolve(params.projectDir),
            baseSha: runtimeSession.baseSha,
          };
          failureWorktree = worktree;
          if (runtimeSession.status === "interrupted") {
            runtimeSession = runtimeStore.updateSession(runtimeSession.id, runtimeSession.version, {
              status: "running",
            });
            engine.notify("session.changed", toSessionChangedNotification(runtimeSession));
          } else if (runtimeSession.status !== "running") {
            throw new Error(`worker session cannot resume from ${runtimeSession.status}`);
          }
        } else {
          worktree = await manager.create(taskId, params.baseSha);
          failureWorktree = worktree;
          runtimeSession = runtimeStore.updateSession(runtimeSession.id, runtimeSession.version, {
            status: "running",
            worktreePath: worktree.path,
            baseSha: worktree.baseSha,
          });
          engine.notify("session.changed", toSessionChangedNotification(runtimeSession));
          if (params.parentSessionId !== undefined && runtimeSession.kind === "worker") {
            const parent = runtimeStore.requireSession(params.parentSessionId);
            if (parent.status === "created" || parent.status === "running") {
              const updatedParent = runtimeStore.updateSession(parent.id, parent.version, {
                ...(parent.status === "created" ? { status: "running" as const } : {}),
                worktreePath: worktree.path,
                baseSha: worktree.baseSha,
              });
              engine.notify("session.changed", toSessionChangedNotification(updatedParent));
            }
          }
        }
      } catch (err) {
        const latest = runtimeStore.requireSession(runtimeSession.id);
        if (latest.status === "created" || latest.status === "running") {
          const failed = runtimeStore.updateSession(latest.id, latest.version, {
            status: existingSession ? "needs-recovery" : "failed",
            outcome: existingSession ? "recovery-required" : "setup-failed",
          });
          engine.notify("session.changed", toSessionChangedNotification(failed));
        }
        if (err instanceof RpcMethodError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `worker setup failed: ${message}`);
      }

      // A2 will provide an engine-generated runId to every outer run. Until
      // then, direct worker calls use their already-generated task UUID so the
      // event stream is still durable and collision-free.
      const events = new RunEventRecorder(engine, params.projectDir, eventRunId);
      failureEvents = events;
      events.record({ type: "run.started", kind: "worker" });
      const failPostWorktreeSetup = (message: string, reasonCode: string): never => {
        events.record({ type: "run.finished", outcome: "error" });
        runtimeStore.appendEvent(runtimeSession.id, {
          type: "worker.failed",
          metadata: { category: "setup", reasonCode },
          payload: { message },
        });
        const latest = runtimeStore.requireSession(runtimeSession.id);
        if (latest.status !== "completed" && latest.status !== "failed" && latest.status !== "cancelled") {
          runtimeSession = runtimeStore.updateSession(latest.id, latest.version, {
            status: "failed",
            outcome: "setup-failed",
          });
          engine.notify("session.changed", toSessionChangedNotification(runtimeSession));
        }
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `worker setup failed: ${message}`, {
          reasonCode,
          worktree: { path: worktree.path, branch: worktree.branch },
        });
      };

      // Task 7: ctx.wiki is built ONLY when the project's wiki is already
      // indexed — mirrors engine.wiki.status's own two-part gate
      // (existsSync(wikiDbPath(...)) then getMeta("head_sha") !== null) rather
      // than triggering a build here, since a worker run should never block
      // on (or silently kick off) a wiki index. `pages` comes from the
      // generated harness bundle, if any; a HarnessValidationError (corrupt or
      // hand-edited `.openfusion/` content) degrades to no page hits rather
      // than failing the run — wiki_query's symbol lookup still works fine on
      // its own.
      let wiki: ToolContext["wiki"];
      const wikiPinned = params.taskWikiHeadSha !== undefined;
      const wikiExists = existsSync(wikiDbPath(path.resolve(params.projectDir)));
      if (!wikiExists && wikiPinned && params.taskWikiHeadSha !== null) {
        failPostWorktreeSetup(
          "worker wiki changed after task snapshot: pinned index is unavailable",
          "wiki-snapshot-drift",
        );
      }
      if (wikiExists) {
        const liveStore = engine.wiki.getStore(params.projectDir);
        const candidateSnapshot = liveStore.snapshot();
        const identity = candidateSnapshot.getSourceIdentity();
        const identityDigest = wikiSourceIdentityDigest(identity);
        const identityMatches = wikiPinned
          ? identity.headSha === params.taskWikiHeadSha && identityDigest === params.taskWikiDigest
          : identity.headSha === worktree.baseSha && identityDigest !== null;
        if (
          wikiPinned &&
          params.taskWikiHeadSha !== null &&
          (!identityMatches || identity.headSha !== worktree.baseSha)
        ) {
          candidateSnapshot.close();
          failPostWorktreeSetup(
            "worker wiki changed after task snapshot capture",
            "wiki-snapshot-drift",
          );
        }
        if (identityMatches && identity.headSha === worktree.baseSha) {
          let pages: WikiPage[] = [];
          try {
            const harness = loadHarnessSnapshot(params.projectDir);
            if (
              params.harnessGeneration !== undefined &&
              (harness?.generationId ?? null) !== params.harnessGeneration
            ) {
              throw new Error("worker harness generation changed after task snapshot");
            }
            if (
              params.harnessFingerprint !== undefined &&
              (harness?.fingerprint.digest ?? null) !== params.harnessFingerprint
            ) {
              throw new Error("worker harness fingerprint changed after task snapshot");
            }
            pages = harness?.bundle.pages ?? [];
          } catch (err) {
            if (
              !(err instanceof HarnessValidationError) ||
              params.harnessFingerprint !== undefined
            ) {
              candidateSnapshot.close();
              failPostWorktreeSetup(
                err instanceof Error ? err.message : String(err),
                err instanceof HarnessValidationError
                  ? "harness-snapshot-invalid"
                  : "harness-snapshot-drift",
              );
            }
          }
          pinnedWikiStore = candidateSnapshot;
          wiki = { store: pinnedWikiStore, pages };
        } else {
          candidateSnapshot.close();
        }
      }
      events.record({
        type: "context.selected",
        variant: wiki === undefined ? "none" : "wiki",
        wikiAttached: wiki !== undefined,
      });

      // Phase 1 telemetry: tool-call NAMES/COUNTS plus error kinds — never
      // arguments — logged once the run completes (see the success path
      // below, right where the run result is assembled).
      const toolCallCounts: Record<string, number> = {};
      const toolErrorCounts: Record<string, number> = {};
      let editFailCount = 0;
      let mutatingToolFinished = false;
      const mutatingTools = new Set(["bash", "write_file", "edit", "apply_patch", "import_child_diff"]);

      const dialectPackId = resolveDialectPackId({
        explicit: params.dialectPack,
        providerKind: kind,
        modelId: params.model,
      });
      const sandboxStatus = await engine.runtime.sandbox.status();
      const runtimeConfiguration = runtimeStore.getConfiguration();
      let frozenContext: FrozenRuntimeContext | undefined;
      if (resuming) {
        const frozen = runtimeStore.latestEvent(runtimeSession.id, "session.context-frozen");
        if (frozen?.payload.state !== "available") {
          throw new RpcMethodError(
            RpcErrorCodes.SERVER_ERROR,
            "worker context snapshot is locked; exact resume is unavailable",
            { locked: true },
          );
        }
        frozenContext = frozen.payload.value as FrozenRuntimeContext;
      }
      const configuredSandboxGrants = frozenContext?.policy.sandboxGrants
        ?? runtimeConfiguration.sandboxGrants;
      const effectiveSandboxGrants = params.inheritedSandboxGrants === undefined
        ? configuredSandboxGrants
        : configuredSandboxGrants.filter((grant) => params.inheritedSandboxGrants!.includes(grant));
      const registrations = params.experimentVariant === "extensions-off"
        ? []
        : runtimeStore.listExtensions();
      const configuredFingerprints = new Set(
        registrations
          .filter((entry) => entry.enabled && entry.approvalStatus === "approved")
          .map((entry) => entry.fingerprint),
      );
      const enabledFingerprints = params.inheritedExtensionFingerprints === undefined
        ? configuredFingerprints
        : new Set([...configuredFingerprints].filter((fingerprint) =>
            params.inheritedExtensionFingerprints!.includes(fingerprint)));
      let discoveredSkills: ReturnType<typeof discoverSkills> = [];
      try {
        discoveredSkills = discoverSkills(worktree.path, {
          hooks: registrations.some((entry) => entry.kind === "hook" && entry.enabled),
          shell: sandboxStatus.available,
          mcp: registrations.some((entry) => entry.kind === "mcp" && entry.enabled),
          network: effectiveSandboxGrants.includes("network"),
          fork: false,
        });
      } catch (error) {
        runtimeStore.appendEvent(runtimeSession.id, {
          type: "extension.diagnostic",
          metadata: { kind: "skill", code: "invalid-metadata" },
          payload: { message: error instanceof Error ? error.message : String(error) },
        });
      }
      const activatedSkills = activateSkills(discoveredSkills, enabledFingerprints).active;
      const sessionSkills = frozenContext === undefined
        ? activatedSkills
        : frozenContext.skills.map((frozen) => {
            if (frozen.snapshot !== undefined) {
              const snapshot = frozen.snapshot as NormalizedSkill;
              if (snapshot.id !== frozen.id || snapshot.fingerprint !== frozen.fingerprint) {
                throw new Error(`frozen skill snapshot is invalid: ${frozen.id}`);
              }
              return snapshot;
            }
            const skill = activatedSkills.find((candidate) =>
              candidate.id === frozen.id && candidate.fingerprint === frozen.fingerprint);
            if (skill === undefined) throw new Error(`frozen skill changed or is unavailable: ${frozen.id}`);
            return skill;
          });
      const enabledMcp = frozenContext === undefined
        ? registrations
            .filter((entry) => entry.kind === "mcp" && entry.enabled && entry.approvalStatus === "approved")
            .map((entry) => ({ id: entry.id, fingerprint: entry.fingerprint, config: entry.config }))
        : (frozenContext.mcpServers ?? []).map((server) => {
            const fallback = registrations.find((entry) =>
              entry.kind === "mcp" && entry.id === server.id && entry.fingerprint === server.fingerprint);
            const configuration = server.configuration ?? fallback?.config;
            if (configuration === undefined) throw new Error(`frozen MCP configuration is unavailable: ${server.id}`);
            return { id: server.id, fingerprint: server.fingerprint, config: configuration as Record<string, unknown> };
          });
      const enabledHooks = frozenContext === undefined
        ? registrations
            .filter((entry) => entry.kind === "hook" && entry.enabled && entry.approvalStatus === "approved")
            .map((entry) => ({ id: entry.id, fingerprint: entry.fingerprint, config: entry.config }))
        : (frozenContext.hooks ?? []).map((hook) => {
            const fallback = registrations.find((entry) =>
              entry.kind === "hook" && entry.id === hook.id && entry.fingerprint === hook.fingerprint);
            const configuration = hook.configuration ?? fallback?.config;
            if (configuration === undefined) throw new Error(`frozen hook configuration is unavailable: ${hook.id}`);
            return { id: hook.id, fingerprint: hook.fingerprint, config: configuration as Record<string, unknown> };
          });
      const policyEvaluator = new PolicyEvaluator({
        projectGrants: {
          id: "project-grants",
          rules: [
            ...(effectiveSandboxGrants.includes("network")
              ? [{ id: "project-network", capability: "network", decision: "allow" as const }]
              : []),
            ...enabledMcp.map((entry) => ({
              id: `approved-mcp-${entry.id}`,
              capability: "mcp.tool",
              resource: `${entry.id}:*`,
              decision: "allow" as const,
            })),
            ...enabledMcp.flatMap((entry) => {
              const config = entry.config as unknown as McpServerConfiguration;
              return mcpTransportClaims(config).flatMap((claim) => {
                if (claim.kind === "network") {
                  return [{
                    id: `approved-mcp-network-${entry.id}`,
                    capability: "network",
                    resource: claim.resource,
                    decision: "allow" as const,
                  }];
                }
                if (claim.kind === "secret") {
                  return [{
                    id: `approved-mcp-secret-${entry.id}`,
                    capability: "secret.use",
                    resource: claim.resource,
                    decision: "allow" as const,
                  }];
                }
                return [];
              });
            }),
          ],
        },
      });
      const nodeToolchainDir = path.dirname(process.execPath);
      const readCache = new RuntimeReadCache();
      const toolGateway = new ToolGateway({
        evaluator: policyEvaluator,
        interactive: params.interactive === true,
        onDecision: (invocation, decision) => {
          runtimeStore.appendEvent(runtimeSession.id, {
            type: "policy.evaluated",
            metadata: {
              tool: invocation.toolId,
              invocationId: invocation.invocationId,
              decision: decision.decision,
              policyId: decision.policyId,
              reasonCode: decision.reasonCode,
              claimCount: invocation.claims.length,
            },
          });
          void engine.runtime.hooks.emit("policy.evaluated", {
            sessionId: runtimeSession.id,
            capability: `tool:${invocation.toolId}`,
            decision: decision.decision === "approval-required" ? "ask" : decision.decision,
          });
        },
      });
      const runtime = createWorkerRuntime(dialectPackId, {
        root: worktree.path,
        bashTimeoutMs: params.bashTimeoutMs,
        wiki,
        sandboxCertified: sandboxStatus.available,
        ...(sandboxStatus.available
          ? {
              sandbox: {
                backend: engine.runtime.sandbox,
                store: runtimeStore,
                sessionId: runtimeSession.id,
                readablePaths: [nodeToolchainDir],
                executablePaths: [nodeToolchainDir, worktree.path],
                networkGranted: effectiveSandboxGrants.includes("network"),
                profile: params.experimentVariant === undefined ? "author" : "eval",
              },
            }
          : {}),
        policy: {
          evaluator: policyEvaluator,
          interactive: params.interactive === true,
        },
        toolGateway,
        readCache,
        // Tool events are structured, already-truncated observability
        // metadata (see tools.ts's own `detail()`) — never prompt/file/
        // command content.
        onToolEvent: (e) => {
          toolCallCounts[e.tool] = (toolCallCounts[e.tool] ?? 0) + 1;
          if (!e.ok) {
            const key = `${e.tool}:${e.errorKind ?? "unknown"}`;
            toolErrorCounts[key] = (toolErrorCounts[key] ?? 0) + 1;
            if (e.tool === "edit" || e.tool === "apply_patch") editFailCount += 1;
          }
          engine.notify("worker.progress", {
            taskId,
            kind: "tool",
            tool: e.tool,
            detail: e.detail,
            ok: e.ok,
            errorKind: e.errorKind,
          });
        },
        onToolLifecycleEvent: (event) => {
          if (event.phase === "started") {
            void engine.runtime.hooks.emit("tool.before", {
              sessionId: runtimeSession.id,
              tool: event.tool,
              capability: mutatingTools.has(event.tool) ? "filesystem-write" : "filesystem-read",
            });
            events.record({ type: "tool.started", tool: event.tool });
            runtimeStore.appendEvent(runtimeSession.id, {
              type: "tool.started",
              metadata: { tool: event.tool },
            });
            return;
          }
          if (event.phase === "failed") {
            void engine.runtime.hooks.emit("tool.after", {
              sessionId: runtimeSession.id,
              tool: event.tool,
              ok: false,
              resultBytes: event.resultBytes,
            });
            events.record({
              type: "tool.failed",
              tool: event.tool,
              durationMs: event.durationMs,
              resultBytes: event.resultBytes,
              truncated: event.truncated,
              errorKind: event.errorKind ?? "unknown",
            });
            runtimeStore.appendEvent(runtimeSession.id, {
              type: "tool.failed",
              metadata: {
                tool: event.tool,
                durationMs: event.durationMs,
                resultBytes: event.resultBytes,
                truncated: event.truncated,
                errorKind: event.errorKind ?? "unknown",
              },
            });
            return;
          }
          events.record({
            type: "tool.finished",
            tool: event.tool,
            durationMs: event.durationMs,
            resultBytes: event.resultBytes,
            truncated: event.truncated,
          });
          void engine.runtime.hooks.emit("tool.after", {
            sessionId: runtimeSession.id,
            tool: event.tool,
            ok: true,
            resultBytes: event.resultBytes,
          });
          runtimeStore.appendEvent(runtimeSession.id, {
            type: "tool.finished",
            metadata: {
              tool: event.tool,
              durationMs: event.durationMs,
              resultBytes: event.resultBytes,
              truncated: event.truncated,
            },
          });
          if (mutatingTools.has(event.tool)) mutatingToolFinished = true;
        },
      });
      const skillLoader = createSkillTool(sessionSkills, engine.runtime.hooks, toolGateway);
      if (skillLoader !== undefined) runtime.tools.load_skill = skillLoader;
      for (const registration of enabledMcp) {
        const config = registration.config as unknown as McpServerConfiguration;
        const connected = await engine.runtime.mcp.connect({
          config,
          ...(config.transport === "stdio" ? { executionCwd: worktree.path } : {}),
          approvedFingerprints: runtimeStore.approvedExtensionFingerprints(),
          credentialResolver: async (reference) => engine.runtime.resolveCredential(reference),
        });
        if (connected.status !== "connected") {
          runtimeStore.appendEvent(runtimeSession.id, {
            type: "extension.diagnostic",
            metadata: { kind: "mcp", code: "approval-required", extensionId: registration.id },
          });
          continue;
        }
        const imported = engine.runtime.mcp.tools({
          serverId: registration.id,
          store: runtimeStore,
          sessionId: runtimeSession.id,
          policy: policyEvaluator,
          interactive: params.interactive === true,
          hooks: engine.runtime.hooks,
          gateway: toolGateway,
          claimPolicies: [
            { policyId: "runtime-parent-v1", claims: mcpTransportClaims(config) },
            { policyId: `mcp-role:${registration.id}`, claims: mcpTransportClaims(config) },
          ],
        });
        for (const [name, definition] of Object.entries(imported)) {
          if (runtime.tools[name] !== undefined) throw new Error(`duplicate runtime tool: ${name}`);
          runtime.tools[name] = definition;
        }
      }
      const configuredChildrenEnabled = frozenContext?.policy.childrenEnabled
        ?? runtimeConfiguration.childrenEnabled;
      const effectiveChildrenEnabled = params.experimentVariant === "single-worker"
        ? false
        : configuredChildrenEnabled;
      if (runtimeSession.kind !== "child" && effectiveChildrenEnabled) {
        const childParentSessionId = runtimeSession.parentSessionId ?? runtimeSession.id;
        const childTools = createChildTools({
          engine,
          store: runtimeStore,
          parentSessionId: childParentSessionId,
          providerId: params.providerId,
          model: params.model,
          dialectPack: runtime.dialectPackId,
          experimentVariant: params.experimentVariant,
          supervisor,
          toolGateway,
          sandboxCertified: sandboxStatus.available,
          harnessGeneration: params.harnessGeneration,
          harnessFingerprint: params.harnessFingerprint,
          taskWikiHeadSha: params.taskWikiHeadSha,
          taskWikiDigest: params.taskWikiDigest,
        });
        for (const [name, definition] of Object.entries(childTools)) {
          if (runtime.tools[name] !== undefined) throw new Error(`duplicate runtime tool: ${name}`);
          runtime.tools[name] = definition;
        }
      }
      if (sandboxStatus.available) {
        for (const registration of enabledHooks) {
          const config = registration.config as unknown as Omit<ProcessHookDefinition, "id" | "fingerprint">;
          const hook: ProcessHookDefinition = {
            ...config,
            id: registration.id,
            fingerprint: registration.fingerprint,
          };
          for (const [toolName, definition] of Object.entries(runtime.tools)) {
            const result = await runProcessHook({
              hook,
              facts: {
                schemaVersion: 1,
                event: "tool.before",
                sessionId: runtimeSession.id,
                sessionKind: runtimeSession.kind,
                tool: toolName,
                capability: mutatingTools.has(toolName) ? "file.write" : "file.read",
                risk: mutatingTools.has(toolName) ? ["filesystem-write"] : ["filesystem-read"],
              },
              interactive: params.interactive === true,
              sandbox: engine.runtime.sandbox,
              store: runtimeStore,
              sessionId: runtimeSession.id,
              cwd: worktree.path,
              approvedFingerprints: runtimeStore.approvedExtensionFingerprints(),
            });
            runtimeStore.appendEvent(runtimeSession.id, {
              type: "hook.evaluated",
              metadata: {
                hookId: registration.id,
                tool: toolName,
                status: result.status,
                ...(result.decision === undefined ? {} : { decision: result.decision }),
              },
            });
            if (result.decision === "deny") {
              delete runtime.tools[toolName];
            } else if (result.decision === "ask") {
              runtime.tools[toolName] = { ...definition, needsApproval: true };
            }
          }
        }
      }
      const selectedTools = frozenContext === undefined
        ? runtime.tools
        : Object.fromEntries(frozenContext.tools.map(({ name }) => {
            const selected = runtime.tools[name];
            if (selected === undefined) {
              throw new Error(`frozen worker tool is no longer available: ${name}`);
            }
            return [name, selected];
          }));
      const activeTools = Object.fromEntries(
        Object.entries(selectedTools).map(([name, definition]) => [
          name,
          withToolBudget(definition, supervisor),
        ]),
      );
      const activeInstructions = frozenContext?.instructionBundle ?? runtime.instructions;
      const wikiSourceDigest = wiki?.store.getMeta("source_fingerprint") ?? undefined;
      const compiledContext = new ContextCompiler().compile({
        snapshot: {
          baseSha: worktree.baseSha,
          ...(wikiSourceDigest === undefined ? {} : { wikiDigest: wikiSourceDigest }),
        },
        instructions: activeInstructions,
        task: params.task,
        ...(params.wikiDigest === undefined ? {} : { approvedProjectContext: params.wikiDigest }),
        ...(wiki === undefined || wikiSourceDigest === undefined
          ? {}
          : {
              retrievedWiki: {
                content: renderMap(wiki.store, 1024, params.task),
                snapshotDigest: wikiSourceDigest,
                queryId: "wiki-map:task",
              },
            }),
      });
      if (
        frozenContext?.compiledContext !== undefined &&
        frozenContext.compiledContext.fingerprint !== compiledContext.fingerprint
      ) {
        throw new RpcMethodError(
          RpcErrorCodes.SERVER_ERROR,
          "worker context snapshot changed; exact resume is unavailable",
          { reasonCode: "context-snapshot-mismatch" },
        );
      }
      if (!resuming) {
        const policy = {
          sandboxGrants: [...effectiveSandboxGrants].sort(),
          interactive: params.interactive === true,
          childrenEnabled: effectiveChildrenEnabled,
          experimentVariant: params.experimentVariant,
        };
        const frozen = freezeRuntimeContext({
          instructionBundle: runtime.instructions,
          tools: Object.entries(runtime.tools).map(([name, value]) => ({
            name,
            ...((value as { description?: string }).description === undefined
              ? {}
              : { description: (value as { description: string }).description }),
            inputSchema: jsonSchemaForTool(value),
          })),
          policy,
          policyFingerprint: runtimeFingerprint({ policyVersion: "balanced-v1", ...policy }),
          sandboxProfileId: sandboxStatus.available ? "macos-worker-v1" : "unavailable",
          skills: sessionSkills.map((skill) => ({
            id: skill.id,
            fingerprint: skill.fingerprint,
            snapshot: skill,
          })),
          mcpServers: enabledMcp.map((entry) => ({
            id: entry.id,
            fingerprint: entry.fingerprint,
            configuration: entry.config,
          })),
          hooks: enabledHooks.map((entry) => ({
            id: entry.id,
            fingerprint: entry.fingerprint,
            configuration: entry.config,
          })),
          adapters: [
            { id: "ai-sdk", version: "7" },
            { id: runtime.dialectPackId, version: runtime.dialectPackVersion },
          ],
          compiledContext: {
            fingerprint: compiledContext.fingerprint,
            baseSha: compiledContext.snapshot.baseSha,
            ...(compiledContext.snapshot.wikiDigest === undefined
              ? {}
              : { wikiDigest: compiledContext.snapshot.wikiDigest }),
            sources: compiledContext.sources,
          },
        });
        runtimeStore.appendEvent(runtimeSession.id, {
          type: "session.context-frozen",
          metadata: { fingerprint: frozen.fingerprint },
          payload: frozen.context,
        });
        const latest = runtimeStore.requireSession(runtimeSession.id);
        runtimeSession = runtimeStore.updateSession(latest.id, latest.version, {
          modelFingerprint: runtimeFingerprint({ providerId: params.providerId, model: params.model }),
          configurationFingerprint: frozen.fingerprint,
        });
        engine.notify("session.changed", toSessionChangedNotification(runtimeSession));
      }

      // Two independent abort sources, combined into the ONE signal
      // runWorkerLoop actually gets: `timeoutSignal` fires on its own after
      // timeoutMs (a wedged model call that never errors on its own),
      // `controller` is fired by WorkerService.close() (Engine.close() mid-run
      // — see WorkerService.beginRun/endRun/close). AbortSignal.any is stable
      // since Node 20.3 (this repo's floor is >=22) and confirmed to typecheck
      // against this repo's tsconfig (no DOM lib override needed) — no manual
      // fallback combinator is carried here.
      //
      // Kept as separate named signals (rather than only ever consulting the
      // combined one) so the catch block below can ask "was it timeoutSignal
      // or controller that actually fired?" by checking each source's OWN
      // `.aborted` flag directly — deterministic regardless of how the AI SDK
      // or a given provider adapter happens to wrap/rewrap the thrown error
      // (mirrors models/methods.ts's isTimeoutError doc comment on why that
      // module has to parse error shape instead: it only has ONE signal to
      // reason about, we have two known sources here).
      const timeoutMs = params.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      // M7b Task 2: a THIRD abort source, alongside timeoutSignal/controller
      // above -- the SAME per-run AbortController engine.orchestrate's own
      // handler registered for `params.runId`, reached here via a READ-ONLY
      // get() (never register()/deregister() -- see cancel-registry.ts's
      // header comment). undefined whenever this run has no runId at all, or
      // a runId that (for whatever reason) doesn't resolve to a registered
      // controller -- either way AbortSignal.any below just combines whatever
      // signals actually exist.
      const cancelController = params.runId !== undefined ? engine.cancelRegistry.get(params.runId) : undefined;
      const signals: AbortSignal[] = [timeoutSignal, controller.signal];
      if (cancelController !== undefined) signals.push(cancelController.signal);

      const modelMessages = [...compiledContext.messages];
      if (resuming) {
        for (const event of runtimeStore.listEvents(runtimeSession.id, { limit: 5_000 })) {
          if (event.type !== "model.response-batch") continue;
          if (event.payload.state !== "available") {
            throw new RpcMethodError(
              RpcErrorCodes.SERVER_ERROR,
              "worker trace is locked; exact resume is unavailable",
              { locked: true },
            );
          }
          const payload = event.payload.value as { messages?: unknown };
          if (!Array.isArray(payload.messages)) {
            throw new Error("worker response batch has invalid message history");
          }
          modelMessages.push(...payload.messages as typeof modelMessages);
        }
      }

      events.record({ type: "attempt.started", attempt: 1 });
      try {
        const pricing = lookupPricing(kind, params.model);
        const pricingConfidence = pricing !== null ? pricing.confidence : "unpriced";
        const supervisorPricingConfidence = pricing === null
          ? "unpriced"
          : pricing.confidence === "verified"
            ? "verified"
            : "estimated";
        const requestedMaxSteps = params.maxSteps ?? runtime.maxSteps;
        const remainingBudgetSteps = runtimeSession.budgetSteps === undefined
          ? requestedMaxSteps
          : runtimeSession.budgetSteps - runtimeSession.usedSteps;
        if (remainingBudgetSteps < 1) throw new Error("worker step budget exhausted");
        const runSignal = AbortSignal.any(signals);
        const loopResult = await runWorkerLoop({
          model: languageModel,
          task: params.task,
          wikiDigest: params.wikiDigest,
          tools: activeTools,
          instructions: activeInstructions,
          contextWindow: params.experimentVariant === "full-history"
            ? undefined
            : resolveFamily(kind, params.model).contextWindow,
          beforeModelMessages: runtimeSession.kind === "child"
            ? () => engine.runtime.children.drainMessages(runtimeSession.id)
            : undefined,
          onModelStart: ({ step }) => engine.runtime.hooks.emit("model.before", {
            sessionId: runtimeSession.id,
            step,
          }),
          onCompaction: (compaction) => {
            runtimeStore.appendEvent(runtimeSession.id, {
              type: "context.compacted",
              metadata: {
                sourceStartMessage: compaction.sourceRange.startMessage,
                sourceEndMessage: compaction.sourceRange.endMessage,
                estimatedTokensBefore: compaction.estimatedTokensBefore,
                estimatedTokensAfter: compaction.estimatedTokensAfter,
              },
              payload: { summary: compaction.summary },
            });
            void engine.runtime.hooks.emit("context.compacted", {
              sessionId: runtimeSession.id,
              beforeTokens: compaction.estimatedTokensBefore,
              afterTokens: compaction.estimatedTokensAfter,
            });
          },
          maxSteps: Math.min(requestedMaxSteps, remainingBudgetSteps),
          abortSignal: runSignal,
          executeModelCall: (operation) => {
            supervisor?.reserveModelCall();
            return engine.providerGateway.execute(
              { providerId: params.providerId, signal: runSignal, cacheStatus: "unknown" },
              operation,
            );
          },
          messages: modelMessages,
          approvalResponse: params.approvalResponse,
          // Step progress is likewise structured + truncated (loop.ts's own
          // ON_STEP_TEXT_TRUNCATE_CHARS) — never the model's full raw output.
          onStep: (s) => {
            engine.notify("worker.progress", {
              taskId,
              kind: "step",
              step: s.step,
              toolCalls: s.toolCalls,
              text: s.text,
            });
          },
          onResponseBatch: async (batch) => {
            const stepCostUsd = pricing === null ? null : estimateCostUsd(pricing, batch.usage);
            supervisor?.recordCost(stepCostUsd, supervisorPricingConfidence);
            runtimeStore.appendEvent(runtimeSession.id, {
              type: "model.response-batch",
              metadata: {
                step: batch.step,
                toolCalls: batch.toolCalls,
                finishReason: batch.finishReason,
                inputTokens: batch.usage.inputTokens,
                outputTokens: batch.usage.outputTokens,
                cacheReadTokens: batch.usage.cacheReadTokens,
              },
              payload: { messages: batch.messages },
            });
            const latest = runtimeStore.requireSession(runtimeSession.id);
            runtimeSession = runtimeStore.updateSession(latest.id, latest.version, {
              usedSteps: latest.usedSteps + 1,
              inputTokens: latest.inputTokens + batch.usage.inputTokens,
              outputTokens: latest.outputTokens + batch.usage.outputTokens,
            });
            void engine.runtime.hooks.emit("model.after", {
              sessionId: runtimeSession.id,
              step: batch.step,
              inputTokens: batch.usage.inputTokens,
              outputTokens: batch.usage.outputTokens,
            });

            // Every completed mutating batch gets a binary-safe checkpoint
            // before another model turn can begin.
            if (mutatingToolFinished) {
              const checkpointPatch = await manager.checkpointPatch(worktree);
              if (checkpointPatch.length > 0) {
                runtimeStore.putCheckpoint({
                  sessionId: runtimeSession.id,
                  baseSha: worktree.baseSha,
                  worktreeFingerprint: createHash("sha256")
                    .update(checkpointPatch)
                    .digest("hex"),
                  patch: Buffer.from(checkpointPatch, "utf8"),
                });
                if (params.parentSessionId !== undefined) {
                  runtimeStore.putCheckpoint({
                    sessionId: params.parentSessionId,
                    baseSha: worktree.baseSha,
                    worktreeFingerprint: createHash("sha256").update(checkpointPatch).digest("hex"),
                    patch: Buffer.from(checkpointPatch, "utf8"),
                  });
                }
              }
              mutatingToolFinished = false;
            }
            const childParentSessionId = runtimeSession.parentSessionId ?? runtimeSession.id;
            if (runtimeSession.kind !== "child") {
              engine.runtime.children.refreshParentStartPoint(runtimeStore, childParentSessionId);
            }
          },
        });

        if (loopResult.pendingApproval !== undefined) {
          // Checkpoint immediately before the externally visible pause, even
          // when the most recent batch itself only requested approval.
          const checkpointPatch = await manager.checkpointPatch(worktree);
          if (checkpointPatch.length > 0) {
            runtimeStore.putCheckpoint({
              sessionId: runtimeSession.id,
              baseSha: worktree.baseSha,
              worktreeFingerprint: createHash("sha256").update(checkpointPatch).digest("hex"),
              patch: Buffer.from(checkpointPatch, "utf8"),
            });
            if (params.parentSessionId !== undefined) {
              runtimeStore.putCheckpoint({
                sessionId: params.parentSessionId,
                baseSha: worktree.baseSha,
                worktreeFingerprint: createHash("sha256").update(checkpointPatch).digest("hex"),
                patch: Buffer.from(checkpointPatch, "utf8"),
              });
            }
          }
          const waiting = runtimeStore.requestApproval(runtimeSession.id, runtimeSession.version, {
            id: loopResult.pendingApproval.approvalId,
          policySource: "runtime-policy-or-enforcing-hook",
          scope: {
            capability: loopResult.pendingApproval.toolName === "bash" ? "process-or-network" : "tool",
              tool: loopResult.pendingApproval.toolName,
            },
            request: {
              toolCallId: loopResult.pendingApproval.toolCallId,
              toolName: loopResult.pendingApproval.toolName,
              input: loopResult.pendingApproval.input,
            },
          });
          runtimeSession = waiting.session;
          engine.notify("session.changed", toSessionChangedNotification(runtimeSession));
          return {
            paused: true,
            sessionId: runtimeSession.id,
            runId: eventRunId,
            approvalId: waiting.approval.id,
            summary: loopResult.summary,
            steps: loopResult.steps,
            toolCallCount: loopResult.toolCallCount,
            usage: loopResult.usage,
            costUsd: null,
            worktree: { path: worktree.path, branch: worktree.branch },
            dialectPack: runtime.dialectPackId,
            dialectPackVersion: runtime.dialectPackVersion,
            editDialect: runtime.editDialect,
            toolCallCounts,
            toolErrorCounts,
            editFailCount,
          };
        }

        const diff = runtimeSession.kind === "child" && params.childStartTreeSha !== undefined
          ? await manager.patchAgainstTree(worktree, params.childStartTreeSha)
          : await manager.diff(worktree);
        const diffStat = runtimeSession.kind === "child" && params.childStartTreeSha !== undefined
          ? await manager.diffStatAgainstTree(worktree, params.childStartTreeSha)
          : await manager.diffStat(worktree);

        const costUsd = pricing !== null ? estimateCostUsd(pricing, loopResult.usage) : null;

        // Metered under the PROVIDER kind (e.g. "deepseek", "zai"), NOT a
        // synthetic "worker/..." kind — pricing.ts's table is keyed by provider
        // kind, and engine.models.usage's byModel breakdown needs to line up
        // with engine.models.complete's own records for the same provider/model
        // so totals stay comparable across call sites. `source: "worker"`
        // (M5b Task 1) is what makes worker vs engine.models.complete vs
        // engine.frontier.* records distinguishable in the ledger — see
        // engine.models.usage's bySource breakdown.
        engine.providerGateway.recordUsage({
          providerId: params.providerId,
          kind,
          model: params.model,
          usage: loopResult.usage,
          costUsd,
          at: Date.now(),
          source: "worker",
          pricingConfidence,
        });

        engine.log(
          `worker.run ${taskId} ${kind}/${params.model}: ${loopResult.steps} steps, ${loopResult.toolCallCount} tool calls pack=${runtime.dialectPackId}`,
        );
        // Phase 1 telemetry: names + counts + error kinds only, never arguments.
        engine.log(`worker.run tool-calls model=${params.model} ${JSON.stringify(toolCallCounts)}`);
        if (Object.keys(toolErrorCounts).length > 0) {
          engine.log(
            `worker.run tool-errors model=${params.model} pack=${runtime.dialectPackId} ${JSON.stringify(toolErrorCounts)} editFail=${editFailCount}`,
          );
        }

        events.record({ type: "attempt.finished", attempt: 1, outcome: "succeeded" });
        events.record({ type: "run.finished", outcome: "succeeded" });
        runtimeStore.appendEvent(runtimeSession.id, {
          type: "worker.completed",
          metadata: {
            steps: loopResult.steps,
            toolCallCount: loopResult.toolCallCount,
            hasDiff: diff.length > 0,
            costUsd,
          },
          payload: { summary: loopResult.summary, diff, diffStat },
        });
        if (runtimeSession.kind === "child") {
          const patchArtifact = runtimeStore.putArtifact(
            runtimeSession.id,
            "child-patch",
            Buffer.from(diff, "utf8"),
          );
          runtimeStore.appendEvent(runtimeSession.id, {
            type: "child.result",
            metadata: {
              artifactId: patchArtifact.id,
              diffStat: diffStat.slice(0, 8_000),
              hasDiff: diff.length > 0,
            },
            payload: { summary: loopResult.summary },
          });
        }
        {
          const latest = runtimeStore.requireSession(runtimeSession.id);
          runtimeSession = runtimeStore.updateSession(latest.id, latest.version, {
            status: "completed",
            outcome: "succeeded",
            costUsd,
          });
          engine.notify("session.changed", toSessionChangedNotification(runtimeSession));
        }

        return {
          sessionId: runtimeSession.id,
          runId: eventRunId,
          diff,
          diffStat,
          summary: loopResult.summary,
          steps: loopResult.steps,
          toolCallCount: loopResult.toolCallCount,
          usage: loopResult.usage,
          costUsd,
          worktree: { path: worktree.path, branch: worktree.branch },
          dialectPack: runtime.dialectPackId,
          dialectPackVersion: runtime.dialectPackVersion,
          editDialect: runtime.editDialect,
          toolCallCounts,
          toolErrorCounts,
          editFailCount,
        };
      } catch (err) {
        // The worktree (and any partial edits already on disk) is
        // DELIBERATELY left in place on failure — see worktree.ts's own
        // class-level doc comment ("never call remove() from a failure
        // path"). The path is carried in `data` so the caller can inspect, or
        // manually clean up the partial work via engine.worker.cleanup.
        const rawMessage = err instanceof Error ? err.message : String(err);
        // Distinguishes WHY the run was cut short, checking each abort
        // source's own `.aborted` flag (set the instant that signal fires,
        // independent of whatever the AI SDK/provider adapter did to the
        // thrown error) rather than parsing `err`'s shape — see the abort
        // signal setup above for why that's safe to do here. `timeoutSignal`
        // is checked first: if BOTH happened to be aborted (a close raced a
        // timeout), "timed out" is the more informative half of that story.
        // M7b Task 2: `cancelled` (engine.cancel({runId}) fired this run's own
        // controller) is checked NEXT, ahead of the generic
        // `controller.signal.aborted` (Engine.close()'s "abort ALL worker
        // runs" mechanism) -- the two are orthogonal abort sources that just
        // happen to share the same combined signal.
        const shuttingDown = engine.runtime.shuttingDown;
        const cancelled = cancelController?.signal.aborted === true && !shuttingDown;
        if (timeoutSignal.aborted) {
          events.record({ type: "attempt.finished", attempt: 1, outcome: "cancelled" });
          events.record({ type: "run.cancelled", reason: "timeout" });
        } else if (cancelled) {
          events.record({ type: "attempt.finished", attempt: 1, outcome: "cancelled" });
          events.record({ type: "run.cancelled", reason: "user" });
        } else if (controller.signal.aborted) {
          events.record({ type: "attempt.finished", attempt: 1, outcome: "cancelled" });
          events.record({ type: "run.cancelled", reason: "shutdown" });
        } else {
          events.record({ type: "attempt.finished", attempt: 1, outcome: "failed" });
          events.record({ type: "run.finished", outcome: "error" });
        }
        const runtimeOutcome = timeoutSignal.aborted
          ? "timeout"
          : cancelled
            ? "cancelled"
            : controller.signal.aborted
              ? "shutdown"
              : "failed";
        const shutdown = shuttingDown && !timeoutSignal.aborted;
        runtimeStore.appendEvent(runtimeSession.id, {
          type: shutdown ? "worker.interrupted" : "worker.failed",
          metadata: { category: runtimeOutcome },
          payload: { message: rawMessage },
        });
        {
          const latest = runtimeStore.requireSession(runtimeSession.id);
          if (latest.status !== "completed" && latest.status !== "failed" && latest.status !== "cancelled") {
            runtimeSession = runtimeStore.updateSession(latest.id, latest.version, {
              status: shutdown
                ? "interrupted"
                : cancelled || timeoutSignal.aborted
                  ? "cancelled"
                  : "failed",
              outcome: runtimeOutcome,
            });
            engine.notify("session.changed", toSessionChangedNotification(runtimeSession));
          }
        }
        const message = timeoutSignal.aborted
          ? `worker run timed out after ${timeoutMs}ms: ${rawMessage}`
          : cancelled
            ? `worker run cancelled: ${rawMessage}`
            : controller.signal.aborted
              ? `worker run aborted: ${rawMessage}`
              : rawMessage;
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `worker run failed: ${message}`, {
          worktree: { path: worktree.path, branch: worktree.branch },
          ...(cancelled ? { cancelled: true } : {}),
        });
      }
    } catch (err) {
      if (failureStore !== undefined && failureSessionId !== undefined) {
        try {
          const latest = failureStore.requireSession(failureSessionId);
          if (!["completed", "failed", "cancelled"].includes(latest.status)) {
            const shutdown = engine.runtime.shuttingDown || controller.signal.aborted;
            const cancelled = params.runId !== undefined &&
              engine.cancelRegistry.get(params.runId)?.signal.aborted === true;
            failureEvents?.record(
              shutdown || cancelled
                ? { type: "run.cancelled", reason: shutdown ? "shutdown" : "user" }
                : { type: "run.finished", outcome: "error" },
            );
            failureStore.appendEvent(failureSessionId, {
              type: shutdown ? "worker.interrupted" : "worker.failed",
              metadata: {
                category: shutdown ? "shutdown" : cancelled ? "cancelled" : "setup",
              },
              payload: { message: err instanceof Error ? err.message : String(err) },
            });
            const updated = failureStore.updateSession(latest.id, latest.version, {
              status: shutdown ? "interrupted" : cancelled ? "cancelled" : "failed",
              outcome: shutdown ? "shutdown" : cancelled ? "cancelled" : "setup-failed",
            });
            engine.notify("session.changed", toSessionChangedNotification(updated));
          }
        } catch {
          // Preserve the originating failure. Runtime persistence is already
          // crash-consistent and startup recovery will classify any row that
          // could not be finalized in this best-effort last boundary.
        }
      }
      if (err instanceof RpcMethodError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `worker run failed: ${message}`, {
        ...(failureWorktree === undefined
          ? {}
          : { worktree: { path: failureWorktree.path, branch: failureWorktree.branch } }),
      });
    } finally {
      // Every admitted handler unregisters only after all setup, execution,
      // persistence, and error mapping have finished.
      pinnedWikiStore?.close();
      engine.worker.endRun(controller);
    }
}

export function registerWorkerMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.worker.run", RunParamsSchema, (params) => {
    requireGitRepo(params.projectDir);
    const runId = params.runId ?? randomUUID();
    return engine.runKernel.run(
      { runId, projectDir: params.projectDir, kind: "worker", writer: true },
      (supervisor) => {
        const snapshot = supervisor.taskSnapshot;
        if (params.baseSha !== undefined && params.baseSha !== snapshot.baseSha) {
          throw new RpcMethodError(RpcErrorCodes.INVALID_PARAMS, "worker baseSha does not match its task snapshot");
        }
        if (
          params.harnessGeneration !== undefined &&
          params.harnessGeneration !== snapshot.harnessGeneration
        ) {
          throw new RpcMethodError(
            RpcErrorCodes.INVALID_PARAMS,
            "worker harness generation does not match its task snapshot",
          );
        }
        if (
          params.harnessFingerprint !== undefined &&
          params.harnessFingerprint !== snapshot.harnessFingerprint
        ) {
          throw new RpcMethodError(
            RpcErrorCodes.INVALID_PARAMS,
            "worker harness fingerprint does not match its task snapshot",
          );
        }
        if (
          params.taskWikiHeadSha !== undefined &&
          params.taskWikiHeadSha !== snapshot.wikiHeadSha
        ) {
          throw new RpcMethodError(
            RpcErrorCodes.INVALID_PARAMS,
            "worker wiki HEAD does not match its task snapshot",
          );
        }
        if (
          params.taskWikiDigest !== undefined &&
          params.taskWikiDigest !== snapshot.wikiDigest
        ) {
          throw new RpcMethodError(
            RpcErrorCodes.INVALID_PARAMS,
            "worker wiki digest does not match its task snapshot",
          );
        }
        return engine.worker.run(engine, {
          ...params,
          runId,
          baseSha: snapshot.baseSha,
          harnessGeneration: snapshot.harnessGeneration,
          harnessFingerprint: snapshot.harnessFingerprint,
          taskWikiHeadSha: snapshot.wikiHeadSha,
          taskWikiDigest: snapshot.wikiDigest,
        }, supervisor);
      },
    );
  });

  registerMethod(engine.dispatcher, "engine.worker.cleanup", CleanupParamsSchema, async (params) => {
    // Same git guard as engine.worker.run: without it, a non-git
    // projectDir reaches `getManager` -> `WorktreeManager.prune()` -> a
    // failing `git worktree prune` call, whose raw `Error` falls through to
    // the dispatcher's generic INTERNAL_ERROR (-32603) instead of this
    // method's SERVER_ERROR (-32000) contract.
    const result = await engine.worker.cleanup(params.projectDir, params.worktreePath, {
      deleteBranch: params.deleteBranch,
    });
    if (result.removed) engine.log("worker.cleanup removed");
    return result;
  });

  // The worktree lifecycle policy's DISCOVERY half (M5b Task 5): a thin
  // projection of WorktreeManager.list() down to {path, branch} — everything
  // a caller needs to decide what to keep vs sweep, without leaking `base`/
  // `baseSha` (internal to diff()/diffStat()'s anchoring, not part of this
  // surface's contract). Reads are always live off `git worktree list
  // --porcelain` (via the cached manager) rather than any locally-tracked
  // set, so this reflects reality even after an out-of-band `git worktree
  // remove` or a crash that skipped engine.worker.cleanup entirely.
  registerMethod(engine.dispatcher, "engine.worker.list", ListParamsSchema, async (params) => {
    requireGitRepo(params.projectDir);
    const manager = await engine.worker.getManager(params.projectDir);
    const worktrees = await manager.list();
    return { worktrees: worktrees.map((w) => ({ path: w.path, branch: w.branch })) };
  });

  // The worktree lifecycle policy's SWEEP half (M5b Task 5). The three
  // producers of worker worktrees each have their own disposition already:
  // engine.worker.run leaves success AND failure worktrees on disk on
  // purpose (see worktree.ts's class doc comment); engine.orchestrate cleans
  // up its OWN rejected/empty-diff attempts as it goes (orchestrate.ts's
  // cleanupWorktree) and deliberately leaves the surviving
  // approved/escalated worktree for engine.orchestrate.apply to read the
  // diff from. What neither of those covers is a worktree abandoned by a
  // crash (engine process killed mid-run, before any of the above cleanup
  // logic got to run) — gc is that backstop: call it with `keep` set to
  // whatever worktree paths are still legitimately in flight (e.g. the one
  // orchestrate just returned as its result), and everything else this
  // manager knows about gets removed, branch and all. Safe to call
  // unconditionally after a session ends, or periodically — a project with
  // zero worker worktrees is a no-op (`removed: []`, `failed: []`).
  //
  // Final review Fix 1 (Important): each worktree's manager.remove() call is
  // now isolated in its own try/catch — a mid-sweep failure (e.g. a locked
  // file handle, a permissions error) used to escape uncaught, aborting the
  // WHOLE gc call with a generic INTERNAL_ERROR and losing the `removed`
  // list for every worktree already swept before the failing one. A failure
  // is now recorded in `failed` (path + error message) and the sweep
  // continues — the caller gets back exactly what happened instead of an
  // all-or-nothing throw, so a partial gc can be retried or inspected rather
  // than silently discarded.
  registerMethod(engine.dispatcher, "engine.worker.gc", GcParamsSchema, async (params) => {
    requireGitRepo(params.projectDir);
    const manager = await engine.worker.getManager(params.projectDir);
    const worktrees = await manager.list();
    // Comparison is realpath-based (resolveProjectKey — the same helper
    // WorkerService itself uses to key its manager cache), not raw string
    // equality: a `keep` entry reached through a symlinked path spelling
    // (or a relative one) must still match the manager's own, already
    // realpath'd worktree.path (see WorktreeManager's constructor doc
    // comment on why baseRepo — and therefore every path it returns — is
    // realpath'd up front).
    const keep = new Set((params.keep ?? []).map(resolveProjectKey));
    const removed: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    for (const worktree of worktrees) {
      if (keep.has(resolveProjectKey(worktree.path))) continue;
      try {
        await manager.remove(worktree, { deleteBranch: true });
        removed.push(worktree.path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ path: worktree.path, error: message });
      }
    }
    if (removed.length > 0) {
      engine.log(`worker.gc removed ${removed.length} worktree(s)`);
    }
    if (failed.length > 0) {
      engine.log(`worker.gc failed to remove ${failed.length} worktree(s)`);
    }
    return { removed, failed };
  });
}
