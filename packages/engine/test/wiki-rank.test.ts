import { describe, expect, it } from "vitest";
import { rankFiles, renderRepoMap } from "../src/wiki/rank.js";
import type { SymbolHit } from "../src/wiki/store.js";

function sym(file: string, name: string): SymbolHit {
  return { file, name, kind: "function", row: 0, col: 0 };
}

describe("rankFiles", () => {
  it("ranks the file everyone references highest", () => {
    const symbols = [sym("core.ts", "util"), sym("a.ts", "a"), sym("b.ts", "b")];
    const refs = [sym("a.ts", "util"), sym("b.ts", "util")];
    const ranked = rankFiles(symbols, refs);
    expect(ranked[0]?.file).toBe("core.ts");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("ignores refs to names defined nowhere (noise filter)", () => {
    const symbols = [sym("a.ts", "a"), sym("b.ts", "b")];
    const refs = [sym("a.ts", "toString"), sym("a.ts", "b")];
    const ranked = rankFiles(symbols, refs);
    expect(ranked[0]?.file).toBe("b.ts");
  });

  it("lists defined symbols per ranked file", () => {
    const symbols = [sym("a.ts", "one"), sym("a.ts", "two")];
    const ranked = rankFiles(symbols, []);
    expect(ranked[0]?.definedSymbols).toEqual(["one", "two"]);
  });
});

describe("renderRepoMap", () => {
  it("stays within the token budget by dropping whole blocks", () => {
    const ranked = Array.from({ length: 50 }, (_, i) => ({
      file: `src/file${i}.ts`,
      score: 1 - i / 100,
      definedSymbols: ["alpha", "beta", "gamma"],
    }));
    const map = renderRepoMap(ranked, 100);
    expect(map.length / 4).toBeLessThanOrEqual(100);
    expect(map).toContain("src/file0.ts");
    expect(map).not.toContain("src/file49.ts");
  });

  it("skips files with empty definedSymbols", () => {
    const ranked = [
      { file: "a.ts", score: 1, definedSymbols: [] },
      { file: "b.ts", score: 0.5, definedSymbols: ["x"] },
    ];
    const map = renderRepoMap(ranked, 1000);
    expect(map).toContain("b.ts");
    expect(map).not.toContain("a.ts");
  });
});
