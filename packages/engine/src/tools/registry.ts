import { createHash } from "node:crypto";
import { z } from "zod";
import { defineToolSpec, type ToolSpec } from "./spec.js";

export const TOOL_REGISTRY_VERSION = "5";

export const BASH_TOOL_SPEC = defineToolSpec({
  id: "bash",
  version: "1",
  summary:
    "Run a shell command through the native OpenFusion sandbox and store bounded output as an encrypted artifact.",
  whenToUse:
    "Use for contained build, test, and inspection commands; request network only when the command cannot run offline.",
  inputSchema: z.object({
    command: z.string().min(1),
    network: z.boolean().optional().describe(
      "Set true only when this command must access the network. It may require user approval.",
    ),
  }).strict(),
  outputSemantics:
    "Returns the exit code, a bounded head/tail preview, byte count, and an artifact ID for paginated output.",
  permission: "execute",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "worker.tools.bash",
});

export const READ_TOOL_OUTPUT_SPEC = defineToolSpec({
  id: "read_tool_output",
  version: "1",
  summary: "Read a bounded UTF-8 page from a prior tool-output artifact.",
  whenToUse: "Use with the artifact ID and next offset returned by bash when its preview is truncated.",
  inputSchema: z.object({
    artifactId: z.string().uuid(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(1024 * 1024).optional(),
  }).strict(),
  outputSemantics: "Returns a bounded page and the next offset without exposing another session's artifact.",
  permission: "read",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "runtime.artifacts.read",
});

export const LOAD_SKILL_TOOL_SPEC = defineToolSpec({
  id: "load_skill",
  version: "1",
  summary: "Load one approved, snapshot-frozen project skill into the current model context.",
  whenToUse: "Use only for a skill listed in the tool description; loading does not grant any additional tools or resources.",
  inputSchema: z.object({ id: z.string().min(1) }).strict(),
  outputSemantics: "Returns the approved immutable skill snapshot and diagnostics, or a typed not-found/policy error.",
  permission: "read",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "runtime.skills.load",
});

export const SPAWN_CHILD_TOOL_SPEC = defineToolSpec({
  id: "spawn_child",
  version: "1",
  summary: "Spawn one isolated depth-one child session for a bounded subtask.",
  whenToUse: "Use only when project policy enables children and the subtask can run independently within the inherited budget.",
  inputSchema: z.object({ task: z.string().min(1).max(32_000) }).strict(),
  outputSemantics: "Returns metadata-only child identity, status, and budget; credentials and content remain supervisor-owned.",
  permission: "dangerous",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "runtime.children.spawn",
});

export const SEND_CHILD_TOOL_SPEC = defineToolSpec({
  id: "send_child",
  version: "1",
  summary: "Send one bounded follow-up message to an active child session.",
  whenToUse: "Use to refine an already-running child task; children cannot message peers or spawn descendants.",
  inputSchema: z.object({ childSessionId: z.string().uuid(), message: z.string().max(64 * 1024) }).strict(),
  outputSemantics: "Returns metadata-only child status after queuing the message.",
  permission: "dangerous",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "runtime.children.send",
});

export const LIST_CHILDREN_TOOL_SPEC = defineToolSpec({
  id: "list_children",
  version: "1",
  summary: "List child-session status and safe budget metadata for this parent.",
  whenToUse: "Use to inspect child progress without reading child prompts, messages, or credentials.",
  inputSchema: z.object({}).strict(),
  outputSemantics: "Returns metadata-only child rows.",
  permission: "read",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "runtime.children.list",
});

export const WAIT_CHILD_TOOL_SPEC = defineToolSpec({
  id: "wait_child",
  version: "1",
  summary: "Wait briefly for one child and return safe status and artifact references.",
  whenToUse: "Use after spawning a child; waits are capped at sixty seconds.",
  inputSchema: z.object({
    childSessionId: z.string().uuid(),
    timeoutMs: z.number().int().min(0).max(60_000).optional(),
  }).strict(),
  outputSemantics: "Returns status, usage, evidence references, and summary only when persisted content is available.",
  permission: "read",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "runtime.children.wait",
});

export const CLOSE_CHILD_TOOL_SPEC = defineToolSpec({
  id: "close_child",
  version: "1",
  summary: "Cancel an active child or close a completed child handle.",
  whenToUse: "Use when child work is no longer needed or before parent termination.",
  inputSchema: z.object({ childSessionId: z.string().uuid() }).strict(),
  outputSemantics: "Returns metadata-only terminal child state.",
  permission: "dangerous",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "runtime.children.close",
});

export const IMPORT_CHILD_DIFF_TOOL_SPEC = defineToolSpec({
  id: "import_child_diff",
  version: "1",
  summary: "Import a completed child's opaque patch into the parent's isolated worktree.",
  whenToUse: "Use only after inspecting child evidence; conflicts never auto-merge and partial imports roll back.",
  inputSchema: z.object({ childSessionId: z.string().uuid() }).strict(),
  outputSemantics: "Returns imported status or a typed parent-drift/conflict result.",
  permission: "dangerous",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "runtime.children.importDiff",
});

export const READ_FILE_TOOL_SPEC = defineToolSpec({
  id: "read_file",
  version: "1",
  summary: "Read a bounded UTF-8 range from a file inside the isolated worktree.",
  whenToUse: "Use relative paths and line pagination for source inspection; control-plane paths are unavailable.",
  inputSchema: z.object({
    path: z.string().min(1),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(2_000).optional(),
  }).strict(),
  outputSemantics: "Returns bounded file content, line boundaries, truncation state, and an optional next offset.",
  permission: "read",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "worker.tools.readFile",
});

export const WRITE_FILE_TOOL_SPEC = defineToolSpec({
  id: "write_file",
  version: "1",
  summary: "Create or replace one UTF-8 file inside the isolated worktree.",
  whenToUse: "Use for complete-file writes at relative paths; control-plane paths and escapes are denied.",
  inputSchema: z.object({ path: z.string().min(1), content: z.string() }).strict(),
  outputSemantics: "Returns success and the number of UTF-8 bytes written.",
  permission: "write",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "worker.tools.writeFile",
});

export const EDIT_TOOL_SPEC = defineToolSpec({
  id: "edit",
  version: "1",
  summary: "Replace one exact unique string occurrence in a file inside the isolated worktree.",
  whenToUse: "Use for narrow edits when the find text is unique; widen context if it is ambiguous.",
  inputSchema: z.object({
    path: z.string().min(1),
    find: z.string().min(1),
    replace: z.string(),
  }).strict(),
  outputSemantics: "Returns success or a typed not-found/not-unique/containment failure with recovery guidance.",
  permission: "write",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "worker.tools.edit",
});

export const APPLY_PATCH_TOOL_SPEC = defineToolSpec({
  id: "apply_patch",
  version: "1",
  summary: "Apply a structured multi-file patch inside the isolated worktree.",
  whenToUse: "Use for coordinated edits across files; every touched relative path is containment checked.",
  inputSchema: z.object({ patch: z.string().min(1) }).strict(),
  outputSemantics: "Returns the contained paths changed or a typed parse, containment, or apply failure.",
  permission: "write",
  transports: ["worker"],
  allowedAgentScopes: ["worker"],
  implementationRef: "worker.tools.applyPatch",
});

export const WIKI_QUERY_TOOL_SPEC = defineToolSpec({
  id: "wiki_query",
  version: "1",
  summary:
    "Look up where a symbol is defined and referenced in this project's code index.",
  whenToUse:
    "Use for function, class, or type names; use grep or read_file for exact strings, regular expressions, or file contents.",
  inputSchema: z.object({ symbol: z.string().min(1) }).strict(),
  outputSemantics:
    "Returns definitions and references plus matching project wiki-page excerpts when that context is available.",
  permission: "read",
  transports: ["worker", "mcp", "frontier"],
  allowedAgentScopes: ["worker", "frontier-readonly", "harness-generator"],
  implementationRef: "wiki.querySymbols",
});

export const WIKI_MAP_TOOL_SPEC = defineToolSpec({
  id: "wiki_map",
  version: "2",
  summary:
    "Get a token-budgeted map of the project files and symbols most relevant to a task.",
  whenToUse:
    "Pass the task or investigation as query before reading files; omit query only for whole-repository orientation.",
  inputSchema: z
    .object({
      query: z.string().min(1).max(2_000).optional(),
      budgetTokens: z.number().int().min(64).max(32_768).optional(),
    })
    .strict(),
  outputSemantics:
    "Returns a plain-text ranked repository map with relevance reasons and symbol line anchors within the requested token budget.",
  permission: "read",
  transports: ["worker", "mcp", "frontier"],
  allowedAgentScopes: ["worker", "frontier-readonly", "harness-generator"],
  implementationRef: "wiki.renderMap",
});

// Projection order is compatibility-sensitive for frontier clients and prompt
// caching. Keep the historical wiki_query -> wiki_map order here; registry
// fingerprints sort by id independently so their digest does not depend on
// declaration order.
const TOOL_SPECS = Object.freeze([
  WIKI_QUERY_TOOL_SPEC,
  WIKI_MAP_TOOL_SPEC,
  BASH_TOOL_SPEC,
  READ_TOOL_OUTPUT_SPEC,
  LOAD_SKILL_TOOL_SPEC,
  SPAWN_CHILD_TOOL_SPEC,
  SEND_CHILD_TOOL_SPEC,
  LIST_CHILDREN_TOOL_SPEC,
  WAIT_CHILD_TOOL_SPEC,
  CLOSE_CHILD_TOOL_SPEC,
  IMPORT_CHILD_DIFF_TOOL_SPEC,
  READ_FILE_TOOL_SPEC,
  WRITE_FILE_TOOL_SPEC,
  EDIT_TOOL_SPEC,
  APPLY_PATCH_TOOL_SPEC,
]);

export type RegisteredToolSpec = (typeof TOOL_SPECS)[number];

export interface ToolRegistryEntry {
  id: string;
  version: string;
  summary: string;
  whenToUse: string;
  inputSchema: unknown;
  outputSemantics: string;
  permission: string;
  transports: readonly string[];
  allowedAgentScopes: readonly string[];
  implementationRef: string;
}

export interface ToolRegistryFingerprint {
  version: string;
  digest: string;
  tools: ToolRegistryEntry[];
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function canonicalize(value: unknown): CanonicalValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (Array.isArray(value)) return value.map((item) => canonicalize(item) ?? null);
  if (typeof value === "object") {
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value).sort(compareIds)) {
      const canonical = canonicalize((value as Record<string, unknown>)[key]);
      if (canonical !== undefined) result[key] = canonical;
    }
    return result;
  }
  throw new TypeError(`cannot fingerprint tool registry value of type ${typeof value}`);
}

function registryEntry(spec: ToolSpec): ToolRegistryEntry {
  return {
    id: spec.id,
    version: spec.version,
    summary: spec.summary,
    whenToUse: spec.whenToUse,
    inputSchema: z.toJSONSchema(spec.inputSchema),
    outputSemantics: spec.outputSemantics,
    permission: spec.permission,
    transports: [...spec.transports].sort(compareIds),
    allowedAgentScopes: [...spec.allowedAgentScopes].sort(compareIds),
    implementationRef: spec.implementationRef,
  };
}

export function listToolSpecs(): readonly RegisteredToolSpec[] {
  return TOOL_SPECS;
}

export function fingerprintToolSpecs(
  specs: readonly ToolSpec[] = TOOL_SPECS,
): ToolRegistryFingerprint {
  const tools = specs.map(registryEntry).sort((a, b) => compareIds(a.id, b.id));
  const ids = tools.map((tool) => tool.id);
  if (new Set(ids).size !== ids.length) throw new Error("tool registry contains duplicate ids");
  const serialized = JSON.stringify(canonicalize(tools));
  const digest = `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
  return { version: TOOL_REGISTRY_VERSION, digest, tools };
}

export const TOOL_REGISTRY_FINGERPRINT = fingerprintToolSpecs();
