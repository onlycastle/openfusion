// Minimal apply_patch dialect for OpenAI/Codex-trained models (Phase 1.1).
// Accepts a freeform patch string in a Codex-like grammar and applies it
// under path containment. Returns structured success/error for telemetry.
import fs from "node:fs";
import path from "node:path";
import { canonicalizePath, isPathContained } from "../engines/path-scope.js";
import type { ToolErrorKind } from "./tools.js";

export interface ApplyPatchResult {
  ok: true;
  filesTouched: string[];
}

export interface ApplyPatchError {
  ok: false;
  error: string;
  errorKind: ToolErrorKind;
}

type FileOp =
  | { kind: "update"; path: string; hunks: Array<{ old: string; new: string }> }
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string };

function containment(root: string, canonicalRoot: string, rawPath: string):
  | { ok: true; resolved: string }
  | { ok: false; error: string } {
  const resolved = path.resolve(root, rawPath);
  const canonical = canonicalizePath(resolved);
  if (!isPathContained(canonical, canonicalRoot)) {
    return { ok: false, error: `path outside worktree: ${rawPath}` };
  }
  return { ok: true, resolved: canonical };
}

/**
 * Parse a freeform apply_patch body. Supports:
 *   *** Begin Patch / *** End Patch wrappers (optional)
 *   *** Update File: rel/path
 *   *** Add File: rel/path
 *   *** Delete File: rel/path
 *   Hunk lines: " context", "-old", "+new" (space-prefixed context optional)
 */
export function parseApplyPatch(patch: string): { ops: FileOp[] } | { error: string } {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const ops: FileOp[] = [];
  let i = 0;

  // Skip optional Begin Patch
  if (lines[i]?.trim() === "*** Begin Patch") i += 1;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "*** End Patch") {
      i += 1;
      continue;
    }

    const updateMatch = trimmed.match(/^\*\*\* Update File:\s+(.+)$/);
    const addMatch = trimmed.match(/^\*\*\* Add File:\s+(.+)$/);
    const deleteMatch = trimmed.match(/^\*\*\* Delete File:\s+(.+)$/);

    if (updateMatch) {
      const filePath = updateMatch[1]!.trim();
      i += 1;
      const hunks: Array<{ old: string; new: string }> = [];
      const oldLines: string[] = [];
      const newLines: string[] = [];
      const flushHunk = () => {
        if (oldLines.length === 0 && newLines.length === 0) return;
        hunks.push({ old: oldLines.join("\n"), new: newLines.join("\n") });
        oldLines.length = 0;
        newLines.length = 0;
      };
      while (i < lines.length) {
        const hl = lines[i] ?? "";
        if (hl.startsWith("*** ")) break;
        if (hl.startsWith("-")) oldLines.push(hl.slice(1));
        else if (hl.startsWith("+")) newLines.push(hl.slice(1));
        else if (hl.startsWith(" ") || hl === "") {
          // context: present in both
          const ctx = hl.startsWith(" ") ? hl.slice(1) : hl;
          oldLines.push(ctx);
          newLines.push(ctx);
        } else if (hl.startsWith("@@")) {
          flushHunk();
          i += 1;
          continue;
        } else {
          // bare context line without prefix
          oldLines.push(hl);
          newLines.push(hl);
        }
        i += 1;
      }
      flushHunk();
      ops.push({
        kind: "update",
        path: filePath,
        hunks,
      });
      continue;
    }

    if (addMatch) {
      const filePath = addMatch[1]!.trim();
      i += 1;
      const contentLines: string[] = [];
      while (i < lines.length) {
        const hl = lines[i] ?? "";
        if (hl.startsWith("*** ")) break;
        if (hl.startsWith("+")) contentLines.push(hl.slice(1));
        else if (!hl.startsWith("-") && !hl.startsWith("@@")) contentLines.push(hl);
        i += 1;
      }
      ops.push({ kind: "add", path: filePath, content: contentLines.join("\n") });
      continue;
    }

    if (deleteMatch) {
      ops.push({ kind: "delete", path: deleteMatch[1]!.trim() });
      i += 1;
      continue;
    }

    return { error: `unrecognized patch line: ${trimmed.slice(0, 80)}` };
  }

  if (ops.length === 0) return { error: "empty patch: no file operations found" };
  return { ops };
}

export function applyPatchToWorktree(
  root: string,
  patch: string,
): ApplyPatchResult | ApplyPatchError {
  const canonicalRoot = fs.realpathSync(root);
  const parsed = parseApplyPatch(patch);
  if ("error" in parsed) {
    return { ok: false, error: parsed.error, errorKind: "invalid_args" };
  }

  const filesTouched: string[] = [];

  for (const op of parsed.ops) {
    const gate = containment(root, canonicalRoot, op.path);
    if (!gate.ok) {
      return { ok: false, error: gate.error, errorKind: "containment" };
    }

    if (op.kind === "delete") {
      if (!fs.existsSync(gate.resolved)) {
        return { ok: false, error: `delete: not found: ${op.path}`, errorKind: "not_found" };
      }
      try {
        fs.unlinkSync(gate.resolved);
        filesTouched.push(op.path);
      } catch (e) {
        return { ok: false, error: `delete failed: ${(e as Error).message}`, errorKind: "io" };
      }
      continue;
    }

    if (op.kind === "add") {
      if (fs.existsSync(gate.resolved)) {
        return { ok: false, error: `add: already exists: ${op.path}`, errorKind: "invalid_args" };
      }
      try {
        fs.mkdirSync(path.dirname(gate.resolved), { recursive: true });
        fs.writeFileSync(gate.resolved, op.content.endsWith("\n") ? op.content : `${op.content}\n`, "utf8");
        filesTouched.push(op.path);
      } catch (e) {
        return { ok: false, error: `add failed: ${(e as Error).message}`, errorKind: "io" };
      }
      continue;
    }

    // update
    if (!fs.existsSync(gate.resolved)) {
      return { ok: false, error: `update: not found: ${op.path}`, errorKind: "not_found" };
    }
    let content: string;
    try {
      content = fs.readFileSync(gate.resolved, "utf8");
    } catch (e) {
      return { ok: false, error: `read failed: ${(e as Error).message}`, errorKind: "io" };
    }

    for (const hunk of op.hunks) {
      if (hunk.old.length === 0) {
        // pure insert at end
        content = content.endsWith("\n") || content.length === 0 ? content + hunk.new : `${content}\n${hunk.new}`;
        if (!content.endsWith("\n") && hunk.new.length > 0) content += "\n";
        continue;
      }
      const occurrences = content.split(hunk.old).length - 1;
      if (occurrences === 0) {
        return {
          ok: false,
          error: `update: hunk not found in ${op.path}`,
          errorKind: "not_found",
        };
      }
      if (occurrences > 1) {
        return {
          ok: false,
          error: `update: hunk matched ${occurrences} times in ${op.path}, must be unique`,
          errorKind: "not_unique",
        };
      }
      const idx = content.indexOf(hunk.old);
      content = content.slice(0, idx) + hunk.new + content.slice(idx + hunk.old.length);
    }

    try {
      fs.writeFileSync(gate.resolved, content, "utf8");
      filesTouched.push(op.path);
    } catch (e) {
      return { ok: false, error: `write failed: ${(e as Error).message}`, errorKind: "io" };
    }
  }

  return { ok: true, filesTouched };
}
