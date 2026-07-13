import { describe, expect, it } from "vitest";
import {
  APPLY_PATCH_TOOL_SPEC,
  BASH_TOOL_SPEC,
  CLOSE_CHILD_TOOL_SPEC,
  EDIT_TOOL_SPEC,
  fingerprintToolSpecs,
  listToolSpecs,
  LOAD_SKILL_TOOL_SPEC,
  IMPORT_CHILD_DIFF_TOOL_SPEC,
  LIST_CHILDREN_TOOL_SPEC,
  READ_FILE_TOOL_SPEC,
  READ_TOOL_OUTPUT_SPEC,
  SEND_CHILD_TOOL_SPEC,
  SPAWN_CHILD_TOOL_SPEC,
  TOOL_REGISTRY_FINGERPRINT,
  TOOL_REGISTRY_VERSION,
  WIKI_MAP_TOOL_SPEC,
  WIKI_QUERY_TOOL_SPEC,
  WAIT_CHILD_TOOL_SPEC,
  WRITE_FILE_TOOL_SPEC,
} from "../src/tools/registry.js";
import { defineToolSpec } from "../src/tools/spec.js";

describe("ToolSpec registry", () => {
  it("has deterministic unique ordering and a content fingerprint", () => {
    const specs = listToolSpecs();
    expect(specs.map((spec) => spec.id)).toEqual([
      "wiki_query",
      "wiki_map",
      "bash",
      "read_tool_output",
      "load_skill",
      "spawn_child",
      "send_child",
      "list_children",
      "wait_child",
      "close_child",
      "import_child_diff",
      "read_file",
      "write_file",
      "edit",
      "apply_patch",
    ]);
    expect(new Set(specs.map((spec) => spec.id)).size).toBe(specs.length);
    expect(TOOL_REGISTRY_FINGERPRINT.version).toBe(TOOL_REGISTRY_VERSION);
    expect(TOOL_REGISTRY_FINGERPRINT.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fingerprintToolSpecs([...specs].reverse())).toEqual(TOOL_REGISTRY_FINGERPRINT);
  });

  it("catalogues every core file, edit, process, and artifact tool", () => {
    expect(BASH_TOOL_SPEC.permission).toBe("execute");
    expect(READ_TOOL_OUTPUT_SPEC.permission).toBe("read");
    expect(LOAD_SKILL_TOOL_SPEC.permission).toBe("read");
    expect(SPAWN_CHILD_TOOL_SPEC.permission).toBe("dangerous");
    expect(SEND_CHILD_TOOL_SPEC.permission).toBe("dangerous");
    expect(LIST_CHILDREN_TOOL_SPEC.permission).toBe("read");
    expect(WAIT_CHILD_TOOL_SPEC.permission).toBe("read");
    expect(CLOSE_CHILD_TOOL_SPEC.permission).toBe("dangerous");
    expect(IMPORT_CHILD_DIFF_TOOL_SPEC.permission).toBe("dangerous");
    expect(READ_FILE_TOOL_SPEC.inputSchema.safeParse({ path: "src/index.ts" }).success).toBe(true);
    expect(WRITE_FILE_TOOL_SPEC.permission).toBe("write");
    expect(EDIT_TOOL_SPEC.inputSchema.safeParse({ path: "x", find: "a", replace: "b" }).success).toBe(true);
    expect(APPLY_PATCH_TOOL_SPEC.permission).toBe("write");
  });

  it("uses the public MCP symbol contract for every wiki_query projection", () => {
    expect(WIKI_QUERY_TOOL_SPEC.inputSchema.parse({ symbol: "renderMap" })).toEqual({
      symbol: "renderMap",
    });
    expect(WIKI_QUERY_TOOL_SPEC.inputSchema.safeParse({ query: "renderMap" }).success).toBe(false);
    expect(WIKI_QUERY_TOOL_SPEC.permission).toBe("read");
    expect(WIKI_QUERY_TOOL_SPEC.transports).toEqual(["worker", "mcp", "frontier"]);
  });

  it("keeps the map budget bounds in the shared schema", () => {
    expect(WIKI_MAP_TOOL_SPEC.inputSchema.safeParse({}).success).toBe(true);
    expect(
      WIKI_MAP_TOOL_SPEC.inputSchema.safeParse({ query: "fix stale wiki rebuild" }).success,
    ).toBe(true);
    expect(WIKI_MAP_TOOL_SPEC.inputSchema.safeParse({ budgetTokens: 64 }).success).toBe(true);
    expect(WIKI_MAP_TOOL_SPEC.inputSchema.safeParse({ budgetTokens: 32_768 }).success).toBe(true);
    expect(WIKI_MAP_TOOL_SPEC.inputSchema.safeParse({ budgetTokens: 63 }).success).toBe(false);
    expect(WIKI_MAP_TOOL_SPEC.inputSchema.safeParse({ budgetTokens: 32_769 }).success).toBe(false);
  });

  it("changes the registry digest when model-facing guidance changes", () => {
    const changed = defineToolSpec({
      ...WIKI_QUERY_TOOL_SPEC,
      summary: `${WIKI_QUERY_TOOL_SPEC.summary} Prefer exact symbol names.`,
    });
    const candidate = fingerprintToolSpecs([WIKI_MAP_TOOL_SPEC, changed]);

    expect(candidate.digest).not.toBe(TOOL_REGISTRY_FINGERPRINT.digest);
    expect(candidate.tools.find((tool) => tool.id === "wiki_map")).toEqual(
      TOOL_REGISTRY_FINGERPRINT.tools.find((tool) => tool.id === "wiki_map"),
    );
  });

  it("rejects duplicate tool ids from a candidate inventory", () => {
    expect(() => fingerprintToolSpecs([WIKI_MAP_TOOL_SPEC, WIKI_MAP_TOOL_SPEC])).toThrow(
      "duplicate ids",
    );
  });
});
