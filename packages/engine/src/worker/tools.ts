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
import type { WikiPage } from "../harness/schema.js";
import { querySymbols, renderMap } from "../wiki/query.js";
import type { SymbolHit, WikiStore } from "../wiki/store.js";
import { applyPatchToWorktree } from "./apply-patch.js";

// Phase 1 dialect-pack telemetry: expected tool failures (model mistakes)
// are classified so edit_fail_rate / tool_error_rate can be attributed per
// pack without logging task text or file content.
export type ToolErrorKind =
  | "not_found"
  | "not_unique"
  | "containment"
  | "invalid_args"
  | "io"
  | "timeout"
  | "aborted"
  | "unknown";

export interface ToolEvent {
  tool: string;
  detail: string;
  ok: boolean;
  errorKind?: ToolErrorKind;
}

export interface ToolContext {
  root: string;
  bashTimeoutMs?: number;
  onToolEvent?: (e: ToolEvent) => void;
  // Task 7: present only once worker/methods.ts has confirmed the project's
  // wiki is actually built (never triggers a build itself — see that
  // module's wiring). When set, createWorkerTools additionally registers
  // wiki_query/wiki_map: on-demand retrieval tools that replace Task 6's
  // removed all-digests prompt injection. `pages` is deliberately narrowed
  // to the three fields wiki_query's page-hit search/excerpt actually reads
  // (slug/title/digest), not the full WikiPage (which also carries `body`).
  wiki?: {
    store: WikiStore;
    pages: ReadonlyArray<Pick<WikiPage, "slug" | "title" | "digest">>;
  };
  // Dialect-pack composition knobs (Phase 1). Defaults preserve pre-pack
  // behavior: all core tools + string-replace edit description.
  includeEdit?: boolean;
  editDescription?: string;
  includeBash?: boolean;
  includeWikiTools?: boolean;
  /** When true, register apply_patch and omit string-replace edit. */
  includeApplyPatch?: boolean;
}

interface WikiQueryResult {
  definitions: SymbolHit[];
  references: SymbolHit[];
  pages: Array<{ slug: string; title: string; excerpt: string }>;
}

// Page-hit excerpt cap (spec §5 / task brief): matches WikiPage.digest's own
// role as the token-budgeted summary — an excerpt is a preview, not the
// whole digest.
const PAGE_EXCERPT_CHARS = 240;

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
// command stdout/stderr. Control characters (newlines included) are
// stripped BEFORE truncation so an embedded newline in a command/path can't
// inject formatting into whatever consumes onToolEvent (e.g. a
// line-oriented progress log). Truncated defensively in case a path or
// command is itself huge (e.g. a generated one-liner or a deeply nested
// path).
function detail(s: string): string {
  return truncate(s.replace(/[\x00-\x1f]/g, " "), DETAIL_TRUNCATE_CHARS);
}

function runBash(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
): Promise<BashResult> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: BASH_MAX_BUFFER, signal: abortSignal },
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
        // (a signal-kill from our own timeout, an abort from the AI SDK's
        // merged options.abortSignal, ENOENT from a bad interpreter, an
        // over-maxBuffer abort) means there is no real exit code to report
        // -- normalize to -1 and attach an explanatory message so the model
        // can tell the difference.
        const e = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        if (typeof e.code === "number") {
          resolve({ stdout: out, stderr: err, exitCode: e.code });
          return;
        }
        // execFile's `signal` option kills the child and rejects/errors with
        // an AbortError (name === "AbortError") when the passed AbortSignal
        // fires -- distinct from our own `timeout` option's SIGTERM kill
        // (which sets `e.killed` but not this name). Surfacing "aborted"
        // here (rather than folding it into the generic message branch)
        // lets a caller distinguish "the deadline/abort fired" from
        // "bashTimeoutMs itself elapsed", even though both are reported the
        // same way to the model (a normal tool result, not a throw) --
        // whichever aborted the child, generateText's own abort handling is
        // what actually ends the run; this is just a clean result in the
        // meantime.
        if (e.name === "AbortError" || abortSignal?.aborted) {
          resolve({ stdout: out, stderr: err, exitCode: -1, error: "aborted" });
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

// Creates the worker toolset scoped to `ctx.root`: the four core tools
// (bash/read_file/write_file/edit) always, plus wiki_query/wiki_map
// (Task 7) when `ctx.wiki` is present — see ToolContext's own doc comment
// on `wiki`.
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
// is out of scope for this milestone -- see spec §7 / M7. Separately, `bash`
// inherits the engine process's own environment and can read any file the
// engine's OS user can read -- not just paths under the worktree -- and
// whatever it prints flows straight into a third-party model provider's
// context, so the boundary this milestone provides is blast-radius/
// isolation of WRITES (deferred fully to M7), not data confidentiality.
const DEFAULT_EDIT_DESCRIPTION =
  "Replace a single, EXACT, unique occurrence of `find` with `replace` " +
  "in a file at a path relative to the worktree root. Fails if `find` " +
  "is missing or matches more than once -- widen `find` with more " +
  "surrounding context to disambiguate.";

function emit(
  ctx: ToolContext,
  toolName: string,
  detailStr: string,
  ok: boolean,
  errorKind?: ToolErrorKind,
): void {
  ctx.onToolEvent?.({ tool: toolName, detail: detailStr, ok, errorKind });
}

export function createWorkerTools(ctx: ToolContext): Record<string, Tool> {
  const canonicalRoot = fs.realpathSync(ctx.root);
  const bashTimeoutMs = ctx.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const includeBash = ctx.includeBash !== false;
  const includeApplyPatch = ctx.includeApplyPatch === true;
  const includeEdit = !includeApplyPatch && ctx.includeEdit !== false;
  const includeWiki = ctx.includeWikiTools !== false && ctx.wiki !== undefined;
  const editDescription = ctx.editDescription ?? DEFAULT_EDIT_DESCRIPTION;

  const tools: Record<string, Tool> = {};

  if (includeBash) {
    tools.bash = tool({
      description:
        "Run a shell command via /bin/sh, with cwd pinned to the worktree root. " +
        "NOTE: this does not prevent the command from `cd`-ing out of the " +
        "worktree or touching absolute paths outside it -- unlike the file " +
        "tools, bash does not enforce path containment. A nonzero exit code " +
        "is a normal result, not a failure of this tool.",
      inputSchema: z.object({ command: z.string().min(1) }),
      execute: async ({ command }, { abortSignal }): Promise<BashResult> => {
        const result = await runBash(command, ctx.root, bashTimeoutMs, abortSignal);
        const timedOut = result.error?.includes("timed out") === true;
        const aborted = result.error === "aborted";
        const ok = result.error === undefined;
        emit(
          ctx,
          "bash",
          detail(command),
          ok,
          ok ? undefined : aborted ? "aborted" : timedOut ? "timeout" : "unknown",
        );
        return result;
      },
    });
  }

  tools.read_file = tool({
    description: "Read a UTF-8 text file at a path relative to the worktree root.",
    inputSchema: z.object({ path: z.string().min(1) }),
    execute: async ({ path: rawPath }, { abortSignal }): Promise<ReadResult | FileErrorResult> => {
      if (abortSignal?.aborted) {
        emit(ctx, "read_file", detail(rawPath), false, "aborted");
        return { error: "aborted" };
      }
      const gate = containmentGate(ctx.root, canonicalRoot, rawPath);
      if (!gate.ok) {
        emit(ctx, "read_file", detail(rawPath), false, "containment");
        return { error: gate.error };
      }
      if (!fs.existsSync(gate.resolved)) {
        emit(ctx, "read_file", detail(rawPath), false, "not_found");
        return { error: "not found" };
      }
      try {
        const content = fs.readFileSync(gate.resolved, "utf8");
        emit(ctx, "read_file", detail(rawPath), true);
        return { content: truncate(content, READ_TRUNCATE_CHARS) };
      } catch (e) {
        emit(ctx, "read_file", detail(rawPath), false, "io");
        return { error: `read failed: ${(e as Error).message}` };
      }
    },
  });

  tools.write_file = tool({
    description:
      "Write (create or overwrite) a UTF-8 text file at a path relative to " +
      "the worktree root, creating parent directories as needed.",
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
    execute: async (
      { path: rawPath, content },
      { abortSignal },
    ): Promise<WriteResult | FileErrorResult> => {
      if (abortSignal?.aborted) {
        emit(ctx, "write_file", detail(rawPath), false, "aborted");
        return { error: "aborted" };
      }
      const gate = containmentGate(ctx.root, canonicalRoot, rawPath);
      if (!gate.ok) {
        emit(ctx, "write_file", detail(rawPath), false, "containment");
        return { error: gate.error };
      }
      try {
        fs.mkdirSync(path.dirname(gate.resolved), { recursive: true });
        fs.writeFileSync(gate.resolved, content, "utf8");
        emit(ctx, "write_file", detail(rawPath), true);
        return { ok: true, bytes: Buffer.byteLength(content, "utf8") };
      } catch (e) {
        emit(ctx, "write_file", detail(rawPath), false, "io");
        return { error: `write failed: ${(e as Error).message}` };
      }
    },
  });

  if (includeApplyPatch) {
    tools.apply_patch = tool({
      description:
        "Apply a multi-file patch in Codex-style freeform format. Wrap with " +
        "`*** Begin Patch` / `*** End Patch`. File ops: " +
        "`*** Update File: rel/path`, `*** Add File: rel/path`, " +
        "`*** Delete File: rel/path`. Hunk lines use leading space (context), " +
        "`-` (remove), `+` (add). Prefer this over sed/echo for edits.",
      inputSchema: z.object({ patch: z.string().min(1) }),
      execute: async ({ patch }, { abortSignal }): Promise<{ ok: true; filesTouched: string[] } | FileErrorResult> => {
        if (abortSignal?.aborted) {
          emit(ctx, "apply_patch", detail("patch"), false, "aborted");
          return { error: "aborted" };
        }
        const result = applyPatchToWorktree(ctx.root, patch);
        if (!result.ok) {
          emit(ctx, "apply_patch", detail(result.error), false, result.errorKind);
          return { error: result.error };
        }
        emit(ctx, "apply_patch", detail(result.filesTouched.join(",")), true);
        return { ok: true, filesTouched: result.filesTouched };
      },
    });
  }

  if (includeEdit) {
    tools.edit = tool({
      description: editDescription,
      inputSchema: z.object({
        path: z.string().min(1),
        find: z.string().min(1),
        replace: z.string(),
      }),
      execute: async (
        { path: rawPath, find, replace },
        { abortSignal },
      ): Promise<EditResult | FileErrorResult> => {
        if (abortSignal?.aborted) {
          emit(ctx, "edit", detail(rawPath), false, "aborted");
          return { error: "aborted" };
        }
        const gate = containmentGate(ctx.root, canonicalRoot, rawPath);
        if (!gate.ok) {
          emit(ctx, "edit", detail(rawPath), false, "containment");
          return { error: gate.error };
        }
        if (!fs.existsSync(gate.resolved)) {
          emit(ctx, "edit", detail(rawPath), false, "not_found");
          return { error: "not found" };
        }
        let content: string;
        try {
          content = fs.readFileSync(gate.resolved, "utf8");
        } catch (e) {
          emit(ctx, "edit", detail(rawPath), false, "io");
          return { error: `read failed: ${(e as Error).message}` };
        }
        const occurrences = content.split(find).length - 1;
        if (occurrences === 0) {
          emit(ctx, "edit", detail(rawPath), false, "not_found");
          return { error: "find not found" };
        }
        if (occurrences > 1) {
          emit(ctx, "edit", detail(rawPath), false, "not_unique");
          return { error: `find matched ${occurrences} times, must be unique` };
        }
        const idx = content.indexOf(find);
        const next = content.slice(0, idx) + replace + content.slice(idx + find.length);
        try {
          fs.writeFileSync(gate.resolved, next, "utf8");
          emit(ctx, "edit", detail(rawPath), true);
          return { ok: true };
        } catch (e) {
          emit(ctx, "edit", detail(rawPath), false, "io");
          return { error: `write failed: ${(e as Error).message}` };
        }
      },
    });
  }

  if (includeWiki && ctx.wiki !== undefined) {
    // Captured into locals (rather than read off `ctx.wiki` inside the
    // closures below) so TS's narrowing of `ctx.wiki !== undefined` doesn't
    // need to survive into a nested arrow function.
    const { store, pages } = ctx.wiki;

    tools.wiki_query = tool({
      description:
        "Look up a SYMBOL (function/class/type name): returns where it is defined and referenced (file:line) in this project's code index, plus matching project wiki pages. For exact strings, regex, or file contents use bash grep / read_file instead.",
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }): Promise<WikiQueryResult> => {
        emit(ctx, "wiki_query", detail(query), true);
        const { definitions, references } = querySymbols(store, query);
        const q = query.toLowerCase();
        const pageHits = pages
          .filter((p) => p.title.toLowerCase().includes(q) || p.digest.toLowerCase().includes(q))
          .map((p) => ({
            slug: p.slug,
            title: p.title,
            excerpt: p.digest.slice(0, PAGE_EXCERPT_CHARS),
          }));
        return { definitions, references, pages: pageHits };
      },
    });

    tools.wiki_map = tool({
      description:
        "Get a token-budgeted map of this project's most important files and symbols — use for whole-repo orientation before diving in.",
      inputSchema: z.object({
        budgetTokens: z.number().int().min(64).max(32768).optional(),
      }),
      execute: async ({ budgetTokens }): Promise<string> => {
        emit(ctx, "wiki_map", detail(String(budgetTokens ?? 1024)), true);
        return renderMap(store, budgetTokens);
      },
    });
  }

  return tools;
}
