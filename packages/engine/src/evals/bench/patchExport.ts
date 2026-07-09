// Shared model_patch export for both bench arms.
//
// Mirrors WorktreeManager.diff() (worker/worktree.ts): git add -A then
// git diff --cached <baselineSha> so new files and mid-task commits cannot
// empty the patch. Path filters exclude OpenFusion harness artifacts so
// they never enter SWE-bench predictions.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

/** Path prefixes excluded from model_patch (repo-relative, POSIX-style). */
export const DEFAULT_PATCH_EXCLUDE_PREFIXES = [
  ".openfusion/",
  "AGENTS.md",
  "CLAUDE.md",
] as const;

export interface ExportModelPatchOptions {
  /** Fixed baseline commit SHA created at setup (not HEAD). */
  baselineSha: string;
  /** Path prefixes to drop from the diff (default: harness artifacts). */
  excludePrefixes?: readonly string[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: MAX_BUFFER });
  return stdout;
}

function pathExcluded(filePath: string, prefixes: readonly string[]): boolean {
  const normalized = filePath.replace(/^\.\//, "");
  return prefixes.some((p) => {
    const bare = p.replace(/\/$/, "");
    return normalized === bare || normalized.startsWith(p.endsWith("/") ? p : `${bare}/`) || normalized === bare;
  });
}

/**
 * Filter a unified diff to drop file hunks whose path matches excludePrefixes.
 * Handles standard `diff --git a/X b/Y` headers.
 */
export function filterUnifiedDiff(diff: string, excludePrefixes: readonly string[]): string {
  if (diff.length === 0) return diff;
  const lines = diff.split("\n");
  const out: string[] = [];
  let skip = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const pathB = match?.[2] ?? "";
      skip = pathExcluded(pathB, excludePrefixes);
      if (!skip) out.push(line);
      continue;
    }
    if (skip) continue;
    out.push(line);
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  const body = out.join("\n");
  return body.length > 0 ? `${body}\n` : "";
}

/**
 * Export model_patch from a checkout's final tree vs baselineSha.
 */
export async function exportModelPatch(
  worktreeRoot: string,
  opts: ExportModelPatchOptions,
): Promise<string> {
  const exclude = opts.excludePrefixes ?? DEFAULT_PATCH_EXCLUDE_PREFIXES;
  await git(worktreeRoot, ["add", "-A"]);
  let raw: string;
  try {
    raw = await git(worktreeRoot, ["diff", "--cached", opts.baselineSha]);
  } catch {
    raw = "";
  }
  return filterUnifiedDiff(raw, exclude);
}
