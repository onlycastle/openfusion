import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { RuntimeHookBus } from "./hooks.js";
import { createToolInvocationClaim, ToolGateway } from "../tools/gateway.js";
import { LOAD_SKILL_TOOL_SPEC } from "../tools/registry.js";
import { renderToolDescription } from "../tools/spec.js";
import { canonicalRuntimeJson } from "./context.js";

export type SkillDialect = "common" | "claude-code" | "codex";

export interface SkillDiagnostic {
  code: "invalid-metadata" | "unsupported-field" | "approval-required" | "unsafe-resource";
  field?: string;
  message: string;
}

export interface NormalizedSkill {
  id: string;
  name: string;
  description: string;
  dialect: SkillDialect;
  sourcePath: string;
  body: string;
  resources: string[];
  allowedTools: string[];
  invocation: { implicit: boolean; userInvocable: boolean };
  vendor: {
    hooks?: unknown;
    shell?: unknown;
    model?: string;
    effort?: string;
    fork?: boolean;
    agent?: string;
    dependencies?: unknown;
    mcp?: unknown;
    interface?: unknown;
  };
  fingerprint: string;
  requiresApproval: boolean;
  diagnostics: SkillDiagnostic[];
}

export interface SkillRuntimeCapabilities {
  hooks: boolean;
  shell: boolean;
  mcp: boolean;
  network: boolean;
  tools: boolean;
  fork: boolean;
}

const DEFAULT_CAPABILITIES: SkillRuntimeCapabilities = {
  hooks: false,
  shell: false,
  mcp: false,
  network: false,
  tools: true,
  fork: false,
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value === "string") return value.split(/[ ,]+/).map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function parseFrontmatter(contents: string): { metadata: Record<string, unknown>; body: string } {
  const normalized = contents.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return { metadata: {}, body: normalized };
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("unterminated SKILL.md frontmatter");
  return {
    metadata: asObject(YAML.parse(normalized.slice(4, end))),
    body: normalized.slice(end + 5),
  };
}

function listResources(root: string): string[] {
  const result: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "SKILL.md" || entry.name === ".agents") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  };
  visit(root);
  return result;
}

function resourceDigests(root: string, resources: readonly string[]): Array<{ path: string; digest: string }> {
  return resources.map((relative) => {
    const absolute = path.resolve(root, ...relative.split("/"));
    const contained = absolute.startsWith(`${path.resolve(root)}${path.sep}`);
    if (!contained) throw new Error(`skill resource escapes its root: ${relative}`);
    return {
      path: relative,
      digest: createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"),
    };
  });
}

function detectDialect(metadata: Record<string, unknown>, codex: Record<string, unknown>): SkillDialect {
  if (Object.keys(codex).length > 0) return "codex";
  const claudeFields = ["hooks", "shell", "model", "effort", "fork", "agent", "context"];
  return claudeFields.some((field) => field in metadata) ? "claude-code" : "common";
}

export function loadSkill(
  skillFile: string,
  capabilities: Partial<SkillRuntimeCapabilities> = {},
): NormalizedSkill {
  const root = path.dirname(path.resolve(skillFile));
  const { metadata, body } = parseFrontmatter(fs.readFileSync(skillFile, "utf8"));
  const codexPath = path.join(root, ".agents", "openai.yaml");
  const codex = fs.existsSync(codexPath) ? asObject(YAML.parse(fs.readFileSync(codexPath, "utf8"))) : {};
  const dialect = detectDialect(metadata, codex);
  const interfaceConfig = asObject(codex.interface);
  const id = stringValue(metadata.name, path.basename(root)).trim();
  const name = stringValue(interfaceConfig.display_name, id).trim();
  const description = stringValue(
    metadata.description,
    stringValue(interfaceConfig.short_description, "Skill instructions"),
  ).trim();
  if (id.length === 0 || name.length === 0 || description.length === 0) {
    throw new Error(`invalid skill metadata: ${skillFile}`);
  }
  const allowedTools = stringArray(metadata["allowed-tools"] ?? metadata.allowedTools);
  const invocationPolicy = asObject(codex.invocation_policy ?? codex.invocation);
  const invocation = {
    implicit: invocationPolicy.allow_implicit_invocation !== false && metadata["disable-model-invocation"] !== true,
    userInvocable: metadata["user-invocable"] !== false,
  };
  const vendor: NormalizedSkill["vendor"] = {
    ...(metadata.hooks === undefined ? {} : { hooks: metadata.hooks }),
    ...(metadata.shell === undefined ? {} : { shell: metadata.shell }),
    ...(typeof metadata.model === "string" ? { model: metadata.model } : {}),
    ...(typeof metadata.effort === "string" ? { effort: metadata.effort } : {}),
    ...(typeof metadata.fork === "boolean" ? { fork: metadata.fork } : {}),
    ...(typeof metadata.agent === "string" ? { agent: metadata.agent } : {}),
    ...(codex.dependencies === undefined ? {} : { dependencies: codex.dependencies }),
    ...(codex.mcp === undefined ? {} : { mcp: codex.mcp }),
    ...(codex.interface === undefined ? {} : { interface: codex.interface }),
  };
  const resources = listResources(root);
  const effective = { ...DEFAULT_CAPABILITIES, ...capabilities };
  const diagnostics: SkillDiagnostic[] = [];
  const fields: Array<[keyof NormalizedSkill["vendor"], keyof SkillRuntimeCapabilities]> = [
    ["hooks", "hooks"],
    ["shell", "shell"],
    ["mcp", "mcp"],
    ["fork", "fork"],
  ];
  for (const [field, capability] of fields) {
    if (vendor[field] !== undefined && !effective[capability]) {
      diagnostics.push({
        code: "unsupported-field",
        field,
        message: `${dialect} field ${field} is inactive because this runtime capability is unavailable`,
      });
    }
  }
  const executableResource = resources.some((resource) => /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts)$/.test(resource));
  const dependencies = asObject(vendor.dependencies);
  const needsNetwork = metadata.network === true || dependencies.network === true;
  const requiresApproval = executableResource || vendor.hooks !== undefined || vendor.shell !== undefined ||
    vendor.mcp !== undefined || allowedTools.length > 0 || needsNetwork;
  const fingerprintInput = {
    dialect,
    metadata,
    codex,
    body,
    resources: resourceDigests(root, resources),
  };
  const fingerprint = `sha256:${createHash("sha256")
    .update(canonicalRuntimeJson(fingerprintInput))
    .digest("hex")}`;
  if (requiresApproval) {
    diagnostics.push({
      code: "approval-required",
      message: "scripts, hooks, MCP, network, or tool capabilities require this exact fingerprint to be approved",
    });
  }
  return {
    id,
    name,
    description,
    dialect,
    sourcePath: path.resolve(skillFile),
    body,
    resources,
    allowedTools,
    invocation,
    vendor,
    fingerprint,
    requiresApproval,
    diagnostics,
  };
}

export function discoverSkills(
  projectDir: string,
  capabilities: Partial<SkillRuntimeCapabilities> = {},
): NormalizedSkill[] {
  const roots = [
    path.join(projectDir, ".claude", "skills"),
    path.join(projectDir, ".agents", "skills"),
  ];
  const files: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.isFile() && entry.name === "SKILL.md") files.push(absolute);
      }
    };
    visit(root);
  }
  return files.sort().map((file) => loadSkill(file, capabilities));
}

export function activateSkills(
  skills: readonly NormalizedSkill[],
  approvedFingerprints: ReadonlySet<string>,
): { active: NormalizedSkill[]; diagnostics: SkillDiagnostic[] } {
  const diagnostics = skills.flatMap((skill) => skill.diagnostics);
  const active = skills.filter((skill) => !skill.requiresApproval || approvedFingerprints.has(skill.fingerprint));
  return { active, diagnostics };
}

/** Model-facing, on-demand projection of the frozen skill catalog. */
export function createSkillTool(
  skills: readonly NormalizedSkill[],
  hooks?: RuntimeHookBus,
  gateway: ToolGateway = new ToolGateway(),
): Tool | undefined {
  if (skills.length === 0) return undefined;
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const catalog = skills.map((skill) => `${skill.id}: ${skill.description}`).join("\n");
  return tool({
    description:
      `${renderToolDescription(LOAD_SKILL_TOOL_SPEC)} Available skills:\n${catalog}`,
    inputSchema: LOAD_SKILL_TOOL_SPEC.inputSchema,
    execute: async ({ id }) => {
      const claims: [] = [];
      const decision = gateway.authorize({
        invocation: createToolInvocationClaim(LOAD_SKILL_TOOL_SPEC.id, claims),
        policies: [
          { policyId: "runtime-parent-v1", claims },
          { policyId: "skill-role-v1", claims },
          { policyId: `tool:${LOAD_SKILL_TOOL_SPEC.id}`, claims },
        ],
        sandboxed: true,
      });
      if (decision.decision !== "allow") {
        return { error: "skill loading denied by policy", errorKind: "policy_denied" };
      }
      const skill = byId.get(id);
      if (skill === undefined) return { error: `skill not found: ${id}`, errorKind: "not_found" };
      await hooks?.emit("skill.activated", { skillId: skill.id, fingerprint: skill.fingerprint });
      return {
        id: skill.id,
        name: skill.name,
        instructions: skill.body,
        resources: skill.resources,
        allowedTools: skill.allowedTools,
        diagnostics: skill.diagnostics.filter((entry) => entry.code === "unsupported-field"),
      };
    },
  });
}
