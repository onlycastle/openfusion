#!/usr/bin/env node
// Compiles @openfusion/engine into a self-contained sidecar binary that
// speaks the engine's JSON-RPC-over-stdio protocol — the artifact Tauri's
// `bundle.externalBin` spawns as a subprocess (M8's desktop shell). See
// docs/research/2026-07-04-m7-tauri-verification.md for the wider context.
//
// Pipeline: tsc build → esbuild single-file bundle (works around @yao-pkg/
// pkg's poor resolution of pnpm-workspace `exports`-only package.json fields
// and monorepo symlinks — see the "why bundle first" note below) → @yao-pkg/
// pkg compiles the bundle to a native executable with an embedded Node 24
// runtime → sibling assets (better-sqlite3's native addon, tree-sitter's
// wasm files, the tags.scm query files) are copied next to the binary in a
// documented layout, since none of them can live INSIDE the compiled binary
// (native code can't be embedded in a V8 snapshot; the wasm files similarly
// need a real path on disk at runtime — see wiki/languages.ts, wiki/
// store.ts, wiki/parser.ts, and util/sidecar-runtime.ts for the runtime-side
// half of this contract).
//
// Runtime asset layout (Tauri externalBin convention — filenames carry the
// Rust target triple):
//   dist-sidecar/openfusion-engine-<triple>            (the executable)
//   dist-sidecar/openfusion-engine-<triple>.assets/
//     better_sqlite3.node                              (native addon)
//     wasm/web-tree-sitter.wasm                         (tree-sitter core runtime)
//     wasm/tree-sitter-<lang>.wasm                      (per-language grammars)
//     queries/<lang>/tags.scm                           (symbol/ref queries)
//
// Idempotent: wipes only THIS triple's prior outputs (binary + its .assets
// dir) plus its own private staging directory before regenerating, so
// artifacts for other triples built into the same dist-sidecar/ (e.g. by a
// future CI matrix) are left alone.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { exec as pkgExec } from "@yao-pkg/pkg";

// Active LTS as of 2026-07 (Node 22 winding down, Node 26 becomes LTS Oct
// 2026 — see the M7 tech-verification doc's "Sanity" section). Pinned
// independently of whatever Node runs this build script or the dev/test
// suite (currently Node 25 locally) — @yao-pkg/pkg's pkg-fetch downloads a
// prebuilt Node runtime matching this version to embed in the executable,
// and the better-sqlite3 native addon fetched below is matched to the SAME
// ABI so the two agree at runtime regardless of the host's own Node version.
const PINNED_NODE_VERSION = "24.18.0";

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(engineRoot, "dist", "main.js");
const sidecarDir = path.join(engineRoot, "dist-sidecar");
const require = createRequire(import.meta.url);

function log(message) {
  process.stdout.write(`[build-sidecar] ${message}\n`);
}

// Rust target-triple naming (Tauri's `bundle.externalBin` convention: the
// bundler appends `-<triple>` to the configured binary name). Only
// darwin-arm64 (this machine) has been exercised end-to-end; the others are
// the obvious mechanical mapping for when M8 needs a CI matrix.
function targetTriple() {
  const table = {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:arm64": "aarch64-unknown-linux-gnu",
    "linux:x64": "x86_64-unknown-linux-gnu",
    "win32:x64": "x86_64-pc-windows-msvc",
  };
  const key = `${os.platform()}:${os.arch()}`;
  const triple = table[key];
  if (triple === undefined) {
    throw new Error(`build-sidecar: no Rust target-triple mapping for host "${key}"`);
  }
  return triple;
}

// @yao-pkg/pkg's own target syntax: `node<major>-<os>-<arch>`.
function pkgTarget() {
  const osTable = { darwin: "macos", linux: "linux", win32: "win" };
  const pkgOs = osTable[os.platform()];
  if (pkgOs === undefined) {
    throw new Error(`build-sidecar: no pkg target mapping for host platform "${os.platform()}"`);
  }
  return `node24-${pkgOs}-${os.arch()}`;
}

function runTsc() {
  log("tsc build …");
  const tsc = require.resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", path.join(engineRoot, "tsconfig.json")], {
    cwd: engineRoot,
    stdio: "inherit",
  });
}

// web-tree-sitter's Node-environment bootstrap uses `await import("module")`
// / `await import("fs/promises")` to dynamically import Node BUILT-INS
// (isomorphic browser/Node compat — irrelevant here, we only ever run in
// Node). This is fatal once compiled: @yao-pkg/pkg (inherited from vercel/
// pkg — see github.com/vercel/pkg/issues/1603, unresolved for years) cannot
// execute ANY `import()` inside a compiled binary at all — even a minimal
// `await import("fs/promises")` with no other code throws
// `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` (verified directly against this
// pkg version with a standalone repro — see the task report). Rewriting the
// two call sites to synchronous `require()` calls sidesteps it entirely.
// The plugin throws if the expected source text is missing so a future
// web-tree-sitter upgrade that changes this code fails the BUILD loudly
// instead of failing silently at binary-runtime.
const dynamicImportShimPlugin = {
  name: "shim-web-tree-sitter-dynamic-import",
  setup(build) {
    build.onLoad({ filter: /web-tree-sitter\.js$/ }, (args) => {
      const original = require("node:fs").readFileSync(args.path, "utf8");
      const patched = original
        .replaceAll('import("fs/promises")', "Promise.resolve(__ofFsPromises)")
        .replaceAll('import("module")', "Promise.resolve({ createRequire: __ofCreateRequire })");
      if (patched === original) {
        throw new Error(
          "build-sidecar: web-tree-sitter's dynamic-import shim found nothing to patch — " +
            "the package likely changed; re-verify the pkg dynamic-import workaround before shipping.",
        );
      }
      return { contents: patched, loader: "js" };
    });
  },
};

// esbuild bundles everything (including the `@openfusion/shared` workspace
// package and web-tree-sitter/@vscode/tree-sitter-wasm's pure-JS glue) into
// ONE file, deliberately NOT relying on @yao-pkg/pkg's own module-graph
// walker: pkg's resolver doesn't follow `exports`-map-only package.json
// fields (no `main` fallback), which silently drops workspace-linked
// packages like `@openfusion/shared` (`Cannot find module` at binary
// runtime) — reproduced and confirmed before landing on this bundle-first
// shape. better-sqlite3 stays external: it's a native addon, and native
// code cannot be embedded in a bundle or a V8 snapshot at all — it has to
// ride alongside the binary (see the runtime-asset-layout note above and
// wiki/store.ts's `nativeBinding` handling).
//
// `format: "cjs"` (not esm): web-tree-sitter's own bootstrap reads
// `import.meta.url` at several points; esbuild's cjs output can't preserve
// real import.meta semantics (it becomes `undefined`, breaking those
// reads), so `define` below pins it to an inert placeholder string instead
// — safe because our OWN `import.meta.url`-dependent code (wiki/
// languages.ts's dev-mode branches) is guarded behind `isPackagedSidecar()`
// and never executes in a compiled binary. (An ESM bundle was tried first
// and independently hit the pkg dynamic-import limitation above, so cjs
// isn't a regression — see the task report for the full elimination order.)
async function bundle(stageDir) {
  log("esbuild bundle …");
  const outfile = path.join(stageDir, "main.cjs");
  await esbuild.build({
    entryPoints: [distEntry],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile,
    external: ["better-sqlite3"],
    define: {
      "import.meta.url": JSON.stringify("file:///openfusion-engine-sidecar-entry.js"),
    },
    // Real top-level `require`s captured under names that can't collide with
    // any local `var require = …` the bundled code declares further down
    // (web-tree-sitter's own bootstrap does exactly that, and — because
    // `var` hoists through the whole function — a same-named replacement
    // would shadow itself with `undefined` at the point of the call).
    banner: {
      js:
        'const __ofCreateRequire = require("module").createRequire;\n' +
        'const __ofFsPromises = require("fs/promises");',
    },
    plugins: [dynamicImportShimPlugin],
    logLevel: "warning",
  });
  return outfile;
}

// better-sqlite3 ships prebuilt native addons per Node ABI (via
// prebuild-install, downloading from better-sqlite3's GitHub releases). The
// copy already installed in node_modules is built against whatever Node ABI
// runs THIS machine's dev/test suite (Node 25, ABI 141) — NOT the pinned
// Node 24 (ABI 137) embedded in the compiled binary; loading an ABI-141
// addon under an ABI-137 runtime fails loudly at dlopen time ("NODE_MODULE_
// VERSION 141 ... requires ... 137", verified directly). Fetching a
// Node-24-matched prebuilt into an ISOLATED staging copy (never touching
// the real node_modules/better-sqlite3 the dev Node/test suite uses) keeps
// this build reproducible on any dev machine regardless of its local Node
// version, without disturbing the 528-test dev suite's own native addon.
function fetchNativeAddon(stageDir) {
  log(`fetching better-sqlite3 native addon for Node ${PINNED_NODE_VERSION} (${os.platform()}/${os.arch()}) …`);
  const realPackageDir = path.dirname(require.resolve("better-sqlite3/package.json"));
  const stagedPackageDir = path.join(stageDir, "better-sqlite3");
  rmSync(stagedPackageDir, { recursive: true, force: true });
  cpSync(realPackageDir, stagedPackageDir, { recursive: true });
  // Drop whatever the real copy already had built/downloaded (the wrong
  // ABI) so a stale artifact can't be picked up if the fetch below no-ops.
  rmSync(path.join(stagedPackageDir, "build"), { recursive: true, force: true });
  rmSync(path.join(stagedPackageDir, "prebuilds"), { recursive: true, force: true });

  // Resolved from the REAL package (not the staged copy, which doesn't get
  // its own node_modules) — prebuild-install is a runtime dependency of
  // better-sqlite3 itself, sitting alongside it in the real node_modules.
  const requireFromBs = createRequire(path.join(realPackageDir, "package.json"));
  const prebuildInstallBin = requireFromBs.resolve("prebuild-install/bin.js");

  execFileSync(
    process.execPath,
    [
      prebuildInstallBin,
      `--target=${PINNED_NODE_VERSION}`,
      "--runtime=node",
      `--arch=${os.arch()}`,
      `--platform=${os.platform()}`,
    ],
    { cwd: stagedPackageDir, stdio: "inherit" },
  );

  const nativeAddon = path.join(stagedPackageDir, "build", "Release", "better_sqlite3.node");
  if (!existsSync(nativeAddon)) {
    throw new Error(`build-sidecar: expected prebuild-install to produce ${nativeAddon}`);
  }
  return nativeAddon;
}

function copyAssets(assetsDir, nativeAddonPath) {
  log("staging sibling assets (native addon + wasm + queries) …");
  mkdirSync(assetsDir, { recursive: true });
  cpSync(nativeAddonPath, path.join(assetsDir, "better_sqlite3.node"));

  const wasmOut = path.join(assetsDir, "wasm");
  mkdirSync(wasmOut, { recursive: true });
  // Tree-sitter's own core runtime wasm (distinct from the per-language
  // grammars below) — Parser.init()'s `locateFile` hook (wiki/parser.ts)
  // looks for this exact filename. Resolved via the package's own `exports`
  // map subpath (it doesn't expose "./package.json", unlike
  // @vscode/tree-sitter-wasm below, so this can't go through the
  // dirname(resolve(package.json)) pattern languages.ts's dev-mode code uses).
  cpSync(
    require.resolve("web-tree-sitter/web-tree-sitter.wasm"),
    path.join(wasmOut, "web-tree-sitter.wasm"),
  );
  const grammarWasmDir = path.join(
    path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")),
    "wasm",
  );
  for (const file of readdirSync(grammarWasmDir)) {
    if (file.endsWith(".wasm")) cpSync(path.join(grammarWasmDir, file), path.join(wasmOut, file));
  }

  cpSync(path.join(engineRoot, "queries"), path.join(assetsDir, "queries"), { recursive: true });
}

async function main() {
  const triple = targetTriple();
  const binaryName = `openfusion-engine-${triple}`;
  const binaryPath = path.join(sidecarDir, binaryName);
  const assetsDir = `${binaryPath}.assets`;
  const stageDir = path.join(sidecarDir, `.stage-${triple}`);

  // Idempotent: only this triple's previous outputs + private staging dir
  // are cleared, so other triples' artifacts already sitting in
  // dist-sidecar/ (a future cross-compile CI matrix) are left untouched.
  rmSync(binaryPath, { force: true });
  rmSync(assetsDir, { recursive: true, force: true });
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(sidecarDir, { recursive: true });

  runTsc();
  const bundlePath = await bundle(stageDir);
  const nativeAddonPath = fetchNativeAddon(stageDir);

  log(`pkg compile → ${binaryName} (embeds Node ${PINNED_NODE_VERSION}) …`);
  await pkgExec([bundlePath, "-t", pkgTarget(), "-o", binaryPath]);
  chmodSync(binaryPath, 0o755);

  copyAssets(assetsDir, nativeAddonPath);

  log(`done: ${binaryPath}`);
  log(`      ${assetsDir}/`);
}

main().catch((err) => {
  process.stderr.write(`[build-sidecar] FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
