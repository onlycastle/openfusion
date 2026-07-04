import path from "node:path";

// Detects whether this process is the compiled sidecar binary (built by
// scripts/build-sidecar.mjs via @yao-pkg/pkg) rather than plain `node
// dist/main.js`. `@yao-pkg/pkg` (like its vercel/pkg ancestor) sets
// `process.pkg` on every packaged run — documented upstream as the
// supported userland check (see pkg's bootstrap-shared.js /
// sea-worker-entry.js) — so this is the same signal pkg itself expects
// callers to use, not a fragile heuristic we invented.
//
// Why this matters: a pkg snapshot has no real `node_modules` on disk (it's
// a V8-snapshot-embedded virtual filesystem mounted at `/snapshot/...`), so
// require.resolve()/import.meta.url-relative lookups that work fine in dev
// (running straight off `dist/`) silently resolve to paths that don't exist
// at runtime once compiled. Both the tree-sitter wasm assets (wiki/
// languages.ts) and better-sqlite3's native addon (wiki/store.ts) need a
// packaged-mode branch that instead resolves against the REAL sibling
// assets directory build-sidecar.mjs copies next to the executable.
export function isPackagedSidecar(): boolean {
  return "pkg" in process;
}

// The sibling assets directory build-sidecar.mjs populates next to the
// compiled binary — named "<binary-basename>.assets" so one glob
// (`openfusion-engine-*`) covers both the binary and its assets when the
// Tauri .app bundle stages externalBin outputs (M8). `process.execPath`
// inside a pkg-compiled binary is patched to the REAL path of the
// executable itself (not the embedded Node runtime) — see pkg's
// bootstrap.js — so this is stable across install locations.
export function packagedAssetsDir(): string {
  return `${process.execPath}.assets`;
}

export function packagedAssetPath(...segments: string[]): string {
  return path.join(packagedAssetsDir(), ...segments);
}
