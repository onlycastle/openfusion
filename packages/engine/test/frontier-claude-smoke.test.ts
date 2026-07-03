import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";

// Real end-to-end smoke test: exercises the DEFAULT Claude adapter
// (registerFrontierMethods' createClaudeAdapter(), no injected queryFn), so
// it spawns the actual `claude` CLI via the Agent SDK. That needs the CLI
// installed and authenticated however the operator set that up — this test
// never touches credentials itself (claude.ts is AUTH-AGNOSTIC by design;
// see docs/research/2026-07-03-m3-api-verification.md, "Auth posture").
//
// Gated behind OPENFUSION_CLAUDE_SMOKE so CI — which has neither the binary
// nor auth configured — always skips it. `it.skipIf` means the whole body
// below never runs when the env var is unset: no git clone, no wiki build,
// no subprocess spawn, so this file adds zero cost to a normal `pnpm test`.
// Authored and typechecked but intentionally never executed by the agent
// implementing this task — only a human with a configured `claude` CLI can
// run it locally with OPENFUSION_CLAUDE_SMOKE=1.
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

describe("Claude Code frontier adapter (real smoke)", () => {
  it.skipIf(!process.env.OPENFUSION_CLAUDE_SMOKE)(
    "answers a repo question using the wiki",
    async () => {
      // Clones this repo's committed HEAD (not the live working tree —
      // git clone from a local path only copies committed history) into a
      // throwaway checkout, so wiki build's `git ls-files` sees the same
      // tracked-file set a real user's clone would, without indexing
      // node_modules/dist or any of this run's uncommitted state.
      const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
      const dir = mkdtempSync(path.join(os.tmpdir(), "of-claude-smoke-"));
      let engine: Engine | undefined;
      try {
        execFileSync("git", ["clone", "--depth", "1", repoRoot, dir], { stdio: "ignore" });

        engine = createEngine();

        const build = await rpc(engine, "engine.wiki.build", { projectDir: dir });
        expect(build.error).toBeUndefined();

        const start = await rpc(engine, "engine.frontier.start", { projectDir: dir, attachWiki: true });
        expect(start.error).toBeUndefined();
        expect(start.result.wikiAttached).toBe(true);
        const { sessionId } = start.result;

        const prompt = await rpc(engine, "engine.frontier.prompt", {
          sessionId,
          text: "Using the wiki_query tool, in which file is createEngine defined? Answer with just the path.",
        });
        expect(prompt.error).toBeUndefined();
        expect(prompt.result.result.resultText as string).toContain("packages/engine/src/engine.ts");
      } finally {
        if (engine !== undefined) await engine.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
