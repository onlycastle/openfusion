import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import type { AgentDef, HarnessBundle, Routing } from "../src/harness/schema.js";
import { writeHarness } from "../src/harness/store.js";

// Real end-to-end smoke test for engine.orchestrate — the M5 EXIT
// CRITERION: real routing (off a handcrafted-but-structurally-valid
// harness, see writeTrivialHarness below — full engine.harness.generate is
// its own smoke test, harness-generate-smoke.test.ts; this test's scope is
// routing+worker+review+escalate, not generation), a REAL open-model worker
// provider (no injected/mock LanguageModel), and REAL frontier review
// through the DEFAULT Claude adapter (registerFrontierMethods'
// createClaudeAdapter, no override) — so this spawns the actual `claude`
// CLI for the review turn(s), exactly like
// harness-generate-smoke.test.ts/frontier-claude-smoke.test.ts do. Needs the
// CLI installed and authenticated however the operator set that up — this
// test never touches credentials itself (see claude.ts's AUTH-AGNOSTIC
// design note).
//
// Gated behind its OWN env var (OPENFUSION_ORCHESTRATE_SMOKE, per the task
// brief) so CI (no live provider key, no Claude CLI/auth) always skips it —
// `it.skipIf` means the body below never runs when the env var is unset, so
// this file adds zero cost to a normal `pnpm test`. Authored and
// typechecked but intentionally never executed by the agent implementing
// this task — only an operator with both a configured worker provider key
// AND a configured `claude` CLI can run it locally:
//
//   OPENFUSION_ORCHESTRATE_SMOKE=1 \
//   OPENFUSION_ORCHESTRATE_SMOKE_API_KEY=sk-... \
//   [OPENFUSION_ORCHESTRATE_SMOKE_KIND=deepseek] \
//   [OPENFUSION_ORCHESTRATE_SMOKE_MODEL=deepseek-chat] \
//   [OPENFUSION_ORCHESTRATE_SMOKE_BASE_URL=...] \
//   pnpm --filter @openfusion/engine test -- orchestrate-smoke
const SMOKE_KIND = (process.env.OPENFUSION_ORCHESTRATE_SMOKE_KIND ?? "deepseek") as
  | "moonshot"
  | "zai"
  | "deepseek"
  | "openai-compatible";
const SMOKE_MODEL = process.env.OPENFUSION_ORCHESTRATE_SMOKE_MODEL ?? "deepseek-chat";
const SMOKE_API_KEY = process.env.OPENFUSION_ORCHESTRATE_SMOKE_API_KEY ?? "";
const SMOKE_BASE_URL = process.env.OPENFUSION_ORCHESTRATE_SMOKE_BASE_URL;

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

async function rpc(engine: Engine, method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

// A minimal, structurally-valid harness with one agent pinned to the smoke
// worker provider — written straight to disk (same mechanism
// engine.harness.generate itself uses, harness/store.ts's writeHarness) so
// engine.orchestrate's own loadHarness call reads it back exactly as it
// would a real generation output.
async function writeTrivialHarness(projectDir: string): Promise<void> {
  const headSha = git(projectDir, "rev-parse", "HEAD");
  const agent: AgentDef = {
    name: "smoke-worker",
    role: "worker",
    description: "Trivial codegen worker for the orchestrate smoke test.",
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

describe("engine.orchestrate (real smoke)", () => {
  it.skipIf(!process.env.OPENFUSION_ORCHESTRATE_SMOKE)(
    "routes, runs a real open-model worker, and reviews with a real frontier session end-to-end",
    async () => {
      // Clones this repo's committed HEAD (not the live working tree) into a
      // throwaway checkout — mirrors harness-generate-smoke.test.ts /
      // frontier-claude-smoke.test.ts so this run's own uncommitted state
      // never leaks into what the worker/frontier see.
      const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
      const dir = mkdtempSync(path.join(os.tmpdir(), "of-orchestrate-smoke-"));
      let engine: Engine | undefined;
      try {
        execFileSync("git", ["clone", "--depth", "1", repoRoot, dir], { stdio: "ignore" });
        await writeTrivialHarness(dir);

        engine = createEngine();
        engine.models.registry.configure({
          id: "smoke",
          kind: SMOKE_KIND,
          apiKey: SMOKE_API_KEY,
          ...(SMOKE_BASE_URL !== undefined ? { baseURL: SMOKE_BASE_URL } : {}),
        });

        const res = await rpc(engine, "engine.orchestrate", {
          projectDir: dir,
          task: "create a file named orchestrate-smoke.txt containing the single word HELLO",
          maxWorkerAttempts: 2,
        });

        expect(res.error).toBeUndefined();
        // A real worker/frontier pair may legitimately land on either
        // outcome (the review could request changes twice, escalating) —
        // this smoke test's contract is "the pipeline completes and
        // produces a landable diff", not a specific verdict from a live
        // model.
        expect(["worker-approved", "escalated"]).toContain(res.result.outcome);
        expect(res.result.diff).toContain("orchestrate-smoke.txt");
        expect(res.result.worktree).not.toBeNull();

        const applyRes = await rpc(engine, "engine.orchestrate.apply", {
          projectDir: dir,
          diff: res.result.diff,
        });
        expect(applyRes.error).toBeUndefined();
        expect(applyRes.result).toEqual({ applied: true });
        expect(existsSync(path.join(dir, "orchestrate-smoke.txt"))).toBe(true);
      } finally {
        if (engine !== undefined) await engine.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
