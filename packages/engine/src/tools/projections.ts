import type { z } from "zod";
import { listToolSpecs } from "./registry.js";
import { renderToolDescription, type ToolSpec } from "./spec.js";

export interface ProjectedToolContract<TInputSchema extends z.ZodType = z.ZodType> {
  description: string;
  inputSchema: TInputSchema;
}

function projectToolContract<const TInputSchema extends z.ZodType>(
  spec: ToolSpec<TInputSchema>,
): ProjectedToolContract<TInputSchema> {
  return {
    description: renderToolDescription(spec),
    inputSchema: spec.inputSchema,
  };
}

export function projectWorkerTool<const TInputSchema extends z.ZodType>(
  spec: ToolSpec<TInputSchema>,
): ProjectedToolContract<TInputSchema> {
  if (!spec.transports.includes("worker")) {
    throw new Error(`tool ${spec.id} is not available on the worker transport`);
  }
  return projectToolContract(spec);
}

export function projectMcpTool<const TInputSchema extends z.ZodType>(
  spec: ToolSpec<TInputSchema>,
): ProjectedToolContract<TInputSchema> {
  if (!spec.transports.includes("mcp")) {
    throw new Error(`tool ${spec.id} is not available on the MCP transport`);
  }
  return projectToolContract(spec);
}

export function frontierMcpAllowedTools(serverName: string): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(serverName)) {
    throw new Error(`invalid MCP server name: ${serverName}`);
  }
  return listToolSpecs()
    .filter(
      (spec) =>
        spec.permission === "read" &&
        spec.transports.includes("mcp") &&
        spec.transports.includes("frontier") &&
        spec.allowedAgentScopes.includes("frontier-readonly"),
    )
    .map((spec) => `mcp__${serverName}__${spec.id}`);
}
