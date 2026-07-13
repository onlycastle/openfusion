// Path-scoped worker toolset: sandboxed bash + read_file + write_file + edit as AI SDK
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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { canonicalizePath, isPathContained } from "../engines/path-scope.js";
import type { WikiPage } from "../harness/schema.js";
import { projectWorkerTool } from "../tools/projections.js";
import {
  APPLY_PATCH_TOOL_SPEC,
  BASH_TOOL_SPEC,
  EDIT_TOOL_SPEC,
  READ_FILE_TOOL_SPEC,
  READ_TOOL_OUTPUT_SPEC,
  WIKI_MAP_TOOL_SPEC,
  WIKI_QUERY_TOOL_SPEC,
  WRITE_FILE_TOOL_SPEC,
} from "../tools/registry.js";
import {
  createToolInvocationClaim,
  ToolGateway,
  type ToolResourceClaim,
} from "../tools/gateway.js";
import { querySymbols, renderMap } from "../wiki/query.js";
import type { SymbolHit, WikiStore } from "../wiki/store.js";
import {
  TOOL_OUTPUT_MAX_BYTES,
  type SandboxBackend,
  type SandboxProfile,
} from "../runtime/sandbox.js";
import type { RuntimeStore } from "../runtime/store.js";
import type { PolicyEvaluator } from "../runtime/policy.js";
import type { RuntimeReadCache } from "../runtime/read-cache.js";
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
  | "output_limit"
  | "policy_denied"
  | "aborted"
  | "unknown";

const ToolErrorKindSchema = z.enum([
  "not_found",
  "not_unique",
  "containment",
  "invalid_args",
  "io",
  "timeout",
  "output_limit",
  "policy_denied",
  "aborted",
  "unknown",
]);

export interface ToolEvent {
  tool: string;
  detail: string;
  ok: boolean;
  errorKind?: ToolErrorKind;
}

export type ToolLifecycleEvent =
  | { phase: "started"; tool: string }
  | {
      phase: "finished" | "failed";
      tool: string;
      durationMs: number;
      resultBytes: number;
      truncated: boolean;
      errorKind?: ToolErrorKind;
    };

export interface ToolContext {
  root: string;
  bashTimeoutMs?: number;
  onToolEvent?: (e: ToolEvent) => void;
  onToolLifecycleEvent?: (e: ToolLifecycleEvent) => void;
  /** Model-facing recovery guidance supplied by the active dialect pack. */
  retryHintFor?: (tool: string, errorKind: ToolErrorKind) => string | undefined;
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
  /** Bash is exposed only when a native sandbox backend was certified. */
  sandboxCertified?: boolean;
  sandbox?: {
    backend: SandboxBackend;
    store: RuntimeStore;
    sessionId: string;
    privateTempRoot?: string;
    readablePaths?: string[];
    executablePaths?: string[];
    networkGranted?: boolean;
    environment?: Record<string, string>;
    profile?: SandboxProfile;
  };
  policy?: {
    evaluator: PolicyEvaluator;
    interactive: boolean;
  };
  /** Central dynamic-claim enforcement. Tests may inject an observer-enabled gateway. */
  toolGateway?: ToolGateway;
  readCache?: RuntimeReadCache;
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
  artifactId?: string;
  outputBytes?: number;
  error?: string;
  errorKind?: ToolErrorKind;
  truncated?: boolean;
}

interface FileErrorResult {
  error: string;
  errorKind: ToolErrorKind;
  recovery?: string;
}

interface ReadResult {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  nextOffset?: number;
}

interface WriteResult {
  ok: true;
  bytes: number;
}

interface EditResult {
  ok: true;
}

const DEFAULT_BASH_TIMEOUT_MS = 30_000;
const READ_TRUNCATE_CHARS = 50 * 1024; // ~50KB, for read_file content
const DEFAULT_READ_LIMIT_LINES = 2_000;
const DETAIL_TRUNCATE_CHARS = 80;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n...[truncated, ${s.length - max} more chars]`;
}

// Shell failures and test summaries commonly appear at the end of output.
// Preserve both ends, following Codex's output-truncation utility, instead
// of retaining only the prefix and discarding the most actionable lines.
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil(max / 2);
  const tail = Math.floor(max / 2);
  const omitted = s.length - head - tail;
  const totalLines = s.split("\n").length;
  return (
    `${s.slice(0, head)}\n` +
    `...[truncated ${omitted} chars from middle; original output ${totalLines} lines]...\n` +
    s.slice(s.length - tail)
  );
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
  const relative = path.relative(canonicalRoot, canonical);
  const first = relative.split(path.sep)[0]?.toLowerCase();
  if (first === ".git" || first === ".gitmodules" || first === ".openfusion") {
    return { ok: false, error: "path is reserved for OpenFusion control state" };
  }
  return { ok: true, resolved: canonical };
}

// Creates the worker toolset scoped to `ctx.root`: the four core tools
// (bash/read_file/write_file/edit) always, plus wiki_query/wiki_map
// (Task 7) when `ctx.wiki` is present — see ToolContext's own doc comment
// on `wiki`.
//
// Bash is included only with a probed native SandboxBackend. There is no
// cwd-only fallback: missing/failed isolation removes the tool entirely.
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

function emitLifecycle(ctx: ToolContext, event: ToolLifecycleEvent): void {
  try {
    ctx.onToolLifecycleEvent?.(event);
  } catch {
    // Lifecycle observation must never affect tool execution.
  }
}

type ObservedToolExecute = (
  input: unknown,
  options: { abortSignal?: AbortSignal },
) => Promise<unknown>;

function resultBytes(result: unknown): number {
  try {
    const serialized = typeof result === "string" ? result : JSON.stringify(result);
    return Buffer.byteLength(serialized ?? "", "utf8");
  } catch {
    return 0;
  }
}

function observeTool(
  ctx: ToolContext,
  toolName: string,
  execute: ObservedToolExecute,
): ObservedToolExecute {
  return async (input, options) => {
    const startedAt = Date.now();
    emitLifecycle(ctx, { phase: "started", tool: toolName });
    try {
      const result = await execute(input, options);
      const metadata =
        typeof result === "object" && result !== null
          ? (result as { error?: unknown; errorKind?: unknown; truncated?: unknown })
          : undefined;
      const failed = typeof metadata?.error === "string";
      const errorKind = ToolErrorKindSchema.safeParse(metadata?.errorKind);
      emitLifecycle(ctx, {
        phase: failed ? "failed" : "finished",
        tool: toolName,
        durationMs: Math.max(0, Date.now() - startedAt),
        resultBytes: resultBytes(result),
        truncated: metadata?.truncated === true,
        ...(failed
          ? { errorKind: errorKind.success ? errorKind.data : "unknown" }
          : {}),
      });
      return result;
    } catch (error) {
      emitLifecycle(ctx, {
        phase: "failed",
        tool: toolName,
        durationMs: Math.max(0, Date.now() - startedAt),
        resultBytes: 0,
        truncated: false,
        errorKind: "unknown",
      });
      throw error;
    }
  };
}

function failure(
  ctx: ToolContext,
  toolName: string,
  detailStr: string,
  errorKind: ToolErrorKind,
  error: string,
): FileErrorResult {
  emit(ctx, toolName, detailStr, false, errorKind);
  const recovery = ctx.retryHintFor?.(toolName, errorKind);
  return recovery === undefined ? { error, errorKind } : { error, errorKind, recovery };
}

export function createWorkerTools(ctx: ToolContext): Record<string, Tool> {
  const canonicalRoot = fs.realpathSync(ctx.root);
  const bashTimeoutMs = ctx.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  const includeBash =
    ctx.includeBash === true && ctx.sandboxCertified === true && ctx.sandbox !== undefined;
  const includeApplyPatch = ctx.includeApplyPatch === true;
  const includeEdit = !includeApplyPatch && ctx.includeEdit !== false;
  const includeWiki = ctx.includeWikiTools !== false && ctx.wiki !== undefined;
  const editDescription = ctx.editDescription ?? DEFAULT_EDIT_DESCRIPTION;
  const toolGateway = ctx.toolGateway ?? new ToolGateway({
    evaluator: ctx.policy?.evaluator,
    interactive: ctx.policy?.interactive,
  });
  const rolePolicy = {
    policyId: "worker-author-v1",
    claims: [
      { kind: "filesystem-read", resource: canonicalRoot },
      { kind: "filesystem-write", resource: canonicalRoot },
      { kind: "process", resource: "/bin/sh" },
      { kind: "network", resource: "tool:bash" },
    ] satisfies ToolResourceClaim[],
  };
  const authorize = (
    toolId: string,
    claims: ToolResourceClaim[],
    approvalSatisfied = false,
  ) => toolGateway.authorize({
    invocation: createToolInvocationClaim(toolId, claims),
    policies: [rolePolicy, { policyId: `tool:${toolId}`, claims }],
    sandboxed: ctx.sandboxCertified === true,
    approvalSatisfied,
  });
  const bashClaims = (network: boolean): ToolResourceClaim[] => [
    { kind: "filesystem-read", resource: canonicalRoot },
    { kind: "filesystem-write", resource: canonicalRoot },
    { kind: "process", resource: "/bin/sh" },
    ...(network ? [{ kind: "network" as const, resource: "tool:bash" }] : []),
  ];

  const tools: Record<string, Tool> = {};

  if (includeBash) {
    const sandbox = ctx.sandbox!;
    tools.bash = tool({
      ...projectWorkerTool(BASH_TOOL_SPEC),
      needsApproval: ({ network }) => {
        if (network !== true) return false;
        return authorize(BASH_TOOL_SPEC.id, bashClaims(true)).decision === "approval-required";
      },
      execute: async ({ command, network = false }, { abortSignal }): Promise<BashResult> => {
        // A shell can mutate any contained path in ways that are opaque to
        // the tool layer, so it conservatively advances the mutation epoch.
        ctx.readCache?.invalidateAll();
        const decision = authorize(
          BASH_TOOL_SPEC.id,
          bashClaims(network),
          network && ctx.policy?.interactive === true,
        );
        if (decision.decision !== "allow") {
          const denied: BashResult = {
            stdout: "",
            stderr: "",
            exitCode: -1,
            error: "tool invocation denied by policy",
            errorKind: "policy_denied",
          };
          emit(ctx, "bash", detail(command), false, denied.errorKind);
          return denied;
        }
        const privateTempDir = fs.mkdtempSync(
          path.join(sandbox.privateTempRoot ?? os.tmpdir(), "openfusion-tool-"),
        );
        const writer = sandbox.store.beginArtifact(sandbox.sessionId, "tool-output", {
          maxBytes: TOOL_OUTPUT_MAX_BYTES,
        });
        let result: Awaited<ReturnType<SandboxBackend["run"]>>;
        try {
          result = await sandbox.backend.run({
            executable: "/bin/sh",
            args: ["-c", command],
            cwd: ctx.root,
            privateTempDir,
            readablePaths: sandbox.readablePaths,
            executablePaths: sandbox.executablePaths,
            networkGranted: sandbox.networkGranted === true || network,
            environment: sandbox.environment,
            profile: sandbox.profile,
            timeoutMs: bashTimeoutMs,
            abortSignal,
            output: writer,
          });
        } catch (error) {
          writer.abort();
          const message = error instanceof Error ? error.message : String(error);
          const failed: BashResult = {
            stdout: "",
            stderr: "",
            exitCode: -1,
            error: message,
            errorKind: abortSignal?.aborted === true ? "aborted" : "unknown",
          };
          emit(ctx, "bash", detail(command), false, failed.errorKind);
          return failed;
        } finally {
          fs.rmSync(privateTempDir, { recursive: true, force: true });
        }
        const errorKind: ToolErrorKind | undefined =
          result.failure === "timeout"
            ? "timeout"
            : result.failure === "cancelled"
              ? "aborted"
              : result.failure === "output-limit"
                ? "output_limit"
                : result.failure === "spawn"
                  ? "unknown"
                  : undefined;
        const error =
          result.failure === "output-limit"
            ? `output limit exceeded after ${result.outputBytes} bytes`
            : result.failure === "timeout"
              ? `command timed out after ${bashTimeoutMs}ms`
              : result.failure === "cancelled"
                ? "aborted"
                : result.failure === "spawn"
                  ? "sandboxed process failed to start"
                  : undefined;
        const modelResult: BashResult = {
          stdout: result.preview,
          stderr: "",
          exitCode: result.exitCode ?? -1,
          artifactId: result.artifact.id,
          outputBytes: result.outputBytes,
          ...(error === undefined ? {} : { error }),
          ...(errorKind === undefined ? {} : { errorKind }),
          ...(result.previewTruncated ? { truncated: true } : {}),
        };
        emit(
          ctx,
          "bash",
          detail(command),
          error === undefined,
          errorKind,
        );
        return modelResult;
      },
    });

    tools.read_tool_output = tool({
      ...projectWorkerTool(READ_TOOL_OUTPUT_SPEC),
      execute: async ({ artifactId, offset, limit }) => {
        if (authorize(READ_TOOL_OUTPUT_SPEC.id, []).decision !== "allow") {
          return failure(ctx, "read_tool_output", detail(artifactId), "policy_denied", "tool invocation denied by policy");
        }
        const artifact = sandbox.store.getArtifact(artifactId);
        if (artifact === null || artifact.sessionId !== sandbox.sessionId) {
          return failure(ctx, "read_tool_output", detail(artifactId), "not_found", "artifact not found");
        }
        emit(ctx, "read_tool_output", detail(artifactId), true);
        return sandbox.store.readArtifactPage(artifactId, { offset, limit });
      },
    });
  }

  tools.read_file = tool({
    ...projectWorkerTool(READ_FILE_TOOL_SPEC),
    execute: async (
      { path: rawPath, offset = 1, limit = DEFAULT_READ_LIMIT_LINES },
      { abortSignal },
    ): Promise<ReadResult | FileErrorResult> => {
      if (abortSignal?.aborted) {
        return failure(ctx, "read_file", detail(rawPath), "aborted", "aborted");
      }
      const gate = containmentGate(ctx.root, canonicalRoot, rawPath);
      if (!gate.ok) {
        return failure(ctx, "read_file", detail(rawPath), "containment", gate.error);
      }
      if (authorize(READ_FILE_TOOL_SPEC.id, [{ kind: "filesystem-read", resource: gate.resolved }]).decision !== "allow") {
        return failure(ctx, "read_file", detail(rawPath), "policy_denied", "tool invocation denied by policy");
      }
      if (!fs.existsSync(gate.resolved)) {
        return failure(ctx, "read_file", detail(rawPath), "not_found", "not found");
      }
      try {
        const content = (ctx.readCache?.read(gate.resolved, `${offset}:${limit}`).bytes
          ?? fs.readFileSync(gate.resolved)).toString("utf8");
        const lines = content.split("\n");
        const totalLines = lines.length;
        const startIndex = Math.min(offset - 1, totalLines);
        const selected = lines.slice(startIndex, startIndex + limit).join("\n");
        const bounded = truncateMiddle(selected, READ_TRUNCATE_CHARS);
        const selectedEnd = Math.min(startIndex + limit, totalLines);
        const truncated = startIndex > 0 || selectedEnd < totalLines || bounded !== selected;
        emit(ctx, "read_file", detail(rawPath), true);
        return {
          content: bounded,
          startLine: startIndex + 1,
          endLine: selectedEnd,
          totalLines,
          truncated,
          ...(selectedEnd < totalLines ? { nextOffset: selectedEnd + 1 } : {}),
        };
      } catch (e) {
        return failure(
          ctx,
          "read_file",
          detail(rawPath),
          "io",
          `read failed: ${(e as Error).message}`,
        );
      }
    },
  });

  tools.write_file = tool({
    ...projectWorkerTool(WRITE_FILE_TOOL_SPEC),
    execute: async (
      { path: rawPath, content },
      { abortSignal },
    ): Promise<WriteResult | FileErrorResult> => {
      if (abortSignal?.aborted) {
        return failure(ctx, "write_file", detail(rawPath), "aborted", "aborted");
      }
      const gate = containmentGate(ctx.root, canonicalRoot, rawPath);
      if (!gate.ok) {
        return failure(ctx, "write_file", detail(rawPath), "containment", gate.error);
      }
      if (authorize(WRITE_FILE_TOOL_SPEC.id, [{ kind: "filesystem-write", resource: gate.resolved }]).decision !== "allow") {
        return failure(ctx, "write_file", detail(rawPath), "policy_denied", "tool invocation denied by policy");
      }
      try {
        fs.mkdirSync(path.dirname(gate.resolved), { recursive: true });
        fs.writeFileSync(gate.resolved, content, "utf8");
        ctx.readCache?.invalidateAll();
        emit(ctx, "write_file", detail(rawPath), true);
        return { ok: true, bytes: Buffer.byteLength(content, "utf8") };
      } catch (e) {
        return failure(
          ctx,
          "write_file",
          detail(rawPath),
          "io",
          `write failed: ${(e as Error).message}`,
        );
      }
    },
  });

  if (includeApplyPatch) {
    tools.apply_patch = tool({
      ...projectWorkerTool(APPLY_PATCH_TOOL_SPEC),
      execute: async ({ patch }, { abortSignal }): Promise<{ ok: true; filesTouched: string[] } | FileErrorResult> => {
        if (abortSignal?.aborted) {
          return failure(ctx, "apply_patch", detail("patch"), "aborted", "aborted");
        }
        if (authorize(APPLY_PATCH_TOOL_SPEC.id, [{ kind: "filesystem-write", resource: canonicalRoot }]).decision !== "allow") {
          return failure(ctx, "apply_patch", detail("patch"), "policy_denied", "tool invocation denied by policy");
        }
        const result = applyPatchToWorktree(ctx.root, patch);
        if (!result.ok) {
          return failure(
            ctx,
            "apply_patch",
            detail(result.error),
            result.errorKind,
            result.error,
          );
        }
        ctx.readCache?.invalidateAll();
        emit(ctx, "apply_patch", detail(result.filesTouched.join(",")), true);
        return { ok: true, filesTouched: result.filesTouched };
      },
    });
  }

  if (includeEdit) {
    tools.edit = tool({
      ...projectWorkerTool(EDIT_TOOL_SPEC),
      description: editDescription,
      execute: async (
        { path: rawPath, find, replace },
        { abortSignal },
      ): Promise<EditResult | FileErrorResult> => {
        if (abortSignal?.aborted) {
          return failure(ctx, "edit", detail(rawPath), "aborted", "aborted");
        }
        const gate = containmentGate(ctx.root, canonicalRoot, rawPath);
        if (!gate.ok) {
          return failure(ctx, "edit", detail(rawPath), "containment", gate.error);
        }
        if (authorize(EDIT_TOOL_SPEC.id, [{ kind: "filesystem-write", resource: gate.resolved }]).decision !== "allow") {
          return failure(ctx, "edit", detail(rawPath), "policy_denied", "tool invocation denied by policy");
        }
        if (!fs.existsSync(gate.resolved)) {
          return failure(ctx, "edit", detail(rawPath), "not_found", "not found");
        }
        let content: string;
        try {
          content = fs.readFileSync(gate.resolved, "utf8");
        } catch (e) {
          return failure(
            ctx,
            "edit",
            detail(rawPath),
            "io",
            `read failed: ${(e as Error).message}`,
          );
        }
        const occurrences = content.split(find).length - 1;
        if (occurrences === 0) {
          return failure(ctx, "edit", detail(rawPath), "not_found", "find not found");
        }
        if (occurrences > 1) {
          return failure(
            ctx,
            "edit",
            detail(rawPath),
            "not_unique",
            `find matched ${occurrences} times, must be unique`,
          );
        }
        const idx = content.indexOf(find);
        const next = content.slice(0, idx) + replace + content.slice(idx + find.length);
        try {
          fs.writeFileSync(gate.resolved, next, "utf8");
          ctx.readCache?.invalidateAll();
          emit(ctx, "edit", detail(rawPath), true);
          return { ok: true };
        } catch (e) {
          return failure(
            ctx,
            "edit",
            detail(rawPath),
            "io",
            `write failed: ${(e as Error).message}`,
          );
        }
      },
    });
  }

  if (includeWiki && ctx.wiki !== undefined) {
    // Captured into locals (rather than read off `ctx.wiki` inside the
    // closures below) so TS's narrowing of `ctx.wiki !== undefined` doesn't
    // need to survive into a nested arrow function.
    const { store, pages } = ctx.wiki;

    tools[WIKI_QUERY_TOOL_SPEC.id] = tool({
      ...projectWorkerTool(WIKI_QUERY_TOOL_SPEC),
      execute: async ({ symbol }): Promise<WikiQueryResult> => {
        if (authorize(WIKI_QUERY_TOOL_SPEC.id, []).decision !== "allow") {
          return { definitions: [], references: [], pages: [] };
        }
        emit(ctx, WIKI_QUERY_TOOL_SPEC.id, detail(symbol), true);
        const { definitions, references } = querySymbols(store, symbol);
        const q = symbol.toLowerCase();
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

    tools[WIKI_MAP_TOOL_SPEC.id] = tool({
      ...projectWorkerTool(WIKI_MAP_TOOL_SPEC),
      execute: async ({ query, budgetTokens }): Promise<string> => {
        if (authorize(WIKI_MAP_TOOL_SPEC.id, []).decision !== "allow") {
          return "tool invocation denied by policy";
        }
        emit(
          ctx,
          WIKI_MAP_TOOL_SPEC.id,
          detail(query ?? String(budgetTokens ?? 1024)),
          true,
        );
        return renderMap(store, budgetTokens, query);
      },
    });
  }

  return Object.fromEntries(
    Object.entries(tools).map(([toolName, definition]) => {
      const execute = (definition as { execute?: ObservedToolExecute }).execute;
      if (execute === undefined) return [toolName, definition];
      return [
        toolName,
        { ...definition, execute: observeTool(ctx, toolName, execute) } as Tool,
      ];
    }),
  );
}
