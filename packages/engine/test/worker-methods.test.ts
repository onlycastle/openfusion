import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

// Simulates a hung model call: the returned promise never settles on its
// own, mirroring a provider that accepted the request but never responds.
// It DOES honor the `abortSignal` generateText attaches to the call so that
// timeoutMs -> AbortSignal.timeout() -> runWorkerLoop's abortSignal plumbing
// (and WorkerService.close()'s own abort) has something real to interrupt --
// MockLanguageModelV4 does not race the signal against its doGenerate
// implementation itself (mirrors worker-loop.test.ts's own makeHangingModel
// and models-complete.test.ts's hungFetch, one layer up the stack).
function makeHangingWorkerMock(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    // `return`ed (not `await`ed then fallen off the end) so the arrow
    // function's inferred return type stays `Promise<never>` -- which IS
    // structurally assignable to the doGenerate contract's
    // `PromiseLike<LanguageModelV4GenerateResult>` (never being the bottom
    // type), whereas `await`-then-implicit-return infers `Promise<void>`,
    // which is not. See worker-loop.test.ts's own makeHangingModel.
    doGenerate: async ({ abortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(abortSignal.reason);
          return;
        }
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
      }),
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
    // M5b Task 1: engine.worker.run records under source "worker", and
    // engine.models.usage carries that breakdown alongside byModel — the
    // same ledger entry, sliced a different way.
    expect(usage.result.bySource["worker"]).toEqual({
      calls: 1,
      inputTokens: 300,
      outputTokens: 80,
      costUsd: usage.result.byModel["deepseek/deepseek-v4-flash"].costUsd,
    });
    // M6 Task 0: deepseek-v4-flash is a verified PRICING entry, so the
    // ledger-wide worst-of confidence is "verified" too.
    expect(usage.result.pricingConfidence).toBe("verified");
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

  // Task 7: names+counts-only tool-call telemetry, logged once the run
  // completes. Runs against a project whose wiki has already been built —
  // this also exercises worker/methods.ts's ctx.wiki wiring (built/guarded
  // the same way engine.wiki.status is), even though this particular
  // model mock never calls wiki_query/wiki_map itself.
  it("logs a worker.run tool-calls line (names+counts only, no arguments) for a project with a built wiki", async () => {
    dir = makeRepo();
    const logs: string[] = [];
    engine = createEngine({ log: (m) => logs.push(m) });
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock());
    await engine.wiki.build(dir);

    const res = await call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create hello.txt",
      providerId: "p1",
      model: "deepseek-v4-flash",
    });
    expect(res.error).toBeUndefined();

    const toolCallLog = logs.find((l) => l.startsWith("worker.run tool-calls"));
    expect(toolCallLog).toBeDefined();
    expect(toolCallLog).toContain("model=deepseek-v4-flash");
    expect(toolCallLog).toContain(JSON.stringify({ write_file: 1 }));
    // Names and counts only — never the tool's own arguments (the path/
    // content the mock's write_file call actually carried).
    expect(toolCallLog).not.toContain("hello.txt");
    expect(toolCallLog).not.toContain("HELLO FROM WORKER");

    // Task 3 (orchestrate run ledger): the same names+counts-only tally is
    // ALSO surfaced on the RPC result itself (not just logged), so
    // orchestrate.ts can aggregate it across worker attempts.
    expect(res.result.toolCallCounts).toEqual({ write_file: 1 });
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

  // M5b Task 0: a hung model call must not hang engine.worker.run forever.
  // timeoutMs -> AbortSignal.timeout() -> runWorkerLoop's abortSignal fires
  // the deadline; the existing failure path (SERVER_ERROR + worktree
  // breadcrumb, no auto-remove) already does the right thing once the
  // signal actually interrupts the loop.
  it("timeoutMs: a hung model call fails fast as SERVER_ERROR containing \"timed out\", leaving the worktree in place", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeHangingWorkerMock());

    const start = Date.now();
    const res = await call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create hello.txt",
      providerId: "p1",
      model: "deepseek-v4-flash",
      // 500ms is comfortably under the schema floor's neighbor (1000ms is
      // the actual floor) -- picked small so this test itself stays fast
      // while still asserting a real deadline fired, not an immediate
      // synchronous rejection.
      timeoutMs: 1000,
    });
    const elapsed = Date.now() - start;

    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error.message).toContain("timed out");
    // Bounds this as "fired the deadline", not "hung until some larger
    // default/afterEach timeout saved us".
    expect(elapsed).toBeLessThan(5000);

    const worktreePath = res.error.data?.worktree?.path as string | undefined;
    expect(typeof worktreePath).toBe("string");
    expect(existsSync(worktreePath!)).toBe(true);
  }, 10_000);

  // M5b Task 0: engine.close() must abort an in-flight worker run rather
  // than hang behind it (or wait out that run's own, possibly much larger,
  // timeoutMs) -- this is what lets escalation/orchestration end a worker
  // run on demand.
  it("engine.close() aborts an in-flight run instead of hanging behind it", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeHangingWorkerMock());

    const runPromise = call(engine, "engine.worker.run", {
      projectDir: dir,
      task: "create hello.txt",
      providerId: "p1",
      model: "deepseek-v4-flash",
      // Deliberately large -- big enough that ONLY engine.close()'s abort
      // (not this run's own timeoutMs) could plausibly end this run within
      // the test's own bounds below.
      timeoutMs: 1_800_000,
    });

    // Let the run actually start (worktree created, controller registered
    // with WorkerService) before racing engine.close() against it. Polled
    // (via the real engine.worker.list RPC, not a fixed sleep) rather than
    // guessing a fixed delay: `manager.create()`'s own `git worktree add`
    // is a real subprocess spawn whose wall-clock time is NOT bounded by a
    // small constant under a loaded machine (M6 Task 4: observed this fixed
    // 50ms wait let engine.close() race ahead of `beginRun()` registering
    // its controller often enough, under a heavily parallel full-suite run,
    // that the hanging mock's promise never got aborted at all -- the test
    // would then hang until ITS OWN timeout, no matter how generous, since
    // the abort event that was supposed to end it never fired). Mirrors
    // orchestrate.test.ts's own "in-flight review + engine.close()" test's
    // identical poll-until-started pattern, for the same reason.
    const startDeadline = Date.now() + 10_000;
    for (;;) {
      const listRes = await call(engine, "engine.worker.list", { projectDir: dir });
      if ((listRes.result?.worktrees?.length ?? 0) > 0) break;
      if (Date.now() > startDeadline) throw new Error("worker run never created its worktree");
      await new Promise((r) => setTimeout(r, 10));
    }

    const closeStart = Date.now();
    await engine.close();
    const closeElapsed = Date.now() - closeStart;
    // Bounds this as "close() aborted the run", not "close() happened to
    // wait for something else".
    expect(closeElapsed).toBeLessThan(2000);

    const res = await runPromise;
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error.message).toContain("aborted");
    // afterEach calls engine.close() again -- must be harmless once the
    // in-flight set this test emptied out is already empty.
  }, 15_000);
});

// M5b Task 5: the worktree lifecycle policy's discovery (list) and sweep
// (gc) surface. Neither method runs a worker loop -- worktrees are created
// directly via WorktreeManager.create through the SAME cached manager
// engine.worker.run itself uses (engine.worker.getManager), which is the
// realistic path (worker.run's own worktree ends up in that same manager's
// list()).
describe("engine.worker.list", () => {
  it("lists worktrees created via the cached WorktreeManager, mapped to {path, branch}", async () => {
    dir = makeRepo();
    engine = createEngine();

    const manager = await engine.worker.getManager(dir);
    const w1 = await manager.create("task-1");
    const w2 = await manager.create("task-2");

    const res = await call(engine, "engine.worker.list", { projectDir: dir });
    expect(res.error).toBeUndefined();
    expect(res.result.worktrees).toEqual(
      expect.arrayContaining([
        { path: w1.path, branch: w1.branch },
        { path: w2.path, branch: w2.branch },
      ]),
    );
    expect(res.result.worktrees).toHaveLength(2);
  });

  it("returns an empty list for a clean project with no worker worktrees", async () => {
    dir = makeRepo();
    engine = createEngine();

    const res = await call(engine, "engine.worker.list", { projectDir: dir });
    expect(res.error).toBeUndefined();
    expect(res.result.worktrees).toEqual([]);
  });

  it("rejects a non-git projectDir with SERVER_ERROR", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-worker-list-nongit-"));
    engine = createEngine();

    const res = await call(engine, "engine.worker.list", { projectDir: dir });
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
  });
});

describe("engine.worker.gc", () => {
  it("removes all worker worktrees and deletes their branches when no keep list is given", async () => {
    dir = makeRepo();
    engine = createEngine();

    const manager = await engine.worker.getManager(dir);
    const w1 = await manager.create("task-1");
    const w2 = await manager.create("task-2");

    const res = await call(engine, "engine.worker.gc", { projectDir: dir });
    expect(res.error).toBeUndefined();
    expect(res.result.removed).toEqual(expect.arrayContaining([w1.path, w2.path]));
    expect(res.result.removed).toHaveLength(2);
    expect(res.result.failed).toEqual([]);

    expect(existsSync(w1.path)).toBe(false);
    expect(existsSync(w2.path)).toBe(false);
    expect(git(dir, "branch", "--list", w1.branch)).toBe("");
    expect(git(dir, "branch", "--list", w2.branch)).toBe("");
  });

  it("keeps exactly the worktree whose path is in `keep`, removing and branch-deleting the rest", async () => {
    dir = makeRepo();
    engine = createEngine();

    const manager = await engine.worker.getManager(dir);
    const w1 = await manager.create("task-1");
    const survivor = await manager.create("task-2");

    const res = await call(engine, "engine.worker.gc", { projectDir: dir, keep: [survivor.path] });
    expect(res.error).toBeUndefined();
    expect(res.result.removed).toEqual([w1.path]);
    expect(res.result.failed).toEqual([]);

    expect(existsSync(w1.path)).toBe(false);
    expect(git(dir, "branch", "--list", w1.branch)).toBe("");

    expect(existsSync(survivor.path)).toBe(true);
    expect(git(dir, "branch", "--list", survivor.branch)).toContain(survivor.branch);
  });

  it("returns an empty removed list for a clean project with no worker worktrees", async () => {
    dir = makeRepo();
    engine = createEngine();

    const res = await call(engine, "engine.worker.gc", { projectDir: dir });
    expect(res.error).toBeUndefined();
    expect(res.result.removed).toEqual([]);
    expect(res.result.failed).toEqual([]);
  });

  // Final review Fix 1 (Important): the per-worktree remove loop had no
  // try/catch — a mid-sweep manager.remove() throw (e.g. an OS-level
  // failure removing one worktree) used to escape as a raw Error, falling
  // through to the dispatcher's generic INTERNAL_ERROR, and losing the
  // partial `removed` list for every worktree ALREADY swept before the
  // failing one. Confirmed RED against pre-fix code (the whole RPC call
  // rejected with INTERNAL_ERROR instead of returning `{removed, failed}`).
  it("isolates a mid-sweep remove failure: the other worktrees are still removed, and the failure is reported in `failed` instead of aborting the whole call", async () => {
    dir = makeRepo();
    engine = createEngine();

    const manager = await engine.worker.getManager(dir);
    const w1 = await manager.create("task-1");
    const w2 = await manager.create("task-2");
    const w3 = await manager.create("task-3");

    const originalRemove = manager.remove.bind(manager);
    manager.remove = async (worktree, opts) => {
      if (worktree.path === w2.path) {
        throw new Error("simulated remove failure for task-2");
      }
      return originalRemove(worktree, opts);
    };

    const res = await call(engine, "engine.worker.gc", { projectDir: dir });
    expect(res.error).toBeUndefined();

    expect(res.result.removed).toEqual(expect.arrayContaining([w1.path, w3.path]));
    expect(res.result.removed).toHaveLength(2);
    expect(res.result.failed).toEqual([{ path: w2.path, error: "simulated remove failure for task-2" }]);

    // The two healthy worktrees were actually removed from disk...
    expect(existsSync(w1.path)).toBe(false);
    expect(existsSync(w3.path)).toBe(false);
    // ...but the one whose remove() failed is still there, untouched.
    expect(existsSync(w2.path)).toBe(true);
    expect(git(dir, "branch", "--list", w2.branch)).toContain(w2.branch);
  });

  it("matches a symlinked-spelling keep path via realpath comparison, not string equality", async () => {
    dir = makeRepo();
    engine = createEngine();

    const manager = await engine.worker.getManager(dir);
    const w1 = await manager.create("task-1");
    const survivor = await manager.create("task-2");

    // A symlink pointing AT the survivor's real worktree directory, under a
    // completely different path -- a plain string/path.resolve comparison
    // against `survivor.path` would never match this.
    const symlinkPath = mkdtempSync(path.join(os.tmpdir(), "of-worker-gc-keep-"));
    rmSync(symlinkPath, { recursive: true, force: true });
    symlinkSync(survivor.path, symlinkPath, "dir");

    try {
      const res = await call(engine, "engine.worker.gc", { projectDir: dir, keep: [symlinkPath] });
      expect(res.error).toBeUndefined();
      expect(res.result.removed).toEqual([w1.path]);
      expect(existsSync(survivor.path)).toBe(true);
      expect(git(dir, "branch", "--list", survivor.branch)).toContain(survivor.branch);
    } finally {
      // unlinkSync, not rmSync: symlinkPath is a symlink POINTING AT a
      // directory, and Node's rmSync (even non-recursive) stats through the
      // symlink and refuses with EISDIR -- unlinkSync removes the symlink
      // entry itself, leaving the real target (survivor.path) untouched.
      unlinkSync(symlinkPath);
    }
  });

  it("rejects a non-git projectDir with SERVER_ERROR", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-worker-gc-nongit-"));
    engine = createEngine();

    const res = await call(engine, "engine.worker.gc", { projectDir: dir });
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
  });
});
