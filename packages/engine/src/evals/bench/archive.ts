// History-strip materialization for SWE-bench instances.
//
// Same isolation property as goldenTaskFromCommit's setup (tasks.ts):
// git archive of a tree + fresh git init so later history (the real fix)
// is unreachable. Unlike goldenTaskFromCommit, this archives base_commit
// ITSELF (already the pre-fix tree in SWE-bench), not commit^.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: MAX_BUFFER });
  return stdout;
}

/**
 * Materialize `baseCommit` from `cloneDir` into `destDir` as a fresh git
 * repo with a single "baseline" commit. Shares no objects/refs with the
 * clone. Returns the baseline commit SHA created in destDir.
 */
export async function materializeBaseCommit(
  cloneDir: string,
  baseCommit: string,
  destDir: string,
): Promise<{ baselineSha: string }> {
  mkdirSync(destDir, { recursive: true });
  const scratch = mkdtempSync(path.join(os.tmpdir(), "of-bench-archive-"));
  try {
    const archivePath = path.join(scratch, "tree.tar");
    await execFileAsync("git", [
      "-C",
      cloneDir,
      "archive",
      "--format=tar",
      "--output",
      archivePath,
      baseCommit,
    ]);
    await execFileAsync("tar", ["-xf", archivePath, "-C", destDir]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  await git(destDir, ["init", "-q"]);
  await git(destDir, ["config", "user.email", "bench@openfusion.local"]);
  await git(destDir, ["config", "user.name", "openfusion-bench"]);
  await git(destDir, ["add", "-A"]);
  await git(destDir, ["commit", "-q", "-m", "baseline"]);
  const baselineSha = (await git(destDir, ["rev-parse", "HEAD"])).trim();
  return { baselineSha };
}
