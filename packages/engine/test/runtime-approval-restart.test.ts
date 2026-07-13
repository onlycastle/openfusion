import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type VerificationRunner } from "../src/engine.js";
import type { FrontierAdapter, FrontierEvent, FrontierSession } from "../src/engines/types.js";
import type { AgentDef, HarnessBundle, Routing, WikiPage } from "../src/harness/schema.js";
import { writeHarness } from "../src/harness/store.js";
import { runtimeCapabilities } from "../src/runtime/capabilities.js";
import { MacOsSandboxBackend } from "../src/runtime/sandbox.js";
import { createPassthroughSandboxRunner } from "./native-sandbox-fixture.js";

let projectDir: string | undefined;
let appStorageDir: string | undefined;
let engine: Engine | undefined;

afterEach(async () => {
  await engine?.close();
  engine = undefined;
  if (projectDir !== undefined) rmSync(projectDir, { recursive: true, force: true });
  if (appStorageDir !== undefined) rmSync(appStorageDir, { recursive: true, force: true });
  projectDir = undefined;
  appStorageDir = undefined;
});

function makeRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "of-root-approval-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@openfusion.local"]);
  execFileSync("git", ["-C", root, "config", "user.name", "OpenFusion Test"]);
  writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  return root;
}

async function writeHarnessFixture(root: string): Promise<void> {
  const headSha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const page: WikiPage = {
    slug: "architecture",
    title: "Architecture",
    digest: "Runtime approval fixture.",
    body: "# Architecture\n",
  };
  const agent: AgentDef = {
    name: "worker",
    role: "worker",
    description: "Fixture worker",
    prompt: "Implement the task.",
    taskClasses: ["codegen"],
    model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "p1" },
    escalation: { maxAttempts: 1 },
  };
  const routing: Routing = {
    version: 1,
    taskClasses: { codegen: { agent: "worker" } },
    escalation: { failuresBeforeFrontier: 1 },
    defaults: { agent: "worker" },
  };
  const bundle: HarnessBundle = {
    manifest: {
      schemaVersion: 1,
      generatorVersion: "0.0.1",
      engine: "claude-code",
      headSha,
      generatedAt: new Date().toISOString(),
      verification: { structural: "pass", evals: "pending" },
      artifacts: [],
    },
    pages: [page],
    agents: [agent],
    routing,
  };
  await writeHarness(root, bundle);
}

function sandbox(root: string): MacOsSandboxBackend {
  return new MacOsSandboxBackend({
    platform: "darwin",
    runnerExecutable: createPassthroughSandboxRunner(root),
    probe: async () => ({ ok: true }),
  });
}

const verifier: VerificationRunner = {
  async status() {
    return { available: true };
  },
  async run() {
    return { exitCode: 0 };
  },
};

function approvingReviewer(): FrontierAdapter {
  return {
    kind: "claude-code",
    async capabilities() {
      return runtimeCapabilities({
        runtimeId: "claude-code",
        runtimeVersion: "test",
        protocolVersion: "test-v1",
        structuredOutput: true,
        toolCalls: true,
        pathAwareApprovals: true,
        mcp: false,
        resume: false,
        fork: false,
        compaction: false,
        sandboxCompatibility: "certified",
      });
    },
    async createSession({ projectDir: sessionProjectDir }): Promise<FrontierSession> {
      return {
        id: randomUUID(),
        projectDir: sessionProjectDir,
        prompt() {
          async function* events(): AsyncGenerator<FrontierEvent> {
            yield {
              type: "text",
              text: "```json\n{\"decision\":\"approve\",\"reasons\":[],\"severity\":\"none\"}\n```",
            };
            yield {
              type: "result",
              resultText: "",
              costUsd: 0.01,
              usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
              numTurns: 1,
              durationMs: 1,
              engineSessionId: null,
            };
          }
          return { events: events(), abort() {} };
        },
        async close() {},
      };
    },
  };
}

async function rpc(method: string, params: unknown): Promise<any> {
  return engine!.dispatcher.dispatch({ jsonrpc: "2.0", id: "test", method, params });
}

describe("orchestration approval restart", () => {
  it("proxies the child approval through the root and resumes its exact worker trace", async () => {
    projectDir = makeRepo();
    await writeHarnessFixture(projectDir);
    appStorageDir = mkdtempSync(path.join(os.tmpdir(), "of-root-approval-storage-"));
    const traceKey = Buffer.alloc(32, 77).toString("base64");
    const runId = "approval-root-run";
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            content: [{
              type: "tool-call",
              toolCallId: "root-network-call",
              toolName: "bash",
              input: JSON.stringify({ command: "printf resumed > root-approved.txt", network: true }),
            }],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: {
              inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "resumed" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 30, noCache: 30, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 8, text: 8, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    const configureEngine = (): void => {
      engine = createEngine({
        appStorageDir,
        sandboxBackend: sandbox(projectDir!),
        verificationRunner: verifier,
      });
      engine.frontier.registerAdapter(approvingReviewer());
      engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: "test-only-key" });
      engine.models.registry.setTestModel("p1", model);
      engine.runtime.configure(projectDir!, { traceKey, traceEnabled: true });
    };

    configureEngine();
    const store = engine!.runtime.getStore(projectDir);
    let root = store.createSession({
      runId,
      kind: "orchestrate",
      initialPayload: {
        operation: "orchestrate",
        params: { projectDir, task: "Use the approved network command", runId, interactive: true },
      },
    });
    root = store.updateSession(root.id, root.version, { status: "running" });
    const workerTask = "Implement the task.\n\nUse the approved network command";
    const paused = await rpc("engine.worker.run", {
      projectDir,
      task: workerTask,
      providerId: "p1",
      model: "deepseek-v4-flash",
      runId,
      parentSessionId: root.id,
      interactive: true,
    });
    expect(paused.error).toBeUndefined();
    expect(paused.result.paused).toBe(true);
    const workerSessionId = paused.result.sessionId as string;
    const approvalId = paused.result.approvalId as string;
    const worktreePath = paused.result.worktree.path as string;
    store.appendEvent(root.id, {
      type: "orchestrate.approval-pause",
      metadata: { workerSessionId, approvalId },
      payload: {
        operation: "approval-pause",
        state: {
          workerSessionId,
          approvalId,
          worker: { task: workerTask, providerId: "p1", model: "deepseek-v4-flash" },
        },
      },
    });
    root = store.requireSession(root.id);
    root = store.updateSession(root.id, root.version, { status: "waiting-approval" });
    expect(existsSync(path.join(worktreePath, "root-approved.txt"))).toBe(false);

    await engine!.close();
    engine = undefined;
    configureEngine();
    const pending = await rpc("engine.sessions.get", { projectDir, sessionId: root.id });
    expect(pending.result.pendingApproval).toMatchObject({ id: approvalId, sessionId: workerSessionId });

    const responded = await rpc("engine.sessions.action", {
      projectDir,
      sessionId: root.id,
      expectedVersion: pending.result.session.version,
      action: {
        type: "respond-approval",
        approvalId,
        approved: true,
        response: { reason: "approved after restart" },
      },
    });
    expect(responded.error).toBeUndefined();

    let terminal: any;
    for (let index = 0; index < 300; index += 1) {
      terminal = (await rpc("engine.sessions.get", {
        projectDir,
        sessionId: root.id,
        includeEvents: true,
      })).result;
      if (["completed", "failed", "cancelled"].includes(terminal.session.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(terminal.session.status).toBe("completed");
    expect(terminal.session.outcome).toBe("worker-approved");
    expect(modelCalls).toBe(2);
    const resumedEventTypes = engine!.runtime.getStore(projectDir).listEvents(workerSessionId, { limit: 100 })
      .map((event) => event.type);
    expect(resumedEventTypes, JSON.stringify(resumedEventTypes)).toContain("tool.finished");
    expect(engine!.runtime.getStore(projectDir).requireSession(workerSessionId).worktreePath).toBe(worktreePath);
    expect(existsSync(path.join(worktreePath, "root-approved.txt"))).toBe(true);
  });
});
