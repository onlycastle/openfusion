import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { createEngine, type Engine } from "../src/engine.js";
import type { FrontierAdapter, FrontierEvent, FrontierPromptHandle, FrontierSession } from "../src/engines/types.js";
import type { AgentDef, HarnessBundle, Routing, WikiPage } from "../src/harness/schema.js";
import { harnessStatus, writeHarness } from "../src/harness/store.js";
import type { CostMeter } from "../src/models/meter.js";
import { goldenTaskFromCommit, synthEvalTask, type EvalTask } from "../src/evals/tasks.js";
import { runEvals } from "../src/evals/run.js";
import { RpcMethodError } from "../src/rpc/errors.js";

// Fixture literal only — must never appear outside test files (mirrors
// orchestrate.test.ts's identical TEST_API_KEY constant/rationale).
const TEST_API_KEY = "sk-test-fixture-never-real-1234567890";

let dir: string;
let engine: Engine;

afterEach(async () => {
  if (engine !== undefined) await engine.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(prefix = "of-evals-"): string {
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

const TRIVIAL_PAGE: WikiPage = {
  slug: "architecture",
  title: "Architecture",
  digest: "A trivial fixture wiki page for evals-run tests.",
  body: "# Architecture\n\nFixture content.\n",
};

// A harness with exactly ONE agent whose model is "frontier" -- routeTask
// (routing.ts) resolves this straight to the frontier-escalation path with
// NO worker attempts and NO review call at all (mirrors orchestrate.test.ts's
// own "routing straight to frontier" fixture). This keeps the fixture here
// to exactly ONE fake frontier adapter with no review-verdict scripting
// needed -- evals-run's own tests are about the report-card/verdict logic,
// not re-testing orchestrate's worker-retry mechanics (already exhaustively
// covered by orchestrate.test.ts).
async function writeFrontierOnlyHarness(projectDir: string): Promise<void> {
  const headSha = git(projectDir, "rev-parse", "HEAD");
  const agent: AgentDef = {
    name: "frontier-agent",
    role: "worker",
    description: "Frontier-only agent for evals-run fixtures.",
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
  await writeHarness(projectDir, bundle);
}

// Builds the "real project being evaluated" fixture: a plain git repo
// carrying a generated harness bundle. That bundle (routing/wiki/agents/
// manifest) is now ALL the harness side of runEvals ever reads off the real
// project (Task 4 Fix 1 — base identity): engine.orchestrate works each
// task against its OWN base-state scratch directory (harnessDir), with the
// real project's harness bundle copied in via writeHarness, never against
// the real project's own source tree. So, unlike before this fix, this
// fixture's own source-tree content (if any) is now irrelevant to whether
// the harness pipeline's diff applies cleanly -- there is no more
// same-content-as-HEAD trick required here.
async function makeHarnessFixture(): Promise<string> {
  const base = makeRepo();
  await writeFrontierOnlyHarness(base);
  return base;
}

const CORRECT_SOURCE = "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n";
const WRONG_SOURCE = "function add(a, b) {\n  return a + b + 1;\n}\n\nmodule.exports = { add };\n";

interface FakeEvalsFrontierOptions {
  baselineCorrect: boolean;
  harnessCorrect: boolean;
  baselineCostUsd?: number | null;
  harnessCostUsd?: number | null;
  meter?: CostMeter;
  sourceFile?: string;
}

// One fake frontier adapter serves BOTH roles this suite needs:
//   - the BASELINE primitive (run.ts's runBaselineTask), tagged
//     resultLabel "eval-baseline"
//   - the HARNESS side's escalation call (orchestrate.ts's runEscalation,
//     reached immediately since the fixture harness routes straight to
//     "frontier"), tagged resultLabel "frontier-escalate"
// createSession's own `resultLabel` (types.ts's documented purpose-tag
// mechanism) is what lets a single fake tell the two apart, independent of
// which directory (baseline scratch dir vs. orchestrate's own worktree) it
// was actually invoked against.
function makeFakeEvalsFrontierAdapter(opts: FakeEvalsFrontierOptions): FrontierAdapter {
  const sourceFile = opts.sourceFile ?? "source.js";
  return {
    kind: "claude-code",
    async createSession({ projectDir, resultLabel }): Promise<FrontierSession> {
      const isBaseline = resultLabel === "eval-baseline";
      const correct = isBaseline ? opts.baselineCorrect : opts.harnessCorrect;
      const configuredCost = isBaseline ? opts.baselineCostUsd : opts.harnessCostUsd;
      const costUsd = configuredCost === undefined ? (isBaseline ? 0.5 : 0.05) : configuredCost;
      return {
        id: randomUUID(),
        projectDir,
        prompt(_text: string, _promptOpts?: { timeoutMs?: number }): FrontierPromptHandle {
          async function* gen(): AsyncGenerator<FrontierEvent> {
            writeFileSync(path.join(projectDir, sourceFile), correct ? CORRECT_SOURCE : WRONG_SOURCE);
            yield { type: "tool_use", name: "Write", summary: `wrote ${sourceFile}` };
            yield { type: "text", text: "done" };
            const event: FrontierEvent = {
              type: "result",
              resultText: "done",
              costUsd,
              usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
              numTurns: 1,
              durationMs: 1,
              engineSessionId: null,
            };
            opts.meter?.record({
              providerId: "claude-code",
              kind: "frontier-claude",
              model: "fake-frontier-model",
              usage: event.usage,
              costUsd: event.costUsd,
              at: Date.now(),
              source: isBaseline ? "frontier-review" : "frontier-escalate",
              pricingConfidence: costUsd !== null ? "verified" : "unpriced",
            });
            yield event;
          }
          return { events: gen(), abort: () => {} };
        },
        async close(): Promise<void> {},
      };
    },
  };
}

// Like makeFakeEvalsFrontierAdapter, but the HARNESS side (resultLabel !=
// "eval-baseline") writes the WRONG source on its first `harnessFailCount`
// invocations and the correct source thereafter; the baseline side is always
// correct. The frontier-only fixture harness routes straight to escalation --
// exactly ONE frontier session per task on each side -- so the harness-side
// counter maps 1:1 to task order, letting a test produce a SMALL clean-subset
// quality gap (e.g. 1 of 30) to exercise QUALITY_NOISE_BAND.
function makePartialFailFrontierAdapter(opts: {
  harnessFailCount: number;
  baselineCostUsd: number;
  harnessCostUsd: number;
  meter: CostMeter;
}): FrontierAdapter {
  let harnessSeen = 0;
  return {
    kind: "claude-code",
    async createSession({ projectDir, resultLabel }): Promise<FrontierSession> {
      const isBaseline = resultLabel === "eval-baseline";
      let correct: boolean;
      if (isBaseline) {
        correct = true;
      } else {
        harnessSeen += 1;
        correct = harnessSeen > opts.harnessFailCount; // first N harness runs fail
      }
      const costUsd = isBaseline ? opts.baselineCostUsd : opts.harnessCostUsd;
      return {
        id: randomUUID(),
        projectDir,
        prompt(_text: string, _promptOpts?: { timeoutMs?: number }): FrontierPromptHandle {
          async function* gen(): AsyncGenerator<FrontierEvent> {
            writeFileSync(path.join(projectDir, "source.js"), correct ? CORRECT_SOURCE : WRONG_SOURCE);
            yield { type: "tool_use", name: "Write", summary: "wrote source.js" };
            yield { type: "text", text: "done" };
            const event: FrontierEvent = {
              type: "result",
              resultText: "done",
              costUsd,
              usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
              numTurns: 1,
              durationMs: 1,
              engineSessionId: null,
            };
            opts.meter.record({
              providerId: "claude-code",
              kind: "frontier-claude",
              model: "fake-frontier-model",
              usage: event.usage,
              costUsd: event.costUsd,
              at: Date.now(),
              source: isBaseline ? "frontier-review" : "frontier-escalate",
              pricingConfidence: costUsd !== null ? "verified" : "unpriced",
            });
            yield event;
          }
          return { events: gen(), abort: () => {} };
        },
        async close(): Promise<void> {},
      };
    },
  };
}

// --- C1 fixtures: mixed pricing (frontier priced, WORKER model unpriced) --
//
// Unlike writeFrontierOnlyHarness above (which routes straight to the
// frontier-escalation path with no worker attempt at all), this fixture
// routes to a real worker model resolution -- required to reproduce C1: the
// bug only shows up when orchestrate.ts's own `cost.totalUsd` sums a null
// (unpriced) `workerUsd` alongside a non-null (always-priced) frontier
// review cost. A harness that skips the worker (frontier-only) can never
// exercise addCost's null-skip semantics the way a real "cheap worker,
// frontier review" split does.
const UNPRICED_WORKER_MODEL = "deepseek-v4-mixed-pricing-fixture";

async function writeUnpricedWorkerHarness(projectDir: string): Promise<void> {
  const headSha = git(projectDir, "rev-parse", "HEAD");
  const agent: AgentDef = {
    name: "codegen-worker",
    role: "worker",
    description: "Writes code for codegen tasks (C1 fixture -- deliberately NOT in the PRICING table).",
    prompt: "You are a codegen specialist. Follow instructions exactly.",
    taskClasses: ["codegen"],
    model: { kind: "deepseek", model: UNPRICED_WORKER_MODEL, providerId: "p1" },
    escalation: { maxAttempts: 2 },
  };
  const routing: Routing = {
    version: 1,
    taskClasses: { codegen: { agent: "codegen-worker" } },
    escalation: { failuresBeforeFrontier: 2 },
    defaults: { agent: "codegen-worker" },
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
  await writeHarness(projectDir, bundle);
}

async function makeUnpricedWorkerHarnessFixture(): Promise<string> {
  const base = makeRepo();
  await writeUnpricedWorkerHarness(base);
  return base;
}

// --- Scripted worker model (ai/test's MockLanguageModelV4) — mirrors
// orchestrate.test.ts's own toolCallStep/textStep/makeWorkerMock (duplicated
// locally per this codebase's established test-fixture convention; see
// run.ts's own doc comments on addCost/callEngineMethod for the same
// rationale). `makeRepeatableWorkerMock` differs from orchestrate.test.ts's
// `makeWorkerMock` only in ALTERNATING (step % 2) rather than "step 1 vs.
// everything else": this suite drives FIVE separate engine.worker.run loops
// (one per eval task, each a single write-then-summarize attempt approved by
// review on the first try, so a single worker model instance registered ONCE
// outside runEvals's own per-task loop still produces the right
// tool-call/text pair for every task in sequence.
function toolCallStep(filePath: string, content: string): {
  content: Array<{ type: "tool-call"; toolCallId: string; toolName: string; input: string }>;
  finishReason: { unified: "tool-calls"; raw: string };
  usage: {
    inputTokens: { total: number; noCache: number; cacheRead: undefined; cacheWrite: undefined };
    outputTokens: { total: number; text: number; reasoning: undefined };
  };
  warnings: never[];
} {
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

function textStep(text: string): {
  content: Array<{ type: "text"; text: string }>;
  finishReason: { unified: "stop"; raw: string };
  usage: {
    inputTokens: { total: number; noCache: number; cacheRead: undefined; cacheWrite: undefined };
    outputTokens: { total: number; text: number; reasoning: undefined };
  };
  warnings: never[];
} {
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

function makeRepeatableWorkerMock(filePath: string, content: string, summary: string): MockLanguageModelV4 {
  let step = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      step++;
      return step % 2 === 1 ? toolCallStep(filePath, content) : textStep(summary);
    },
  });
}

// Serves BOTH the baseline primitive (resultLabel "eval-baseline") and the
// harness side's READ-ONLY review session (resultLabel "frontier-review") —
// always approves, so the worker's first (and only) attempt is never
// retried or escalated. Both cost figures are priced/verified: the whole
// point of C1's fixture is that ONLY the worker call (a real
// engine.models.complete call against a model absent from PRICING, recorded
// automatically by models/methods.ts's own runComplete -- see pricing.ts's
// lookupPricing) is unpriced; the frontier side is never the unpriced
// component in this scenario.
function makeMixedPricingFrontierAdapter(meter: CostMeter): FrontierAdapter {
  return {
    kind: "claude-code",
    async createSession({ projectDir, resultLabel }): Promise<FrontierSession> {
      const isBaseline = resultLabel === "eval-baseline";
      return {
        id: randomUUID(),
        projectDir,
        prompt(_text: string, _promptOpts?: { timeoutMs?: number }): FrontierPromptHandle {
          async function* gen(): AsyncGenerator<FrontierEvent> {
            if (isBaseline) {
              writeFileSync(path.join(projectDir, "source.js"), CORRECT_SOURCE);
              yield { type: "tool_use", name: "Write", summary: "wrote source.js" };
              yield { type: "text", text: "done" };
              const event: FrontierEvent = {
                type: "result",
                resultText: "done",
                costUsd: 0.5,
                usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
                numTurns: 1,
                durationMs: 1,
                engineSessionId: null,
              };
              meter.record({
                providerId: "claude-code",
                kind: "frontier-claude",
                model: "fake-frontier-model",
                usage: event.usage,
                costUsd: event.costUsd,
                at: Date.now(),
                source: "frontier-review",
                pricingConfidence: "verified",
              });
              yield event;
              return;
            }
            // Harness-side review: approve immediately -- no retry, no
            // escalation, so the worker's own (unpriced) cost is the ONLY
            // component orchestrate.ts's addCost null-skip can hide.
            yield {
              type: "text",
              text: "```json\n" + JSON.stringify({ decision: "approve", reasons: [], severity: "none" }) + "\n```",
            };
            const event: FrontierEvent = {
              type: "result",
              resultText: "approve",
              costUsd: 0.05,
              usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
              numTurns: 1,
              durationMs: 1,
              engineSessionId: null,
            };
            meter.record({
              providerId: "claude-code",
              kind: "frontier-claude",
              model: "fake-frontier-model",
              usage: event.usage,
              costUsd: event.costUsd,
              at: Date.now(),
              source: "frontier-review",
              pricingConfidence: "verified",
            });
            yield event;
          }
          return { events: gen(), abort: () => {} };
        },
        async close(): Promise<void> {},
      };
    },
  };
}

describe("runEvals — C1: mixed pricing (unpriced worker cost must not overstate savings)", () => {
  it("frontier priced, WORKER model unpriced -> verdict 'inconclusive' (never 'pass'); manifest not flipped; note names the unpriced count", async () => {
    dir = await makeUnpricedWorkerHarnessFixture();
    engine = createEngine();
    engine.models.registry.configure({ id: "p1", kind: "deepseek", apiKey: TEST_API_KEY });
    engine.models.registry.setTestModel("p1", makeRepeatableWorkerMock("source.js", CORRECT_SOURCE, "wrote source.js"));
    engine.frontier.registerAdapter(makeMixedPricingFrontierAdapter(engine.models.meter));

    const tasks: EvalTask[] = Array.from({ length: 5 }, (_, i) => synthEvalTask({ id: `t${i + 1}` }));
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.taskCount).toBe(5);
    // Quality genuinely held on every task -- this is NOT an ETH-hazard
    // scenario. The bug this test targets is purely about the SAVINGS claim.
    expect(report.baseline.passed).toBe(5);
    expect(report.harness.passed).toBe(5);
    expect(report.qualityHeld).toBe(true);
    expect(report.perTask.every((t) => t.harnessOutcome === "worker-approved")).toBe(true);

    // THE BUG (pre-fix): orchestrate.ts's own `cost.totalUsd` silently drops
    // the unpriced worker cost (addCost's null-skip semantics), so
    // harness.costUsd looks like a real, priced (review-only) number and
    // savingsPct comes out positive -- looking exactly like a legitimate
    // "pass".
    expect(report.harness.costUsd).not.toBeNull();
    expect(report.savingsPct).not.toBeNull();
    expect(report.savingsPct!).toBeGreaterThan(0);

    // THE FIX (C1): a run where ANY model call went unpriced must never be
    // reported as "pass" -- the savings figure above rests on an
    // undercounted cost, not a real measurement.
    expect(report.verdict).toBe("inconclusive");
    expect(report.note).toContain("unpriced");
    expect(report.note).toMatch(/\d+ model call\(s\) were unpriced/);
    expect(harnessStatus(dir).evals).toBe("pending");
  }, 30_000);
});

describe("runEvals — sample-size gate", () => {
  it("harness matches baseline (both pass), priced -- but too few tasks -> inconclusive even on a good run", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({
        baselineCorrect: true,
        harnessCorrect: true,
        baselineCostUsd: 0.5,
        harnessCostUsd: 0.05,
        meter: engine.models.meter,
      }),
    );

    const tasks: EvalTask[] = [synthEvalTask({ id: "t1" }), synthEvalTask({ id: "t2" })];
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.taskCount).toBe(2);
    expect(report.baseline.passed).toBe(2);
    expect(report.harness.passed).toBe(2);
    expect(report.harness.escalations).toBe(2);
    expect(report.qualityHeld).toBe(true);
    expect(report.savingsPct).not.toBeNull();
    expect(report.savingsPct!).toBeGreaterThan(0);
    // THE GATE: enough quality/savings to look like a pass, but 2 < 5.
    expect(report.verdict).toBe("inconclusive");
    expect(report.note.toLowerCase()).toContain("demo, not a claim");

    expect(harnessStatus(dir).evals).toBe("pending");
  });

  it("priced, quality held, positive savings, but between the low floor and the savings-pass floor -> inconclusive", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({
        baselineCorrect: true,
        harnessCorrect: true,
        baselineCostUsd: 0.5,
        harnessCostUsd: 0.05,
        meter: engine.models.meter,
      }),
    );

    // 6 tasks: clears MIN_TASK_COUNT_FOR_VERDICT (5) but below
    // MIN_TASK_COUNT_FOR_SAVINGS_PASS (20).
    const tasks: EvalTask[] = Array.from({ length: 6 }, (_, i) => synthEvalTask({ id: `t${i + 1}` }));
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.qualityHeld).toBe(true);
    expect(report.savingsPct!).toBeGreaterThan(0);
    expect(report.verdict).toBe("inconclusive");
    expect(harnessStatus(dir).evals).toBe("pending");
  }, 120_000);
});

describe("runEvals — ETH hazard", () => {
  it("harness FAILS a task the baseline PASSES -> verdict 'fail' (a GENUINE quality failure, not a measurement artifact)", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({
        baselineCorrect: true,
        harnessCorrect: false,
        baselineCostUsd: 0.5,
        harnessCostUsd: 0.05,
        meter: engine.models.meter,
      }),
    );

    const tasks: EvalTask[] = [synthEvalTask({ id: "t1" }), synthEvalTask({ id: "t2" })];
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.baseline.passed).toBe(2);
    expect(report.harness.passed).toBe(0);
    expect(report.qualityHeld).toBe(false);
    // RE-VERIFY (Task 4 Fix 2 requirement): this "fail" must be earned by a
    // GENUINE quality failure -- the harness actually produced a tested,
    // applied, oracle-scored (wrong) fix on every task -- never a
    // measurement artifact (apply-failed/error) masquerading as one. If
    // this pipeline regressed back to the old base-identity bug, these
    // outcomes would instead be "apply-failed" (or the diff would never
    // even apply), which is exactly the false-hazard failure mode Task 4
    // fixes.
    expect(report.perTask.every((t) => t.harnessOutcome === "escalated")).toBe(true);
    expect(report.perTask.every((t) => t.baselineOutcome === "completed")).toBe(true);
    // Even though the harness is dramatically cheaper, quality dropping
    // below baseline is an automatic "fail" -- savingsPct is never allowed
    // to paper over an ETH hazard.
    expect(report.verdict).toBe("fail");
    expect(harnessStatus(dir).evals).toBe("fail");
  });
});

describe("runEvals — quality-gap significance (noise band, research 2026-07-07 §3.3)", () => {
  it("small clean-subset gap within the noise band (1 of 20) -> NOT an ETH fail; quality treated as held", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makePartialFailFrontierAdapter({
        harnessFailCount: 1, // 1/20 = 5pp; strictly at/below the 0.05 band -> not significant
        baselineCostUsd: 0.5,
        harnessCostUsd: 0.05,
        meter: engine.models.meter,
      }),
    );
    const tasks: EvalTask[] = Array.from({ length: 20 }, (_, i) => synthEvalTask({ id: `t${i + 1}` }));
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.baseline.passed).toBe(20);
    expect(report.harness.passed).toBe(19);
    expect(report.qualityGapWithinNoise).toBe(true);
    // Not a fail: within noise, so quality "held"; priced + >=20 tasks +
    // positive savings -> pass.
    expect(report.verdict).toBe("pass");
    expect(harnessStatus(dir).evals).toBe("pass");
  }, 120_000);

  it("clean-subset gap ABOVE the noise band (3 of 20 = 15pp) -> ETH fail", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makePartialFailFrontierAdapter({
        harnessFailCount: 3, // 3/20 = 15pp > 0.05
        baselineCostUsd: 0.5,
        harnessCostUsd: 0.05,
        meter: engine.models.meter,
      }),
    );
    const tasks: EvalTask[] = Array.from({ length: 20 }, (_, i) => synthEvalTask({ id: `t${i + 1}` }));
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.harness.passed).toBe(17);
    expect(report.qualityGapWithinNoise).toBe(false);
    expect(report.verdict).toBe("fail");
    expect(harnessStatus(dir).evals).toBe("fail");
  }, 120_000);
});

describe("runEvals — cost-regression hazard (two-dimensional verdict, research 2026-07-07 §4.3)", () => {
  it("quality held but harness materially MORE expensive (>=10%) -> ETH cost-hazard fail (fires at the low floor)", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({
        baselineCorrect: true,
        harnessCorrect: true,
        baselineCostUsd: 0.05,
        harnessCostUsd: 0.5, // harness 10x the baseline cost -> savings ~ -9.0
        meter: engine.models.meter,
      }),
    );
    const tasks: EvalTask[] = Array.from({ length: 5 }, (_, i) => synthEvalTask({ id: `t${i + 1}` }));
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.qualityHeld).toBe(true);
    expect(report.savingsPct!).toBeLessThan(0);
    expect(report.verdict).toBe("fail");
    expect(harnessStatus(dir).evals).toBe("fail");
    // Non-vacuous: every report note contains the boilerplate "Cost figures
    // are estimate-class..." sentence, so asserting just "cost" would pass
    // regardless of which branch fired. This substring is unique to the
    // cost-hazard branch's OWN note text (run.ts's extraNotes.push inside the
    // `cleanSavingsPct <= -COST_REGRESSION_FAIL_FRACTION` branch) and does
    // NOT appear in the always-present boilerplate.
    expect(report.note.toLowerCase()).toContain("cost-regression threshold");
  }, 120_000);

  it("quality held, harness only MILDLY more expensive (<10%) -> inconclusive, never a fail", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({
        baselineCorrect: true,
        harnessCorrect: true,
        baselineCostUsd: 0.1,
        harnessCostUsd: 0.103, // +3% -> savings -0.03, within the -0.10 band
        meter: engine.models.meter,
      }),
    );
    const tasks: EvalTask[] = Array.from({ length: 20 }, (_, i) => synthEvalTask({ id: `t${i + 1}` }));
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.qualityHeld).toBe(true);
    expect(report.savingsPct!).toBeLessThan(0);
    expect(report.verdict).toBe("inconclusive");
    expect(harnessStatus(dir).evals).toBe("pending");
  }, 120_000);
});

describe("runEvals — cross-change interactions", () => {
  it("within-noise quality gap AND a material cost regression -> cost-hazard fail wins", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makePartialFailFrontierAdapter({
        harnessFailCount: 1, // 1/20 = 5pp, within the 0.05 noise band -> quality treated as held
        baselineCostUsd: 0.05,
        harnessCostUsd: 0.5, // harness 10x the baseline cost -> a material cost regression
        meter: engine.models.meter,
      }),
    );
    const tasks: EvalTask[] = Array.from({ length: 20 }, (_, i) => synthEvalTask({ id: `t${i + 1}` }));
    const report = await runEvals(engine, { projectDir: dir, tasks });

    // Within-noise -> quality treated as held -> held-quality + material cost
    // regression -> cost-hazard fail. Pins the most important cross-change
    // interaction between the significance gate and the cost-hazard gate.
    expect(report.qualityGapWithinNoise).toBe(true);
    expect(report.verdict).toBe("fail");
    expect(harnessStatus(dir).evals).toBe("fail");
  }, 120_000);

  it("small-suite quality gap of 1-of-2 (50pp) still fails (noise band must not weaken small-N flagging)", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makePartialFailFrontierAdapter({
        harnessFailCount: 1, // 1/2 = 50pp, well above the 0.05 noise band
        baselineCostUsd: 0.5,
        harnessCostUsd: 0.05, // harness CHEAPER -- no cost-hazard confound
        meter: engine.models.meter,
      }),
    );
    const tasks: EvalTask[] = Array.from({ length: 2 }, (_, i) => synthEvalTask({ id: `t${i + 1}` }));
    const report = await runEvals(engine, { projectDir: dir, tasks });

    // Pins the plan's own "1-of-2 = 50pp must still fail" invariant: a tiny
    // suite's large fractional gap must never be absorbed by the noise band.
    expect(report.qualityGapWithinNoise).toBe(false);
    expect(report.verdict).toBe("fail");
    expect(harnessStatus(dir).evals).toBe("fail");
  }, 120_000);
});

describe("runEvals — base identity (Task 4 Fix 1)", () => {
  it("engine.orchestrate works the harness side from harnessDir, never from the real project directory", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    const capturedEscalateProjectDirs: string[] = [];
    engine.frontier.registerAdapter({
      kind: "claude-code",
      async createSession({ projectDir, resultLabel }): Promise<FrontierSession> {
        if (resultLabel === "frontier-escalate") capturedEscalateProjectDirs.push(projectDir);
        return {
          id: randomUUID(),
          projectDir,
          prompt(_text: string, _promptOpts?: { timeoutMs?: number }): FrontierPromptHandle {
            async function* gen(): AsyncGenerator<FrontierEvent> {
              writeFileSync(path.join(projectDir, "source.js"), CORRECT_SOURCE);
              yield { type: "tool_use", name: "Write", summary: "wrote source.js" };
              yield { type: "text", text: "done" };
              yield {
                type: "result",
                resultText: "done",
                costUsd: 0.1,
                usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
                numTurns: 1,
                durationMs: 1,
                engineSessionId: null,
              };
            }
            return { events: gen(), abort: () => {} };
          },
          async close(): Promise<void> {},
        };
      },
    });

    await runEvals(engine, { projectDir: dir, tasks: [synthEvalTask({ id: "t1" })] });

    expect(capturedEscalateProjectDirs).toHaveLength(1);
    const escalateProjectDir = capturedEscalateProjectDirs[0]!;
    const realProjectDirResolved = realpathSync(path.resolve(dir));
    // The escalation session's cwd is a worktree UNDER the harness eval
    // scratch dir (this pipeline's own "of-eval-harness-" mkdtemp prefix —
    // see run.ts), never under the real project directory.
    expect(escalateProjectDir).toContain("of-eval-harness-");
    expect(escalateProjectDir.startsWith(realProjectDirResolved)).toBe(false);
  });

  it("solves a golden task from its OWN base state even when the real project's HEAD already contains the fix", async () => {
    dir = makeRepo();
    // Commit A: a buggy add() with its own pre-existing (currently failing)
    // test.
    writeFileSync(
      path.join(dir, "source.js"),
      ["function add(a, b) {", "  return a - b; // bug: should be a + b", "}", "", "module.exports = { add };", ""].join(
        "\n",
      ),
    );
    writeFileSync(
      path.join(dir, "test.js"),
      [
        "const assert = require('node:assert');",
        "const { add } = require('./source');",
        "assert.strictEqual(add(2, 3), 5);",
        "console.log('ok');",
        "",
      ].join("\n"),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "A: add buggy add() with its test");

    // Commit B: the real fix.
    writeFileSync(
      path.join(dir, "source.js"),
      ["function add(a, b) {", "  return a + b;", "}", "", "module.exports = { add };", ""].join("\n"),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "B: fix add() to return the correct sum");
    const commitB = git(dir, "rev-parse", "HEAD");

    // CRITICAL, deliberately NOT reset: the real project's HEAD is left at
    // commit B -- the fix ALREADY present. Under the pre-Fix-1 pipeline
    // (engine.orchestrate run against realProjectDir at its CURRENT HEAD),
    // the worker/escalation worktree would be checked out from this
    // already-fixed state, so a frontier "implementing" the same change
    // again produces NOTHING (an empty diff) -- scored against harnessDir,
    // which is still at the commit's PARENT (bug present, per
    // goldenTaskFromCommit's own setup()) -- a guaranteed oracle failure
    // that has nothing to do with harness quality. This is the exact flaw
    // Task 4 Fix 1 exists to close: it must no longer happen.
    await writeFrontierOnlyHarness(dir);

    engine = createEngine();
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({ baselineCorrect: true, harnessCorrect: true, meter: engine.models.meter }),
    );

    const task = await goldenTaskFromCommit(dir, commitB, ["node", "test.js"]);
    const report = await runEvals(engine, { projectDir: dir, tasks: [task] });

    expect(report.baseline.passed).toBe(1);
    // THE FIX: even though realProjectDir's HEAD already has the fix, the
    // harness is still scored on a genuine fix produced from the task's OWN
    // (pre-fix) base state -- not a structural, guaranteed failure.
    expect(report.harness.passed).toBe(1);
    expect(report.perTask[0]!.harnessOutcome).toBe("escalated");
  });
});

describe("runEvals — measurement failures are not quality evidence (Task 4 Fix 2)", () => {
  it("harness-side infra errors on every task -> verdict 'inconclusive' (never 'fail'); manifest not flipped", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter({
      kind: "claude-code",
      async createSession({ projectDir, resultLabel }): Promise<FrontierSession> {
        if (resultLabel === "frontier-escalate") {
          // Simulates a transient infra failure (e.g. an adapter/session
          // error) on the harness side -- NOT the harness genuinely
          // attempting and failing the task.
          throw new Error("simulated infra failure: escalation session could not be created");
        }
        return {
          id: randomUUID(),
          projectDir,
          prompt(_text: string, _promptOpts?: { timeoutMs?: number }): FrontierPromptHandle {
            async function* gen(): AsyncGenerator<FrontierEvent> {
              writeFileSync(path.join(projectDir, "source.js"), CORRECT_SOURCE);
              yield { type: "tool_use", name: "Write", summary: "wrote source.js" };
              yield { type: "text", text: "done" };
              const event: FrontierEvent = {
                type: "result",
                resultText: "done",
                costUsd: 0.5,
                usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
                numTurns: 1,
                durationMs: 1,
                engineSessionId: null,
              };
              engine.models.meter.record({
                providerId: "claude-code",
                kind: "frontier-claude",
                model: "fake-frontier-model",
                usage: event.usage,
                costUsd: event.costUsd,
                at: Date.now(),
                source: "frontier-review",
                pricingConfidence: "verified",
              });
              yield event;
            }
            return { events: gen(), abort: () => {} };
          },
          async close(): Promise<void> {},
        };
      },
    });

    const tasks: EvalTask[] = [synthEvalTask({ id: "t1" }), synthEvalTask({ id: "t2" })];
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.baseline.passed).toBe(2);
    expect(report.harness.passed).toBe(0);
    // The raw comparison still shows a gap -- that's expected. The FIX is
    // in what verdict that gap is allowed to produce.
    expect(report.qualityHeld).toBe(false);
    expect(report.perTask.every((t) => t.harnessOutcome === "error")).toBe(true);
    expect(report.perTask.every((t) => t.baselineOutcome === "completed")).toBe(true);
    // THE FIX: a measurement failure (the harness never even got to
    // genuinely attempt-and-be-scored) must never be reported as an
    // ETH-hazard "fail".
    expect(report.verdict).toBe("inconclusive");
    expect(report.note).toContain("2 of 2 task(s) hit a measurement failure");
    expect(report.note).toContain("2 error");
    expect(harnessStatus(dir).evals).toBe("pending");
  });
});

describe("runEvals — measurement-failure gate applies symmetrically to pass and fail (review round 2)", () => {
  it("baseline errors inflate the harness's raw pass count over a genuine clean-subset quality gap -> verdict must be 'inconclusive', never 'pass'", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();

    // 5 tasks (t1..t5). Baseline ERRORS on t1/t2 (a measurement failure --
    // the frontier session itself throws, so baselineOutcome is "error" and
    // baselinePassed is false for both, NOT a completed-but-wrong attempt)
    // and PASSES cleanly on its other 3 tasks (t3/t4/t5). Harness PASSES
    // t1/t2 (the two baseline-error tasks) plus ONE clean task (t3), and
    // FAILS the other two clean tasks (t4/t5).
    //
    // Raw counts: baselinePassed = 3 (t3,t4,t5), harnessPassed = 3
    // (t1,t2,t3) -> harnessPassed >= baselinePassed -> qualityHeld = true.
    // Before the symmetric fix, the clean-subset + materiality recheck
    // lived ONLY inside the `!qualityHeld` branch, so this run would sail
    // straight past it into "pass" territory (priced, 5 tasks, savings >
    // 0) -- even though on the CLEAN subset (t3,t4,t5, where neither side
    // measurement-failed) the harness genuinely passed only 1 of 3 against
    // the baseline's 3 of 3: a real ETH-hazard quality gap, papered over as
    // a savings win, on a run that is 40% measurement failures (over the
    // 20% materiality threshold).
    const baselineShouldError = [true, true, false, false, false];
    const harnessShouldBeCorrect = [true, true, true, false, false];
    let baselineCallIndex = 0;
    let harnessCallIndex = 0;

    engine.frontier.registerAdapter({
      kind: "claude-code",
      async createSession({ projectDir, resultLabel }): Promise<FrontierSession> {
        const isBaseline = resultLabel === "eval-baseline";
        let index: number;
        if (isBaseline) {
          index = baselineCallIndex++;
          if (baselineShouldError[index]) {
            throw new Error(`simulated baseline infra failure for task index ${index}`);
          }
        } else {
          index = harnessCallIndex++;
        }
        const correct = isBaseline ? true : harnessShouldBeCorrect[index]!;
        const costUsd = isBaseline ? 0.5 : 0.05;
        return {
          id: randomUUID(),
          projectDir,
          prompt(_text: string, _promptOpts?: { timeoutMs?: number }): FrontierPromptHandle {
            async function* gen(): AsyncGenerator<FrontierEvent> {
              writeFileSync(path.join(projectDir, "source.js"), correct ? CORRECT_SOURCE : WRONG_SOURCE);
              yield { type: "tool_use", name: "Write", summary: "wrote source.js" };
              yield { type: "text", text: "done" };
              const event: FrontierEvent = {
                type: "result",
                resultText: "done",
                costUsd,
                usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
                numTurns: 1,
                durationMs: 1,
                engineSessionId: null,
              };
              engine.models.meter.record({
                providerId: "claude-code",
                kind: "frontier-claude",
                model: "fake-frontier-model",
                usage: event.usage,
                costUsd: event.costUsd,
                at: Date.now(),
                source: isBaseline ? "frontier-review" : "frontier-escalate",
                pricingConfidence: "verified",
              });
              yield event;
            }
            return { events: gen(), abort: () => {} };
          },
          async close(): Promise<void> {},
        };
      },
    });

    const tasks: EvalTask[] = Array.from({ length: 5 }, (_, i) => synthEvalTask({ id: `t${i + 1}` }));
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.baseline.passed).toBe(3);
    expect(report.harness.passed).toBe(3);
    // The raw field stays raw (documented) -- it's the VERDICT that must
    // not trust this direction on a 40%-corrupted run.
    expect(report.qualityHeld).toBe(true);
    expect(report.perTask.filter((t) => t.baselineOutcome === "error")).toHaveLength(2);
    expect(report.savingsPct).not.toBeNull();
    expect(report.savingsPct!).toBeGreaterThan(0);

    // THE FIX: the measurement-failure gate must fire on the PASS side
    // exactly as it already does on the fail side.
    expect(report.verdict).toBe("inconclusive");
    expect(report.note).toContain("2 of 5 task(s) hit a measurement failure");
    expect(harnessStatus(dir).evals).toBe("pending");

    // M7c Task 1: the structured clean-subset fields must match the EXACT
    // numbers the verdict above was computed from (see the "clean subset"
    // block in runEvals) -- not the raw, all-task figures. Clean subset here
    // is t3/t4/t5 (t1/t2 measurement-failed on the baseline side):
    // baseline passes all 3 clean tasks, harness passes only t3 of the 3.
    expect(report.measurementFailureCount).toBe(2);
    expect(report.cleanTaskCount).toBe(3);
    expect(report.cleanBaselinePassed).toBe(3);
    expect(report.cleanHarnessPassed).toBe(1);
    // Clean-subset cost: baseline 0.5 * 3 = 1.5, harness 0.05 * 3 = 0.15 ->
    // (1.5 - 0.15) / 1.5 = 0.9 -- deliberately different from the raw,
    // all-task report.savingsPct (~0.833) asserted above, proving these are
    // genuinely the clean-subset figures and not a copy of the raw ones.
    expect(report.cleanSavingsPct).not.toBeNull();
    expect(report.cleanSavingsPct!).toBeCloseTo(0.9, 5);
    expect(report.cleanSavingsPct).not.toBeCloseTo(report.savingsPct!, 2);
  }, 30_000);
});

describe("runEvals — 0-vs-0 baseline (Task 4 Fix 3)", () => {
  it("baseline solves 0 tasks -> verdict 'inconclusive' even with held quality and positive savings; never 'pass'", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({
        baselineCorrect: false,
        harnessCorrect: false,
        baselineCostUsd: 0.5,
        harnessCostUsd: 0.05,
        meter: engine.models.meter,
      }),
    );

    const tasks: EvalTask[] = Array.from({ length: 5 }, (_, i) => synthEvalTask({ id: `t${i + 1}` }));
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.baseline.passed).toBe(0);
    expect(report.harness.passed).toBe(0);
    // 0 >= 0 holds trivially -- exactly the false-pass shape Fix 3 targets.
    expect(report.qualityHeld).toBe(true);
    expect(report.savingsPct).not.toBeNull();
    expect(report.savingsPct!).toBeGreaterThan(0);
    expect(report.perTask.every((t) => t.baselineOutcome === "completed")).toBe(true);
    // THE FIX: 0 baseline passes means there is nothing to hold quality
    // against -- never a "pass", however good the savings arithmetic looks.
    expect(report.verdict).toBe("inconclusive");
    expect(report.note).toContain("baseline solved 0");
    expect(harnessStatus(dir).evals).toBe("pending");
  }, 30_000);
});

describe("runEvals — unpriced costs", () => {
  it("unpriced baseline/harness costs -> savingsPct null -> inconclusive", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({
        baselineCorrect: true,
        harnessCorrect: true,
        baselineCostUsd: null,
        harnessCostUsd: null,
        meter: engine.models.meter,
      }),
    );

    // 2 tasks (not 5): the sample-size gate ALSO independently forces
    // "inconclusive" at this count (see the dedicated sample-size-gate
    // describe block above) -- this test's own job is only the unpriced ->
    // null-savings arithmetic, not re-isolating it from the sample-size
    // gate, so it stays at the same (cheaper) task count as the other
    // 2-task tests in this file rather than paying for 5 full
    // baseline+harness orchestrate cycles again.
    const tasks: EvalTask[] = [synthEvalTask({ id: "t1" }), synthEvalTask({ id: "t2" })];
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.taskCount).toBe(2);
    expect(report.baseline.costUsd).toBeNull();
    expect(report.harness.costUsd).toBeNull();
    expect(report.savingsPct).toBeNull();
    expect(report.qualityHeld).toBe(true);
    expect(report.verdict).toBe("inconclusive");
    expect(report.pricingConfidence).toBe("unpriced");
    expect(harnessStatus(dir).evals).toBe("pending");
  });
});

describe("runEvals — genuine pass", () => {
  it("enough tasks, priced, quality held, positive savings -> verdict 'pass' and the manifest flips", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({
        baselineCorrect: true,
        harnessCorrect: true,
        baselineCostUsd: 0.5,
        harnessCostUsd: 0.05,
        meter: engine.models.meter,
      }),
    );

    const tasks: EvalTask[] = Array.from({ length: 20 }, (_, i) => synthEvalTask({ id: `t${i + 1}` }));
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.taskCount).toBe(20);
    expect(report.qualityHeld).toBe(true);
    expect(report.savingsPct).toBeCloseTo(0.9, 5);
    expect(report.verdict).toBe("pass");
    expect(harnessStatus(dir).evals).toBe("pass");

    // M7c Task 1: on a run with NO measurement failures, the clean-subset
    // structured fields equal the raw, all-task figures exactly.
    expect(report.measurementFailureCount).toBe(0);
    expect(report.cleanTaskCount).toBe(report.taskCount);
    expect(report.cleanBaselinePassed).toBe(report.baseline.passed);
    expect(report.cleanHarnessPassed).toBe(report.harness.passed);
    expect(report.cleanSavingsPct).toBeCloseTo(report.savingsPct!, 5);
  }, 120_000);
});

describe("runEvals — eval scratch dir placement + cleanup", () => {
  it("creates baseline+harness scratch dirs under os.tmpdir() (never under projectDir) and removes them after scoring", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({ baselineCorrect: true, harnessCorrect: true, meter: engine.models.meter }),
    );

    const capturedDirs: string[] = [];
    const base = synthEvalTask({ id: "t1" });
    const spiedTask: EvalTask = {
      ...base,
      setup: async (d: string) => {
        capturedDirs.push(d);
        await base.setup(d);
      },
    };

    await runEvals(engine, { projectDir: dir, tasks: [spiedTask] });

    // One baseline dir + one harness dir for the single task.
    expect(capturedDirs).toHaveLength(2);
    const projectRoot = path.resolve(dir);
    for (const d of capturedDirs) {
      expect(path.isAbsolute(d)).toBe(true);
      expect(d.startsWith(os.tmpdir())).toBe(true);
      expect(d.startsWith(projectRoot)).toBe(false);
      // Cleanup already ran by the time runEvals resolved -- both scratch
      // dirs are transient eval machinery, always auto-removed.
      expect(existsSync(d)).toBe(false);
    }
  });
});

// M7b Task 2: mid-batch cancellation. Unlike makeFakeEvalsFrontierAdapter's
// own blockReviewUntilClose-style fixtures elsewhere in this codebase (whose
// prompt handle's abort() is a no-op — only close() ever unblocked them,
// which was fine for the M6 close()-only mechanism), engine.cancel's new
// per-run signal reaches a session via `handle.abort()`, NOT `session.close()`
// — so THIS fixture wires abort() to actually unblock its blocked generator.
//
// Distinguishes baseline vs. harness-escalation calls via resultLabel
// (mirrors makeFakeEvalsFrontierAdapter above), and counts ESCALATE calls
// (1-based) so a specific one — the second, i.e. the SECOND task's harness
// side — can be scripted to block until aborted. The FIRST escalate call
// (task 1) and every baseline call complete immediately and normally.
interface CancelEvalsFrontierOptions {
  blockOnEscalateCallIndex: number;
  blockReached: { count: number };
}

function makeCancelEvalsFrontierAdapter(opts: CancelEvalsFrontierOptions): FrontierAdapter {
  let escalateCallIndex = 0;
  return {
    kind: "claude-code",
    async createSession({ projectDir, resultLabel }): Promise<FrontierSession> {
      const isEscalate = resultLabel === "frontier-escalate";
      let thisEscalateIndex = 0;
      if (isEscalate) {
        escalateCallIndex += 1;
        thisEscalateIndex = escalateCallIndex;
      }
      const shouldBlock = isEscalate && thisEscalateIndex === opts.blockOnEscalateCallIndex;

      let resolveUnblock: () => void = () => {};
      const unblock = new Promise<void>((resolve) => {
        resolveUnblock = resolve;
      });

      return {
        id: randomUUID(),
        projectDir,
        prompt(_text: string, _promptOpts?: { timeoutMs?: number }): FrontierPromptHandle {
          if (shouldBlock) {
            opts.blockReached.count += 1;
            async function* gen(): AsyncGenerator<FrontierEvent> {
              await unblock;
              // Ends without ever yielding a result event -- mirrors a
              // wedged turn that never got to finish; cancellation, not
              // the turn itself, ended it.
            }
            // The load-bearing difference from every OTHER fake adapter's
            // no-op abort() in this test suite: abort() is what a
            // cancellation actually calls (via orchestrate.ts's
            // runFrontierTurn abort-threading), so it must be wired to
            // really unblock the generator above.
            return { events: gen(), abort: () => resolveUnblock() };
          }
          async function* gen(): AsyncGenerator<FrontierEvent> {
            yield { type: "text", text: "done" };
            yield {
              type: "result",
              resultText: "done",
              costUsd: 0.01,
              usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
              numTurns: 1,
              durationMs: 1,
              engineSessionId: null,
            };
          }
          return { events: gen(), abort: () => {} };
        },
        async close(): Promise<void> {},
      };
    },
  };
}

describe("runEvals — mid-batch cancel (M7b Task 2)", () => {
  it("cancels between/within tasks: in-flight scratch dirs are removed, remaining tasks never even start, and the registry empties", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();
    const blockReached = { count: 0 };
    engine.frontier.registerAdapter(
      makeCancelEvalsFrontierAdapter({ blockOnEscalateCallIndex: 2, blockReached }),
    );

    const capturedDirs: string[] = [];
    const capturedTaskIds: string[] = [];
    const tasks: EvalTask[] = ["t1", "t2", "t3"].map((id) => {
      const base = synthEvalTask({ id, sourceFile: `source-${id}.js`, testFile: `test-${id}.js` });
      return {
        ...base,
        setup: async (d: string) => {
          capturedDirs.push(d);
          capturedTaskIds.push(id);
          await base.setup(d);
        },
      };
    });

    // runEvals() is the engine-internal API (see this file's own
    // WIRE-SAFETY comment on EvalTask.setup) -- it only ever get()s a
    // runId's controller, never register()s/deregister()s it (that is
    // engine.evals.run's own RPC handler's job, methods.ts). This test
    // calls runEvals directly (required so its EvalTask fixtures, with real
    // setup() closures, never have to cross a wire) but must therefore
    // stand in for that handler's own register/finally-deregister wrapping
    // itself, so the registry-no-leak property is genuinely exercised.
    const runId = "eval-batch-1";
    engine.cancelRegistry.register(runId);
    let caught: unknown;
    try {
      const runPromise = runEvals(engine, { projectDir: dir, tasks, runId });

      const deadline = Date.now() + 10_000;
      while (blockReached.count < 1) {
        if (Date.now() > deadline) throw new Error("harness escalation call never started blocking");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const cancelRes = await call(engine, "engine.cancel", { runId });
      expect(cancelRes.error).toBeUndefined();
      expect(cancelRes.result.cancelled).toBe(true);

      try {
        await runPromise;
      } catch (err) {
        caught = err;
      }
    } finally {
      engine.cancelRegistry.deregister(runId);
    }

    expect(caught).toBeInstanceOf(RpcMethodError);
    const err = caught as RpcMethodError;
    expect(err.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect((err.data as { cancelled?: boolean }).cancelled).toBe(true);

    // Task 1 (baseline + harness, both completed normally) and task 2
    // (baseline completed normally; harness escalation was in flight when
    // cancelled) each contributed one baseline dir + one harness dir --
    // task 3 never even started: its own scratch dirs were never created,
    // so task.setup was never called for it, so its id was never captured
    // (checked directly below, not just inferred from a total count).
    expect(capturedDirs).toHaveLength(4);
    expect(capturedTaskIds).toEqual(["t1", "t1", "t2", "t2"]);
    for (const d of capturedDirs) {
      expect(existsSync(d)).toBe(false);
    }

    // No leak: this registry entry is gone once the (manually wrapped)
    // register/deregister scope above has closed.
    expect(engine.cancelRegistry.size()).toBe(0);
  }, 15_000);
});

describe("runEvals — evals.progress notifications", () => {
  it("emits start, {baseline,harness,scored} per task (with taskId), then done", async () => {
    dir = await makeHarnessFixture();
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({ baselineCorrect: true, harnessCorrect: true, meter: engine.models.meter }),
    );

    await runEvals(engine, {
      projectDir: dir,
      tasks: [synthEvalTask({ id: "t1" }), synthEvalTask({ id: "t2" })],
    });

    const events = notifications
      .filter((n) => n.method === "evals.progress")
      .map((n) => n.params as { stage: string; taskId?: string });

    expect(events.map((e) => e.stage)).toEqual([
      "start",
      "baseline",
      "harness",
      "scored",
      "baseline",
      "harness",
      "scored",
      "done",
    ]);
    expect(events[0]!.taskId).toBeUndefined();
    expect(events[1]!.taskId).toBe("t1");
    expect(events[2]!.taskId).toBe("t1");
    expect(events[3]!.taskId).toBe("t1");
    expect(events[4]!.taskId).toBe("t2");
    expect(events[7]!.taskId).toBeUndefined();
  });

  // M7c Task 5: orchestrate.progress/evals.progress notifications previously
  // carried no runId at all -- a client with more than one run in flight (of
  // the same kind) had no reliable way to filter progress to just ITS run
  // (the desktop engineClient helper had to fall back to a "filter by method
  // name only, assume single-run-at-a-time" posture -- see that module's own
  // doc comment). Every stage's notification must now carry the SAME runId
  // the caller supplied, end to end.
  it("carries the run's runId on every notification when one was supplied to runEvals", async () => {
    dir = await makeHarnessFixture();
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({ baselineCorrect: true, harnessCorrect: true, meter: engine.models.meter }),
    );

    await runEvals(engine, {
      projectDir: dir,
      tasks: [synthEvalTask({ id: "t1" })],
      runId: "eval-progress-1",
    });

    const events = notifications
      .filter((n) => n.method === "evals.progress")
      .map((n) => n.params as { stage: string; taskId?: string; runId?: string });

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.runId).toBe("eval-progress-1");
    }
  });

  it("omits runId entirely when none was supplied (backward compatible shape)", async () => {
    dir = await makeHarnessFixture();
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({ baselineCorrect: true, harnessCorrect: true, meter: engine.models.meter }),
    );

    await runEvals(engine, { projectDir: dir, tasks: [synthEvalTask({ id: "t1" })] });

    const events = notifications
      .filter((n) => n.method === "evals.progress")
      .map((n) => n.params as Record<string, unknown>);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect("runId" in e).toBe(false);
    }
  });
});

describe("runEvals — guard failures", () => {
  it("no harness -> throws SERVER_ERROR", async () => {
    dir = makeRepo();
    engine = createEngine();

    await expect(runEvals(engine, { projectDir: dir, tasks: [synthEvalTask()] })).rejects.toMatchObject({
      code: RpcErrorCodes.SERVER_ERROR,
    });
  });

  it("non-git projectDir -> throws SERVER_ERROR", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-evals-nogit-"));
    engine = createEngine();

    await expect(runEvals(engine, { projectDir: dir, tasks: [synthEvalTask()] })).rejects.toMatchObject({
      code: RpcErrorCodes.SERVER_ERROR,
    });
  });

  it("an empty tasks array -> throws SERVER_ERROR", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();

    await expect(runEvals(engine, { projectDir: dir, tasks: [] })).rejects.toMatchObject({
      code: RpcErrorCodes.SERVER_ERROR,
    });
  });
});

// Exercises the ACTUAL engine.evals.run RPC method (not runEvals() directly)
// end-to-end: JSON-safe golden-commit descriptors in, reconstructed via
// goldenTaskFromCommit server-side, scored exactly like every other test in
// this file. Proves the wire-layer adapter (methods.ts) is wired correctly,
// distinct from the bulk of the business-logic coverage above.
describe("engine.evals.run (RPC wire layer) — golden task descriptors", () => {
  it("reconstructs a golden task from a commitSha descriptor and runs the report card end-to-end", async () => {
    dir = makeRepo();
    // Commit A: a buggy add() with its own (currently failing) pre-existing
    // test.
    writeFileSync(
      path.join(dir, "source.js"),
      ["function add(a, b) {", "  return a - b; // bug: should be a + b", "}", "", "module.exports = { add };", ""].join(
        "\n",
      ),
    );
    writeFileSync(
      path.join(dir, "test.js"),
      [
        "const assert = require('node:assert');",
        "const { add } = require('./source');",
        "assert.strictEqual(add(2, 3), 5);",
        "console.log('ok');",
        "",
      ].join("\n"),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "A: add buggy add() with its test");

    // Commit B: the real fix.
    writeFileSync(
      path.join(dir, "source.js"),
      ["function add(a, b) {", "  return a + b;", "}", "", "module.exports = { add };", ""].join("\n"),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "B: fix add() to return the correct sum");
    const commitB = git(dir, "rev-parse", "HEAD");

    // Deliberately NOT reset back to commit A: the real project's HEAD is
    // left at commit B, the fix ALREADY present -- exactly the shape that
    // used to break this pipeline (Task 4 Fix 1's base-identity bug; see
    // this suite's dedicated "base identity" describe block above, and
    // run.ts's header comment). Post-fix, engine.orchestrate works this
    // task against its OWN base-state scratch directory regardless of what
    // state the real project's HEAD happens to be at.
    await writeFrontierOnlyHarness(dir);

    engine = createEngine();
    engine.frontier.registerAdapter(
      makeFakeEvalsFrontierAdapter({ baselineCorrect: true, harnessCorrect: true, meter: engine.models.meter }),
    );

    const res = await call(engine, "engine.evals.run", {
      projectDir: dir,
      tasks: [{ commitSha: commitB, testCommand: ["node", "test.js"] }],
    });

    expect(res.error).toBeUndefined();
    const report = res.result;
    expect(report.taskCount).toBe(1);
    expect(report.baseline.passed).toBe(1);
    expect(report.harness.passed).toBe(1);
    expect(report.perTask[0]!.harnessOutcome).toBe("escalated");
    // 1 task never clears the sample-size gate, regardless of quality.
    expect(report.verdict).toBe("inconclusive");
    expect(harnessStatus(dir).evals).toBe("pending");
  });

  it("rejects an empty tasks array at the schema level", async () => {
    dir = await makeHarnessFixture();
    engine = createEngine();

    const res = await call(engine, "engine.evals.run", { projectDir: dir, tasks: [] });
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.INVALID_PARAMS);
  });
});

// M7c Task 5 (FIX BATCH T2.1 -- the coverage gap the M7b/M7c reviews named):
// every OTHER cancellation test in this file (the "mid-batch cancel" describe
// block above) drives runEvals() directly and hand-simulates the
// register()/deregister() wrapping that is actually evals/methods.ts's OWN
// RPC handler's job -- see that describe block's own comment, which documents
// this exact gap ("this test... must therefore stand in for that handler's
// own register/finally-deregister wrapping itself"). This describe block
// instead drives the ACTUAL `engine.evals.run` RPC method end-to-end through
// the real dispatcher (dispatcher.dispatch -> evals/methods.ts's registered
// handler -> its own register() -> runEvals() -> its own deregister() in
// `finally`), mirroring orchestrate.test.ts's "cancellation via engine.cancel"
// describe block for engine.orchestrate. A single golden-commit task
// (commitSha + testCommand -- the only JSON-safe task shape this RPC method
// accepts; see methods.ts's own WIRE-SAFETY header comment) is enough: its
// harness-side escalation call is where makeCancelEvalsFrontierAdapter blocks
// until engine.cancel aborts it.
describe("engine.evals.run (RPC wire layer) — cancellation via engine.cancel (M7c Task 5)", () => {
  it("cancels an in-flight run driven through evals/methods.ts's own handler: registers via the real handler, aborts promptly, reports the cancelled marker, and leaves the registry empty", async () => {
    dir = makeRepo();
    writeFileSync(
      path.join(dir, "source.js"),
      ["function add(a, b) {", "  return a - b; // bug: should be a + b", "}", "", "module.exports = { add };", ""].join(
        "\n",
      ),
    );
    writeFileSync(
      path.join(dir, "test.js"),
      [
        "const assert = require('node:assert');",
        "const { add } = require('./source');",
        "assert.strictEqual(add(2, 3), 5);",
        "console.log('ok');",
        "",
      ].join("\n"),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "A: add buggy add() with its test");

    writeFileSync(
      path.join(dir, "source.js"),
      ["function add(a, b) {", "  return a + b;", "}", "", "module.exports = { add };", ""].join("\n"),
    );
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "B: fix add() to return the correct sum");
    const commitB = git(dir, "rev-parse", "HEAD");

    await writeFrontierOnlyHarness(dir);

    engine = createEngine();
    const blockReached = { count: 0 };
    // Only one task -> its own (only) harness escalation call is call #1.
    engine.frontier.registerAdapter(makeCancelEvalsFrontierAdapter({ blockOnEscalateCallIndex: 1, blockReached }));

    const runId = "evals-rpc-cancel-1";
    const runPromise = call(engine, "engine.evals.run", {
      projectDir: dir,
      tasks: [{ commitSha: commitB, testCommand: ["node", "test.js"] }],
      runId,
    });

    const deadline = Date.now() + 10_000;
    while (blockReached.count < 1) {
      if (Date.now() > deadline) throw new Error("harness escalation call never started blocking");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Registered by engine.evals.run's OWN handler (methods.ts) -- not by
    // this test -- which is exactly the wiring the gap this test closes
    // cares about.
    expect(engine.cancelRegistry.get(runId)).toBeDefined();

    const cancelRes = await call(engine, "engine.cancel", { runId });
    expect(cancelRes.error).toBeUndefined();
    expect(cancelRes.result.cancelled).toBe(true);

    const res = await runPromise;
    expect(res.result).toBeUndefined();
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error.data.cancelled).toBe(true);

    // No leak: evals/methods.ts's own `finally` deregistered this runId once
    // the RPC call settled.
    expect(engine.cancelRegistry.size()).toBe(0);
  }, 15_000);
});
