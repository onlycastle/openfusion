import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import type { RuntimeStore } from "../src/runtime/store.js";
import type { SandboxBackend } from "../src/runtime/sandbox.js";
import type { RuntimeSession } from "../src/runtime/types.js";
import { createChildTools } from "../src/runtime/children.js";
import { ToolGateway } from "../src/tools/gateway.js";
import type { WorktreeManager, Worktree } from "../src/worker/worktree.js";

let projectDir: string | undefined;
let storageDir: string | undefined;
let engine: Engine | undefined;

afterEach(async () => {
  await engine?.close();
  engine = undefined;
  if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
  if (storageDir !== undefined) rmSync(storageDir, { recursive: true, force: true });
  projectDir = undefined;
  storageDir = undefined;
});

function repo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "of-children-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@openfusion.local"]);
  execFileSync("git", ["-C", root, "config", "user.name", "OpenFusion Test"]);
  writeFileSync(path.join(root, "shared.txt"), "base\n", "utf8");
  execFileSync("git", ["-C", root, "add", "shared.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  return root;
}

async function parentFixture(store: RuntimeStore): Promise<{
  parent: RuntimeSession;
  worktree: Worktree;
  manager: WorktreeManager;
}> {
  let parent = store.createSession({ kind: "orchestrate", budgetSteps: 90 });
  const manager = await engine!.worker.getManager(projectDir!);
  const worktree = await manager.create(parent.id);
  parent = store.updateSession(parent.id, parent.version, {
    status: "running",
    worktreePath: worktree.path,
    baseSha: worktree.baseSha,
  });
  writeFileSync(path.join(worktree.path, "parent.txt"), "checkpoint\n", "utf8");
  store.putCheckpoint({
    sessionId: parent.id,
    baseSha: worktree.baseSha,
    worktreeFingerprint: "parent-v1",
    patch: Buffer.from(await manager.checkpointPatch(worktree), "utf8"),
  });
  return { parent, worktree, manager };
}

function configure(model: MockLanguageModelV4, sandboxBackend?: SandboxBackend): RuntimeStore {
  projectDir = repo();
  storageDir = mkdtempSync(path.join(os.tmpdir(), "of-child-storage-"));
  engine = createEngine({ appStorageDir: storageDir, sandboxBackend });
  engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: "test" });
  engine.models.registry.setTestModel("p1", model);
  engine.runtime.configure(projectDir, {
    traceKey: Buffer.alloc(32, 9).toString("base64"),
    traceEnabled: true,
    childrenEnabled: true,
  });
  return engine.runtime.getStore(projectDir);
}

async function waitForStatus(store: RuntimeStore, id: string, status: string): Promise<RuntimeSession> {
  for (let index = 0; index < 300; index += 1) {
    const session = store.requireSession(id);
    if (session.status === status) return session;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`session ${id} did not reach ${status}`);
}

describe("bounded child sessions", () => {
  it("routes model-facing child tools through ToolGateway and fails spawning closed without containment", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "unused" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const store = configure(model);
    const { parent } = await parentFixture(store);
    const decisions: Array<{ toolId: string; decision: string }> = [];
    const tools = createChildTools({
      engine: engine!,
      store,
      parentSessionId: parent.id,
      providerId: "p1",
      model: "deepseek-v4-flash",
      sandboxCertified: false,
      toolGateway: new ToolGateway({
        onDecision: (invocation, decision) => decisions.push({
          toolId: invocation.toolId,
          decision: decision.decision,
        }),
      }),
    });
    const execute = async (name: string, args: unknown): Promise<unknown> => {
      const definition = tools[name] as unknown as {
        execute(input: unknown, options: { abortSignal?: AbortSignal }): Promise<unknown>;
      };
      return definition.execute(args, {});
    };

    await expect(execute("list_children", {})).resolves.toMatchObject({ children: [] });
    await expect(execute("spawn_child", { task: "must not start" })).resolves.toMatchObject({
      errorKind: "policy_denied",
    });
    expect(store.listChildren(parent.id)).toHaveLength(0);
    expect(decisions).toEqual([
      { toolId: "list_children", decision: "allow" },
      { toolId: "spawn_child", decision: "deny" },
    ]);
  });

  it("constructs checkpoint-derived worktrees and enforces depth and per-parent concurrency", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        await gate;
        return {
          content: [{ type: "text", text: "child done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: 3, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const store = configure(model);
    const { parent } = await parentFixture(store);
    const children: RuntimeSession[] = [];
    for (let index = 0; index < 3; index += 1) {
      children.push(await engine!.runtime.children.spawn(engine!, store, {
        parentSessionId: parent.id,
        task: `child ${index}`,
        providerId: "p1",
        model: "deepseek-v4-flash",
      }));
    }
    expect(children.every((child) => child.budgetSteps === 20)).toBe(true);
    expect(children.every((child) => existsSync(path.join(child.worktreePath!, "parent.txt")))).toBe(true);
    const delegation = store.latestEvent(children[0]!.id, "delegation.accepted");
    expect(delegation?.metadata).toMatchObject({
      parentSessionId: parent.id,
      providerId: "p1",
      maxSteps: 20,
    });
    expect(delegation?.metadata.authorityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(delegation?.metadata)).not.toContain("apiKey");
    await expect(engine!.runtime.children.spawn(engine!, store, {
      parentSessionId: parent.id,
      task: "too many",
      providerId: "p1",
      model: "deepseek-v4-flash",
    })).rejects.toThrow(/3 active children/);
    await expect(engine!.runtime.children.spawn(engine!, store, {
      parentSessionId: children[0]!.id,
      task: "recursive",
      providerId: "p1",
      model: "deepseek-v4-flash",
    })).rejects.toThrow(/cannot spawn children/);

    release();
    for (const child of children) await waitForStatus(store, child.id, "completed");
    const result = engine!.runtime.children.result(store, parent.id, children[0]!.id);
    expect(result).toMatchObject({ summaryAvailable: true, summary: "child done" });
    expect(result.artifactId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("imports a non-conflicting opaque patch and never touches the selected checkout", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "unused" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const store = configure(model);
    const { parent, worktree: parentWorktree, manager } = await parentFixture(store);
    const checkpoint = store.latestCheckpoint(parent.id)!;
    const childWorktree = await manager.reconstruct(
      "manual-child",
      checkpoint.baseSha,
      (await import("node:zlib")).gunzipSync(store.readArtifact(checkpoint.patchArtifactId)),
    );
    const childStartTree = await manager.snapshotTree(childWorktree);
    writeFileSync(path.join(childWorktree.path, "child.txt"), "from child\n", "utf8");
    let child = store.createSession({
      parentSessionId: parent.id,
      parentCheckpointSeq: checkpoint.seq,
      kind: "child",
      worktreePath: childWorktree.path,
      baseSha: childWorktree.baseSha,
    });
    const patch = Buffer.from(await manager.patchAgainstTree(childWorktree, childStartTree), "utf8");
    const artifact = store.putArtifact(child.id, "child-patch", patch);
    store.appendEvent(child.id, {
      type: "child.result",
      metadata: { artifactId: artifact.id, diffStat: "child.txt | 1 +" },
      payload: { summary: "added child file" },
    });
    child = store.updateSession(child.id, child.version, { status: "running" });
    child = store.updateSession(child.id, child.version, { status: "completed" });

    const imported = await engine!.runtime.children.importDiff(
      engine!,
      store,
      parent.id,
      parent.version,
      child.id,
    );
    expect(imported.imported).toBe(true);
    expect(readFileSync(path.join(parentWorktree.path, "child.txt"), "utf8")).toBe("from child\n");
    expect(existsSync(path.join(projectDir!, "child.txt"))).toBe(false);
    expect(store.getChildRelation(child.id)?.patchImportState).toBe("imported");
  });

  it("rejects conflicts without partial parent mutation and propagates parent cancellation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        await gate;
        throw new Error("cancelled child model");
      },
    });
    const store = configure(model);
    const { parent, worktree: parentWorktree, manager } = await parentFixture(store);
    const checkpoint = store.latestCheckpoint(parent.id)!;
    const childWorktree = await manager.reconstruct(
      "conflict-child",
      checkpoint.baseSha,
      (await import("node:zlib")).gunzipSync(store.readArtifact(checkpoint.patchArtifactId)),
    );
    const childStartTree = await manager.snapshotTree(childWorktree);
    writeFileSync(path.join(childWorktree.path, "shared.txt"), "child\n", "utf8");
    let conflictChild = store.createSession({
      parentSessionId: parent.id,
      parentCheckpointSeq: checkpoint.seq,
      kind: "child",
      worktreePath: childWorktree.path,
      baseSha: childWorktree.baseSha,
    });
    const artifact = store.putArtifact(
      conflictChild.id,
      "child-patch",
      Buffer.from(await manager.patchAgainstTree(childWorktree, childStartTree), "utf8"),
    );
    store.appendEvent(conflictChild.id, { type: "child.result", metadata: { artifactId: artifact.id } });
    conflictChild = store.updateSession(conflictChild.id, conflictChild.version, { status: "running" });
    conflictChild = store.updateSession(conflictChild.id, conflictChild.version, { status: "completed" });
    writeFileSync(path.join(parentWorktree.path, "shared.txt"), "parent\n", "utf8");
    const conflict = await engine!.runtime.children.importDiff(
      engine!, store, parent.id, parent.version, conflictChild.id,
    );
    expect(conflict).toMatchObject({ imported: false, reason: "conflict" });
    expect(readFileSync(path.join(parentWorktree.path, "shared.txt"), "utf8")).toBe("parent\n");

    let latestParent = store.requireSession(parent.id);
    const active = await engine!.runtime.children.spawn(engine!, store, {
      parentSessionId: parent.id,
      task: "stay active",
      providerId: "p1",
      model: "deepseek-v4-flash",
    });
    latestParent = store.requireSession(parent.id);
    engine!.runtime.cancel(engine!, store, parent.id, latestParent.version);
    release();
    await waitForStatus(store, active.id, "cancelled");
  });

  it("bubbles a child's approval through a running parent and resumes the exact trace", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            content: [{
              type: "tool-call",
              toolCallId: "child-network",
              toolName: "bash",
              input: JSON.stringify({ command: "printf approved > child-approved.txt", network: true }),
            }],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 3, text: 3, reasoning: undefined },
            },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "approved child done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 4, text: 4, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    const sandbox: SandboxBackend = {
      async status() { return { backend: "openfusion-sandbox", available: true, provisional: false }; },
      async run(request) {
        const stdout = execFileSync(request.executable, request.args, { cwd: request.cwd });
        request.output.write(stdout);
        const artifact = request.output.finish();
        return {
          exitCode: 0,
          signal: null,
          artifact,
          preview: stdout.toString("utf8"),
          previewTruncated: false,
          outputBytes: stdout.length,
        };
      },
    };
    const store = configure(model, sandbox);
    // A project network grant is deliberately broader than the parent's
    // empty frozen authority. Child intersection must still ask.
    store.configure({ sandboxGrants: ["network"] });
    const { parent } = await parentFixture(store);
    const child = await engine!.runtime.children.spawn(engine!, store, {
      parentSessionId: parent.id,
      task: "run approved command",
      providerId: "p1",
      model: "deepseek-v4-flash",
    });
    await waitForStatus(store, child.id, "waiting-approval");
    const pending = store.getPendingApprovalInTree(parent.id)!;
    expect(pending.sessionId).toBe(child.id);
    const currentParent = store.requireSession(parent.id);
    const response = await engine!.dispatcher.dispatch({
      jsonrpc: "2.0",
      id: "approval",
      method: "engine.sessions.action",
      params: {
        projectDir,
        sessionId: parent.id,
        expectedVersion: currentParent.version,
        action: {
          type: "respond-approval",
          approvalId: pending.id,
          approved: true,
          response: { reason: "human approved child elevation" },
        },
      },
    });
    expect(response?.error).toBeUndefined();
    await waitForStatus(store, child.id, "completed");
    expect(readFileSync(path.join(child.worktreePath!, "child-approved.txt"), "utf8")).toBe("approved");
    expect(store.requireSession(parent.id).status).toBe("running");
    expect(modelCalls).toBe(2);
  });
});
