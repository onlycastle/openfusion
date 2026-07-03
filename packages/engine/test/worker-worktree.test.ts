import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager, type Worktree } from "../src/worker/worktree.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeBaseRepo(): string {
  const base = mkdtempSync(path.join(os.tmpdir(), "of-wt-"));
  execFileSync("git", ["init", "-q", base]);
  git(base, "config", "user.email", "t@t");
  git(base, "config", "user.name", "t");
  writeFileSync(path.join(base, "a.txt"), "alpha\n");
  git(base, "add", "-A");
  git(base, "commit", "-qm", "init");
  return base;
}

describe("WorktreeManager.create", () => {
  it("creates a real git worktree on branch worker/<taskId>", async () => {
    dir = makeBaseRepo();
    const manager = new WorktreeManager(dir);
    const wt = await manager.create("t1");

    expect(wt.id).toBe("t1");
    expect(wt.branch).toBe("worker/t1");
    expect(wt.base).toBe(realpathSync(dir));
    // baseSha is the base repo's HEAD at creation time -- with a single
    // commit on the base repo (makeBaseRepo's "init"), that's also the
    // worktree's own current HEAD, since the branch was just cut from it.
    expect(wt.baseSha).toBe(git(wt.path, "rev-parse", "HEAD"));
    expect(existsSync(wt.path)).toBe(true);
    expect(git(wt.path, "rev-parse", "--is-inside-work-tree")).toBe("true");
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("worker/t1");
    // Shares the base repo's object store rather than a full clone: the
    // linked worktree's `.git` is a file pointing at the base repo's
    // admin dir, not a directory of its own.
    expect(existsSync(path.join(wt.path, ".git"))).toBe(true);
  });

  it("ensures .openfusion/.gitignore guards worktrees/", async () => {
    dir = makeBaseRepo();
    const manager = new WorktreeManager(dir);
    await manager.create("t1");

    const gitignore = readFileSync(path.join(dir, ".openfusion", ".gitignore"), "utf8");
    expect(gitignore.split("\n").map((l) => l.trim())).toContain("worktrees/");
  });

  it("rejects a taskId that escapes the worktrees directory", async () => {
    dir = makeBaseRepo();
    const manager = new WorktreeManager(dir);
    await expect(manager.create("../evil")).rejects.toThrow();
    await expect(manager.create("..")).rejects.toThrow();
    await expect(manager.create("bad id!")).rejects.toThrow();
  });

  it("succeeds for two concurrent creates with different taskIds", async () => {
    dir = makeBaseRepo();
    const manager = new WorktreeManager(dir);
    const [a, b] = await Promise.all([manager.create("concurrent-a"), manager.create("concurrent-b")]);

    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
    expect(a.branch).toBe("worker/concurrent-a");
    expect(b.branch).toBe("worker/concurrent-b");
  });
});

describe("WorktreeManager.list", () => {
  it("includes worktrees created via create()", async () => {
    dir = makeBaseRepo();
    const manager = new WorktreeManager(dir);
    const wt = await manager.create("t1");

    const listed = await manager.list();
    // list()'s baseSha is a best-effort reconstruction (see WorktreeManager
    // .list's doc comment) -- for a worktree that was JUST created off the
    // base repo's current HEAD, with no commits since on either side, it
    // exactly equals create()'s own recorded baseSha.
    expect(listed).toContainEqual<Worktree>({
      id: "t1",
      path: wt.path,
      branch: "worker/t1",
      base: wt.base,
      baseSha: wt.baseSha,
    });
  });

  it("does not include the base repo's own checkout", async () => {
    dir = makeBaseRepo();
    const manager = new WorktreeManager(dir);
    await manager.create("t1");

    const listed = await manager.list();
    expect(listed.some((w) => w.path === realpathSync(dir))).toBe(false);
  });
});

describe("WorktreeManager.diff / diffStat", () => {
  it("captures both an edited tracked file and a brand-new untracked file", async () => {
    dir = makeBaseRepo();
    const manager = new WorktreeManager(dir);
    const wt = await manager.create("t1");

    writeFileSync(path.join(wt.path, "a.txt"), "alpha\nbeta\n");
    writeFileSync(path.join(wt.path, "new.txt"), "brand new file\n");

    const diff = await manager.diff(wt);
    expect(diff).toContain("a.txt");
    expect(diff).toContain("+beta");
    // A bare `git diff` never shows untracked files; this only passes
    // because diff() stages with `add -A` before diffing --cached.
    expect(diff).toContain("new.txt");
    expect(diff).toContain("+brand new file");

    const stat = await manager.diffStat(wt);
    expect(stat).toContain("a.txt");
    expect(stat).toContain("new.txt");
  });

  it("returns an empty diff when nothing changed", async () => {
    dir = makeBaseRepo();
    const manager = new WorktreeManager(dir);
    const wt = await manager.create("t1");

    const diff = await manager.diff(wt);
    expect(diff.trim()).toBe("");
  });

  // Critical regression (M5a final review): an open model driving the
  // worker's bash tool has been observed running `git commit` UNPROMPTED.
  // The old implementation (`git add -A` + `git diff --cached`, i.e. index
  // vs HEAD) goes blind the instant that happens: `git commit` moves HEAD to
  // match the index, so index == HEAD and the diff comes back empty even
  // though `worker/<taskId>` carries a real change. Since this diff is M5a's
  // headline deliverable and M5b's review gate's entire input, an empty diff
  // here means the gate reviews nothing. `diff()` must instead be anchored
  // to the base SHA recorded at worktree creation, which a later commit
  // cannot move.
  it("still shows the change after the worker runs `git commit` (base-SHA-anchored, not HEAD-anchored)", async () => {
    dir = makeBaseRepo();
    const manager = new WorktreeManager(dir);
    const wt = await manager.create("t1");

    writeFileSync(path.join(wt.path, "a.txt"), "alpha\nbeta\n");
    // Simulate the worker committing its own change against instructions.
    git(wt.path, "commit", "-am", "worker committed");

    const diff = await manager.diff(wt);
    expect(diff).toContain("a.txt");
    expect(diff).toContain("+beta");
  });
});

describe("WorktreeManager.remove", () => {
  it("removes the worktree directory", async () => {
    dir = makeBaseRepo();
    const manager = new WorktreeManager(dir);
    const wt = await manager.create("t1");
    expect(existsSync(wt.path)).toBe(true);

    await manager.remove(wt);

    expect(existsSync(wt.path)).toBe(false);
    // The branch survives removal unless deleteBranch is requested.
    expect(git(dir, "branch", "--list", "worker/t1")).not.toBe("");
  });

  it("also deletes the branch when deleteBranch is true", async () => {
    dir = makeBaseRepo();
    const manager = new WorktreeManager(dir);
    const wt = await manager.create("t2");

    await manager.remove(wt, { deleteBranch: true });

    expect(existsSync(wt.path)).toBe(false);
    expect(git(dir, "branch", "--list", "worker/t2")).toBe("");
  });
});

describe("WorktreeManager.prune", () => {
  it("runs clean and sweeps orphaned admin entries", async () => {
    dir = makeBaseRepo();
    const manager = new WorktreeManager(dir);
    const wt = await manager.create("t1");

    // Simulate a crash that deleted the worktree directory out-of-band,
    // bypassing remove() and leaving a stale admin entry behind.
    rmSync(wt.path, { recursive: true, force: true });
    expect(git(dir, "worktree", "list", "--porcelain")).toContain(wt.path);

    await expect(manager.prune()).resolves.toBeUndefined();

    expect(git(dir, "worktree", "list", "--porcelain")).not.toContain(wt.path);
    const listed = await manager.list();
    expect(listed.some((w) => w.id === "t1")).toBe(false);
  });
});
