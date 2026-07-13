// File-size ratchet — spec §3 rule 3. Baselined files may shrink, never grow;
// files not in the baseline are "new" and capped at NEW_FILE_LIMIT lines.
// Regenerate the baseline ONLY when a file legitimately shrinks and you want
// to lock in the gain: pnpm arch:budget:rebase.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const NEW_FILE_LIMIT = 400;
const BASELINE_PATH = new URL("./file-budget-baseline.json", import.meta.url);
const INCLUDE = /^(packages\/(engine|shared)\/(src|test)|apps\/desktop\/src)\/.*\.(ts|tsx)$/;

export function checkBudget(entries, baseline) {
  const violations = [];
  for (const { path, lines } of entries) {
    const limit = Object.hasOwn(baseline, path) ? baseline[path] : NEW_FILE_LIMIT;
    if (lines > limit) violations.push({ path, lines, limit });
  }
  return violations;
}

function trackedEntries() {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n").filter((f) => INCLUDE.test(f));
  return files.map((path) => ({
    path,
    lines: readFileSync(path, "utf8").split("\n").length,
  }));
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const mode = process.argv[2];
  if (mode === "--rebase") {
    const baseline = Object.fromEntries(
      trackedEntries().filter((e) => e.lines > NEW_FILE_LIMIT).map((e) => [e.path, e.lines]),
    );
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`baseline written: ${Object.keys(baseline).length} grandfathered files`);
  } else if (mode === "--check" || mode === undefined) {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    const violations = checkBudget(trackedEntries(), baseline);
    for (const v of violations) {
      console.error(`FILE BUDGET: ${v.path} has ${v.lines} lines (limit ${v.limit})`);
    }
    if (violations.length > 0) {
      console.error("\nSplit the file (spec 2026-07-13 §6) — do not raise the limit.");
      process.exit(1);
    }
    console.log("file budget: ok");
  }
}
