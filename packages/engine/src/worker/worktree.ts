import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Diffs (and, in principle, `worktree list --porcelain` for a repo with many
// concurrent workers) can exceed Node's default 1MB execFile buffer, which
// would truncate stdout or throw ERR_CHILD_PROCESS_STDIO_MAXBUFFER outright.
// 64MB comfortably covers any realistic single-task diff without needing a
// streaming API.
const MAX_BUFFER = 64 * 1024 * 1024;

// A taskId becomes one directory segment under the host-private worktree
// root and is passed to Git via execFile's array form. An unsanitized value
// could still escape that root with separators or `..`, so keep the
// conservative filename-safe set below.
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

function projectStorageId(baseRepo: string): string {
  return createHash("sha256").update(baseRepo).digest("hex");
}

function defaultStorageRoot(): string {
  return process.env.OPENFUSION_APP_STORAGE_DIR ?? path.join(os.tmpdir(), "openfusion-app-storage");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: MAX_BUFFER });
  return stdout;
}

export async function applyGitPatchFromMemory(
  cwd: string,
  patch: Buffer,
  args: string[] = ["--binary"],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, "apply", ...args, "-"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk.slice(0, 64 * 1024 - stderr.length);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git apply failed (${code ?? "signal"}): ${stderr.trim()}`));
    });
    child.stdin.end(patch);
  });
}

function assertValidTaskId(taskId: string): void {
  // `.` and `..` pass the character-class test (both chars are individually
  // allowed, for taskIds like "fix.bug-1") but are dangerous as a WHOLE
  // path segment: a root-level `..` would resolve outside the owned storage
  // directory. Reject it explicitly in addition to the regex.
  if (taskId === "." || taskId === "..") {
    throw new Error(`invalid taskId ${JSON.stringify(taskId)}: must not be "." or ".."`);
  }
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(
      `invalid taskId ${JSON.stringify(taskId)}: must match ${TASK_ID_PATTERN} (letters, digits, "." "_" "-" only)`,
    );
  }
}

// Manages detached per-task Git worktrees under the host application storage
// root, outside the selected repository. Each task edits a real isolated
// checkout (sharing the base repo's object store) instead of racing other
// tasks in the selected working directory. See
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
  private readonly storageRoot: string;

  constructor(baseRepo: string, options: { storageRoot?: string } = {}) {
    // realpath'd once up front so every path this class returns or compares
    // against is canonical. Without this, a symlinked baseRepo (e.g. macOS
    // where os.tmpdir() is /var/folders -> /private/var/folders) would make
    // `worktreesDir()`'s lexically-joined path disagree with the realpath'd
    // path `git worktree list --porcelain` reports for the same worktree —
    // the exact class of bug just fixed in path-scope.ts's writeScope
    // handling for symlinked project roots (see the m5a-worker-substrate
    // history). Requires baseRepo to already exist.
    this.baseRepo = realpathSync(baseRepo);
    this.storageRoot = path.resolve(options.storageRoot ?? defaultStorageRoot());
  }

  private worktreesDir(): string {
    return path.join(this.storageRoot, "worktrees", projectStorageId(this.baseRepo));
  }

  async create(taskId: string, requestedBaseSha?: string): Promise<Worktree> {
    assertValidTaskId(taskId);
    const worktreePath = path.join(this.worktreesDir(), taskId);
    const baseSha = requestedBaseSha ?? (await git(this.baseRepo, ["rev-parse", "HEAD"])).trim();
    // Detached worktrees prevent a model-created commit from moving a named
    // branch and guarantee retries always begin at the captured snapshot.
    await git(this.baseRepo, ["worktree", "add", "--detach", worktreePath, baseSha]);
    // Read the SHA back from the new worktree's own HEAD rather than
    // re-querying the base repo's HEAD: `worktree add ... HEAD` already
    // pinned the branch to a specific commit, so asking the worktree itself
    // is exact and race-free (the base repo's HEAD could in principle move
    // between the `worktree add` call above and a separate `rev-parse`
    // against `this.baseRepo`).
    const canonicalWorktreePath = realpathSync(worktreePath);
    const actualBaseSha = (await git(canonicalWorktreePath, ["rev-parse", "HEAD"])).trim();
    if (actualBaseSha !== baseSha) {
      await git(this.baseRepo, ["worktree", "remove", "--force", worktreePath]).catch(() => "");
      throw new Error("worktree base SHA did not match the requested task snapshot");
    }
    return {
      id: taskId,
      path: canonicalWorktreePath,
      branch: "detached",
      base: this.baseRepo,
      baseSha,
    };
  }

  /** Reconstruct a fresh detached worktree from an encrypted checkpoint. */
  async reconstruct(taskId: string, baseSha: string, patch: Buffer): Promise<Worktree> {
    const worktree = await this.create(taskId, baseSha);
    try {
      if (patch.length > 0) await applyGitPatchFromMemory(worktree.path, patch);
      return worktree;
    } catch (error) {
      await this.remove(worktree).catch(() => {});
      throw error;
    }
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
    const configuredOwnedRoot = this.worktreesDir();
    // Git reports canonical worktree paths. On macOS the configured temp
    // root commonly uses `/var/...` while Git reports the same directory as
    // `/private/var/...`; compare canonical spellings or every detached
    // host-private worktree disappears from list()/cleanup after creation.
    const ownedRoot = existsSync(configuredOwnedRoot)
      ? realpathSync(configuredOwnedRoot)
      : path.resolve(configuredOwnedRoot);
    const worktrees: Worktree[] = [];
    for (const block of out.split("\n\n")) {
      if (block.trim().length === 0) continue;
      let worktreePath: string | undefined;
      let branchRef: string | undefined;
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) worktreePath = line.slice("worktree ".length);
        else if (line.startsWith("branch ")) branchRef = line.slice("branch ".length);
      }
      if (!worktreePath) continue;
      const canonicalWorktreePath = existsSync(worktreePath)
        ? realpathSync(worktreePath)
        : path.resolve(worktreePath);
      if (!canonicalWorktreePath.startsWith(`${ownedRoot}${path.sep}`)) continue;
      const id = path.basename(worktreePath);
      let baseSha: string;
      try {
        baseSha = (await git(worktreePath, ["merge-base", "HEAD", baseHeadSha])).trim();
      } catch {
        baseSha = baseHeadSha;
      }
      worktrees.push({
        id,
        path: canonicalWorktreePath,
        branch: branchRef?.replace(/^refs\/heads\//, "") ?? "detached",
        base: this.baseRepo,
        baseSha,
      });
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

  /** Checkpoint form: complete binary-safe patch against the immutable base. */
  async checkpointPatch(worktree: Worktree): Promise<string> {
    await git(worktree.path, ["add", "-A"]);
    return git(worktree.path, ["diff", "--cached", "--binary", worktree.baseSha]);
  }

  /** Writes the current staged worktree state as an unreferenced Git tree. */
  async snapshotTree(worktree: Worktree): Promise<string> {
    await git(worktree.path, ["add", "-A"]);
    return (await git(worktree.path, ["write-tree"])).trim();
  }

  /** Binary-safe delta from a child session's encrypted start-tree ref. */
  async patchAgainstTree(worktree: Worktree, treeSha: string): Promise<string> {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(treeSha)) throw new Error("invalid child start tree");
    await git(worktree.path, ["add", "-A"]);
    return git(worktree.path, ["diff", "--cached", "--binary", treeSha]);
  }

  async diffStatAgainstTree(worktree: Worktree, treeSha: string): Promise<string> {
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(treeSha)) throw new Error("invalid child start tree");
    await git(worktree.path, ["add", "-A"]);
    return git(worktree.path, ["diff", "--cached", "--stat", treeSha]);
  }

  // Manual teardown only — see the class-level doc comment. Never call this
  // from a failure path.
  async remove(worktree: Worktree, opts?: { deleteBranch?: boolean }): Promise<void> {
    await git(worktree.base, ["worktree", "remove", "--force", worktree.path]);
    if (opts?.deleteBranch && worktree.branch !== "detached") {
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
