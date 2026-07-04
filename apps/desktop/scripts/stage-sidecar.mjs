#!/usr/bin/env node
// Copies Task 1's compiled engine sidecar binary (+ its `.assets` sibling
// directory) from packages/engine/dist-sidecar/ into
// apps/desktop/src-tauri/binaries/, where Tauri's `bundle.externalBin`
// convention (tauri.conf.json: `"externalBin": ["binaries/openfusion-engine"]`)
// and `Command::sidecar`/`Command.sidecar()` (Task 3/4) expect to find it.
//
// This is a manual, DEV-time staging step — it is run by hand (or by CI)
// rather than wired into src-tauri/build.rs, since build.rs would need
// Node/pnpm available in the same shell as cargo to reach into
// packages/engine, which isn't guaranteed on every machine that runs cargo.
//
// IMPORTANT: this step is NOT optional. `src-tauri/build.rs` calls
// `tauri_build::build()`, which validates that every `tauri.conf.json`
// `bundle.externalBin` entry resolves to a real file on disk *during the
// build itself* — before this crate's own code even compiles. Without a
// staged `binaries/openfusion-engine-<triple>` (+ its `.assets` sibling),
// `cargo build`/`cargo test` in apps/desktop FAILS (exit code 101: "resource
// path `binaries/openfusion-engine-<triple>` doesn't exist"). So this
// script (preceded by `pnpm --filter @openfusion/engine build:sidecar`) is a
// prerequisite for ANY `cargo build`/`cargo test` in apps/desktop, not just
// `tauri dev` — a fresh clone or CI runner must run both before it can build
// or test this crate at all. M8 (actual .app bundling) will decide whether
// staging becomes a `beforeBundleCommand` hook or stays a manual pnpm script
// step.
//
// NOTE on the `.assets` dir specifically: the engine binary self-locates its
// runtime assets (better-sqlite3's native addon, tree-sitter wasm files,
// tags.scm queries) via `${process.execPath}.assets` (see
// packages/engine/src/util/sidecar-runtime.ts and
// .superpowers/sdd/m7a-task-1-report.md). In `tauri dev`, Tauri spawns the
// sidecar directly from src-tauri/binaries/<name>-<triple>, so
// process.execPath matches the triple-suffixed filename we stage here and
// self-location works unmodified. Once M8 does real `.app` bundling, Tauri
// copies the externalBin into Contents/MacOS/<name> WITH THE TRIPLE SUFFIX
// STRIPPED — at that point `${execPath}.assets` would look for
// `openfusion-engine.assets`, not `openfusion-engine-<triple>.assets`. M8
// must either (a) also stage a triple-less copy of `.assets` at bundle time,
// or (b) change the engine's runtime asset lookup to something bundle-
// layout-aware. Flagging here so it isn't rediscovered from scratch later.
import { cpSync, chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const engineDistSidecar = path.join(repoRoot, "packages", "engine", "dist-sidecar");
const binariesDir = path.join(desktopRoot, "src-tauri", "binaries");

function log(message) {
  process.stdout.write(`[stage-sidecar] ${message}\n`);
}

// Same table as packages/engine/scripts/build-sidecar.mjs's targetTriple() —
// kept as a small independent copy rather than an import: this script must
// run standalone from apps/desktop (no workspace dependency on
// @openfusion/engine), and the mapping is small/stable enough that
// duplicating it is cheaper than wiring a cross-package import for it.
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
    throw new Error(`stage-sidecar: no Rust target-triple mapping for host "${key}"`);
  }
  return triple;
}

function main() {
  const triple = targetTriple();
  const binaryName = `openfusion-engine-${triple}`;
  const assetsName = `${binaryName}.assets`;

  const srcBinary = path.join(engineDistSidecar, binaryName);
  const srcAssets = path.join(engineDistSidecar, assetsName);

  if (!existsSync(srcBinary)) {
    throw new Error(
      `stage-sidecar: no sidecar binary at ${srcBinary}.\n` +
        "Build it first: pnpm --filter @openfusion/engine build:sidecar",
    );
  }
  if (!existsSync(srcAssets)) {
    throw new Error(`stage-sidecar: sidecar binary present but its .assets sibling is missing at ${srcAssets}`);
  }

  mkdirSync(binariesDir, { recursive: true });

  const destBinary = path.join(binariesDir, binaryName);
  const destAssets = path.join(binariesDir, assetsName);

  rmSync(destBinary, { force: true });
  rmSync(destAssets, { recursive: true, force: true });

  cpSync(srcBinary, destBinary);
  chmodSync(destBinary, 0o755);
  cpSync(srcAssets, destAssets, { recursive: true });

  // M8: `tauri.conf.json`'s `bundle.resources` ships `.assets/` into the
  // packaged app's `Contents/Resources/assets` (see
  // `apps/desktop/src-tauri/src/lib.rs`'s `resolve_packaged_assets_dir` doc
  // comment for the Rust-side half of this mapping). `tauri.conf.json` is a
  // static, non-templated file, so its `resources` map needs a FIXED
  // (non-triple-suffixed) source path -- it cannot glob/interpolate the
  // host's target triple the way `bundle.externalBin` does for the binary
  // itself. So, in addition to the triple-suffixed `.assets` copy above
  // (needed for `tauri dev`'s spawn -- see this file's top-of-file doc
  // comment on why the sidecar's own `${execPath}.assets` self-location only
  // works with the triple-suffixed name in dev), also stage a second,
  // triple-LESS copy at a fixed name purely for `bundle.resources` to pick
  // up at build time. This is a plain second copy (not a symlink) to match
  // this script's existing copy-not-link convention and to avoid any
  // symlink-resolution surprises in the bundler's own resource-copying step.
  const destAssetsFixedName = path.join(binariesDir, "openfusion-engine.assets");
  rmSync(destAssetsFixedName, { recursive: true, force: true });
  cpSync(srcAssets, destAssetsFixedName, { recursive: true });

  log(`staged ${binaryName} (+ .assets, + a triple-less .assets copy for bundle.resources) into ` +
    `${path.relative(repoRoot, binariesDir)}/`);
}

main();
