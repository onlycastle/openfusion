// Dialect-pack → worker runtime (Phase 1). A pack owns tool composition,
// instruction text, maxSteps, retry hints, and telemetry labels — not just
// a YAML label on the shared edit path.
// Spec: docs/superpowers/specs/2026-07-09-model-family-dialect-packs-design.md §4.2
import type { Tool } from "ai";
import {
  requireDialectPack,
  type DialectPackMeta,
  type EditDialect,
} from "../models/catalog.js";
import {
  createWorkerTools,
  type ToolContext,
  type ToolErrorKind,
} from "./tools.js";

const BASE_INSTRUCTIONS =
  "You are a coding worker. Use the provided tools to make the requested " +
  "change in the working directory. Keep going until the task is done, " +
  "then reply with a short summary of what you changed. Do not run `git " +
  "commit`, `git add`, or any git command that changes history or the " +
  "index -- leave all your changes as uncommitted working-tree edits so " +
  "they can be reviewed.";

const STRICT_EDIT_DESCRIPTION =
  "Replace a single, EXACT, unique occurrence of `find` with `replace` " +
  "in a file at a path relative to the worktree root. " +
  "CRITICAL: `find` must match EXACTLY once — copy enough surrounding " +
  "context (2–4 unique lines) so the match cannot be ambiguous. " +
  "If a prior edit failed as not unique, widen `find` with more context " +
  "before retrying. Prefer one careful edit over many small ones.";

const WHOLE_FILE_INSTRUCTIONS =
  "\n\nEdit style for this run: prefer `write_file` to create or fully " +
  "rewrite files. Avoid partial string replacements when the change " +
  "touches more than a few lines — rewrite the whole file contents instead.";

const STRICT_INSTRUCTIONS =
  "\n\nEdit style for this run: every `edit` must use a unique `find` " +
  "string with enough surrounding context. After a failed unique match, " +
  "re-read the file and widen context before retrying.";

const APPLY_PATCH_INSTRUCTIONS =
  "\n\nEdit style for this run: use the `apply_patch` tool with Codex-style " +
  "freeform patches (`*** Begin Patch` … `*** End Patch`, " +
  "`*** Update File:` / `*** Add File:` / `*** Delete File:`). " +
  "Do not use sed or echo redirection for multi-line edits. " +
  "Hunk context must uniquely identify the change site.";

export interface WorkerRuntime {
  dialectPackId: string;
  dialectPackVersion: string;
  editDialect: EditDialect;
  tools: Record<string, Tool>;
  instructions: string;
  maxSteps: number;
  retryHintFor(tool: string, errorKind: ToolErrorKind): string | undefined;
  telemetryBase: {
    dialectPack: string;
    dialectPackVersion: string;
    editDialect: string;
  };
}

export interface CreateWorkerRuntimeOpts {
  /** When false, wiki tools are omitted even if ctx.wiki is set. Default true for standard+wiki packs. */
  includeWikiTools?: boolean;
}

function buildInstructions(pack: DialectPackMeta): string {
  let text = BASE_INSTRUCTIONS;
  if (pack.editDialect === "whole-file") {
    text += WHOLE_FILE_INSTRUCTIONS;
  } else if (pack.editDialect === "apply-patch") {
    text += APPLY_PATCH_INSTRUCTIONS;
  } else if (pack.id === "string-edit-strict") {
    text += STRICT_INSTRUCTIONS;
  }
  if (text.length > pack.promptBudgetChars) {
    text = text.slice(0, pack.promptBudgetChars);
  }
  return text;
}

function toolsetFlags(
  pack: DialectPackMeta,
  opts: CreateWorkerRuntimeOpts | undefined,
  ctx: ToolContext,
): Pick<
  ToolContext,
  "includeEdit" | "includeBash" | "includeWikiTools" | "editDescription" | "includeApplyPatch"
> {
  const includeWikiDefault =
    pack.toolset === "standard+wiki" || (pack.toolset === "standard" && ctx.wiki !== undefined);
  const includeWikiTools =
    opts?.includeWikiTools !== undefined ? opts.includeWikiTools : includeWikiDefault;

  if (pack.editDialect === "apply-patch") {
    return {
      includeEdit: false,
      includeApplyPatch: true,
      includeBash: pack.permissionPosture !== "no-bash",
      includeWikiTools,
    };
  }

  if (pack.editDialect === "whole-file") {
    return {
      includeEdit: false,
      includeApplyPatch: false,
      includeBash: pack.permissionPosture !== "no-bash" && pack.toolset !== "minimal",
      includeWikiTools: includeWikiTools && pack.toolset !== "minimal",
    };
  }

  if (pack.toolset === "minimal") {
    return {
      includeEdit: pack.editDialect === "string-replace",
      includeApplyPatch: false,
      includeBash: pack.permissionPosture === "permissive-worker",
      includeWikiTools: false,
      editDescription:
        pack.id === "string-edit-strict" ? STRICT_EDIT_DESCRIPTION : undefined,
    };
  }

  return {
    includeEdit: true,
    includeApplyPatch: false,
    includeBash: pack.permissionPosture !== "no-bash",
    includeWikiTools,
    editDescription:
      pack.id === "string-edit-strict" ? STRICT_EDIT_DESCRIPTION : undefined,
  };
}

function retryHintForPack(
  pack: DialectPackMeta,
  tool: string,
  errorKind: ToolErrorKind,
): string | undefined {
  if (tool === "edit" && errorKind === "not_unique") {
    return (
      "Previous edit failed: find matched more than once. Re-read the file " +
      "and widen find with 2–4 unique surrounding lines so it matches exactly once."
    );
  }
  if (tool === "edit" && errorKind === "not_found") {
    return (
      "Previous edit failed: find not found. Re-read the file and copy the " +
      "exact current text into find, or use write_file if rewriting is safer."
    );
  }
  if (tool === "apply_patch" && errorKind === "not_found") {
    return (
      "Previous apply_patch failed: hunk not found. Re-read the file and " +
      "widen context lines so the old side uniquely matches."
    );
  }
  if (tool === "apply_patch" && errorKind === "not_unique") {
    return (
      "Previous apply_patch failed: hunk matched multiple times. Add more " +
      "unique context lines around the change."
    );
  }
  if (tool === "apply_patch" && errorKind === "invalid_args") {
    return (
      "Previous apply_patch failed to parse. Use *** Begin Patch / *** End Patch, " +
      "*** Update File: path, and -/+/space hunk lines."
    );
  }
  if (pack.editDialect === "whole-file" && tool === "write_file" && errorKind === "io") {
    return "write_file failed. Check the path is relative to the worktree root and try again.";
  }
  return undefined;
}

/**
 * Build a WorkerRuntime from a dialect pack meta object (or pack id via
 * requireDialectPack). Tool path containment still lives in createWorkerTools.
 */
export function createWorkerRuntime(
  packOrId: DialectPackMeta | string,
  ctx: ToolContext,
  opts?: CreateWorkerRuntimeOpts,
): WorkerRuntime {
  const pack = typeof packOrId === "string" ? requireDialectPack(packOrId) : packOrId;
  const flags = toolsetFlags(pack, opts, ctx);
  const retryHintFor = (tool: string, errorKind: ToolErrorKind) =>
    retryHintForPack(pack, tool, errorKind);
  const tools = createWorkerTools({
    ...ctx,
    ...flags,
    retryHintFor,
    // For standard packs, wiki tools follow pack toolset + ctx.wiki presence.
    includeWikiTools: flags.includeWikiTools,
  });

  return {
    dialectPackId: pack.id,
    dialectPackVersion: pack.version,
    editDialect: pack.editDialect,
    tools,
    instructions: buildInstructions(pack),
    maxSteps: pack.maxSteps,
    retryHintFor,
    telemetryBase: {
      dialectPack: pack.id,
      dialectPackVersion: pack.version,
      editDialect: pack.editDialect,
    },
  };
}
