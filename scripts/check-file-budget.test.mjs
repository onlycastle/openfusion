import { test } from "node:test";
import assert from "node:assert/strict";
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
