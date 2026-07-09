import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportModelPatch,
  filterUnifiedDiff,
} from "../src/evals/bench/patchExport.js";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): { root: string; baselineSha: string } {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-bench-patch-"));
  execFileSync("git", ["init", "-q", dir]);
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "tracked.txt"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "baseline");
  const baselineSha = git(dir, "rev-parse", "HEAD");
  return { root: dir, baselineSha };
}

describe("patch export", () => {
  it("filterUnifiedDiff drops harness artifact paths", () => {
    const diff = [
      "diff --git a/src/foo.py b/src/foo.py",
      "--- a/src/foo.py",
      "+++ b/src/foo.py",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/.openfusion/manifest.json b/.openfusion/manifest.json",
      "--- a/.openfusion/manifest.json",
      "+++ b/.openfusion/manifest.json",
      "@@ -0,0 +1 @@",
      "+{}",
      "diff --git a/AGENTS.md b/AGENTS.md",
      "--- a/AGENTS.md",
      "+++ b/AGENTS.md",
      "@@ -0,0 +1 @@",
      "+hi",
      "",
    ].join("\n");
    const filtered = filterUnifiedDiff(diff, [".openfusion/", "AGENTS.md"]);
    expect(filtered).toContain("src/foo.py");
    expect(filtered).not.toContain(".openfusion");
    expect(filtered).not.toContain("AGENTS.md");
  });

  it("exportModelPatch includes new files and excludes .openfusion", async () => {
    const { root, baselineSha } = makeRepo();
    writeFileSync(path.join(root, "tracked.txt"), "hello world\n");
    writeFileSync(path.join(root, "newfile.py"), "print(1)\n");
    mkdirSync(path.join(root, ".openfusion"), { recursive: true });
    writeFileSync(path.join(root, ".openfusion", "manifest.json"), "{}\n");

    const patch = await exportModelPatch(root, { baselineSha });
    expect(patch).toContain("tracked.txt");
    expect(patch).toContain("newfile.py");
    expect(patch).toContain("print(1)");
    expect(patch).not.toContain(".openfusion");
  });

  it("exportModelPatch survives mid-task git commit (baseSha anchor)", async () => {
    const { root, baselineSha } = makeRepo();
    writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "agent unprompted commit");
    const patch = await exportModelPatch(root, { baselineSha });
    expect(patch).toContain("changed");
    expect(patch.length).toBeGreaterThan(0);
  });
});
