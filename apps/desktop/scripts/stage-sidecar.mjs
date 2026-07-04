#!/usr/bin/env node
// Copies Task 1's compiled engine sidecar binary (+ its `.assets` sibling
// directory) from packages/engine/dist-sidecar/ into
// apps/desktop/src-tauri/binaries/, where Tauri's `bundle.externalBin`
// convention (tauri.conf.json: `"externalBin": ["binaries/openfusion-engine"]`)
// and `Command::sidecar`/`Command.sidecar()` (Task 3/4) expect to find it.
//
// This is a DEV-time staging step only — running `tauri dev` (or, later,
// `tauri build`) needs the binary physically present under src-tauri/ first,
// since Cargo/Tauri don't know how to reach into packages/engine themselves.
// It is intentionally NOT wired into src-tauri/build.rs: build.rs runs on
// every `cargo build`, including CI/contributor machines that haven't built
// the sidecar (or don't have Node/pnpm in the same shell as cargo), and this
// scaffold's `cargo build` must stay green independent of the sidecar's
// existence. M8 (actual .app bundling) will decide whether staging becomes
// a `beforeBundleCommand` hook or stays a manual pnpm script step.
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

  log(`staged ${binaryName} (+ .assets) into ${path.relative(repoRoot, binariesDir)}/`);
}

main();
