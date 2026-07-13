import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
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
  const root = mkdtempSync(path.join(os.tmpdir(), "of-approval-runtime-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@openfusion.local"]);
  execFileSync("git", ["-C", root, "config", "user.name", "OpenFusion Test"]);
  writeFileSync(path.join(root, "base.txt"), "base\n", "utf8");
  execFileSync("git", ["-C", root, "add", "base.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  return root;
}

function sandbox(root: string): MacOsSandboxBackend {
  return new MacOsSandboxBackend({
    platform: "darwin",
    runnerExecutable: createPassthroughSandboxRunner(root),
    probe: async () => ({ ok: true }),
  });
}

async function call(method: string, params: unknown) {
  return engine!.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

describe("durable worker approval", () => {
  it("survives engine restart and executes the approved tool exactly once", async () => {
    projectDir = makeRepo();
    appStorageDir = mkdtempSync(path.join(os.tmpdir(), "of-approval-storage-"));
    const traceKey = Buffer.alloc(32, 42).toString("base64");
    let modelCalls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            content: [{
              type: "tool-call",
              toolCallId: "network-call",
              toolName: "bash",
              input: JSON.stringify({
                command: "printf approved > approved.txt",
                network: true,
              }),
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
          content: [{ type: "text", text: "approved command completed" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 30, noCache: 30, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 8, text: 8, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    const configureEngine = (): Engine => {
      const configured = createEngine({ appStorageDir, sandboxBackend: sandbox(projectDir!) });
      configured.models.registry.configure({
        id: "p1",
        kind: "deepseek",
        apiKey: "test-only-key",
      });
      configured.models.registry.setTestModel("p1", model);
      configured.runtime.configure(projectDir!, { traceKey, traceEnabled: true });
      engine = configured;
      return configured;
    };

    const firstEngine = configureEngine();
    const paused = await call("engine.worker.run", {
      projectDir,
      task: "Run the approved command",
      providerId: "p1",
      model: "deepseek-v4-flash",
      interactive: true,
    });
    expect(paused?.error).toBeUndefined();
    expect(paused?.result).toMatchObject({ paused: true });
    const sessionId = (paused!.result as { sessionId: string }).sessionId;
    const approvalId = (paused!.result as { approvalId: string }).approvalId;
    const worktreePath = (paused!.result as { worktree: { path: string } }).worktree.path;
    expect(existsSync(path.join(worktreePath, "approved.txt"))).toBe(false);
    expect(modelCalls).toBe(1);

    await firstEngine.close();
    engine = undefined;
    const restartedEngine = configureEngine();
    const store = restartedEngine.runtime.getStore(projectDir);
    const waiting = store.requireSession(sessionId);
    expect(waiting.status).toBe("waiting-approval");
    const responded = store.respondApproval(sessionId, waiting.version, approvalId, true);

    const resumed = await call("engine.worker.run", {
      projectDir,
      task: "Run the approved command",
      providerId: "p1",
      model: "deepseek-v4-flash",
      interactive: true,
      resumeSessionId: sessionId,
      approvalResponse: { approvalId, approved: true },
    });
    expect(resumed?.error).toBeUndefined();
    expect(resumed?.result).toMatchObject({ sessionId, summary: "approved command completed" });
    expect(responded.approval.status).toBe("approved");
    expect(existsSync(path.join(worktreePath, "approved.txt"))).toBe(true);
    expect(modelCalls).toBe(2);
    expect(store.requireSession(sessionId).status).toBe("completed");
  });
});
