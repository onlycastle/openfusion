import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { goldenTaskFromCommit, runOracle, synthEvalTask } from "../src/evals/tasks.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

describe("runOracle", () => {
  it("passes when testCommand exits 0", async () => {
    const dir = tmpDir("of-oracle-");
    const result = await runOracle(dir, ["node", "-e", "process.exit(0)"]);
    expect(result).toEqual({ passed: true, exitCode: 0, durationMs: expect.any(Number) });
  });

  it("fails when testCommand exits nonzero", async () => {
    const dir = tmpDir("of-oracle-");
    const result = await runOracle(dir, ["node", "-e", "process.exit(1)"]);
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("reports a distinct nonzero exit code verbatim", async () => {
    const dir = tmpDir("of-oracle-");
    const result = await runOracle(dir, ["node", "-e", "process.exit(7)"]);
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(7);
  });

  it("respects the timeout: a long-running command is killed and reported as failed", async () => {
    const dir = tmpDir("of-oracle-");
    const timeoutMs = 200;
    const start = Date.now();
    const result = await runOracle(dir, ["node", "-e", "setTimeout(() => {}, 60000)"], timeoutMs);
    const elapsed = Date.now() - start;

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(-1);
    // durationMs is reported as the configured timeout, not measured
    // wall-clock overhead -- deterministic, not flake-prone.
    expect(result.durationMs).toBe(timeoutMs);
    // Generous bound: the child must actually be killed well before its own
    // 60s sleep would elapse.
    expect(elapsed).toBeLessThan(10_000);
  });

  it("throws a clear error for a nonexistent test command (ENOENT is a setup error, not a failed eval)", async () => {
    const dir = tmpDir("of-oracle-");
    await expect(
      runOracle(dir, ["definitely-not-a-real-binary-xyz", "--version"]),
    ).rejects.toThrow(/test command not found/);
  });
});

describe("synthEvalTask", () => {
  it("fails before the described change and passes after it is applied", async () => {
    const dir = tmpDir("of-synth-");
    const task = synthEvalTask();
    await task.setup(dir);

    const before = await runOracle(dir, task.testCommand);
    expect(before.passed).toBe(false);

    // Apply the described change for real (finish the stub implementation)
    // rather than special-casing the assertion -- proves the fixture is a
    // genuine fail-to-pass, not a fixed toggle.
    const sourcePath = path.join(dir, "source.js");
    const fixed = readFileSync(sourcePath, "utf8").replace("return undefined;", "return a + b;");
    writeFileSync(sourcePath, fixed);

    const after = await runOracle(dir, task.testCommand);
    expect(after.passed).toBe(true);
  });

  it("describes the change in its prompt", () => {
    const task = synthEvalTask();
    expect(task.prompt.length).toBeGreaterThan(0);
    expect(task.id).toBe("synth-add");
  });

  it("supports custom file names and prompt via options", async () => {
    const dir = tmpDir("of-synth-");
    const task = synthEvalTask({ id: "custom", sourceFile: "impl.js", testFile: "spec.js", prompt: "custom prompt" });
    expect(task.id).toBe("custom");
    expect(task.prompt).toBe("custom prompt");
    await task.setup(dir);
    expect(existsSync(path.join(dir, "impl.js"))).toBe(true);
    expect(existsSync(path.join(dir, "spec.js"))).toBe(true);
  });
});

describe("goldenTaskFromCommit", () => {
  function makeFixtureRepo(): string {
    const repo = tmpDir("of-golden-repo-");
    execFileSync("git", ["init", "-q", repo]);
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");

    // Commit A: adds source.js with a bug AND test.js -- the test PRE-EXISTS
    // and FAILS against the bug (v1's required fail-to-pass shape).
    writeFileSync(
      path.join(repo, "source.js"),
      ["function add(a, b) {", "  return a - b; // bug: should be a + b", "}", "", "module.exports = { add };", ""].join(
        "\n",
      ),
    );
    writeFileSync(
      path.join(repo, "test.js"),
      [
        "const assert = require('node:assert');",
        "const { add } = require('./source');",
        "assert.strictEqual(add(2, 3), 5);",
        "console.log('ok');",
        "",
      ].join("\n"),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "A: add buggy add() with its test");

    // Commit B: fixes the bug so the pre-existing test now passes.
    writeFileSync(
      path.join(repo, "source.js"),
      ["function add(a, b) {", "  return a + b;", "}", "", "module.exports = { add };", ""].join("\n"),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "B: fix add() to return the correct sum");

    return repo;
  }

  it("setup produces the parent state (bug present, test present-and-failing)", async () => {
    const repo = makeFixtureRepo();
    const commitB = git(repo, "rev-parse", "HEAD");
    const task = await goldenTaskFromCommit(repo, commitB, ["node", "test.js"]);

    const dir = tmpDir("of-golden-eval-");
    await task.setup(dir);

    expect(existsSync(path.join(dir, "source.js"))).toBe(true);
    expect(existsSync(path.join(dir, "test.js"))).toBe(true);
    expect(readFileSync(path.join(dir, "source.js"), "utf8")).toContain("a - b");

    // Fail-to-pass precondition: the oracle FAILS at the parent state.
    const result = await runOracle(dir, task.testCommand);
    expect(result.passed).toBe(false);
  });

  it("prompt is derived from the target commit's subject", async () => {
    const repo = makeFixtureRepo();
    const commitB = git(repo, "rev-parse", "HEAD");
    const task = await goldenTaskFromCommit(repo, commitB, ["node", "test.js"]);

    expect(task.prompt).toContain("B: fix add() to return the correct sum");
  });

  it("the setup directory cannot reach the target commit via git log --all", async () => {
    const repo = makeFixtureRepo();
    const commitB = git(repo, "rev-parse", "HEAD");
    const subjectB = git(repo, "log", "-1", "--format=%s", commitB);
    const task = await goldenTaskFromCommit(repo, commitB, ["node", "test.js"]);

    const dir = tmpDir("of-golden-eval-");
    await task.setup(dir);

    // The eval directory IS a git repo (a fresh "baseline" commit), so the
    // worker's own git-based tooling still works -- but its object graph is
    // completely disconnected from `repo`'s.
    expect(git(dir, "rev-parse", "--is-inside-work-tree")).toBe("true");

    const allLog = git(dir, "log", "--all", "--oneline");
    expect(allLog).not.toContain(commitB);
    expect(allLog).not.toContain(subjectB);
    expect(allLog.split("\n").length).toBe(1);
    expect(allLog).toContain("baseline");

    expect(() => git(dir, "cat-file", "-e", commitB)).toThrow();
  });

  it("applying the real fix (simulating a correct solution) makes the oracle pass", async () => {
    const repo = makeFixtureRepo();
    const commitB = git(repo, "rev-parse", "HEAD");
    const task = await goldenTaskFromCommit(repo, commitB, ["node", "test.js"]);

    const dir = tmpDir("of-golden-eval-");
    await task.setup(dir);

    const sourcePath = path.join(dir, "source.js");
    const fixed = readFileSync(sourcePath, "utf8").replace("a - b", "a + b");
    writeFileSync(sourcePath, fixed);

    const result = await runOracle(dir, task.testCommand);
    expect(result.passed).toBe(true);
  });
});
