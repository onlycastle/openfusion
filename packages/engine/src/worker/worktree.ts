import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ensureGitignoreGuard } from "../util/gitignore-guard.js";

const execFileAsync = promisify(execFile);

// Diffs (and, in principle, `worktree list --porcelain` for a repo with many
// concurrent workers) can exceed Node's default 1MB execFile buffer, which
// would truncate stdout or throw ERR_CHILD_PROCESS_STDIO_MAXBUFFER outright.
// 64MB comfortably covers any realistic single-task diff without needing a
// streaming API.
const MAX_BUFFER = 64 * 1024 * 1024;

// A taskId becomes a directory name (`.openfusion/worktrees/<taskId>`) and a
// branch name segment (`worker/<taskId>`) that both get shelled out to git
// via execFile's array form (never a shell, so no injection risk there) —
// but an unsanitized taskId could still contain path separators or `..`
// segments that escape the worktrees directory, or characters git itself
// rejects in ref names. Restricting to the conservative
// filename/branch-safe set below avoids both classes of problem without
// needing to reason about git's full ref-name grammar.
const TASK_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export interface Worktree {
  id: string;
  path: string;
  branch: string;
  base: string;
}

function branchFor(taskId: string): string {
  return `worker/${taskId}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: MAX_BUFFER });
  return stdout;
}

function assertValidTaskId(taskId: string): void {
  // `.` and `..` pass the character-class test (both chars are individually
  // allowed, for taskIds like "fix.bug-1") but are dangerous as a WHOLE
  // path segment: `.openfusion/worktrees/..` would resolve back out to
  // `.openfusion/`. Reject them explicitly in addition to the regex.
  if (taskId === "." || taskId === "..") {
    throw new Error(`invalid taskId ${JSON.stringify(taskId)}: must not be "." or ".."`);
  }
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(
      `invalid taskId ${JSON.stringify(taskId)}: must match ${TASK_ID_PATTERN} (letters, digits, "." "_" "-" only)`,
    );
  }
}

// Manages per-task git worktrees under `<baseRepo>/.openfusion/worktrees/`
// so each worker task edits a real, isolated checkout of the repo (sharing
// the base repo's object store — cheap, no full clone) instead of racing
// other tasks in the same working directory. See
// docs/research/2026-07-04-m5-api-verification.md for the verified git
// behaviors this class relies on.
//
// Deliberately NOT responsible for deciding when a worktree is torn down:
// `remove` is only ever meant to be called by an explicit, successful
// caller decision (task merged/discarded). A worker that crashes or fails
// mid-task must leave its worktree — and any uncommitted edits in it —
// exactly where they are, so a human (or a retry) can inspect or recover
// them. Auto-deleting on failure destroys work with no way back (this is a
// real bug class: see Claude Code issue #55724 in the research doc above).
export class WorktreeManager {
  private readonly baseRepo: string;

  constructor(baseRepo: string) {
    // realpath'd once up front so every path this class returns or compares
    // against is canonical. Without this, a symlinked baseRepo (e.g. macOS
    // where os.tmpdir() is /var/folders -> /private/var/folders) would make
    // `worktreesDir()`'s lexically-joined path disagree with the realpath'd
    // path `git worktree list --porcelain` reports for the same worktree —
    // the exact class of bug just fixed in path-scope.ts's writeScope
    // handling for symlinked project roots (see the m5a-worker-substrate
    // history). Requires baseRepo to already exist.
    this.baseRepo = realpathSync(baseRepo);
  }

  private worktreesDir(): string {
    return path.join(this.baseRepo, ".openfusion", "worktrees");
  }

  async create(taskId: string): Promise<Worktree> {
    assertValidTaskId(taskId);
    // Guard before the worktree exists, not after: a worker that crashes
    // between `worktree add` and this call would otherwise leave an
    // ungitignored worktree directory sitting in the base repo's working
    // tree. `ensureGitignoreGuard` is additive/idempotent (see
    // util/gitignore-guard.ts), so this is safe to call on every `create`
    // regardless of what wiki/store.ts or harness/store.ts have already
    // written into the same `.openfusion/.gitignore`.
    ensureGitignoreGuard(path.join(this.baseRepo, ".openfusion"), ["worktrees/"]);
    const worktreePath = path.join(this.worktreesDir(), taskId);
    const branch = branchFor(taskId);
    // `git worktree add` creates all missing parent directories itself
    // (verified: `.openfusion/worktrees/` need not pre-exist) and shares
    // the base repo's object store rather than cloning. Passing `-b`
    // explicitly is required — omitting it detaches HEAD instead of
    // creating `branch`.
    await git(this.baseRepo, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
    return { id: taskId, path: worktreePath, branch, base: this.baseRepo };
  }

  // Lists only the worktrees this manager owns (branch matching
  // `worker/<id>`), sourced from git's own porcelain output rather than
  // re-derived from `worktreesDir()` — `worktree list` is the authoritative
  // record (it also naturally excludes the base repo's own checkout, whose
  // branch is never `worker/*`), and using git's reported path instead of a
  // lexically rebuilt one sidesteps any symlink-canonicalization mismatch.
  async list(): Promise<Worktree[]> {
    const out = await git(this.baseRepo, ["worktree", "list", "--porcelain"]);
    const worktrees: Worktree[] = [];
    for (const block of out.split("\n\n")) {
      if (block.trim().length === 0) continue;
      let worktreePath: string | undefined;
      let branchRef: string | undefined;
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) worktreePath = line.slice("worktree ".length);
        else if (line.startsWith("branch ")) branchRef = line.slice("branch ".length);
      }
      if (!worktreePath || !branchRef) continue;
      const branch = branchRef.replace(/^refs\/heads\//, "");
      const match = /^worker\/(.+)$/.exec(branch);
      if (!match) continue;
      const id = match[1];
      if (id === undefined) continue;
      worktrees.push({ id, path: worktreePath, branch, base: this.baseRepo });
    }
    return worktrees;
  }

  // Workers edit files in the worktree WITHOUT committing, and often create
  // brand-new files. A bare `git diff` only compares the working tree
  // against the INDEX, and never shows untracked files at all — so a
  // freshly-created file would be invisible. The robust approach: `add -A`
  // to stage everything (including new and deleted files), then
  // `diff --cached` to compare the index against HEAD. This DELIBERATELY
  // leaves the change staged afterward (documented here rather than
  // resetting it back to unstaged) — repeated calls to `diff`/`diffStat`
  // are idempotent no-ops once staged, and staged-but-uncommitted is
  // already the state a worker's edits are expected to sit in until a
  // caller decides to commit, discard, or hand it to a review gate.
  async diff(worktree: Worktree): Promise<string> {
    await git(worktree.path, ["add", "-A"]);
    return git(worktree.path, ["diff", "--cached"]);
  }

  async diffStat(worktree: Worktree): Promise<string> {
    await git(worktree.path, ["add", "-A"]);
    return git(worktree.path, ["diff", "--cached", "--stat"]);
  }

  // Manual teardown only — see the class-level doc comment. Never call this
  // from a failure path.
  async remove(worktree: Worktree, opts?: { deleteBranch?: boolean }): Promise<void> {
    await git(worktree.base, ["worktree", "remove", "--force", worktree.path]);
    if (opts?.deleteBranch) {
      await git(worktree.base, ["branch", "-D", worktree.branch]);
    }
  }

  // Sweeps orphaned worktree admin entries (e.g. left behind by a worktree
  // directory that was deleted out-of-band, or a crash mid-`remove`).
  // Idempotent; safe to run unconditionally on engine startup.
  async prune(): Promise<void> {
    await git(this.baseRepo, ["worktree", "prune"]);
  }
}
