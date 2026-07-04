import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { createEngine, type Engine } from "../src/engine.js";
import type { FrontierAdapter, FrontierEvent, FrontierPromptHandle, FrontierSession } from "../src/engines/types.js";
import type { AgentDef, HarnessBundle, Routing, WikiPage } from "../src/harness/schema.js";
import { harnessStatus, writeHarness } from "../src/harness/store.js";
import type { CostMeter } from "../src/models/meter.js";
import { goldenTaskFromCommit, synthEvalTask, type EvalTask } from "../src/evals/tasks.js";
import { runEvals } from "../src/evals/run.js";

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

    const tasks: EvalTask[] = Array.from({ length: 5 }, (_, i) => synthEvalTask({ id: `t${i + 1}` }));
    const report = await runEvals(engine, { projectDir: dir, tasks });

    expect(report.taskCount).toBe(5);
    expect(report.qualityHeld).toBe(true);
    expect(report.savingsPct).toBeCloseTo(0.9, 5);
    expect(report.verdict).toBe("pass");
    expect(harnessStatus(dir).evals).toBe("pass");
  }, 30_000);
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
