#!/usr/bin/env node
// Closes Blocker A from
// docs/research/2026-07-04-m8-signing-verification.md: Tauri's macOS
// bundler auto-signs the externalBin sidecar binary itself (Contents/MacOS/
// openfusion-engine) correctly, but it does NOT sign anything shipped via
// `bundle.resources` -- and the ONLY way to ship the sidecar's sibling
// `.assets/` dir (tree-sitter wasm, tags.scm queries, better-sqlite3's
// native addon) is `bundle.resources` (tauri.conf.json:
// `"resources": {"binaries/openfusion-engine.assets": "assets"}`). So
// `.assets/better_sqlite3.node` -- an unsigned nested Mach-O -- would ship
// inside Contents/Resources/assets and notarization rejects it ("the
// signature of the binary is invalid" / "not signed").
//
// This script finds every Mach-O under the STAGED, triple-less `.assets`
// dir that `bundle.resources` actually reads from (staged by
// `scripts/stage-sidecar.mjs`; see that file's doc comment on why a
// triple-less copy exists at all) and codesigns each one with
// `--options runtime` (hardened runtime -- required for notarization) BEFORE
// `tauri build`'s bundling phase copies it into the .app. `.wasm`/`.scm`/
// JSON/text files are left untouched -- Apple only scans Mach-O, and
// codesign would error on a non-Mach-O anyway.
//
// Wiring: run as `build.beforeBundleCommand` in tauri.conf.json, which Tauri
// runs BEFORE it copies `bundle.resources` into the .app (the copy is a
// plain `fs::copy`, so a codesign done beforehand survives it intact).
//
// Signing gate: `tauri build` (any profile) always runs this hook, so this
// script -- not tauri.conf.json -- is what has to tell an operator's signed
// release apart from a plain local/CI dev bundle:
//   - `APPLE_SIGNING_IDENTITY` set                         -> SIGN.
//   - unset AND `TAURI_ENV_DEBUG === "true"` (Tauri sets    -> SKIP + warn
//     this for `tauri build --debug`; verified empirically:    (dev bundle,
//     it is simply ABSENT for a release build, not "false")    no cert yet).
//   - unset AND not a debug build (a real release attempt)  -> FAIL LOUDLY
//     (an unsigned nested Mach-O would silently sink notarization later --
//     better to stop the build now with a clear message).
//
// NEVER logs the identity value or any cert/key material -- only whether
// signing ran, was skipped, or is required.
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// --- Mach-O detection (pure, unit-tested against fixtures) -----------------

// Thin (32/64-bit) and fat/universal Mach-O magic numbers, both byte orders.
// Apple's own notarization rejection checklist (per the research doc) scans
// for Mach-O specifically -- these are the only magics that matter.
const MACHO_MAGICS = new Set([
  0xfeedface, // MH_MAGIC (32-bit)
  0xfeedfacf, // MH_MAGIC_64 (64-bit)
  0xcefaedfe, // MH_CIGAM (32-bit, byte-swapped)
  0xcffaedfe, // MH_CIGAM_64 (64-bit, byte-swapped)
  0xcafebabe, // FAT_MAGIC (universal binary)
  0xbebafeca, // FAT_CIGAM (universal binary, byte-swapped)
  0xcafebabf, // FAT_MAGIC_64
  0xbfbafeca, // FAT_CIGAM_64
]);

/**
 * @param {Buffer} buf at least 4 bytes, read from the start of a file.
 * @returns {boolean} true if the buffer starts with a Mach-O magic number.
 */
export function isMachOBuffer(buf) {
  if (buf.length < 4) return false;
  return MACHO_MAGICS.has(buf.readUInt32BE(0));
}

/**
 * Reads only the first 4 bytes of `filePath` (never the whole file -- some
 * of these, like better_sqlite3.node, are multi-megabyte native addons) and
 * checks them against known Mach-O magic numbers.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isMachOFile(filePath) {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(4);
    const bytesRead = readSync(fd, buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    return isMachOBuffer(buf);
  } finally {
    closeSync(fd);
  }
}

/**
 * Recursively lists every regular file under `dir` (skips directories,
 * symlinks, etc.). Order is not guaranteed -- callers must not depend on it.
 * @param {string} dir
 * @returns {string[]} absolute file paths.
 */
export function findFilesRecursive(dir) {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
    // symlinks / sockets / etc: deliberately ignored -- nothing we stage
    // into .assets should ever be one.
  }
  return out;
}

// --- signing gate (pure, unit-tested) --------------------------------------

/**
 * @param {{ identity: string | undefined, tauriEnvDebug: string | undefined }} env
 * @returns {{ action: "sign" | "skip" | "fail", reason: string }}
 */
export function decideSigningAction({ identity, tauriEnvDebug }) {
  if (identity) {
    return { action: "sign", reason: "APPLE_SIGNING_IDENTITY is set." };
  }
  if (tauriEnvDebug === "true") {
    return {
      action: "skip",
      reason:
        "APPLE_SIGNING_IDENTITY is unset and this is a `tauri build --debug` " +
        "bundle (TAURI_ENV_DEBUG=true) -- skipping presign so local/dev " +
        "bundling without a cert still works.",
    };
  }
  return {
    action: "fail",
    reason:
      "APPLE_SIGNING_IDENTITY is unset and this is NOT a debug build " +
      "(TAURI_ENV_DEBUG is not \"true\") -- refusing to produce a release " +
      "bundle whose bundle.resources/ would contain an unsigned nested " +
      "Mach-O (better_sqlite3.node). Set APPLE_SIGNING_IDENTITY to the " +
      "Developer ID Application identity to use for signing, or pass " +
      "--debug for an unsigned local build.",
  };
}

// --- main -------------------------------------------------------------------

function resolveAssetsDir() {
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // Matches stage-sidecar.mjs's `destAssetsFixedName`: the fixed
  // (non-triple-suffixed) copy that tauri.conf.json's `bundle.resources`
  // reads from, since tauri.conf.json is static and can't glob the host's
  // target triple the way `bundle.externalBin` does for the binary itself.
  return path.join(desktopRoot, "src-tauri", "binaries", "openfusion-engine.assets");
}

function log(message) {
  process.stdout.write(`[presign-sidecar-assets] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`[presign-sidecar-assets] WARNING: ${message}\n`);
}

export function main() {
  const decision = decideSigningAction({
    identity: process.env.APPLE_SIGNING_IDENTITY,
    tauriEnvDebug: process.env.TAURI_ENV_DEBUG,
  });

  if (decision.action === "skip") {
    warn(decision.reason);
    return;
  }
  if (decision.action === "fail") {
    throw new Error(`presign-sidecar-assets: ${decision.reason}`);
  }

  const assetsDir = resolveAssetsDir();
  if (!statSync(assetsDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `presign-sidecar-assets: staged assets dir not found at ${assetsDir}. ` +
        "Run `pnpm --filter @openfusion/desktop stage-sidecar` (after " +
        "`pnpm --filter @openfusion/engine build:sidecar`) before bundling.",
    );
  }

  const allFiles = findFilesRecursive(assetsDir);
  const machOFiles = allFiles.filter(isMachOFile);

  if (machOFiles.length === 0) {
    log(`no Mach-O files found under ${path.relative(process.cwd(), assetsDir)} -- nothing to sign.`);
    return;
  }

  log(`signing ${machOFiles.length} Mach-O file(s) under ${path.relative(process.cwd(), assetsDir)}...`);
  for (const file of machOFiles) {
    // --force makes this idempotent (re-signing an already-signed file is a
    // no-op failure mode otherwise); --options runtime opts into the
    // hardened runtime, a hard notarization prerequisite; --timestamp adds
    // the secure timestamp notarization also requires. The identity itself
    // is passed straight from the env var to codesign's argv -- never
    // interpolated into a shell string, and never printed.
    execFileSync(
      "codesign",
      ["--sign", process.env.APPLE_SIGNING_IDENTITY, "--options", "runtime", "--timestamp", "--force", file],
      { stdio: "inherit" },
    );
    log(`signed ${path.relative(assetsDir, file)}`);
  }
  log("done.");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[presign-sidecar-assets] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
