import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Shared `.gitignore` guard for everything OpenFusion writes under a
// project's `.openfusion/` directory. Originally this was duplicated
// independently in wiki/store.ts (guarding `cache/`, the symbol-index
// sqlite db) and harness/store.ts (guarding `cache/` again, for the same
// reason, from the harness side) — two call sites enforcing the identical
// invariant with copy-pasted logic that could silently drift. Extracted here
// when worker/worktree.ts needed to guard a THIRD entry (`worktrees/`, so
// per-task worker worktrees under `.openfusion/worktrees/` are never
// committed): a third independent copy would have made the drift risk
// worse, not better, so this call unifies all three instead.
//
// Idempotent and additive: each call only appends the entries IT cares
// about that aren't already present, so call order across the three sites
// doesn't matter and no site can accidentally clobber another's entry.
// Defensive about pre-existing content — if `.gitignore` already exists
// (e.g. hand-edited, or written by a different guard first) but is missing
// one of `entries`, this appends rather than assuming the file is already
// correct.
export function ensureGitignoreGuard(dir: string, entries: string[]): void {
  mkdirSync(dir, { recursive: true });
  const gitignorePath = path.join(dir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, entries.map((entry) => `${entry}\n`).join(""));
    return;
  }
  const current = readFileSync(gitignorePath, "utf8");
  const present = new Set(current.split("\n").map((line) => line.trim()));
  const missing = entries.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;
  const withTrailingNewline = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
  writeFileSync(gitignorePath, `${withTrailingNewline}${missing.map((entry) => `${entry}\n`).join("")}`);
}
