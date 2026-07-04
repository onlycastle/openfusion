import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packagedAssetPath, resolveAssetsBaseDir } from "../util/sidecar-runtime.js";

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
  { id: "python", wasmFile: "tree-sitter-python.wasm", queryDir: "python", extensions: [".py"] },
  { id: "go", wasmFile: "tree-sitter-go.wasm", queryDir: "go", extensions: [".go"] },
  { id: "rust", wasmFile: "tree-sitter-rust.wasm", queryDir: "rust", extensions: [".rs"] },
  { id: "java", wasmFile: "tree-sitter-java.wasm", queryDir: "java", extensions: [".java"] },
];

// Resolved-assets case FIRST in both functions below: a pkg snapshot has no
// real node_modules and import.meta.url points into the virtual `/snapshot/`
// filesystem, so the normal dev-mode resolution (require.resolve /
// file-URL-relative) would resolve to paths that don't exist on the real
// filesystem at runtime. build-sidecar.mjs copies the real wasm files and
// queries/ tree into the resolved assets base dir (the sibling
// "<binary>.assets/" dir, or OPENFUSION_ASSETS_DIR in the packaged .app —
// see util/sidecar-runtime.ts's resolveAssetsBaseDir() for the shared
// precedence both this file and wiki/store.ts's nativeBindingOption() /
// wiki/parser.ts's parserInitOptions() derive from).
export function wasmDir(): string {
  if (resolveAssetsBaseDir() !== null) return packagedAssetPath("wasm");
  const require = createRequire(import.meta.url);
  return path.join(
    path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")),
    "wasm",
  );
}

export function queriesDir(): string {
  if (resolveAssetsBaseDir() !== null) return packagedAssetPath("queries");
  // src/wiki/ and dist/wiki/ are both two levels below the package root,
  // where queries/ lives (shipped via package.json "files").
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../queries",
  );
}
