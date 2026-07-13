import { describe, expect, it } from "vitest";
import {
  frontierMcpAllowedTools,
  projectMcpTool,
  projectWorkerTool,
} from "../src/tools/projections.js";
import { WIKI_MAP_TOOL_SPEC, WIKI_QUERY_TOOL_SPEC } from "../src/tools/registry.js";
import { renderToolDescription, type ToolSpec } from "../src/tools/spec.js";

describe("ToolSpec projections", () => {
  it("projects the same schema object and description into worker and MCP surfaces", () => {
    const specs: readonly ToolSpec[] = [WIKI_MAP_TOOL_SPEC, WIKI_QUERY_TOOL_SPEC];
    for (const spec of specs) {
      const worker = projectWorkerTool(spec);
      const mcp = projectMcpTool(spec);

      expect(worker.description).toBe(renderToolDescription(spec));
      expect(mcp.description).toBe(worker.description);
      expect(worker.inputSchema).toBe(spec.inputSchema);
      expect(mcp.inputSchema).toBe(worker.inputSchema);
    }
  });

  it("derives the read-only Claude MCP allowlist from registry permissions and scopes", () => {
    expect(frontierMcpAllowedTools("wiki")).toEqual([
      "mcp__wiki__wiki_query",
      "mcp__wiki__wiki_map",
    ]);
  });

  it("rejects an invalid MCP server name instead of constructing an unsafe tool id", () => {
    expect(() => frontierMcpAllowedTools("wiki server")).toThrow("invalid MCP server name");
  });
});
