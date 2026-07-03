// Shared path-containment helpers for engine.frontier's write-scope policy.
// Used both at the RPC boundary (methods.ts's engine.frontier.start, which
// validates that each writeScope entry actually resolves inside the
// project) and inside the Claude adapter's canUseTool policy (claude.ts,
// which checks a write tool's target path against the resolved scope
// dirs) — extracted so the two checks share one predicate and cannot drift
// apart (M4 task-1 review round 1, Finding 1).
import fs from "node:fs";
import path from "node:path";

// Prefix check with a path.sep guard: a parent of "/a/b" must NOT match a
// child of "/a/bad" (a naive `child.startsWith(parent)` would, since "/a/b"
// is a literal string prefix of "/a/bad"). Exact match also counts as
// contained — e.g. the scope/project directory's own path. Both arguments
// are expected to already be resolved/normalized (path.resolve or
// fs.realpathSync) by the caller; this is a pure string comparison with no
// filesystem access of its own.
export function isPathContained(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

// Canonicalizes `targetPath` for a containment check that can't be fooled by
// a pre-existing symlink somewhere along it (M4 task-1 review round 1,
// Finding 2): walks up from `targetPath` to the deepest EXISTING ancestor,
// resolves that ancestor's real path (following any symlinks along the way
// — e.g. `scope/link` where `link` points outside `scope`), then re-joins
// the non-existent tail (a file a Write call is about to create, or
// directories that don't exist yet) onto the canonical ancestor.
//
// Residual (documented v1 caveat): this closes the pre-existing-symlink
// bypass class, not a TOCTOU race — the target could still be replaced with
// a symlink between this check returning and the CLI's own write actually
// happening. A single synchronous check cannot close that; it would need
// the write itself to go through an fd opened with O_NOFOLLOW or
// equivalent, which is the CLI's concern, not this adapter's.
export function canonicalizePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const tail: string[] = [];
  let current = resolved;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved; // hit the filesystem root; nothing on this path exists
    tail.unshift(path.basename(current));
    current = parent;
  }
  const real = fs.realpathSync(current);
  return tail.length > 0 ? path.join(real, ...tail) : real;
}
