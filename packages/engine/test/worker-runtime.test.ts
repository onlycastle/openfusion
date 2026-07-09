import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkerRuntime } from "../src/worker/runtime.js";
import { createWorkerTools, type ToolEvent } from "../src/worker/tools.js";

const FAKE_OPTS = { toolCallId: "test-call", messages: [], context: {} };

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "of-runtime-"));
}

function getExecute(
  t: { execute?: unknown } | undefined,
): (input: unknown, opts: unknown) => Promise<{ error?: string; ok?: true }> {
  const exec = t?.execute;
  if (typeof exec !== "function") throw new Error("tool has no execute");
  return exec as (input: unknown, opts: unknown) => Promise<{ error?: string; ok?: true }>;
}

describe("createWorkerRuntime", () => {
  it("string-edit-default includes edit + write_file and emits base instructions", () => {
    const root = makeRoot();
    const runtime = createWorkerRuntime("string-edit-default", { root });
    expect(runtime.dialectPackId).toBe("string-edit-default");
    expect(runtime.tools.edit).toBeDefined();
    expect(runtime.tools.write_file).toBeDefined();
    expect(runtime.tools.bash).toBeDefined();
    expect(runtime.instructions).toContain("coding worker");
    expect(runtime.telemetryBase.editDialect).toBe("string-replace");
  });

  it("whole-file-prefer omits edit and mentions write_file in instructions", () => {
    const root = makeRoot();
    const runtime = createWorkerRuntime("whole-file-prefer", { root });
    expect(runtime.tools.edit).toBeUndefined();
    expect(runtime.tools.write_file).toBeDefined();
    expect(runtime.instructions).toContain("write_file");
    expect(runtime.editDialect).toBe("whole-file");
  });

  it("string-edit-strict tightens edit description and retry hints", () => {
    const root = makeRoot();
    const runtime = createWorkerRuntime("string-edit-strict", { root });
    expect(runtime.tools.edit).toBeDefined();
    expect(runtime.instructions).toContain("unique");
    expect(runtime.retryHintFor("edit", "not_unique")).toContain("widen");
    expect(runtime.retryHintFor("edit", "not_found")).toContain("Re-read");
  });

  it("packs produce different tool sets (measurable, not cosmetic)", () => {
    const root = makeRoot();
    const a = createWorkerRuntime("string-edit-default", { root });
    const b = createWorkerRuntime("whole-file-prefer", { root });
    expect(Object.keys(a.tools).sort()).not.toEqual(Object.keys(b.tools).sort());
    expect(a.instructions).not.toBe(b.instructions);
  });
});

describe("tool error telemetry", () => {
  it("classifies edit not_found and not_unique failures", async () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "f.txt"), "hello world hello\n", "utf8");
    const events: ToolEvent[] = [];
    const tools = createWorkerTools({
      root,
      onToolEvent: (e) => events.push(e),
    });

    const edit = getExecute(tools.edit);

    await edit({ path: "f.txt", find: "missing", replace: "x" }, FAKE_OPTS);
    await edit({ path: "f.txt", find: "hello", replace: "x" }, FAKE_OPTS);

    expect(events.some((e) => e.tool === "edit" && e.errorKind === "not_found" && !e.ok)).toBe(
      true,
    );
    expect(events.some((e) => e.tool === "edit" && e.errorKind === "not_unique" && !e.ok)).toBe(
      true,
    );
  });
});
