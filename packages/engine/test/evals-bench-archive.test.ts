import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeBaseCommit } from "../src/evals/bench/archive.js";

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

describe("materializeBaseCommit", () => {
  it("archives base tree into a disconnected git repo", async () => {
    const clone = mkdtempSync(path.join(os.tmpdir(), "of-bench-clone-"));
    const dest = mkdtempSync(path.join(os.tmpdir(), "of-bench-dest-"));
    dirs.push(clone, dest);

    execFileSync("git", ["init", "-q", clone]);
    git(clone, "config", "user.email", "t@t");
    git(clone, "config", "user.name", "t");
    writeFileSync(path.join(clone, "app.py"), "v1\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "base");
    const base = git(clone, "rev-parse", "HEAD");
    writeFileSync(path.join(clone, "app.py"), "v2-fix\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "fix");

    const { baselineSha } = await materializeBaseCommit(clone, base, dest);
    expect(baselineSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(path.join(dest, "app.py"))).toBe(true);
    const content = execFileSync("cat", [path.join(dest, "app.py")], { encoding: "utf8" });
    expect(content).toBe("v1\n");
    // Only one commit reachable — the fix is not in this object graph.
    const log = git(dest, "log", "--oneline", "--all");
    expect(log.split("\n")).toHaveLength(1);
    // No remote pointing at clone
    const remotes = git(dest, "remote");
    expect(remotes).toBe("");
  });
});
