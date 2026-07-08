import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { createEngine, type Engine } from "../src/engine.js";
import type {
  FrontierAdapter,
  FrontierEvent,
  FrontierPromptHandle,
  FrontierSession,
} from "../src/engines/types.js";
import type { AgentDef, HarnessBundle, Routing, WikiPage } from "../src/harness/schema.js";
import { CARD_SLUG } from "../src/harness/schema.js";
import { writeHarness } from "../src/harness/store.js";
import type { CostMeter } from "../src/models/meter.js";
import { orchestrate } from "../src/orchestrate/orchestrate.js";
import { readRuns } from "../src/runs/ledger.js";

// Fixture literal only — must never appear outside test files.
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

function makeRepo(prefix = "of-orchestrate-"): string {
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

// writeHarness never creates the `wiki/` directory at all when `pages` is
// empty (no page files -> nothing to mkdir for), and loadHarness's own
// readRequiredDir then throws on that missing directory — a real
// engine.harness.generate output always has pages, so every fixture below
// includes this one trivial page to stay representative.
const TRIVIAL_PAGE: WikiPage = {
  slug: "architecture",
  title: "Architecture",
  digest: "A trivial fixture wiki page for orchestrate tests.",
  body: "# Architecture\n\nFixture content.\n",
};

// Writes a minimal, structurally-valid harness (one agent, one task class)
// straight to disk via the real store (harness/store.ts) — loadHarness
// (called inside orchestrate.ts) reads it back exactly as it would a real
// engine.harness.generate output. The agent pins an explicit providerId
// ("p1") so routeTask resolution is deterministic regardless of which
// worker model gets configured/mocked per test.
async function writeTestHarness(
  projectDir: string,
  opts: {
    failuresBeforeFrontier?: number;
    pages?: WikiPage[];
    // Task 6: manifest.verification.card — OMITTED (the default) reproduces
    // a legacy manifest (written before the card field existed, or before
    // the card stage ran at all), exactly like every pre-Task-6 caller of
    // this helper already gets. Only set explicitly by the worker-context
    // injection-swap fixtures below, which need to control the approval gate.
    card?: "draft" | "approved";
  } = {},
): Promise<void> {
  const headSha = git(projectDir, "rev-parse", "HEAD");
  const agent: AgentDef = {
    name: "codegen-worker",
    role: "worker",
    description: "Writes code for codegen tasks.",
    prompt: "You are a codegen specialist. Follow instructions exactly.",
    taskClasses: ["codegen"],
    model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "p1" },
    escalation: { maxAttempts: 2 },
  };
  const routing: Routing = {
    version: 1,
    taskClasses: { codegen: { agent: "codegen-worker" } },
    escalation: { failuresBeforeFrontier: opts.failuresBeforeFrontier ?? 2 },
    defaults: { agent: "codegen-worker" },
  };
  const bundle: HarnessBundle = {
    manifest: {
      schemaVersion: 1,
      generatorVersion: "0.0.1",
      engine: "claude-code",
      headSha,
      generatedAt: new Date().toISOString(),
      verification: {
        structural: "pass",
        evals: "pending",
        ...(opts.card !== undefined ? { card: opts.card } : {}),
      },
      artifacts: [],
    },
    pages: opts.pages ?? [TRIVIAL_PAGE],
    agents: [agent],
    routing,
  };
  await writeHarness(projectDir, bundle);
}

// --- Scripted fake worker model (ai/test's MockLanguageModelV4) -----------

interface GenerateStep {
  content: Array<
    | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
    | { type: "text"; text: string }
  >;
  finishReason: { unified: "tool-calls" | "stop"; raw: string };
  usage: {
    inputTokens: { total: number; noCache: number; cacheRead: undefined; cacheWrite: undefined };
    outputTokens: { total: number; text: number; reasoning: undefined };
  };
  warnings: never[];
}

function toolCallStep(filePath: string, content: string): GenerateStep {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: `call-${randomUUID()}`,
        toolName: "write_file",
        input: JSON.stringify({ path: filePath, content }),
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

function textStep(text: string): GenerateStep {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 200, noCache: 200, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 30, text: 30, reasoning: undefined },
    },
    warnings: [],
  };
}

// One tool-call step (writes `filePath`), then a text summary — the
// standard single-attempt "worker did real work" shape, mirroring
// worker-methods.test.ts's own makeWorkerMock.
function makeWorkerMock(filePath: string, content: string, summary: string): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      step++;
      return step === 1 ? toolCallStep(filePath, content) : textStep(summary);
    },
  });
}

// A single provider instance reused across TWO separate engine.worker.run
// calls (the retry-then-approve and escalation tests each make two worker
// attempts): call 1 writes attempt1.txt, call 2 writes attempt2.txt — each
// engine.worker.run invocation runs its own fresh multi-step loop against
// this SAME stateful mock.
function makeMultiAttemptWorkerMock(): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      call++;
      if (call === 1) return toolCallStep("attempt1.txt", "first try");
      if (call === 2) return textStep("Attempt 1 summary");
      if (call === 3) return toolCallStep("attempt2.txt", "second try");
      return textStep("Attempt 2 summary");
    },
  });
}

// Makes NO tool calls at all — engine.worker.run's diff comes back empty.
function makeEmptyWorkerMock(summary: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doGenerate: async () => textStep(summary) });
}

// Attempt 1 completes normally (writes attempt1.txt, then a text summary —
// a full, successful engine.worker.run call); attempt 2's very first model
// call THROWS instead of returning a step, so engine.worker.run itself
// rejects (mirrors worker-methods.test.ts's own "mid-loop model failure"
// mock) — the fixture for Finding 2 (M5b Task 4 review round 1): a worker
// failure on attempt >=2, after an earlier attempt's worktree was already
// cleaned up.
function makeAttempt1ThenThrowWorkerMock(): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      call++;
      if (call === 1) return toolCallStep("attempt1.txt", "first try");
      if (call === 2) return textStep("Attempt 1 summary");
      throw new Error("provider exploded on attempt 2");
    },
  });
}

// M7b Task 2: simulates a hung worker model call — the returned promise
// never settles on its own, but DOES honor the `abortSignal` generateText
// attaches to the call, so the cancel-signal plumbing (timeoutMs ->
// AbortSignal.timeout(), WorkerService.close(), and now engine.cancel's own
// per-run AbortController — all combined via worker/methods.ts's
// AbortSignal.any) has something real to interrupt. Ported verbatim from
// worker-methods.test.ts's own makeHangingWorkerMock (see its doc comment
// for why the arrow function is `return`ed rather than `await`ed-then-
// fallen-off-the-end).
function makeHangingWorkerMock(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
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

// --- Scripted fake frontier adapter ----------------------------------------

function resultEvent(overrides: Partial<Extract<FrontierEvent, { type: "result" }>> = {}): FrontierEvent {
  return {
    type: "result",
    resultText: "",
    costUsd: 0.01,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    numTurns: 1,
    durationMs: 1,
    engineSessionId: null,
    ...overrides,
  };
}

function textEvent(text: string): FrontierEvent {
  return { type: "text", text };
}

interface FakeVerdict {
  decision: "approve" | "request-changes";
  reasons: string[];
  severity: "none" | "minor" | "major";
}

interface FakeFrontierOptions {
  // Consumed in order, one per REVIEW session created (a review session is
  // any createSession call with no non-empty writeScope). Clamped to the
  // last entry if more review sessions are created than scripted.
  reviewVerdicts?: FakeVerdict[];
  reviewCostUsd?: number;
  // false => the escalation session's prompt() does NOT write any file,
  // simulating a frontier escalation that produces an empty diff.
  escalationWritesFile?: boolean;
  escalationCostUsd?: number;
  createSessionCalls?: Array<{ projectDir: string; toolPolicy?: { writeScope?: string[] }; resultLabel?: string }>;
  // Captures the raw prompt text sent to the ESCALATION session only (one
  // entry per escalation prompt() call) — lets a test assert the routed
  // agent's specialist framing (agent.prompt) and the "current working
  // directory" wording actually reach the frontier turn.
  escalationPrompts?: string[];
  reviewSessionStarts?: { count: number };
  closedSessions?: { count: number };
  // M6 Task 1 review round 1 (Fix 1 test): captures the `opts` each REVIEW
  // session's prompt() call received, one entry per call — lets a test
  // assert orchestrate.ts always threads a BOUNDED timeoutMs into the
  // review turn, even when the RPC caller omitted reviewTimeoutMs entirely
  // (the default must reach here, not `undefined`).
  reviewPromptOpts?: Array<{ timeoutMs?: number }>;
  // Same, for the ESCALATION session's prompt() call.
  escalationPromptOpts?: Array<{ timeoutMs?: number }>;
  // M6 Task 1 (eval-batch safety gate): when true, a REVIEW session's
  // prompt() blocks forever (never yields, never completes) until THIS
  // session's own close() is called — standing in for a wedged real review
  // turn. There is no RPC-level "active handle" for a direct session like
  // this (orchestrate.ts drives it in-process, never through
  // engine.frontier.prompt), so close() is the ONLY teardown mechanism that
  // can ever reach it — exactly what FrontierService.track()/close() must
  // now guarantee.
  blockReviewUntilClose?: boolean;
  // Counts close() calls made specifically on a REVIEW session (not
  // escalation) — used to prove engine.close() actually reached the
  // in-flight review session created outside engine.frontier.start.
  reviewCloseSpy?: { count: number };
  // Mirrors engines/methods.ts's REAL onResult wiring (resultLabel
  // "frontier-escalate" -> source "frontier-escalate", else
  // "frontier-review") so tests can assert engine.models.usage's bySource
  // breakdown end-to-end through the fake, the same way the real adapter
  // would tag it (see claude.ts + engines/methods.ts, and their own unit
  // tests in frontier-claude.test.ts).
  meter?: CostMeter;
}

function makeFakeFrontierAdapter(opts: FakeFrontierOptions = {}): FrontierAdapter {
  const verdicts = opts.reviewVerdicts ?? [];
  let reviewIdx = 0;

  function recordResult(resultLabel: string | undefined, event: Extract<FrontierEvent, { type: "result" }>): void {
    opts.meter?.record({
      providerId: "claude-code",
      kind: "frontier-claude",
      model: "fake-frontier-model",
      usage: event.usage,
      costUsd: event.costUsd,
      at: Date.now(),
      source: resultLabel === "frontier-escalate" ? "frontier-escalate" : "frontier-review",
      // Mirrors engines/methods.ts's real onResult wiring: frontier cost is
      // the provider's own reported figure, not a PRICING-table estimate.
      pricingConfidence: event.costUsd !== null ? "verified" : "unpriced",
    });
  }

  return {
    kind: "claude-code",
    async createSession({ projectDir, toolPolicy, resultLabel }): Promise<FrontierSession> {
      opts.createSessionCalls?.push({ projectDir, toolPolicy, resultLabel });
      const writeScope = toolPolicy?.writeScope ?? [];
      const isEscalation = writeScope.length > 0;
      if (!isEscalation && opts.reviewSessionStarts !== undefined) {
        opts.reviewSessionStarts.count += 1;
      }
      // M6 Task 1: resolved by THIS session's own close() below — the only
      // teardown mechanism reachable for a review session opened outside
      // engine.frontier.start (see blockReviewUntilClose's own doc comment
      // on FakeFrontierOptions).
      let resolveClosed: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });

      return {
        id: randomUUID(),
        projectDir,
        prompt(text: string, promptOpts?: { timeoutMs?: number }): FrontierPromptHandle {
          if (!isEscalation && opts.blockReviewUntilClose === true) {
            async function* gen(): AsyncGenerator<FrontierEvent> {
              await closed;
              // Ends without ever yielding a result event — mirrors a
              // wedged review turn that never got to finish; the session
              // was force-closed instead.
            }
            return { events: gen(), abort: () => {} };
          }
          if (isEscalation) {
            opts.escalationPrompts?.push(text);
            opts.escalationPromptOpts?.push(promptOpts ?? {});
            async function* gen(): AsyncGenerator<FrontierEvent> {
              if (opts.escalationWritesFile !== false) {
                // Writes RELATIVE TO the `projectDir` this session was
                // actually created with — NOT writeScope[0] — because the
                // whole point of this fake is to stand in for a REAL
                // frontier, which edits files at paths resolved against its
                // subprocess cwd (see claude.ts: `cwd: projectDir` in the
                // query() options), not against writeScope. A real
                // escalation only ever lands inside writeScope[0] when cwd
                // (this `projectDir`) IS writeScope[0] — i.e. the worktree.
                // Before the fix, orchestrate.ts's runEscalation created
                // this session with the BASE repo as `projectDir`, so this
                // write would land in the base repo and `manager.diff`
                // (which reads the worktree) would see nothing.
                writeFileSync(path.join(projectDir, "escalated.txt"), "written by frontier escalation\n");
                yield { type: "tool_use", name: "Write", summary: "wrote escalated.txt" };
              }
              yield { type: "text", text: "Escalation complete" };
              const event = resultEvent({ costUsd: opts.escalationCostUsd ?? 0.2 }) as Extract<
                FrontierEvent,
                { type: "result" }
              >;
              recordResult(resultLabel, event);
              yield event;
            }
            return { events: gen(), abort: () => {} };
          }

          opts.reviewPromptOpts?.push(promptOpts ?? {});
          const verdict = verdicts[Math.min(reviewIdx, verdicts.length - 1)] ?? {
            decision: "approve",
            reasons: [],
            severity: "none",
          };
          reviewIdx += 1;
          async function* gen(): AsyncGenerator<FrontierEvent> {
            yield textEvent("```json\n" + JSON.stringify(verdict) + "\n```");
            const event = resultEvent({ costUsd: opts.reviewCostUsd ?? 0.02 }) as Extract<
              FrontierEvent,
              { type: "result" }
            >;
            recordResult(resultLabel, event);
            yield event;
          }
          return { events: gen(), abort: () => {} };
        },
        async close(): Promise<void> {
          if (opts.closedSessions !== undefined) opts.closedSessions.count += 1;
          if (!isEscalation && opts.reviewCloseSpy !== undefined) opts.reviewCloseSpy.count += 1;
          resolveClosed();
        },
      };
    },
  };
}

// --- Tests -------------------------------------------------------------

describe("engine.orchestrate — happy path", () => {
  it("worker writes a file, frontier approves -> worker-approved; apply lands the file in the base repo", async () => {
    dir = makeRepo();
    await writeTestHarness(dir);
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("hello.txt", "HELLO FROM WORKER", "Created hello.txt"));
    const createSessionCalls: Array<{ projectDir: string; toolPolicy?: { writeScope?: string[] }; resultLabel?: string }> =
      [];
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({
        reviewVerdicts: [{ decision: "approve", reasons: [], severity: "none" }],
        createSessionCalls,
        meter: engine.models.meter,
      }),
    );

    const res = await call(engine, "engine.orchestrate", {
      projectDir: dir,
      task: "add hello.txt with a greeting",
    });
    expect(res.error).toBeUndefined();
    const result = res.result;

    expect(result.outcome).toBe("worker-approved");
    expect(result.agent).toBe("codegen-worker");
    expect(result.resolution).toEqual({ providerId: "p1", model: "deepseek-v4-flash" });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ n: 1, kind: "worker", summary: "Created hello.txt" });
    expect(result.attempts[0].verdict.decision).toBe("approve");
    expect(result.attempts[0].empty).toBeUndefined();
    expect(result.diff).toContain("hello.txt");
    expect(result.diff).toContain("+HELLO FROM WORKER");
    expect(result.diffStat).toContain("hello.txt");
    expect(result.worktree).not.toBeNull();
    expect(existsSync(result.worktree.path)).toBe(true);

    expect(result.cost.workerUsd).toBeGreaterThan(0);
    expect(result.cost.frontierUsd).toBeGreaterThan(0);
    expect(result.cost.totalUsd).toBeCloseTo(result.cost.workerUsd + result.cost.frontierUsd, 10);
    expect(result.cost.note).toBe("estimate-class");

    // Review session must have been started READ-ONLY (no writeScope at all).
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0]!.toolPolicy).toBeUndefined();

    // Meter tagging: worker under "worker", review under "frontier-review".
    const usage = await call(engine, "engine.models.usage", {});
    expect(usage.result.bySource["worker"].calls).toBe(1);
    expect(usage.result.bySource["frontier-review"].calls).toBe(1);
    expect(usage.result.bySource["frontier-escalate"]).toBeUndefined();

    const applyRes = await call(engine, "engine.orchestrate.apply", { projectDir: dir, diff: result.diff });
    expect(applyRes.error).toBeUndefined();
    expect(applyRes.result).toEqual({ applied: true });
    expect(existsSync(path.join(dir, "hello.txt"))).toBe(true);
    expect(readFileSync(path.join(dir, "hello.txt"), "utf8")).toContain("HELLO FROM WORKER");
  });
});

describe("engine.orchestrate — retry then approve", () => {
  it("attempt 1 rejected (worktree cleaned), attempt 2 approved (worktree survives)", async () => {
    dir = makeRepo();
    await writeTestHarness(dir, { failuresBeforeFrontier: 2 });
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeMultiAttemptWorkerMock());
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({
        reviewVerdicts: [
          { decision: "request-changes", reasons: ["needs a null check"], severity: "minor" },
          { decision: "approve", reasons: [], severity: "none" },
        ],
      }),
    );

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "improve the widget" });
    expect(res.error).toBeUndefined();
    const result = res.result;

    expect(result.outcome).toBe("worker-approved");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ n: 1, kind: "worker" });
    expect(result.attempts[0].verdict.decision).toBe("request-changes");
    expect(result.attempts[1]).toMatchObject({ n: 2, kind: "worker" });
    expect(result.attempts[1].verdict.decision).toBe("approve");
    expect(result.diff).toContain("attempt2.txt");
    expect(result.diff).not.toContain("attempt1.txt");

    // Only the surviving (attempt-2) worktree remains on disk.
    const manager = await engine.worker.getManager(dir);
    const worktrees = await manager.list();
    expect(worktrees).toHaveLength(1);
    expect(path.resolve(worktrees[0]!.path)).toBe(path.resolve(result.worktree.path));
  });
});

// Final review Fix 3 (Important): retries used to be blind re-rolls —
// attempt n+1 got the IDENTICAL worker task prompt as attempt n, ignoring
// the prior verdict's `reasons` (or the fact of a prior empty diff)
// entirely. That weakens convergence and inflates the escalation rate (an
// M6 metric). The fix threads the prior attempt's outcome into
// buildWorkerTask so attempt n+1's task text names what went wrong.
//
// Captures the `task` param of every engine.worker.run dispatch by
// monkeypatching engine.dispatcher.dispatch — the same monkeypatch style
// already used elsewhere in this suite for manager.create/diff — since
// orchestrate.ts drives engine.worker.run through the dispatcher
// (callEngineMethod), not a direct function call.
function captureWorkerTasks(e: Engine): string[] {
  const tasks: string[] = [];
  const originalDispatch = e.dispatcher.dispatch.bind(e.dispatcher);
  e.dispatcher.dispatch = (async (message: unknown) => {
    const req = message as { method?: string; params?: { task?: string } };
    if (req.method === "engine.worker.run" && typeof req.params?.task === "string") {
      tasks.push(req.params.task);
    }
    return originalDispatch(message);
  }) as typeof e.dispatcher.dispatch;
  return tasks;
}

// M6 Task 2: same monkeypatch style as captureWorkerTasks above, but
// captures the FULL engine.worker.run params (task AND wikiDigest) for each
// dispatch — lets a test assert the harness's wiki page digests reach
// engine.worker.run via its own `wikiDigest` param, distinctly from the
// `task` string (which orchestrate.ts's buildWorkerTask still composes from
// only agent.prompt + task + retry feedback — the digest travels alongside
// it, not folded into it; see orchestrate.ts's own doc comment on why).
function captureWorkerRunCalls(e: Engine): Array<{ task: string; wikiDigest?: string }> {
  const calls: Array<{ task: string; wikiDigest?: string }> = [];
  const originalDispatch = e.dispatcher.dispatch.bind(e.dispatcher);
  e.dispatcher.dispatch = (async (message: unknown) => {
    const req = message as { method?: string; params?: { task?: string; wikiDigest?: string } };
    if (req.method === "engine.worker.run" && typeof req.params?.task === "string") {
      calls.push({ task: req.params.task, wikiDigest: req.params.wikiDigest });
    }
    return originalDispatch(message);
  }) as typeof e.dispatcher.dispatch;
  return calls;
}

describe("engine.orchestrate — retry feedback", () => {
  it("attempt 1's task is unchanged; attempt 2's task appends the prior verdict's rejection reasons", async () => {
    dir = makeRepo();
    await writeTestHarness(dir, { failuresBeforeFrontier: 2 });
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeMultiAttemptWorkerMock());
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({
        reviewVerdicts: [
          { decision: "request-changes", reasons: ["needs a null check", "missing test coverage"], severity: "minor" },
          { decision: "approve", reasons: [], severity: "none" },
        ],
      }),
    );
    const capturedTasks = captureWorkerTasks(engine);

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "improve the widget" });
    expect(res.error).toBeUndefined();

    expect(capturedTasks).toHaveLength(2);
    // Attempt 1 gets exactly the base framing — no feedback yet exists.
    expect(capturedTasks[0]).toBe("You are a codegen specialist. Follow instructions exactly.\n\nimprove the widget");
    // Attempt 2 appends the prior verdict's own reasons, verbatim.
    expect(capturedTasks[1]).toContain(capturedTasks[0]);
    expect(capturedTasks[1]).toContain("needs a null check");
    expect(capturedTasks[1]).toContain("missing test coverage");
    expect(capturedTasks[1]!.toLowerCase()).toContain("previous attempt was reviewed and rejected");
  });

  it("attempt 2's task notes a prior empty diff when attempt 1 made no changes", async () => {
    dir = makeRepo();
    await writeTestHarness(dir, { failuresBeforeFrontier: 2 });
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    // Attempt 1: no tool calls at all (empty diff). Attempt 2: writes a file
    // and is approved.
    let step = 0;
    engine.models.registry.setTestModel(
      "p1",
      new MockLanguageModelV4({
        doGenerate: async () => {
          step++;
          if (step === 1) return textStep("nothing to change");
          if (step === 2) return toolCallStep("attempt2.txt", "second try");
          return textStep("Attempt 2 summary");
        },
      }),
    );
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({ reviewVerdicts: [{ decision: "approve", reasons: [], severity: "none" }] }),
    );
    const capturedTasks = captureWorkerTasks(engine);

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "improve the widget" });
    expect(res.error).toBeUndefined();
    expect(res.result.outcome).toBe("worker-approved");

    expect(capturedTasks).toHaveLength(2);
    expect(capturedTasks[1]!.toLowerCase()).toContain("previous attempt produced no changes");
  });
});

describe("engine.orchestrate — escalation", () => {
  it("both worker attempts rejected -> frontier escalation (with writeScope) edits a file -> escalated", async () => {
    dir = makeRepo();
    await writeTestHarness(dir, { failuresBeforeFrontier: 2 });
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeMultiAttemptWorkerMock());
    const createSessionCalls: Array<{ projectDir: string; toolPolicy?: { writeScope?: string[] }; resultLabel?: string }> =
      [];
    const escalationPrompts: string[] = [];
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({
        reviewVerdicts: [
          { decision: "request-changes", reasons: ["nope"], severity: "minor" },
          { decision: "request-changes", reasons: ["still nope"], severity: "major" },
        ],
        createSessionCalls,
        escalationPrompts,
        meter: engine.models.meter,
      }),
    );

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "improve the widget" });
    expect(res.error).toBeUndefined();
    const result = res.result;

    expect(result.outcome).toBe("escalated");
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[0].kind).toBe("worker");
    expect(result.attempts[1].kind).toBe("worker");
    expect(result.attempts[2].kind).toBe("frontier");
    expect(result.attempts[2].empty).toBeUndefined();
    expect(result.diff).toContain("escalated.txt");
    expect(result.worktree).not.toBeNull();

    // The escalation session must have been started WITH a non-empty
    // writeScope — the M4 write-policy path exercised for the first time.
    const escalationCall = createSessionCalls.find((c) => (c.toolPolicy?.writeScope?.length ?? 0) > 0);
    expect(escalationCall).toBeDefined();
    expect(escalationCall!.toolPolicy!.writeScope).toEqual([result.worktree.path]);
    expect(escalationCall!.resultLabel).toBe("frontier-escalate");

    // CRITICAL (Finding 1, M5b Task 4 review round 1): the escalation
    // session's cwd (its `projectDir`, per claude.ts's `cwd: projectDir`)
    // must be the WORKTREE, not the base repo — otherwise a real frontier's
    // edits (at base-repo-relative paths) all resolve outside writeScope and
    // get denied, and manager.diff (which reads the worktree) sees nothing.
    expect(escalationCall!.projectDir).toBe(result.worktree.path);

    // Minor (M5b Task 4 review round 1): the escalation turn is framed with
    // the routed agent's own specialist prompt, and "current working
    // directory" is now literally correct since cwd IS the worktree.
    expect(escalationPrompts).toHaveLength(1);
    expect(escalationPrompts[0]).toContain("You are a codegen specialist. Follow instructions exactly.");
    expect(escalationPrompts[0]).toContain("current working directory");

    // Only 2 review sessions (no writeScope) + 1 escalation session (with
    // writeScope) were ever created.
    const reviewCalls = createSessionCalls.filter((c) => (c.toolPolicy?.writeScope?.length ?? 0) === 0);
    expect(reviewCalls).toHaveLength(2);

    expect(result.cost.frontierUsd).toBeGreaterThan(0);

    // Meter tagging: escalate's result is tagged "frontier-escalate",
    // distinct from the two reviews' "frontier-review".
    const usage = await call(engine, "engine.models.usage", {});
    expect(usage.result.bySource["frontier-review"].calls).toBe(2);
    expect(usage.result.bySource["frontier-escalate"].calls).toBe(1);

    // Both REJECTED worker worktrees were cleaned — only the escalation's
    // own worktree (created via the SAME WorktreeManager, so it carries the
    // same `worker/<id>` branch naming — WorktreeManager.list() has no
    // separate "escalation" category) remains on disk.
    const manager = await engine.worker.getManager(dir);
    const worktrees = await manager.list();
    expect(worktrees).toHaveLength(1);
    expect(path.resolve(worktrees[0]!.path)).toBe(path.resolve(result.worktree.path));
    expect(existsSync(result.worktree.path)).toBe(true);
  });

  it("routing straight to 'frontier' skips workers entirely and escalates on attempt 1", async () => {
    dir = makeRepo();
    const headSha = git(dir, "rev-parse", "HEAD");
    const agent: AgentDef = {
      name: "frontier-agent",
      role: "worker",
      description: "Frontier-only agent.",
      prompt: "You handle everything directly.",
      taskClasses: ["codegen"],
      model: "frontier",
      escalation: { maxAttempts: 2 },
    };
    const routing: Routing = {
      version: 1,
      taskClasses: { codegen: { agent: "frontier-agent" } },
      escalation: { failuresBeforeFrontier: 2 },
      defaults: { agent: "frontier-agent" },
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
      pages: [TRIVIAL_PAGE],
      agents: [agent],
      routing,
    };
    await writeHarness(dir, bundle);

    engine = createEngine();
    engine.frontier.registerAdapter(makeFakeFrontierAdapter({}));

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "do everything" });
    expect(res.error).toBeUndefined();
    const result = res.result;

    expect(result.outcome).toBe("escalated");
    expect(result.resolution).toBe("frontier");
    expect(result.attempts).toEqual([{ n: 1, kind: "frontier", summary: "Escalation complete" }]);
  });

  it("an empty escalation diff (frontier makes no edits) results in outcome 'failed'", async () => {
    dir = makeRepo();
    await writeTestHarness(dir, { failuresBeforeFrontier: 1 });
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeEmptyWorkerMock("nothing to change"));
    engine.frontier.registerAdapter(makeFakeFrontierAdapter({ escalationWritesFile: false }));

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "improve the widget" });
    expect(res.error).toBeUndefined();
    const result = res.result;

    expect(result.outcome).toBe("failed");
    expect(result.worktree).toBeNull();
    expect(result.diff).toBe("");

    // Nothing left on disk — the empty worker attempt AND the empty
    // escalation attempt were both cleaned up.
    const manager = await engine.worker.getManager(dir);
    expect(await manager.list()).toHaveLength(0);
  });
});

describe("engine.orchestrate — empty worker diff", () => {
  it("counts as a failed attempt with no review call", async () => {
    dir = makeRepo();
    await writeTestHarness(dir, { failuresBeforeFrontier: 2 });
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeEmptyWorkerMock("nothing to change"));
    const reviewSessionStarts = { count: 0 };
    engine.frontier.registerAdapter(makeFakeFrontierAdapter({ reviewSessionStarts }));

    const res = await call(engine, "engine.orchestrate", {
      projectDir: dir,
      task: "improve the widget",
      maxWorkerAttempts: 1,
    });
    expect(res.error).toBeUndefined();
    const result = res.result;

    expect(result.attempts[0]).toMatchObject({ n: 1, kind: "worker", empty: true });
    expect(result.attempts[0].verdict).toBeUndefined();
    expect(reviewSessionStarts.count).toBe(0);

    // maxWorkerAttempts:1 -> the empty attempt's worktree was cleaned, then
    // escalation ran next and its own (surviving) worktree remains.
    const manager = await engine.worker.getManager(dir);
    expect(await manager.list()).toHaveLength(1);
  });
});

// Task 6 (the ETH-anti-pattern injection swap): M6 Task 2 (see git history)
// wired EVERY wiki page's digest into EVERY worker prompt, bounded only by a
// combined character cap — exactly the configuration the ETH Zurich +
// DeepMind AGENTS.md study (arXiv:2602.11988) measured as harmful (restated,
// inferable context costs success AND inference budget). Task 6 replaces
// that with a categorical swap (spec
// docs/superpowers/specs/2026-07-08-wiki-project-card-design.md §4,
// orchestrate.ts's own buildWorkerContext doc comment): an APPROVED project
// card only, falling back to the build-and-test page's digest alone when
// there's no approved card, and nothing at all otherwise. These tests pin
// each of the three branches end to end — the worker actually receives (or
// doesn't) the right content via engine.worker.run's `wikiDigest` param —
// and that the branch NAME (never the digest text) reaches an
// orchestrate.progress notification.
describe("engine.orchestrate — worker context injection swap (Task 6, ETH anti-pattern fix)", () => {
  const CARD_DIGEST = "CARD-DIGEST-MARKER: the exact test command is `pnpm test`.";
  const ARCH_DIGEST = "ARCH-MARKER: this project uses a layered architecture.";
  const BT_DIGEST = "BT-MARKER: run `pnpm build && pnpm test` from the repo root.";

  const CARD_PAGE: WikiPage = { slug: CARD_SLUG, title: "Project Card", digest: CARD_DIGEST, body: "# Project Card\n" };
  const ARCH_PAGE: WikiPage = { slug: "architecture", title: "Architecture", digest: ARCH_DIGEST, body: "# Architecture\n" };
  const BUILD_AND_TEST_PAGE: WikiPage = {
    slug: "build-and-test",
    title: "Build and test",
    digest: BT_DIGEST,
    body: "# Build and test\n",
  };

  // Runs one orchestrate call against `pages`/`card`, capturing both the
  // engine.worker.run params (task/wikiDigest) and every orchestrate.progress
  // notification's `detail` string — the two things Task 6's contract cares
  // about (what reached the worker; what got notified).
  async function runAndCapture(
    pages: WikiPage[],
    card: "draft" | "approved" | undefined,
  ): Promise<{
    run: { task: string; wikiDigest?: string };
    progressDetails: string[];
    // Task 3: OrchestrateResult.contextBranch off the SAME call — asserted
    // alongside the pre-existing progress-notification/wikiDigest checks
    // below so each of the three branches is pinned on the RETURNED result
    // too, not just the notification/worker-param side effects.
    contextBranch: string;
  }> {
    dir = makeRepo();
    await writeTestHarness(dir, { pages, card });
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("hello.txt", "hi", "done"));
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({ reviewVerdicts: [{ decision: "approve", reasons: [], severity: "none" }] }),
    );
    const capturedRuns = captureWorkerRunCalls(engine);

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "add hello.txt" });
    expect(res.error).toBeUndefined();
    expect(capturedRuns).toHaveLength(1);

    const progressDetails = notifications
      .filter((n) => n.method === "orchestrate.progress")
      .map((n) => (n.params as { detail: string }).detail);

    return { run: capturedRuns[0]!, progressDetails, contextBranch: res.result.contextBranch };
  }

  it("approved card present -> only the card digest reaches the worker; branch 'approved-card'", async () => {
    const { run, progressDetails, contextBranch } = await runAndCapture([CARD_PAGE, ARCH_PAGE], "approved");

    expect(run.wikiDigest).toContain(CARD_DIGEST);
    expect(run.wikiDigest).toContain("## Project card");
    expect(run.wikiDigest).not.toContain(ARCH_DIGEST);
    // The digest travels via its own param, not folded into the task text.
    expect(run.task).not.toContain(CARD_DIGEST);

    expect(progressDetails).toContain("worker context: approved-card");
    expect(contextBranch).toBe("approved-card");
  });

  it("draft card + a build-and-test page -> the build-and-test digest reaches the worker, not the card; branch 'build-and-test-fallback'", async () => {
    const { run, progressDetails, contextBranch } = await runAndCapture([CARD_PAGE, BUILD_AND_TEST_PAGE], "draft");

    expect(run.wikiDigest).toContain(BT_DIGEST);
    expect(run.wikiDigest).toContain("## Project knowledge (from the harness wiki)");
    expect(run.wikiDigest).not.toContain(CARD_DIGEST);
    expect(run.task).not.toContain(BT_DIGEST);

    expect(progressDetails).toContain("worker context: build-and-test-fallback");
    expect(contextBranch).toBe("build-and-test-fallback");
  });

  it("no card, no build-and-test page (legacy harness) -> no worker context at all; branch 'none'", async () => {
    const { run, progressDetails, contextBranch } = await runAndCapture([ARCH_PAGE], undefined);

    expect(run.wikiDigest).toBeUndefined();
    expect(run.task).not.toContain("## Project");

    expect(progressDetails).toContain("worker context: none");
    expect(contextBranch).toBe("none");
  });

  // Final review Fix 6 (seam test): every test above writes the manifest's
  // card state directly via writeTestHarness/writeHarness — none of them
  // actually exercise the RPC a real desktop user clicks ("Approve") to get
  // from a draft to an approved card. This test pins the FULL seam: a draft
  // card on disk -> engine.harness.card.approve (the real dispatcher, the
  // real store.ts's setCardState) -> a fresh engine.orchestrate run reads
  // that manifest back off disk (loadHarness) and buildWorkerContext picks
  // the "approved-card" branch -> the worker actually receives the card
  // digest. Nothing here bypasses the RPC layer the way writeTestHarness's
  // `card: "approved"` option does for the other tests in this describe.
  it("engine.harness.card.approve, then engine.orchestrate: the worker receives the card digest via the real approve RPC + manifest round-trip", async () => {
    dir = makeRepo();
    await writeTestHarness(dir, { pages: [CARD_PAGE, ARCH_PAGE], card: "draft" });
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("hello.txt", "hi", "done"));
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({ reviewVerdicts: [{ decision: "approve", reasons: [], severity: "none" }] }),
    );
    const capturedRuns = captureWorkerRunCalls(engine);

    // The card starts unapproved — approve it through the real RPC before
    // orchestrate ever runs, exactly as the desktop review panel would.
    const approveRes = await call(engine, "engine.harness.card.approve", { projectDir: dir });
    expect(approveRes.error).toBeUndefined();
    expect(approveRes.result).toEqual({ approved: true });

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "add hello.txt" });
    expect(res.error).toBeUndefined();
    expect(capturedRuns).toHaveLength(1);

    expect(capturedRuns[0]!.wikiDigest).toContain(CARD_DIGEST);
    expect(capturedRuns[0]!.wikiDigest).toContain("## Project card");
    expect(capturedRuns[0]!.wikiDigest).not.toContain(ARCH_DIGEST);
    expect(res.result.contextBranch).toBe("approved-card");
  });
});

// Task 3: engine.orchestrate's own run-ledger write point (runs/ledger.ts's
// recordRun, AWAITED by the handler — see the settled-before-response pins
// below). Dispatches THROUGH the real RPC dispatcher (not a direct
// orchestrate() call) since the write point lives in
// orchestrate/methods.ts's handler, not in orchestrate.ts's own pipeline —
// evals/run.ts's nested orchestrate() calls bypass this handler entirely
// and are therefore never recorded (see that write point's own doc
// comment).
describe("engine.orchestrate — run ledger write point (Task 3)", () => {
  const CARD_DIGEST_MARKER = "LEDGER-CARD-DIGEST-MARKER";
  const LEDGER_CARD_PAGE: WikiPage = {
    slug: CARD_SLUG,
    title: "Project Card",
    digest: CARD_DIGEST_MARKER,
    body: "# Project Card\n",
  };

  it("records exactly one orchestrate record with contextBranch/reviews/workerModel/durationMs; never carries the task text or an attempt summary (content pin)", async () => {
    dir = makeRepo();
    await writeTestHarness(dir, { failuresBeforeFrontier: 2, pages: [LEDGER_CARD_PAGE], card: "approved" });
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });

    // A distinctive task string and two distinctive per-attempt summary
    // strings — the content pin below asserts NONE of these ever reach the
    // serialized ledger record.
    const TASK_TEXT = "UNIQUE-TASK-MARKER-XYZ";
    const SUMMARY_MARKER_1 = "ATTEMPT-1-SUMMARY-MARKER-XYZ";
    const SUMMARY_MARKER_2 = "ATTEMPT-2-SUMMARY-MARKER-XYZ";
    let step = 0;
    engine.models.registry.setTestModel(
      "p1",
      new MockLanguageModelV4({
        doGenerate: async () => {
          step++;
          if (step === 1) return toolCallStep("attempt1.txt", "first try");
          if (step === 2) return textStep(SUMMARY_MARKER_1);
          if (step === 3) return toolCallStep("attempt2.txt", "second try");
          return textStep(SUMMARY_MARKER_2);
        },
      }),
    );
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({
        reviewVerdicts: [
          { decision: "request-changes", reasons: ["needs a null check"], severity: "minor" },
          { decision: "approve", reasons: [], severity: "none" },
        ],
      }),
    );

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: TASK_TEXT });
    expect(res.error).toBeUndefined();
    expect(res.result.outcome).toBe("worker-approved");
    expect(res.result.contextBranch).toBe("approved-card");
    expect(res.result.toolCallCounts).toEqual({ write_file: 2 });

    // Read IMMEDIATELY — no polling. The write point AWAITS recordRun
    // (orchestrate/methods.ts), so the append has settled before the RPC
    // response resolves; this line deliberately pins that
    // settled-before-response contract. It matters beyond read-after-write
    // UX: an unawaited (fire-and-forget) append here once kept running on
    // the libuv threadpool PAST the response, racing this suite's own
    // afterEach rmSync teardown — re-creating .openfusion/cache mid-walk
    // and flaking unrelated tests in this file with ENOTEMPTY.
    const { records } = readRuns(dir);
    expect(records).toHaveLength(1);

    const record = records[0]!;
    if (record.kind !== "orchestrate") throw new Error(`expected an "orchestrate" record, got "${record.kind}"`);
    expect(record.outcome).toBe("worker-approved");
    expect(record.contextBranch).toBe("approved-card");
    expect(record.workerModel).toBe("deepseek-v4-flash");
    expect(record.taskClass).toBe("codegen");
    expect(record.agent).toBe("codegen-worker");
    expect(record.attempts).toBe(2);
    expect(record.escalated).toBe(false);
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.reviews).toEqual([
      { decision: "request-changes", reasons: ["needs a null check"] },
      { decision: "approve", reasons: [] },
    ]);
    expect(record.toolCallCounts).toEqual({ write_file: 2 });

    // The content pin: the record's own content-line rule (runs/ledger.ts's
    // header comment) — task text, attempt summaries, and the card digest
    // itself must never appear in the serialized record.
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(TASK_TEXT);
    expect(serialized).not.toContain(SUMMARY_MARKER_1);
    expect(serialized).not.toContain(SUMMARY_MARKER_2);
    expect(serialized).not.toContain(CARD_DIGEST_MARKER);
  });

  it("error path: dispatching against a projectDir with no harness records one 'error' outcome with errorCategory 'no-harness'", async () => {
    dir = makeRepo();
    engine = createEngine();

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "do something" });
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error.message).toContain("no harness");

    // Immediate read — same settled-before-response pin as the success-path
    // test above: the error record too must be durable by the time the RPC
    // rejection reaches the caller.
    const { records } = readRuns(dir);
    expect(records).toHaveLength(1);

    const record = records[0]!;
    if (record.kind !== "orchestrate") throw new Error(`expected an "orchestrate" record, got "${record.kind}"`);
    expect(record.outcome).toBe("error");
    expect(record.errorCategory).toBe("no-harness");
    expect(record.taskClass).toBe("unknown");
    expect(record.agent).toBe("unknown");
    expect(record.workerModel).toBe("unknown");
    expect(record.attempts).toBe(0);
    expect(record.escalated).toBe(false);
    expect(record.reviews).toEqual([]);
    expect(record.contextBranch).toBe("none");
  });

  // Final-review Fix 3: the ledger append itself can fail (disk full,
  // permission error, ENOTDIR — anything appendRun's mkdir/appendFile or its
  // Fix-1 ensureGitignoreGuard call can throw) on an orchestrate run that
  // otherwise SUCCEEDED. `recordRun`'s never-rejects contract must hold even
  // then: the RPC still resolves with its normal result, and the failure is
  // only ever visible as a single kind-only engine.log line.
  it("a ledger append failure during a SUCCESSFUL orchestrate still resolves the RPC, and logs the append-failed line", async () => {
    dir = makeRepo();
    await writeTestHarness(dir);
    const logs: string[] = [];
    engine = createEngine({ log: (m) => logs.push(m) });
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("hello.txt", "hi", "done"));
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({ reviewVerdicts: [{ decision: "approve", reasons: [], severity: "none" }] }),
    );

    // Force appendRun's own mkdir to fail WITHOUT taking the harness fixture
    // down with it: writeTestHarness's manifest.json/wiki/agents/routing.yaml
    // all live directly under `.openfusion/`, so making `.openfusion` itself
    // a non-directory (the mechanism runs-ledger.test.ts's unit-level fs
    // failure test uses) would make loadHarness fail too, which is a
    // different, uninteresting failure mode. Instead, make `.openfusion/cache`
    // — a sibling appendRun creates on demand, never touched by writeHarness
    // — a FILE. Fix 1's ensureGitignoreGuard call (targeting `.openfusion`
    // itself, still a real directory here, already carrying the
    // `.gitignore` writeTestHarness wrote) runs first and succeeds; only the
    // `mkdir(dirname(runs.jsonl))` call just past it hits the FILE and fails.
    writeFileSync(path.join(dir, ".openfusion", "cache"), "not a directory");

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "add hello.txt" });
    expect(res.error).toBeUndefined();
    expect(res.result.outcome).toBe("worker-approved");

    expect(logs).toContain("run-ledger: append failed (orchestrate)");
  });

  it("evals-internal orchestrate() calls (bypassing the RPC dispatcher) are never written to the ledger", async () => {
    // Regression guard for the "evals excluded" contract: calling the plain
    // orchestrate() pipeline function directly — exactly what
    // evals/run.ts's runHarnessTask does — must leave the ledger untouched,
    // since the write point lives in orchestrate/methods.ts's RPC handler,
    // not in orchestrate() itself.
    dir = makeRepo();
    await writeTestHarness(dir);
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("hello.txt", "hi", "done"));
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({ reviewVerdicts: [{ decision: "approve", reasons: [], severity: "none" }] }),
    );

    const result = await orchestrate(engine, { projectDir: dir, task: "add hello.txt" });
    expect(result.outcome).toBe("worker-approved");

    // Give any (incorrectly present) fire-and-forget write a moment to land
    // before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readRuns(dir).records).toHaveLength(0);
  });
});

describe("engine.orchestrate — taskClass + review/escalate cost split (M6 Task 2)", () => {
  it("result.taskClass matches the class routeTask actually picked", async () => {
    dir = makeRepo();
    await writeTestHarness(dir);
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("hello.txt", "hi", "done"));
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({ reviewVerdicts: [{ decision: "approve", reasons: [], severity: "none" }] }),
    );

    const res = await call(engine, "engine.orchestrate", {
      projectDir: dir,
      task: "add hello.txt with a greeting",
    });
    expect(res.error).toBeUndefined();
    // writeTestHarness's only routing.taskClasses entry is "codegen", and
    // this task text matches no other keyword rule (no test/doc/refactor/
    // fix mention) so classifyTask falls through to "codegen".
    expect(res.result.taskClass).toBe("codegen");
  });

  it("cost.reviewUsd and cost.escalateUsd are populated separately and sum to frontierUsd", async () => {
    dir = makeRepo();
    // failuresBeforeFrontier: 1 -> exactly one worker attempt before
    // escalation, so this run exercises BOTH a review call (rejecting that
    // one attempt) and an escalation call, letting reviewUsd and
    // escalateUsd each land a single, distinctly-priced cost.
    await writeTestHarness(dir, { failuresBeforeFrontier: 1 });
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("attempt1.txt", "first try", "Attempt 1 summary"));
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({
        reviewVerdicts: [{ decision: "request-changes", reasons: ["nope"], severity: "minor" }],
        reviewCostUsd: 0.05,
        escalationCostUsd: 0.5,
      }),
    );

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "improve the widget" });
    expect(res.error).toBeUndefined();
    const result = res.result;

    expect(result.outcome).toBe("escalated");
    expect(result.cost.reviewUsd).toBeCloseTo(0.05, 10);
    expect(result.cost.escalateUsd).toBeCloseTo(0.5, 10);
    expect(result.cost.frontierUsd).toBeCloseTo(result.cost.reviewUsd + result.cost.escalateUsd, 10);
    expect(result.cost.totalUsd).toBeCloseTo(result.cost.workerUsd + result.cost.frontierUsd, 10);
  });
});

// M6 Task 1 review round 1, Fix 1 (Important — the substantive one):
// reviewTimeoutMs/workerTimeoutMs had NO default. An RPC caller omitting
// reviewTimeoutMs left the review/escalation frontier call UNBOUNDED — and
// under the stdin-close shutdown path (main.ts: abortAll -> pipeline.drain
// -> engine.close), drain() waits on THIS in-flight orchestrate call before
// close() can ever reap the direct frontier session it opened, so a wedged
// REAL review/escalation could hang an entire eval batch. Since the real
// Claude adapter now ENFORCES opts.timeoutMs (M6 Task 1 Change A), giving
// orchestrate its own default deadline is what makes every sub-call here
// self-bounding regardless of what a caller passes (or omits). These tests
// assert the DEFAULT (not `undefined`) reaches the fake frontier session's
// prompt() call whenever the RPC caller leaves the corresponding param out.
//
// Mirrors worker/methods.ts's own DEFAULT_RUN_TIMEOUT_MS convention: the
// default constants live in orchestrate.ts as internal, unexported consts,
// so the literal values below (300_000 / 600_000) are asserted directly
// rather than imported.
const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;
const DEFAULT_ESCALATE_TIMEOUT_MS = 600_000;

describe("engine.orchestrate — default deadlines (Fix 1, review round 1)", () => {
  it("omitted reviewTimeoutMs still passes a bounded timeoutMs to the review session's prompt", async () => {
    dir = makeRepo();
    await writeTestHarness(dir);
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("hello.txt", "HELLO FROM WORKER", "Created hello.txt"));
    const reviewPromptOpts: Array<{ timeoutMs?: number }> = [];
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({
        reviewVerdicts: [{ decision: "approve", reasons: [], severity: "none" }],
        reviewPromptOpts,
      }),
    );

    const res = await call(engine, "engine.orchestrate", {
      projectDir: dir,
      task: "add hello.txt with a greeting",
      // reviewTimeoutMs deliberately OMITTED.
    });
    expect(res.error).toBeUndefined();

    expect(reviewPromptOpts).toHaveLength(1);
    expect(reviewPromptOpts[0]!.timeoutMs).toBe(DEFAULT_REVIEW_TIMEOUT_MS);
  });

  it("omitted reviewTimeoutMs still passes a bounded timeoutMs to the escalation session's prompt", async () => {
    dir = makeRepo();
    const headSha = git(dir, "rev-parse", "HEAD");
    const agent: AgentDef = {
      name: "frontier-agent",
      role: "worker",
      description: "Frontier-only agent.",
      prompt: "You handle everything directly.",
      taskClasses: ["codegen"],
      model: "frontier",
      escalation: { maxAttempts: 2 },
    };
    const routing: Routing = {
      version: 1,
      taskClasses: { codegen: { agent: "frontier-agent" } },
      escalation: { failuresBeforeFrontier: 2 },
      defaults: { agent: "frontier-agent" },
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
      pages: [TRIVIAL_PAGE],
      agents: [agent],
      routing,
    };
    await writeHarness(dir, bundle);

    engine = createEngine();
    const escalationPromptOpts: Array<{ timeoutMs?: number }> = [];
    engine.frontier.registerAdapter(makeFakeFrontierAdapter({ escalationPromptOpts }));

    const res = await call(engine, "engine.orchestrate", {
      projectDir: dir,
      task: "do everything",
      // reviewTimeoutMs deliberately OMITTED.
    });
    expect(res.error).toBeUndefined();

    expect(escalationPromptOpts).toHaveLength(1);
    expect(escalationPromptOpts[0]!.timeoutMs).toBe(DEFAULT_ESCALATE_TIMEOUT_MS);
  });

  it("an explicit reviewTimeoutMs is still honored verbatim for both review and escalation", async () => {
    dir = makeRepo();
    await writeTestHarness(dir, { failuresBeforeFrontier: 1 });
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeEmptyWorkerMock("nothing to change"));
    const reviewPromptOpts: Array<{ timeoutMs?: number }> = [];
    const escalationPromptOpts: Array<{ timeoutMs?: number }> = [];
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({ reviewPromptOpts, escalationPromptOpts, escalationWritesFile: false }),
    );

    const res = await call(engine, "engine.orchestrate", {
      projectDir: dir,
      task: "improve the widget",
      reviewTimeoutMs: 12_345,
    });
    expect(res.error).toBeUndefined();

    // Empty worker diff never reaches review — only escalation's prompt runs.
    expect(escalationPromptOpts).toHaveLength(1);
    expect(escalationPromptOpts[0]!.timeoutMs).toBe(12_345);
  });
});

describe("engine.orchestrate — guard failures", () => {
  it("no harness -> SERVER_ERROR", async () => {
    dir = makeRepo();
    engine = createEngine();

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "do something" });
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error.message).toContain("no harness");
  });

  it("non-git projectDir -> SERVER_ERROR", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-orchestrate-nogit-"));
    engine = createEngine();

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "do something" });
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
  });
});

describe("engine.orchestrate — progress notifications", () => {
  it("happy path emits load, route, load (worker context), worker:1, review:1, done in order", async () => {
    dir = makeRepo();
    await writeTestHarness(dir);
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("hello.txt", "hi", "done"));
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({ reviewVerdicts: [{ decision: "approve", reasons: [], severity: "none" }] }),
    );

    await call(engine, "engine.orchestrate", { projectDir: dir, task: "add hello.txt" });

    const stages = notifications
      .filter((n) => n.method === "orchestrate.progress")
      .map((n) => (n.params as { stage: string }).stage);
    const deduped = stages.filter((s, i) => s !== stages[i - 1]);
    // Task 6: a second "load" stage now fires right after routing, carrying
    // the worker-context branch name (`worker context: <branch>`) — see
    // orchestrate.ts's own call site comment for why it's stage "load" and
    // not a new stage of its own.
    expect(deduped).toEqual(["load", "route", "load", "worker:1", "review:1", "done"]);
  });

  it("escalation path emits worker:1, review:1, worker:2, review:2, escalate, done", async () => {
    dir = makeRepo();
    await writeTestHarness(dir, { failuresBeforeFrontier: 2 });
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeMultiAttemptWorkerMock());
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({
        reviewVerdicts: [
          { decision: "request-changes", reasons: ["a"], severity: "minor" },
          { decision: "request-changes", reasons: ["b"], severity: "minor" },
        ],
      }),
    );

    await call(engine, "engine.orchestrate", { projectDir: dir, task: "improve the widget" });

    const stages = notifications
      .filter((n) => n.method === "orchestrate.progress")
      .map((n) => (n.params as { stage: string }).stage);
    const deduped = stages.filter((s, i) => s !== stages[i - 1]);
    // Task 6: same extra "load" (worker-context) stage as the happy-path
    // test above.
    expect(deduped).toEqual([
      "load",
      "route",
      "load",
      "worker:1",
      "review:1",
      "worker:2",
      "review:2",
      "escalate",
      "done",
    ]);
  });

  // M7c Task 5: orchestrate.progress/evals.progress notifications previously
  // carried no runId at all -- a client with more than one run in flight (of
  // the same kind) had no reliable way to filter progress to just ITS run
  // (the desktop engineClient helper had to fall back to a "filter by method
  // name only, assume single-run-at-a-time" posture -- see that module's own
  // doc comment). Every stage's notification must now carry the SAME runId
  // the caller supplied, end to end, and omit it entirely when none was
  // given (backward compatible shape for any existing/older caller).
  it("carries the run's runId on every notification when one was supplied", async () => {
    dir = makeRepo();
    await writeTestHarness(dir);
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("hello.txt", "hi", "done"));
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({ reviewVerdicts: [{ decision: "approve", reasons: [], severity: "none" }] }),
    );

    await call(engine, "engine.orchestrate", {
      projectDir: dir,
      task: "add hello.txt",
      runId: "orchestrate-progress-1",
    });

    const events = notifications
      .filter((n) => n.method === "orchestrate.progress")
      .map((n) => n.params as { stage: string; runId?: string });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.runId).toBe("orchestrate-progress-1");
    }
  });

  it("omits runId entirely when none was supplied (backward compatible shape)", async () => {
    dir = makeRepo();
    await writeTestHarness(dir);
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("hello.txt", "hi", "done"));
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({ reviewVerdicts: [{ decision: "approve", reasons: [], severity: "none" }] }),
    );

    await call(engine, "engine.orchestrate", { projectDir: dir, task: "add hello.txt" });

    const events = notifications
      .filter((n) => n.method === "orchestrate.progress")
      .map((n) => n.params as Record<string, unknown>);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect("runId" in e).toBe(false);
    }
  });
});

describe("engine.orchestrate — failure semantics", () => {
  it("an unrecoverable throw mid-pipeline wraps as SERVER_ERROR carrying attempts so far", async () => {
    dir = makeRepo();
    await writeTestHarness(dir, { failuresBeforeFrontier: 2 });
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("hello.txt", "hi", "done"));
    // No frontier adapter registered under "claude-code" at all — even
    // though registerFrontierMethods() registers the REAL default adapter,
    // overriding getAdapter to return undefined simulates an
    // "unknown frontier engine" failure once the review step is reached
    // (after a real worker attempt already ran).
    engine.frontier.getAdapter = () => undefined;

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "add hello.txt" });
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error.data?.attempts).toBeDefined();
    // The worker attempt succeeded (non-empty diff) but never got a verdict
    // — its worktree is still on disk and reported for inspection.
    expect(res.error.data?.worktree?.path).toBeDefined();
    expect(existsSync(res.error.data.worktree.path)).toBe(true);
  });

  it("attempt 1 rejected+cleaned, attempt 2's worker.run throws -> SERVER_ERROR's data.worktree is attempt 2's path, not stale null", async () => {
    dir = makeRepo();
    await writeTestHarness(dir, { failuresBeforeFrontier: 2 });
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeAttempt1ThenThrowWorkerMock());
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({
        // Only attempt 1 ever reaches review (attempt 2 throws inside
        // engine.worker.run itself, before any review session opens).
        reviewVerdicts: [{ decision: "request-changes", reasons: ["needs work"], severity: "minor" }],
      }),
    );

    const res = await call(engine, "engine.orchestrate", { projectDir: dir, task: "improve the widget" });
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);

    // Finding 2 (M5b Task 4 review round 1): before the fix, attempt 1's
    // worktree was already cleaned (rejected verdict) so `lastWorktree` was
    // null by the time attempt 2's engine.worker.run threw — that throw's
    // OWN error carries attempt 2's real (still-on-disk) worktree path in
    // its `data`, which the fix now lifts instead of reporting the stale
    // null.
    expect(res.error.data?.attempts).toHaveLength(1);
    expect(res.error.data?.worktree?.path).toBeDefined();
    const worktreePath = res.error.data.worktree.path as string;
    expect(existsSync(worktreePath)).toBe(true);

    // It's attempt 2's worktree specifically — attempt 1's is already gone.
    const manager = await engine.worker.getManager(dir);
    const worktrees = await manager.list();
    expect(worktrees).toHaveLength(1);
    expect(path.resolve(worktrees[0]!.path)).toBe(path.resolve(worktreePath));
  });
});

// M6 Task 1 (eval-batch safety gate): the review session orchestrate.ts
// opens for the frontier-review gate is created DIRECTLY off the registered
// adapter (adapter.createSession), bypassing engine.frontier.start entirely
// — so it never lands in FrontierService's addressable #sessions map, and
// before this fix Engine.close() had no way to reach it at all. A wedged
// real review turn would therefore survive engine.close() outright, letting
// an eval batch of N real orchestrate loops hang on one stuck review. Fixed
// by FrontierService.track()/untrack (engines/methods.ts) — orchestrate.ts
// tracks its review (and escalation) session on create and untracks it in
// the same `finally` where it closes the session.
describe("engine.orchestrate — in-flight review + engine.close() (Task 1 Change B)", () => {
  it("engine.close() resolves within a bounded time and closes the in-flight review session", async () => {
    dir = makeRepo();
    await writeTestHarness(dir);
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeWorkerMock("hello.txt", "HELLO FROM WORKER", "Created hello.txt"));
    const reviewSessionStarts = { count: 0 };
    const reviewCloseSpy = { count: 0 };
    engine.frontier.registerAdapter(
      makeFakeFrontierAdapter({
        blockReviewUntilClose: true,
        reviewSessionStarts,
        reviewCloseSpy,
      }),
    );

    const orchestratePromise = call(engine, "engine.orchestrate", {
      projectDir: dir,
      task: "add hello.txt with a greeting",
    });

    // Wait for the worker attempt to finish and the review session to
    // actually start (its prompt() is now blocked awaiting close()) before
    // racing engine.close() against it — polled rather than a flat sleep so
    // this isn't sensitive to how long the real worktree/worker machinery
    // takes under load.
    const deadline = Date.now() + 10_000;
    while (reviewSessionStarts.count < 1) {
      if (Date.now() > deadline) throw new Error("review session never started");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const start = Date.now();
    await engine.close();
    const elapsed = Date.now() - start;

    // Generous bound per the task brief's own flake-avoidance guidance.
    expect(elapsed).toBeLessThan(3_000);
    expect(reviewCloseSpy.count).toBe(1);

    const res = await orchestratePromise;
    // The blocked review session never produced a result event once
    // close() ended its (still-open) generator — reviewDiff/promptForJson
    // sees the turn end without schema-valid JSON, which orchestrate.ts
    // surfaces as a SERVER_ERROR, not a hang.
    expect(res.error).toBeDefined();
  }, 15_000);
});

// M7b Task 2: engine-side cancellation of an in-flight engine.orchestrate
// run via engine.cancel { runId }. Unlike the engine.close()-driven test
// above (which tears down EVERYTHING), engine.cancel targets exactly ONE
// run by its client-supplied runId, leaving any other in-flight run (and
// the engine itself) untouched.
describe("engine.orchestrate — cancellation via engine.cancel (M7b Task 2)", () => {
  it("cancel mid-run (hanging worker attempt): aborts promptly, reports the cancelled marker, preserves the worktree breadcrumb, and leaves the registry empty", async () => {
    dir = makeRepo();
    await writeTestHarness(dir);
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeHangingWorkerMock());
    engine.frontier.registerAdapter(makeFakeFrontierAdapter({}));

    const start = Date.now();
    const orchestratePromise = call(engine, "engine.orchestrate", {
      projectDir: dir,
      task: "add hello.txt with a greeting",
      runId: "r1",
    });

    // Wait for the worker attempt to actually start (worktree created) —
    // polled via the real engine.worker.list RPC rather than a fixed sleep,
    // mirroring worker-methods.test.ts's own "engine.close() aborts an
    // in-flight run" test's identical poll-until-started pattern (and this
    // suite's own "in-flight review + engine.close()" test above).
    const startDeadline = Date.now() + 10_000;
    for (;;) {
      const listRes = await call(engine, "engine.worker.list", { projectDir: dir });
      if ((listRes.result?.worktrees?.length ?? 0) > 0) break;
      if (Date.now() > startDeadline) throw new Error("worker run never created its worktree");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const cancelRes = await call(engine, "engine.cancel", { runId: "r1" });
    expect(cancelRes.error).toBeUndefined();
    expect(cancelRes.result.cancelled).toBe(true);

    const res = await orchestratePromise;
    const elapsed = Date.now() - start;
    // Generous bound — only engine.cancel's abort (not the hanging model's
    // own never-settling promise) could plausibly end this run this fast.
    expect(elapsed).toBeLessThan(5_000);

    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error.data.cancelled).toBe(true);
    // Breadcrumb, not deleted: the worker attempt's worktree is left on disk
    // exactly like any other failed attempt (worktree.ts's own "never
    // remove on a failure path" discipline) — cancellation is deliberately
    // treated just like any other failure for worktree-preservation
    // purposes.
    expect(res.error.data.worktree).not.toBeNull();
    expect(existsSync(res.error.data.worktree.path)).toBe(true);

    // No leak: the registry entry this run's runId occupied is gone once
    // the run has settled (methods.ts's own register/finally-deregister).
    expect(engine.cancelRegistry.size()).toBe(0);
  }, 15_000);

  it("engine.cancel on an unknown runId resolves { cancelled: false } without erroring", async () => {
    dir = makeRepo();
    engine = createEngine();

    const res = await call(engine, "engine.cancel", { runId: "no-such-run" });
    expect(res.error).toBeUndefined();
    expect(res.result.cancelled).toBe(false);
  });

  it("an ordinary (uncancelled) run with a runId behaves exactly as before, and the registry empties on normal completion too", async () => {
    dir = makeRepo();
    await writeTestHarness(dir);
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel(
      "p1",
      makeWorkerMock("hello.txt", "HELLO FROM WORKER", "Created hello.txt"),
    );
    engine.frontier.registerAdapter(makeFakeFrontierAdapter({}));

    const res = await call(engine, "engine.orchestrate", {
      projectDir: dir,
      task: "add hello.txt with a greeting",
      runId: "r-normal",
    });

    expect(res.error).toBeUndefined();
    expect(res.result.outcome).toBe("worker-approved");
    expect(res.result.diff).toContain("hello.txt");
    // Registry emptied on NORMAL completion too, not just on cancel.
    expect(engine.cancelRegistry.size()).toBe(0);
  });
});

describe("engine.orchestrate.apply", () => {
  it("returns { applied: true } as a no-op for an empty diff", async () => {
    dir = makeRepo();
    engine = createEngine();

    const res = await call(engine, "engine.orchestrate.apply", { projectDir: dir, diff: "" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ applied: true });
  });

  it("returns SERVER_ERROR with the git error for a malformed diff", async () => {
    dir = makeRepo();
    engine = createEngine();

    const res = await call(engine, "engine.orchestrate.apply", {
      projectDir: dir,
      diff: "this is not a valid unified diff at all\n",
    });
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error.message).toContain("git apply failed");
  });

  it("rejects a non-git projectDir with SERVER_ERROR", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-orchestrate-apply-nogit-"));
    engine = createEngine();

    const res = await call(engine, "engine.orchestrate.apply", { projectDir: dir, diff: "" });
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
  });
});
