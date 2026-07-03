import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import { validateHarness } from "../src/harness/schema.js";
import { loadHarness } from "../src/harness/store.js";

// Real end-to-end smoke test: exercises the DEFAULT Claude adapter
// (registerFrontierMethods' createClaudeAdapter(), no injected/scripted
// session), so it spawns the actual `claude` CLI via the Agent SDK, builds
// a real wiki index, and runs 6 real frontier prompts (overview + 4 pages +
// agents-routing) against this repo. Needs the CLI installed and
// authenticated however the operator set that up — this test never touches
// credentials itself (see claude.ts's AUTH-AGNOSTIC design note).
//
// Gated behind OPENFUSION_CLAUDE_SMOKE — same env var
// frontier-claude-smoke.test.ts uses — so CI (which has neither the binary
// nor auth configured) always skips it. Authored and typechecked but
// intentionally never executed by the agent implementing this task; only a
// human with a configured `claude` CLI can run it locally with
// OPENFUSION_CLAUDE_SMOKE=1.
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

async function rpc(engine: Engine, method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

describe("engine.harness.generate (real smoke)", () => {
  it.skipIf(!process.env.OPENFUSION_CLAUDE_SMOKE)(
    "generates a full, structurally-valid harness bundle for this repo",
    async () => {
      // Clones this repo's committed HEAD (not the live working tree) into a
      // throwaway checkout — mirrors frontier-claude-smoke.test.ts so wiki
      // build's `git ls-files` sees a real tracked-file set without indexing
      // node_modules/dist or this run's uncommitted state.
      const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
      const dir = mkdtempSync(path.join(os.tmpdir(), "of-harness-smoke-"));
      let engine: Engine | undefined;
      try {
        execFileSync("git", ["clone", "--depth", "1", repoRoot, dir], { stdio: "ignore" });

        engine = createEngine();

        const res = await rpc(engine, "engine.harness.generate", { projectDir: dir });
        expect(res.error).toBeUndefined();
        expect(res.result.pages).toBe(4);
        expect(res.result.agents).toBeGreaterThanOrEqual(2);
        expect(res.result.reportCard).toEqual({ structural: "pass", evals: "pending" });

        const bundle = loadHarness(dir);
        expect(bundle).not.toBeNull();
        expect(bundle!.pages).toHaveLength(4);
        expect(bundle!.agents.length).toBeGreaterThanOrEqual(2);
        expect(validateHarness(bundle!)).toEqual([]);
      } finally {
        if (engine !== undefined) await engine.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
