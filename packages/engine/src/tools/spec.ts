import { z } from "zod";

export type ToolPermission = "read" | "write" | "execute" | "network" | "dangerous";
export type ToolTransport = "worker" | "mcp" | "frontier";

/**
 * Transport-neutral model-facing contract for one tool.
 *
 * Runtime handlers deliberately do not live here: the registry is allowed to
 * describe and expose an existing capability, but it is not an indirection
 * through which an optimizer can replace the implementation or expand its
 * permissions.
 */
export interface ToolSpec<TInputSchema extends z.ZodType = z.ZodType> {
  id: string;
  version: string;
  summary: string;
  whenToUse: string;
  inputSchema: TInputSchema;
  outputSemantics: string;
  permission: ToolPermission;
  transports: readonly ToolTransport[];
  allowedAgentScopes: readonly string[];
  implementationRef: string;
}

export function defineToolSpec<const TInputSchema extends z.ZodType>(
  spec: ToolSpec<TInputSchema>,
): Readonly<ToolSpec<TInputSchema>> {
  if (spec.id.length === 0) throw new Error("tool id must not be empty");
  if (spec.version.length === 0) throw new Error(`tool ${spec.id} version must not be empty`);
  if (new Set(spec.transports).size !== spec.transports.length) {
    throw new Error(`tool ${spec.id} has duplicate transports`);
  }
  if (new Set(spec.allowedAgentScopes).size !== spec.allowedAgentScopes.length) {
    throw new Error(`tool ${spec.id} has duplicate agent scopes`);
  }

  return Object.freeze({
    ...spec,
    transports: Object.freeze([...spec.transports]),
    allowedAgentScopes: Object.freeze([...spec.allowedAgentScopes]),
  });
}

export function renderToolDescription(spec: ToolSpec): string {
  return `${spec.summary} When to use: ${spec.whenToUse}`;
}

