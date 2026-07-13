import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkBudget, NEW_FILE_LIMIT } from "./check-file-budget.mjs";

test("baselined file at its recorded size passes", () => {
  assert.deepEqual(checkBudget([{ path: "a.ts", lines: 2000 }], { "a.ts": 2000 }), []);
});
test("baselined file that grew fails with its own limit", () => {
  assert.deepEqual(checkBudget([{ path: "a.ts", lines: 2001 }], { "a.ts": 2000 }), [
    { path: "a.ts", lines: 2001, limit: 2000 },
  ]);
});
test("baselined file that shrank passes (ratchet only bites growth)", () => {
  assert.deepEqual(checkBudget([{ path: "a.ts", lines: 1500 }], { "a.ts": 2000 }), []);
});
test("new file under the cap passes, over the cap fails", () => {
  assert.deepEqual(checkBudget([{ path: "b.ts", lines: 400 }], {}), []);
  assert.deepEqual(checkBudget([{ path: "b.ts", lines: 401 }], {}), [
    { path: "b.ts", lines: 401, limit: NEW_FILE_LIMIT },
  ]);
});
test("unknown CLI mode exits 2 instead of silently passing", () => {
  const script = fileURLToPath(new URL("./check-file-budget.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--chekc"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes("unknown mode"));
});
