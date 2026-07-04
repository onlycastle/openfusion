import { existsSync } from "node:fs";
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

// M8 Blocker B: in a PACKAGED `.app`, Tauri strips the target-triple suffix
// from the externalBin binary and stages it at
// `Contents/MacOS/openfusion-engine`, while `bundle.resources` (the only way
// to ship the sibling `.assets/` dir — Tauri has no sibling-file mechanism
// for externalBin) copies `.assets/` into `Contents/Resources/` — a
// DIFFERENT directory. So `${execPath}.assets` self-location (below) cannot
// find it there; the Rust host resolves the real Resources dir and passes
// it via `OPENFUSION_ASSETS_DIR` on the spawned sidecar's env. See
// docs/research/2026-07-04-m8-signing-verification.md (Blocker B).
//
// resolveAssetsBaseDir() is the single source of truth every asset consumer
// (wiki/store.ts's nativeBinding, wiki/parser.ts's locateFile, wiki/
// languages.ts's wasmDir()/queriesDir()) derives from, so setting the one
// env var covers all of them. Precedence:
//
//   1. `OPENFUSION_ASSETS_DIR`, if set AND the directory exists — the
//      packaged-.app case. Checked first and unconditionally (not gated on
//      isPackagedSidecar()) so it also applies to a plain `node dist/
//      main.js` run with the env var forced on, e.g. this file's own tests.
//   2. `${process.execPath}.assets`, if isPackagedSidecar() — the M7a
//      standalone-binary convention (build-sidecar.mjs stages assets as a
//      SIBLING of the binary; `process.execPath` inside a pkg-compiled
//      binary is patched to the REAL path of the executable itself, not the
//      embedded Node runtime — see pkg's bootstrap.js — so this is stable
//      across install locations). UNCHANGED: test/sidecar-binary.test.ts
//      exercises exactly this branch with no env var set.
//   3. `null` — a plain, un-packaged dev/test engine. Callers fall back to
//      their own node_modules/source-relative resolution, UNCHANGED.
//
// A bad/stale env var (pointing at a directory that doesn't exist) is NOT
// trusted blindly — it falls through to cases 2/3 rather than handing
// callers a base dir with nothing in it.
//
// Expected layout under the resolved base dir (MUST match build-sidecar.
// mjs's `copyAssets` and Task 2's Rust-side `bundle.resources` mapping):
//   <base>/better_sqlite3.node
//   <base>/wasm/web-tree-sitter.wasm
//   <base>/wasm/tree-sitter-<lang>.wasm
//   <base>/queries/<lang>/tags.scm
export function resolveAssetsBaseDir(): string | null {
  const envDir = process.env.OPENFUSION_ASSETS_DIR;
  if (envDir !== undefined && envDir.length > 0 && existsSync(envDir)) {
    return envDir;
  }
  if (isPackagedSidecar()) {
    return `${process.execPath}.assets`;
  }
  return null;
}

export function packagedAssetsDir(): string {
  const resolved = resolveAssetsBaseDir();
  if (resolved === null) {
    throw new Error(
      "packagedAssetsDir(): no assets base dir resolved (OPENFUSION_ASSETS_DIR " +
        "is unset/missing and this is not a packaged sidecar) — callers must " +
        "gate on resolveAssetsBaseDir() !== null before calling this",
    );
  }
  return resolved;
}

export function packagedAssetPath(...segments: string[]): string {
  return path.join(packagedAssetsDir(), ...segments);
}
