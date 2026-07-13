import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type VerificationRunner } from "../src/engine.js";
import type { FrontierAdapter, FrontierEvent, FrontierPromptHandle, FrontierSession } from "../src/engines/types.js";
import { clonePath, harnessBundlePath } from "../src/evals/bench/paths.js";
import { runBench } from "../src/evals/bench/runner.js";
import type { AgentDef, HarnessBundle, Routing, WikiPage } from "../src/harness/schema.js";
import { writeHarness } from "../src/harness/store.js";
import type { CostMeter } from "../src/models/meter.js";
import { runtimeCapabilities } from "../src/runtime/capabilities.js";

let dirs: string[] = [];
let engine: Engine | undefined;

const TEST_VERIFICATION_RUNNER: VerificationRunner = {
  async status() {
    return { available: true };
  },
  async run() {
    return { exitCode: 0 };
  },
};

afterEach(async () => {
  if (engine !== undefined) await engine.close();
  engine = undefined;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeFixtureClone(benchRoot: string, repo: string): { clone: string; baseCommit: string } {
  const clone = clonePath(benchRoot, repo);
  mkdirSync(path.dirname(clone), { recursive: true });
  execFileSync("git", ["init", "-q", clone]);
  git(clone, "config", "user.email", "bench@test");
  git(clone, "config", "user.name", "bench");
  writeFileSync(path.join(clone, "README.md"), "fixture\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "base");
  return { clone, baseCommit: git(clone, "rev-parse", "HEAD") };
}

function writeDataset(benchRoot: string, repo: string, baseCommit: string): string {
  const file = path.join(benchRoot, "mini.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        dataset: "test/mini",
        version: 1,
        instances: [
          {
            instance_id: "owner__repo-1",
            repo,
            base_commit: baseCommit,
            problem_statement: "Create solution.txt with the fix.",
            patch: "SECRET_GOLD_PATCH",
            test_patch: "SECRET_TEST_PATCH",
            hints_text: "SECRET_HINTS",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

const PAGE: WikiPage = {
  slug: "architecture",
  title: "Architecture",
  digest: "Fixture benchmark harness.",
  body: "# Architecture\n\nFixture content.\n",
};

function frontierOnlyHarness(headSha: string): HarnessBundle {
  const agent: AgentDef = {
    name: "frontier-agent",
    role: "worker",
    description: "Frontier-only bench fixture agent.",
    prompt: "Patch the checkout directly.",
    taskClasses: ["codegen"],
    model: "frontier",
    escalation: { maxAttempts: 2 },
  };
  const routing: Routing = {
    version: 1,
    taskClasses: { codegen: { agent: agent.name } },
    escalation: { failuresBeforeFrontier: 2 },
    defaults: { agent: agent.name },
  };
  return {
    manifest: {
      schemaVersion: 1,
      generatorVersion: "0.0.1-test",
      engine: "claude-code",
      headSha,
      generatedAt: new Date().toISOString(),
      verification: { structural: "pass", evals: "pending" },
      artifacts: [],
    },
    pages: [PAGE],
    agents: [agent],
    routing,
  };
}

function makeFakeBenchFrontierAdapter(meter: CostMeter): FrontierAdapter {
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
    async createSession({ projectDir, resultLabel }): Promise<FrontierSession> {
      return {
        id: randomUUID(),
        projectDir,
        prompt(_text: string, _opts?: { timeoutMs?: number }): FrontierPromptHandle {
          async function* events(): AsyncGenerator<FrontierEvent> {
            const isBaseline = resultLabel === "eval-baseline";
            const isReview = resultLabel === "frontier-review";
            const content = isBaseline ? "baseline patch\n" : "harness patch\n";
            const costUsd = isReview ? 0 : isBaseline ? 1 : 0.25;
            if (isReview) {
              yield {
                type: "text",
                text: "```json\n" + JSON.stringify({ decision: "approve", reasons: [], severity: "none" }) + "\n```",
              };
            } else {
              writeFileSync(path.join(projectDir, "solution.txt"), content);
              yield { type: "tool_use", name: "Write", summary: "wrote solution.txt" };
            }
            const result: FrontierEvent = {
              type: "result",
              resultText: isReview ? "approve" : "done",
              costUsd,
              usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0 },
              numTurns: 1,
              durationMs: 1,
              engineSessionId: null,
            };
            meter.record({
              providerId: "claude-code",
              kind: "frontier-claude",
              model: "fake-bench-frontier",
              usage: result.usage,
              costUsd,
              at: Date.now(),
              source: isBaseline ? "frontier-review" : "frontier-escalate",
              pricingConfidence: "provider-reported",
            });
            yield result;
          }
          return { events: events(), abort: () => {} };
        },
        async close(): Promise<void> {},
      };
    },
  };
}

describe("runBench", () => {
  it("runs a paired local fixture and writes JSON predictions", async () => {
    const benchRoot = mkdtempSync(path.join(os.tmpdir(), "of-bench-run-"));
    dirs.push(benchRoot);
    const repo = "owner/repo";
    const { clone, baseCommit } = makeFixtureClone(benchRoot, repo);
    expect(existsSync(path.join(clone, ".git"))).toBe(true);
    const datasetPath = writeDataset(benchRoot, repo, baseCommit);

    const hPath = harnessBundlePath(benchRoot, repo);
    await writeHarness(hPath, frontierOnlyHarness(baseCommit));

    engine = createEngine({ verificationRunner: TEST_VERIFICATION_RUNNER });
    engine.frontier.registerAdapter(makeFakeBenchFrontierAdapter(engine.models.meter));

    const result = await runBench(engine, {
      benchRoot,
      datasetPath,
      runId: "dry-run",
      log: () => {},
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.baselineOutcome).toBe("completed");
    expect(result.rows[0]!.harnessOutcome).toBe("escalated");
    expect(result.rows[0]!.baselinePatch).toContain("solution.txt");
    expect(result.rows[0]!.harnessPatch).toContain("solution.txt");
    expect(result.rows[0]!.baselinePatch).not.toContain("SECRET_");
    expect(result.rows[0]!.harnessPatch).not.toContain(".openfusion");
    expect(result.unpricedCalls).toBe(0);
    expect(result.pricingConfidence).toBe("provider-reported");

    const baselinePreds = JSON.parse(readFileSync(result.predictionsBaselinePath, "utf8")) as Record<string, unknown>;
    const harnessPreds = JSON.parse(readFileSync(result.predictionsHarnessPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(baselinePreds)).toEqual(["owner__repo-1"]);
    expect(Object.keys(harnessPreds)).toEqual(["owner__repo-1"]);
  });
});
