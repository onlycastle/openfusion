import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import type { AgentDef, HarnessBundle, Routing } from "../src/harness/schema.js";
import { writeHarness } from "../src/harness/store.js";
import { goldenTaskFromCommit } from "../src/evals/tasks.js";
import { runEvals } from "../src/evals/run.js";

// Real end-to-end smoke test for engine.evals.run — the M6 EXIT CRITERION.
// Exercises a REAL golden task mined from an actual commit (a fail-to-pass
// fix with a pre-existing test — see evals/tasks.ts's own goldenTaskFromCommit
// doc comment for the exact v1 constraint), a REAL open-model worker provider
// (no mock LanguageModel), and REAL frontier sessions through the DEFAULT
// Claude adapter for BOTH roles this pipeline drives (the baseline's direct
// frontier turn AND the harness's own review/escalate turns) — so this
// spawns the actual `claude` CLI, same as orchestrate-smoke.test.ts /
// harness-generate-smoke.test.ts.
//
// COMMIT SELECTION (deliberately operator-supplied, not auto-mined): the
// research this task is built on
// (docs/research/2026-07-04-m6-pricing-eval-verification.md, "Golden tasks
// from commits") lists real gotchas with picking a commit programmatically —
// flaky tests, multi-file diffs, docs-only/test-only commits, narrow
// assertions that reject a correct-but-different solution. Auto-selecting
// "a recent commit" without a human confirming it satisfies
// goldenTaskFromCommit's fail-to-pass precondition (the commit's own test(s)
// must ALREADY exist and FAIL at the parent) risks a smoke test that
// silently measures nothing, or throws on a bad pick — and this test is
// never executed by the agent that wrote it, so there is no way to validate
// an auto-picked commit ahead of time either. The operator names a real
// commit (from this repo, by default) that satisfies the constraint; this
// test's own job is only to wire it through engine.evals.run end-to-end,
// with a real worker and real frontier.
//
// Gated behind its own env var so CI (no live provider key, no Claude
// CLI/auth) always skips it — authored and typechecked but intentionally
// never executed by the agent implementing this task; only an operator with
// a configured worker provider key AND a configured `claude` CLI can run it
// locally:
//
//   OPENFUSION_EVALS_SMOKE=1 \
//   OPENFUSION_EVALS_SMOKE_COMMIT=<sha> \                  # REQUIRED -- a real fail-to-pass fix commit
//   OPENFUSION_EVALS_SMOKE_TEST_COMMAND="node test.js" \   # REQUIRED -- argv form, space-split below
//   OPENFUSION_EVALS_SMOKE_API_KEY=sk-... \
//   [OPENFUSION_EVALS_SMOKE_REPO=/path/to/repo] \          # defaults to this monorepo's root
//   [OPENFUSION_EVALS_SMOKE_KIND=deepseek] \
//   [OPENFUSION_EVALS_SMOKE_MODEL=deepseek-chat] \
//   [OPENFUSION_EVALS_SMOKE_BASE_URL=...] \
//   pnpm --filter @openfusion/engine test -- evals-run-smoke
const SMOKE_KIND = (process.env.OPENFUSION_EVALS_SMOKE_KIND ?? "deepseek") as
  | "moonshot"
  | "zai"
  | "deepseek"
  | "openai-compatible";
const SMOKE_MODEL = process.env.OPENFUSION_EVALS_SMOKE_MODEL ?? "deepseek-chat";
const SMOKE_API_KEY = process.env.OPENFUSION_EVALS_SMOKE_API_KEY ?? "";
const SMOKE_BASE_URL = process.env.OPENFUSION_EVALS_SMOKE_BASE_URL;
const SMOKE_COMMIT = process.env.OPENFUSION_EVALS_SMOKE_COMMIT;
const SMOKE_TEST_COMMAND = process.env.OPENFUSION_EVALS_SMOKE_TEST_COMMAND;
const SMOKE_REPO = process.env.OPENFUSION_EVALS_SMOKE_REPO;

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`could not find a .git directory above ${startDir}`);
    }
    dir = parent;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

// A minimal, structurally-valid harness with one agent pinned to the smoke
// worker provider — written straight to disk (same mechanism
// engine.harness.generate itself uses, harness/store.ts's writeHarness) so
// engine.orchestrate's own loadHarness call (inside engine.evals.run's
// harness-side scoring) reads it back exactly as it would a real generation
// output. Mirrors orchestrate-smoke.test.ts's own writeTrivialHarness.
async function writeTrivialHarness(projectDir: string): Promise<void> {
  const headSha = git(projectDir, "rev-parse", "HEAD");
  const agent: AgentDef = {
    name: "smoke-worker",
    role: "worker",
    description: "Trivial codegen worker for the evals-run smoke test.",
    prompt: "You are a codegen specialist. Make the exact change requested, nothing more.",
    taskClasses: ["codegen"],
    model: { kind: SMOKE_KIND, model: SMOKE_MODEL, providerId: "smoke" },
    escalation: { maxAttempts: 2 },
  };
  const routing: Routing = {
    version: 1,
    taskClasses: { codegen: { agent: "smoke-worker" } },
    escalation: { failuresBeforeFrontier: 1 },
    defaults: { agent: "smoke-worker" },
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
    pages: [],
    agents: [agent],
    routing,
  };
  await writeHarness(projectDir, bundle);
}

describe("engine.evals.run (real smoke)", () => {
  it.skipIf(!process.env.OPENFUSION_EVALS_SMOKE)(
    "scores a real golden task end-to-end: real worker + real frontier baseline + real frontier harness escalation",
    async () => {
      if (SMOKE_COMMIT === undefined || SMOKE_TEST_COMMAND === undefined) {
        throw new Error(
          "OPENFUSION_EVALS_SMOKE requires OPENFUSION_EVALS_SMOKE_COMMIT and " +
            "OPENFUSION_EVALS_SMOKE_TEST_COMMAND -- a real fail-to-pass fix commit + its test command. See this " +
            "file's header comment for why these are operator-supplied rather than auto-mined.",
        );
      }
      const testCommand = SMOKE_TEST_COMMAND.split(" ").filter((s) => s.length > 0);

      // Full clone (not --depth 1, unlike orchestrate-smoke's) --
      // goldenTaskFromCommit needs the target commit's PARENT tree, and
      // this clone doubles as BOTH the mining source (it shares every commit
      // object with the repo it was cloned from) and the "real project"
      // engine.evals.run evaluates, so its own history must reach
      // SMOKE_COMMIT's parent.
      const repoRoot = SMOKE_REPO ?? findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
      const dir = mkdtempSync(path.join(os.tmpdir(), "of-evals-smoke-"));
      let engine: Engine | undefined;
      try {
        execFileSync("git", ["clone", repoRoot, dir], { stdio: "ignore" });
        // The REAL project's HEAD is checked out at the commit's PARENT --
        // matching the golden task's own pre-change state -- so
        // engine.orchestrate's worktree (checked out from THIS HEAD) starts
        // from the same content the eval scratch dirs will also start from.
        // See run.ts's header comment on why that identity is what lets the
        // produced diff apply cleanly onto the harness eval dir.
        git(dir, "checkout", "-q", `${SMOKE_COMMIT}^`);

        await writeTrivialHarness(dir);

        engine = createEngine();
        engine.models.registry.configure({
          id: "smoke",
          kind: SMOKE_KIND,
          apiKey: SMOKE_API_KEY,
          ...(SMOKE_BASE_URL !== undefined ? { baseURL: SMOKE_BASE_URL } : {}),
        });
        // No frontier adapter override: registerFrontierMethods' default
        // createClaudeAdapter() drives BOTH the baseline's own direct-
        // frontier turn (run.ts's runBaselineTask) and the harness side's
        // review/escalate turns (orchestrate.ts) for real.

        const task = await goldenTaskFromCommit(dir, SMOKE_COMMIT, testCommand);
        const report = await runEvals(engine, { projectDir: dir, tasks: [task] });

        expect(report.taskCount).toBe(1);
        // A real worker/frontier pair may legitimately land on either
        // pass/fail per side -- this smoke test's contract is "the full
        // pipeline runs end-to-end and produces a well-formed report card",
        // not a specific verdict from a live model.
        expect(["pass", "fail", "inconclusive"]).toContain(report.verdict);
        expect(report.perTask).toHaveLength(1);
        expect(report.perTask[0]!.id).toBe(task.id);
        expect(typeof report.note).toBe("string");
        expect(report.note.length).toBeGreaterThan(0);
      } finally {
        if (engine !== undefined) await engine.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    900_000,
  );
});
