import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatchToWorktree, parseApplyPatch } from "../src/worker/apply-patch.js";
import { createWorkerRuntime } from "../src/worker/runtime.js";

describe("parseApplyPatch", () => {
  it("parses update/add/delete ops", () => {
    const parsed = parseApplyPatch(`*** Begin Patch
*** Update File: a.ts
@@
 hello
-world
+there
*** Add File: b.ts
+export const x = 1;
*** Delete File: c.ts
*** End Patch`);
    expect("ops" in parsed).toBe(true);
    if ("ops" in parsed) {
      expect(parsed.ops).toHaveLength(3);
      expect(parsed.ops[0]).toMatchObject({ kind: "update", path: "a.ts" });
      expect(parsed.ops[1]).toMatchObject({ kind: "add", path: "b.ts" });
      expect(parsed.ops[2]).toMatchObject({ kind: "delete", path: "c.ts" });
    }
  });
});

describe("applyPatchToWorktree", () => {
  it("updates a file with a unique hunk", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "of-patch-"));
    writeFileSync(path.join(root, "a.ts"), "hello\nworld\n", "utf8");
    const result = applyPatchToWorktree(
      root,
      `*** Begin Patch
*** Update File: a.ts
@@
 hello
-world
+there
*** End Patch`,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(root, "a.ts"), "utf8")).toBe("hello\nthere\n");
  });

  it("rejects non-unique hunks", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "of-patch-"));
    writeFileSync(path.join(root, "a.ts"), "x\nx\n", "utf8");
    const result = applyPatchToWorktree(
      root,
      `*** Begin Patch
*** Update File: a.ts
@@
-x
+y
*** End Patch`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorKind).toBe("not_unique");
  });
});

describe("apply-patch-v1 dialect pack", () => {
  it("exposes apply_patch and not edit", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "of-pack-"));
    const runtime = createWorkerRuntime("apply-patch-v1", { root });
    expect(runtime.tools.apply_patch).toBeDefined();
    expect(runtime.tools.edit).toBeUndefined();
    expect(runtime.instructions).toContain("apply_patch");
    expect(runtime.editDialect).toBe("apply-patch");
  });
});
