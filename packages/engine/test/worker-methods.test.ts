import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { createEngine, type Engine } from "../src/engine.js";
import { estimateCostUsd, lookupPricing } from "../src/models/pricing.js";

// Fixture literal only — must never appear outside test files (see task
// self-review grep).
const TEST_API_KEY = "sk-test-fixture-never-real-1234567890";

let dir: string;
let engine: Engine;

afterEach(async () => {
  await engine.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(prefix = "of-worker-methods-"): string {
  const base = mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", base]);
  git(base, "config", "user.email", "t@t");
  git(base, "config", "user.name", "t");
  writeFileSync(path.join(base, "README.md"), "hello\n");
  git(base, "add", "-A");
  git(base, "commit", "-qm", "init");
  return base;
}

async function call(e: Engine, method: string, params: unknown): Promise<any> {
  return e.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

// Reuses worker-loop.test.ts's stateful-mock approach: the first
// doGenerate() call emits a write_file tool call, the second replies with a
// final summary — the minimum shape that proves the whole
// resolve->worktree->tools->loop->diff->meter pipeline is really wired, not
// just typechecking.
function makeWorkerMock(): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      call++;
      if (call === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "write_file",
              input: JSON.stringify({ path: "hello.txt", content: "HELLO FROM WORKER" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: {
            inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 50, text: 0, reasoning: undefined },
          },
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: "Created hello.txt" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 200, noCache: 200, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 30, text: 30, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

describe("engine.worker.run", () => {
  it("produces a reviewable diff, summary, usage, and priced cost, and leaves the worktree in place", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock());

    const res = await call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create hello.txt",
      providerId: "p1",
      model: "deepseek-v4-flash",
    });

    expect(res.error).toBeUndefined();
    expect(res.result.diff).toContain("hello.txt");
    expect(res.result.diff).toContain("+HELLO FROM WORKER");
    expect(res.result.diffStat).toContain("hello.txt");
    expect(res.result.summary).toBe("Created hello.txt");
    expect(res.result.toolCallCount).toBe(1);
    expect(res.result.usage).toEqual({ inputTokens: 300, outputTokens: 80, cacheReadTokens: 0 });

    const pricing = lookupPricing("deepseek", "deepseek-v4-flash");
    expect(pricing).not.toBeNull();
    expect(res.result.costUsd).toBeCloseTo(estimateCostUsd(pricing!, res.result.usage), 10);

    expect(typeof res.result.worktree.path).toBe("string");
    expect(res.result.worktree.branch).toMatch(/^worker\//);

    // The worktree is LEFT IN PLACE — not auto-removed after a successful run.
    expect(existsSync(res.result.worktree.path)).toBe(true);
    expect(existsSync(path.join(res.result.worktree.path, "hello.txt"))).toBe(true);
  });

  it("records the worker's usage into engine.models.usage", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock());

    await call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create hello.txt",
      providerId: "p1",
      model: "deepseek-v4-flash",
    });

    const usage = await call(engine, "engine.models.usage", {});
    expect(usage.error).toBeUndefined();
    expect(usage.result.calls).toBe(1);
    expect(usage.result.inputTokens).toBe(300);
    expect(usage.result.outputTokens).toBe(80);
    expect(usage.result.byModel["deepseek/deepseek-v4-flash"]).toBeDefined();
    expect(usage.result.byModel["deepseek/deepseek-v4-flash"].calls).toBe(1);
  });

  it("emits worker.progress notifications for both tool and step events", async () => {
    dir = makeRepo();
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock());

    await call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create hello.txt",
      providerId: "p1",
      model: "deepseek-v4-flash",
    });

    const progress = notifications.filter((n) => n.method === "worker.progress");
    expect(progress.length).toBeGreaterThan(0);
    const kinds = progress.map((n) => (n.params as { kind: string }).kind);
    expect(kinds).toContain("tool");
    expect(kinds).toContain("step");

    const toolEvent = progress.find((n) => (n.params as { kind: string }).kind === "tool")!
      .params as { tool: string; detail: string };
    expect(toolEvent.tool).toBe("write_file");
  });

  it("engine.worker.cleanup removes the worktree from disk", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock());

    const runRes = await call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create hello.txt",
      providerId: "p1",
      model: "deepseek-v4-flash",
    });
    const worktreePath = runRes.result.worktree.path;
    expect(existsSync(worktreePath)).toBe(true);

    const cleanupRes = await call(engine, "engine.worker.cleanup", {
      projectDir: dir,
      worktreePath,
    });
    expect(cleanupRes.error).toBeUndefined();
    expect(cleanupRes.result).toEqual({ removed: true });
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("rejects a non-git projectDir with SERVER_ERROR", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-worker-nongit-"));
    engine = createEngine();

    const res = await call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create hello.txt",
      providerId: "p1",
      model: "deepseek-v4-flash",
    });

    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
  });

  it("rejects an unconfigured provider with SERVER_ERROR and creates no worktree", async () => {
    dir = makeRepo();
    engine = createEngine();

    const res = await call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create hello.txt",
      providerId: "ghost",
      model: "some-model",
    });

    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);

    // No worker/* worktree branch should have been created for the
    // resolve()-time failure — the worktree is created only AFTER the model
    // resolves.
    const worktreeList = git(dir, "worktree", "list", "--porcelain");
    expect(worktreeList).not.toContain("worker/");
  });

  // Final-review Fix 2 (consistency): a RAW (non-RpcMethodError) throw from
  // getManager()/manager.create() — e.g. a git failure creating the
  // worktree itself — used to fall through uncaught to the dispatcher's
  // generic INTERNAL_ERROR (-32603), inconsistent with every other
  // pre-worktree failure in this method (non-git projectDir, unconfigured
  // provider), both of which are SERVER_ERROR (-32000). Before the fix this
  // asserted RpcErrorCodes.INTERNAL_ERROR; confirmed RED against the
  // pre-fix code, now GREEN against the wrapped setup path.
  it("wraps a raw manager.create() failure into SERVER_ERROR with no worktree data", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock());

    // Warm the manager cache, then monkeypatch create() to simulate an
    // infrastructure failure (e.g. disk full, git worktree add failure)
    // that throws a plain Error, not an RpcMethodError.
    const manager = await engine.worker.getManager(dir);
    manager.create = async () => {
      throw new Error("disk exploded");
    };

    const res = await call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create hello.txt",
      providerId: "p1",
      model: "deepseek-v4-flash",
    });

    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    // No worktree was ever created on this path, so there's nothing to
    // attach — unlike the main try/catch's worktree-preserving errors.
    expect(res.error.data).toBeUndefined();
  });

  // Final-review Fix 2 (consistency): engine.worker.cleanup had no git-repo
  // guard at all, so a non-git projectDir reached
  // WorktreeManager.prune()'s `git worktree prune` call, whose raw Error
  // fell through to INTERNAL_ERROR (-32603) — inconsistent with
  // engine.worker.run's SERVER_ERROR (-32000) contract for the same class
  // of input. Before the fix this asserted RpcErrorCodes.INTERNAL_ERROR;
  // confirmed RED against the pre-fix code, now GREEN against the added
  // requireHeadSha guard.
  it("engine.worker.cleanup rejects a non-git projectDir with SERVER_ERROR", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-worker-cleanup-nongit-"));
    engine = createEngine();

    const res = await call(engine, "engine.worker.cleanup", {
      projectDir: dir,
      worktreePath: path.join(dir, "whatever"),
    });

    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
  });

  it("on a mid-loop model failure, returns SERVER_ERROR with the worktree path in data and leaves it in place", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });

    let call_ = 0;
    const throwingModel = new MockLanguageModelV4({
      doGenerate: async () => {
        call_++;
        if (call_ === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "write_file",
                input: JSON.stringify({ path: "partial.txt", content: "partial work" }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 0, reasoning: undefined },
            },
            warnings: [],
          };
        }
        throw new Error("provider exploded mid-loop");
      },
    });
    engine.models.registry.setTestModel("p1", throwingModel);

    const res = await call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create hello.txt",
      providerId: "p1",
      model: "deepseek-v4-flash",
    });

    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error.data?.worktree?.path).toBeDefined();

    const worktreePath = res.error.data.worktree.path as string;
    // NOT auto-removed — the partial edit is still on disk for inspection.
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(path.join(worktreePath, "partial.txt"))).toBe(true);
  });

  it("on a post-loop diff failure, returns SERVER_ERROR with the worktree path in data and leaves it in place", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock());

    const res = await call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create hello.txt",
      providerId: "p1",
      model: "deepseek-v4-flash",
    });

    // First verify the run succeeded to get a valid worktree
    expect(res.result).toBeDefined();
    const worktreePath = res.result.worktree.path as string;
    expect(existsSync(worktreePath)).toBe(true);

    // Now simulate a diff failure on a second run by monkeypatching the manager
    const manager = await engine.worker.getManager(dir);
    let throwOnDiff = false;
    const originalDiff = manager.diff.bind(manager);
    manager.diff = async (worktree) => {
      if (throwOnDiff) {
        throw new Error("diff infrastructure failure");
      }
      return originalDiff(worktree);
    };

    throwOnDiff = true;

    const failRes = await call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create another.txt",
      providerId: "p1",
      model: "deepseek-v4-flash",
    });

    expect(failRes.result).toBeUndefined();
    expect(failRes.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(failRes.error.data?.worktree?.path).toBeDefined();
    expect(failRes.error.data?.worktree?.branch).toBeDefined();

    const failedWorktreePath = failRes.error.data.worktree.path as string;
    // NOT auto-removed — the worktree is still on disk for inspection.
    expect(existsSync(failedWorktreePath)).toBe(true);
  });
});
