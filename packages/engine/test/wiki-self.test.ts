import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createEngine } from "../src/engine.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
let cloneDir: string;
afterAll(() => rmSync(cloneDir, { recursive: true, force: true }));

describe("self-index smoke", () => {
  it("indexes a clone of this repository and finds createEngine", async () => {
    cloneDir = mkdtempSync(path.join(os.tmpdir(), "of-self-"));
    execFileSync("git", ["clone", "-q", "--local", repoRoot, path.join(cloneDir, "repo")]);
    const projectDir = path.join(cloneDir, "repo");
    const engine = createEngine();
    try {
      const build = await engine.dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "engine.wiki.build",
        params: { projectDir },
      });
      expect(build?.error).toBeUndefined();
      const stats = build?.result as { filesIndexed: number; symbols: number };
      expect(stats.filesIndexed).toBeGreaterThanOrEqual(10);
      expect(stats.symbols).toBeGreaterThanOrEqual(30);

      const query = await engine.dispatcher.dispatch({
        jsonrpc: "2.0",
        id: 2,
        method: "engine.wiki.query",
        params: { projectDir, symbol: "createEngine" },
      });
      const defs = (query?.result as { definitions: { file: string }[] }).definitions;
      expect(defs.some((d) => d.file === "packages/engine/src/engine.ts")).toBe(true);
    } finally {
      await engine.close();
    }
  }, 60_000);
});
