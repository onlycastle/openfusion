import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WikiParser } from "../src/wiki/parser.js";

let parser: WikiParser;
beforeAll(async () => {
  parser = await WikiParser.create();
}, 30_000);
afterAll(() => parser.dispose());

const TS_SOURCE = `
export function greet(name: string): string {
  return format(name);
}
export class Greeter {
  wave(): void {
    greet("hi");
  }
}
`;

describe("WikiParser", () => {
  it("extracts definitions from TypeScript source", () => {
    const result = parser.parseFile("src/a.ts", TS_SOURCE);
    expect(result).not.toBeNull();
    const names = result!.symbols.map((s) => s.name);
    expect(names).toContain("greet");
    expect(names).toContain("Greeter");
    expect(names).toContain("wave");
    const greet = result!.symbols.find((s) => s.name === "greet")!;
    expect(greet.kind.length).toBeGreaterThan(0);
    expect(greet.row).toBeGreaterThan(0);
  });

  it("extracts references (calls)", () => {
    const result = parser.parseFile("src/a.ts", TS_SOURCE);
    const refNames = result!.refs.map((r) => r.name);
    expect(refNames).toContain("format");
    expect(refNames).toContain("greet");
  });

  it("parses .tsx and .js via their grammars", () => {
    expect(
      parser.parseFile("c.tsx", "export function App() { return <div/>; }"),
    ).not.toBeNull();
    expect(
      parser.parseFile("b.js", "function jsOnly() {} jsOnly();"),
    ).not.toBeNull();
  });

  it("returns null for unsupported extensions", () => {
    expect(parser.parseFile("readme.md", "# hi")).toBeNull();
  });

  it("reports supported extensions", () => {
    const exts = parser.supportedExtensions();
    expect(exts.has(".ts")).toBe(true);
    expect(exts.has(".tsx")).toBe(true);
    expect(exts.has(".js")).toBe(true);
  });

  it("does not double-count new-expression class references", () => {
    const result = parser.parseFile(
      "n.ts",
      "class Foo {}\nconst x = new Foo();\n",
    );
    const fooClassRefs = result!.refs.filter(
      (r) => r.name === "Foo" && r.kind === "class",
    );
    expect(fooClassRefs).toHaveLength(1);
  });
});
