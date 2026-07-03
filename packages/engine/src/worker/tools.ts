// Path-scoped worker toolset: bash + read_file + write_file + edit as AI SDK
// v7 `tool()` definitions (verified shape: `tool({ description, inputSchema,
// execute })` -- `inputSchema`, NOT `parameters`; see
// docs/research/2026-07-04-m5-api-verification.md). The SDK provides NO
// sandbox of its own -- a bare `child_process` + `cwd` is documented as not
// a security boundary -- so these `execute` closures ARE the sandbox
// boundary for open-model workers operating on a real (if isolated) git
// worktree (see ../worker/worktree.ts). Path containment reuses
// ../engines/path-scope.ts's `isPathContained` + `canonicalizePath`, the
// single helper M4 hardened over three review rounds plus one M5a round;
// this module does not re-implement or fork that logic.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { canonicalizePath, isPathContained } from "../engines/path-scope.js";

export interface ToolContext {
  root: string;
  bashTimeoutMs?: number;
  onToolEvent?: (e: { tool: string; detail: string }) => void;
}

interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

interface FileErrorResult {
  error: string;
}

interface ReadResult {
  content: string;
}

interface WriteResult {
  ok: true;
  bytes: number;
}

interface EditResult {
  ok: true;
}

const DEFAULT_BASH_TIMEOUT_MS = 30_000;
const BASH_MAX_BUFFER = 1024 * 1024; // 1MB -- the research doc's example cap
const OUTPUT_TRUNCATE_CHARS = 10 * 1024; // ~10KB, for bash stdout/stderr
const READ_TRUNCATE_CHARS = 50 * 1024; // ~50KB, for read_file content
const DETAIL_TRUNCATE_CHARS = 80;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n...[truncated, ${s.length - max} more chars]`;
}

// Detail strings passed to onToolEvent are observability metadata ONLY
// (surfaced in progress/logging UIs) -- never file content, replace text, or
// command stdout/stderr. Truncated defensively in case a path or command is
// itself huge (e.g. a generated one-liner or a deeply nested path).
function detail(s: string): string {
  return truncate(s, DETAIL_TRUNCATE_CHARS);
}

function runBash(command: string, cwd: string, timeoutMs: number): Promise<BashResult> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: BASH_MAX_BUFFER },
      (error, stdout, stderr) => {
        const out = truncate(stdout, OUTPUT_TRUNCATE_CHARS);
        const err = truncate(stderr, OUTPUT_TRUNCATE_CHARS);
        if (!error) {
          resolve({ stdout: out, stderr: err, exitCode: 0 });
          return;
        }
        // Node overloads `error.code` here: a NUMBER means the process ran
        // to completion and exited nonzero (the normal case a worker reads,
        // e.g. `exit 3` -> code 3 -- returned below with no `error` field,
        // since a nonzero exit is not itself a tool failure). Anything else
        // (a signal-kill from our own timeout, ENOENT from a bad
        // interpreter, an over-maxBuffer abort) means there is no real exit
        // code to report -- normalize to -1 and attach an explanatory
        // message so the model can tell the difference.
        const e = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        if (typeof e.code === "number") {
          resolve({ stdout: out, stderr: err, exitCode: e.code });
          return;
        }
        const message = e.killed
          ? `command timed out after ${timeoutMs}ms`
          : (e.message ?? String(e));
        resolve({ stdout: out, stderr: err, exitCode: -1, error: message });
      },
    );
  });
}

type Gate = { ok: true; resolved: string } | { ok: false; error: string };

// Resolves `rawPath` against the worktree root and enforces containment.
// Returns the CANONICALIZED (symlink-resolved) path on success, and that
// same canonicalized path is what callers must use for the actual
// filesystem operation, not the raw `path.resolve` result -- otherwise a
// symlink among the path's existing ancestors could make the containment
// check pass against one location while the raw resolved path (still
// containing the un-followed symlink segment) performs the actual
// read/write somewhere slightly different. Using one canonical value for
// both the check and the operation closes that gap.
function containmentGate(root: string, canonicalRoot: string, rawPath: string): Gate {
  const resolved = path.resolve(root, rawPath);
  const canonical = canonicalizePath(resolved);
  if (!isPathContained(canonical, canonicalRoot)) {
    return { ok: false, error: `path outside worktree: ${rawPath}` };
  }
  return { ok: true, resolved: canonical };
}

// Creates the four-tool worker toolset scoped to `ctx.root`.
//
// Trust model (v1, accepted for this milestone): the worker operates on the
// user's OWN repository, already isolated into its own git worktree (see
// worker/worktree.ts) -- these tools bound the worker's blast radius to
// that worktree; they do not attempt full process sandboxing.
//
// `bash`'s boundary is cwd-pinning ONLY: a command can still `cd ..` and
// touch anything outside the worktree, or address absolute paths directly
// (e.g. `rm -rf /somewhere`) -- there is no seccomp/container/VM layer
// here, and none of that is caught or blocked. `read_file`/`write_file`/
// `edit`, by contrast, DO enforce real path containment on every single
// call, because the model's most likely and most consequential mistake is
// a relative-path typo or a stale path from prior context, not a
// deliberately adversarial shell one-liner. Real isolation (containers/VMs)
// is out of scope for this milestone -- see spec §7 / M7.
export function createWorkerTools(ctx: ToolContext): Record<string, Tool> {
  const canonicalRoot = fs.realpathSync(ctx.root);
  const bashTimeoutMs = ctx.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;

  const bash = tool({
    description:
      "Run a shell command via /bin/sh, with cwd pinned to the worktree root. " +
      "NOTE: this does not prevent the command from `cd`-ing out of the " +
      "worktree or touching absolute paths outside it -- unlike the file " +
      "tools, bash does not enforce path containment. A nonzero exit code " +
      "is a normal result, not a failure of this tool.",
    inputSchema: z.object({ command: z.string().min(1) }),
    execute: async ({ command }): Promise<BashResult> => {
      ctx.onToolEvent?.({ tool: "bash", detail: detail(command) });
      return runBash(command, ctx.root, bashTimeoutMs);
    },
  });

  const read_file = tool({
    description: "Read a UTF-8 text file at a path relative to the worktree root.",
    inputSchema: z.object({ path: z.string().min(1) }),
    execute: async ({ path: rawPath }): Promise<ReadResult | FileErrorResult> => {
      ctx.onToolEvent?.({ tool: "read_file", detail: detail(rawPath) });
      const gate = containmentGate(ctx.root, canonicalRoot, rawPath);
      if (!gate.ok) return { error: gate.error };
      if (!fs.existsSync(gate.resolved)) return { error: "not found" };
      try {
        const content = fs.readFileSync(gate.resolved, "utf8");
        return { content: truncate(content, READ_TRUNCATE_CHARS) };
      } catch (e) {
        return { error: `read failed: ${(e as Error).message}` };
      }
    },
  });

  const write_file = tool({
    description:
      "Write (create or overwrite) a UTF-8 text file at a path relative to " +
      "the worktree root, creating parent directories as needed.",
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
    execute: async ({ path: rawPath, content }): Promise<WriteResult | FileErrorResult> => {
      ctx.onToolEvent?.({ tool: "write_file", detail: detail(rawPath) });
      const gate = containmentGate(ctx.root, canonicalRoot, rawPath);
      if (!gate.ok) return { error: gate.error };
      try {
        fs.mkdirSync(path.dirname(gate.resolved), { recursive: true });
        fs.writeFileSync(gate.resolved, content, "utf8");
        return { ok: true, bytes: Buffer.byteLength(content, "utf8") };
      } catch (e) {
        return { error: `write failed: ${(e as Error).message}` };
      }
    },
  });

  const edit = tool({
    description:
      "Replace a single, EXACT, unique occurrence of `find` with `replace` " +
      "in a file at a path relative to the worktree root. Fails if `find` " +
      "is missing or matches more than once -- widen `find` with more " +
      "surrounding context to disambiguate.",
    inputSchema: z.object({
      path: z.string().min(1),
      find: z.string().min(1),
      replace: z.string(),
    }),
    execute: async ({ path: rawPath, find, replace }): Promise<EditResult | FileErrorResult> => {
      ctx.onToolEvent?.({ tool: "edit", detail: detail(rawPath) });
      const gate = containmentGate(ctx.root, canonicalRoot, rawPath);
      if (!gate.ok) return { error: gate.error };
      if (!fs.existsSync(gate.resolved)) return { error: "not found" };
      let content: string;
      try {
        content = fs.readFileSync(gate.resolved, "utf8");
      } catch (e) {
        return { error: `read failed: ${(e as Error).message}` };
      }
      const occurrences = content.split(find).length - 1;
      if (occurrences === 0) return { error: "find not found" };
      if (occurrences > 1) {
        return { error: `find matched ${occurrences} times, must be unique` };
      }
      const idx = content.indexOf(find);
      const next = content.slice(0, idx) + replace + content.slice(idx + find.length);
      try {
        fs.writeFileSync(gate.resolved, next, "utf8");
        return { ok: true };
      } catch (e) {
        return { error: `write failed: ${(e as Error).message}` };
      }
    },
  });

  return { bash, read_file, write_file, edit };
}
