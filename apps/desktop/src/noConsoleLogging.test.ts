// A static, grep-style check: nothing under this app's source ever calls
// console.*. This is a stronger and simpler invariant to hold and verify
// than "never log THESE specific fields" — engine call params/results and
// secret values pass through several layers (engineClient.ts, the Keys/
// Project screens), and a field-by-field audit would need updating every
// time a new call site is added. A blanket ban doesn't.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url));

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      files.push(fullPath);
    }
  }
  return files;
}

const CONSOLE_CALL = /console\s*\.\s*(log|debug|info|warn|error|trace)\s*\(/;

describe("no console.* logging anywhere in the desktop frontend source", () => {
  const files = listSourceFiles(srcDir);

  it("found at least one non-test source file to check (sanity check the scan itself works)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file.slice(srcDir.length + 1)} contains no console.* calls`, () => {
      const source = readFileSync(file, "utf8");
      expect(CONSOLE_CALL.test(source)).toBe(false);
    });
  }
});
