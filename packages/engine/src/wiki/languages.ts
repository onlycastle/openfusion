import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LanguageSpec {
  id: string;
  wasmFile: string;
  queryDir: string;
  extensions: string[];
}

export const LANGUAGE_SPECS: LanguageSpec[] = [
  {
    id: "typescript",
    wasmFile: "tree-sitter-typescript.wasm",
    queryDir: "typescript",
    extensions: [".ts", ".mts", ".cts"],
  },
  {
    id: "tsx",
    wasmFile: "tree-sitter-tsx.wasm",
    queryDir: "typescript",
    extensions: [".tsx"],
  },
  {
    id: "javascript",
    wasmFile: "tree-sitter-javascript.wasm",
    queryDir: "javascript",
    extensions: [".js", ".mjs", ".cjs", ".jsx"],
  },
];

export function wasmDir(): string {
  const require = createRequire(import.meta.url);
  return path.join(
    path.dirname(require.resolve("tree-sitter-wasms/package.json")),
    "out",
  );
}

export function queriesDir(): string {
  // src/wiki/ and dist/wiki/ are both two levels below the package root,
  // where queries/ lives (shipped via package.json "files").
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../queries",
  );
}
