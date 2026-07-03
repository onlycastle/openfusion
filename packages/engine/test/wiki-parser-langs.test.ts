import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WikiParser } from "../src/wiki/parser.js";

let parser: WikiParser;
beforeAll(async () => {
  parser = await WikiParser.create();
}, 60_000);
afterAll(() => parser.dispose());

const CASES: Array<{ file: string; source: string; def: string }> = [
  { file: "a.py", source: "def snake(x):\n    return x\n", def: "snake" },
  { file: "b.go", source: "package p\n\nfunc Gopher() int { return 1 }\n", def: "Gopher" },
  { file: "c.rs", source: "pub fn ferris() -> i32 { 1 }\n", def: "ferris" },
  {
    file: "D.java",
    source: "class D {\n  int brew() { return 1; }\n}\n",
    def: "brew",
  },
];

describe("multi-language parsing", () => {
  for (const c of CASES) {
    it(`extracts definitions from ${c.file}`, () => {
      const result = parser.parseFile(c.file, c.source);
      expect(result).not.toBeNull();
      expect(result!.symbols.map((s) => s.name)).toContain(c.def);
    });
  }

  it("reports the new extensions as supported", () => {
    const exts = parser.supportedExtensions();
    for (const e of [".py", ".go", ".rs", ".java"]) {
      expect(exts.has(e)).toBe(true);
    }
  });
});
