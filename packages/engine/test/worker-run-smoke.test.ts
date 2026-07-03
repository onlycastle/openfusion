import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";

// Real end-to-end smoke test: exercises engine.worker.run against a REAL,
// configured open-model provider (no injected/mock LanguageModel) driving a
// real git worktree + real tool loop. Gated behind OPENFUSION_WORKER_SMOKE —
// same pattern as frontier-claude-smoke.test.ts / harness-generate-smoke.
// test.ts's OPENFUSION_CLAUDE_SMOKE gate — so CI (which has no live provider
// keys) always skips it; `it.skipIf` means the body below never runs when
// the env var is unset, so this file adds zero cost to a normal `pnpm
// test`. Authored and typechecked but intentionally never executed by the
// agent implementing this task — only an operator with a configured
// provider key can run it locally.
//
// Provider selection is itself env-driven (defaults to deepseek, the
// cheapest priced provider in pricing.ts) rather than hardcoded, so an
// operator can point this at whichever open-model provider they have a key
// for without editing the test:
//   OPENFUSION_WORKER_SMOKE=1 \
//   OPENFUSION_WORKER_SMOKE_API_KEY=sk-... \
//   [OPENFUSION_WORKER_SMOKE_KIND=deepseek] \
//   [OPENFUSION_WORKER_SMOKE_MODEL=deepseek-chat] \
//   [OPENFUSION_WORKER_SMOKE_BASE_URL=...] \
//   pnpm --filter @openfusion/engine test -- worker-run-smoke
const SMOKE_KIND = (process.env.OPENFUSION_WORKER_SMOKE_KIND ?? "deepseek") as
  | "moonshot"
  | "zai"
  | "deepseek"
  | "openai-compatible";
const SMOKE_MODEL = process.env.OPENFUSION_WORKER_SMOKE_MODEL ?? "deepseek-chat";
const SMOKE_API_KEY = process.env.OPENFUSION_WORKER_SMOKE_API_KEY ?? "";
const SMOKE_BASE_URL = process.env.OPENFUSION_WORKER_SMOKE_BASE_URL;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const base = mkdtempSync(path.join(os.tmpdir(), "of-worker-smoke-"));
  execFileSync("git", ["init", "-q", base]);
  git(base, "config", "user.email", "t@t");
  git(base, "config", "user.name", "t");
  writeFileSync(path.join(base, "README.md"), "smoke test repo\n");
  git(base, "add", "-A");
  git(base, "commit", "-qm", "init");
  return base;
}

async function rpc(engine: Engine, method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

describe("engine.worker.run (real smoke)", () => {
  it.skipIf(!process.env.OPENFUSION_WORKER_SMOKE)(
    "a real open model creates hello.txt containing HELLO in an isolated worktree",
    async () => {
      const dir = makeRepo();
      let engine: Engine | undefined;
      try {
        engine = createEngine();
        engine.models.registry.configure({
          id: "smoke",
          kind: SMOKE_KIND,
          apiKey: SMOKE_API_KEY,
          ...(SMOKE_BASE_URL !== undefined ? { baseURL: SMOKE_BASE_URL } : {}),
        });

        const res = await rpc(engine, "engine.worker.run", {
          projectDir: dir,
          task: "create hello.txt containing HELLO",
          providerId: "smoke",
          model: SMOKE_MODEL,
        });

        expect(res.error).toBeUndefined();
        expect(res.result.diff).toContain("hello.txt");
        expect(res.result.diff.toUpperCase()).toContain("HELLO");
      } finally {
        if (engine !== undefined) await engine.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
