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
  // The base repo's HEAD SHA at the moment this worktree's branch was
  // created — NOT the repo path (that's `base`). `diff()`/`diffStat()`
  // anchor to this SHA instead of HEAD so a worker `git commit` (moving
  // HEAD) can no longer make the diff go blind. See `diff()`'s own doc
  // comment for the full story.
  baseSha: string;
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
    // Read the SHA back from the new worktree's own HEAD rather than
    // re-querying the base repo's HEAD: `worktree add ... HEAD` already
    // pinned the branch to a specific commit, so asking the worktree itself
    // is exact and race-free (the base repo's HEAD could in principle move
    // between the `worktree add` call above and a separate `rev-parse`
    // against `this.baseRepo`).
    const baseSha = (await git(worktreePath, ["rev-parse", "HEAD"])).trim();
    return { id: taskId, path: worktreePath, branch, base: this.baseRepo, baseSha };
  }

  // Lists only the worktrees this manager owns (branch matching
  // `worker/<id>`), sourced from git's own porcelain output rather than
  // re-derived from `worktreesDir()` — `worktree list` is the authoritative
  // record (it also naturally excludes the base repo's own checkout, whose
  // branch is never `worker/*`), and using git's reported path instead of a
  // lexically rebuilt one sidesteps any symlink-canonicalization mismatch.
  async list(): Promise<Worktree[]> {
    const out = await git(this.baseRepo, ["worktree", "list", "--porcelain"]);
    // list() reconstructs Worktree records from git's own porcelain output,
    // which has no notion of "the SHA this branch started from" — only
    // create() knows that exactly (it reads it straight back from the
    // freshly created branch's HEAD). For a reconstructed entry, best-effort
    // it as the merge-base of the worktree's HEAD and the base repo's
    // CURRENT HEAD: for a worker branch that hasn't diverged via its own
    // commits yet (the common case immediately after create()) this equals
    // the true baseSha exactly; if the base repo's HEAD has since moved on,
    // this is merely an approximation. Callers that need the exact baseSha
    // (i.e. `diff`/`diffStat`) always receive the real one from create()'s
    // return value, never a list()-reconstructed one.
    const baseHeadSha = (await git(this.baseRepo, ["rev-parse", "HEAD"])).trim();
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
      let baseSha: string;
      try {
        baseSha = (await git(worktreePath, ["merge-base", "HEAD", baseHeadSha])).trim();
      } catch {
        baseSha = baseHeadSha;
      }
      worktrees.push({ id, path: worktreePath, branch, base: this.baseRepo, baseSha });
    }
    return worktrees;
  }

  // Workers edit files in the worktree WITHOUT committing, and often create
  // brand-new files. A bare `git diff` only compares the working tree
  // against the INDEX, and never shows untracked files at all — so a
  // freshly-created file would be invisible. The robust approach: `add -A`
  // to stage everything (including new and deleted files), then diff the
  // index against a fixed point. This DELIBERATELY leaves the change staged
  // afterward (documented here rather than resetting it back to unstaged) —
  // repeated calls to `diff`/`diffStat` are idempotent no-ops once staged,
  // and staged-but-uncommitted is already the state a worker's edits are
  // expected to sit in until a caller decides to commit, discard, or hand it
  // to a review gate.
  //
  // That fixed point is `worktree.baseSha` (the base repo's HEAD at the
  // moment this worktree's branch was created), NOT `HEAD` — this is the
  // load-bearing fix for a real failure mode: an open model driving the
  // worker's bash tool has been observed running `git commit` UNPROMPTED.
  // `git diff --cached` (index vs HEAD) goes blind the instant that
  // happens, because `git commit` moves HEAD to match the index, so
  // index == HEAD and the diff comes back "" — even though the branch
  // carries a real change. Since this diff is M5a's headline deliverable
  // and M5b's review gate's entire input, an empty diff here means the gate
  // reviews nothing. Anchoring to `baseSha` instead of `HEAD` fixes this:
  // `git diff --cached <baseSha>` compares the INDEX (synced to the working
  // tree by the preceding `add -A`, so this captures working, staged, AND
  // already-committed changes made since `baseSha`) against the fixed base
  // commit, which a later `git commit` cannot move. Verified empirically
  // (scratch repo) that `git diff --cached <baseSha>` and the uncached
  // `git diff <baseSha>` produce byte-identical output in every case tested
  // here (tracked-file edit, brand-new untracked file, and a `git commit`
  // made mid-task) — `--cached` was kept because it's the smaller diff from
  // the pre-fix code (same flags, just an explicit revision instead of the
  // implicit HEAD) and keeps the "diff reflects the index we just staged"
  // framing above accurate.
  async diff(worktree: Worktree): Promise<string> {
    await git(worktree.path, ["add", "-A"]);
    return git(worktree.path, ["diff", "--cached", worktree.baseSha]);
  }

  async diffStat(worktree: Worktree): Promise<string> {
    await git(worktree.path, ["add", "-A"]);
    return git(worktree.path, ["diff", "--cached", "--stat", worktree.baseSha]);
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
