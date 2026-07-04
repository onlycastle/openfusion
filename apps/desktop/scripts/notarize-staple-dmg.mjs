#!/usr/bin/env node
// Closes the ".dmg staple gap" from
// docs/research/2026-07-04-m8-signing-verification.md: `tauri build` signs,
// notarizes, and staples the `.app` inline (when Apple creds are present in
// env), but it only CODE-SIGNS the `.dmg` it wraps that `.app` in -- it
// never notarizes or staples the `.dmg` itself. An unstapled `.dmg` still
// passes Gatekeeper for a user with network access (Gatekeeper falls back to
// an online notarization check), but fails offline -- so for a distributable
// artifact the `.dmg` needs its own `stapler staple` pass post-build.
//
// Usage (run AFTER `tauri build` has produced a `.dmg`):
//   node scripts/notarize-staple-dmg.mjs                # staple only
//   node scripts/notarize-staple-dmg.mjs --notarize      # submit --wait, then staple
//   node scripts/notarize-staple-dmg.mjs --dmg <path>    # explicit .dmg (skip search)
//
// Which mode an operator needs depends on how the `.dmg` was produced: if
// `tauri build` ran with Apple API-key creds in env, IT already notarized +
// stapled the `.app` inside, so `--staple-only` (the default) staples the
// same already-approved notarization ticket onto the `.dmg` container.
// `--notarize` is for the case where the `.dmg` itself needs its own
// submission (e.g. it was rebuilt/re-signed after the `.app` was notarized,
// or the operator wants to double check) -- CONFIRM which is actually needed
// at operator time; this script supports both rather than guessing.
//
// FAILS LOUDLY (non-zero exit, clear stderr message) if: `xcrun` isn't on
// PATH, no `.dmg` can be found (or more than one candidate and none named
// explicitly), or `--notarize` is requested without a resolvable Apple
// credential set in env. NEVER logs credential values -- only which
// credential MODE (api-key / apple-id / keychain-profile) it resolved.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// --- .dmg discovery (pure, unit-tested against a fixture dir tree) ---------

/**
 * Lists `.dmg` files directly inside each of `dirs` (non-recursive -- this
 * mirrors tauri-bundler's own `bundle/dmg/` layout, one level deep). Missing
 * directories are silently skipped (e.g. a `--debug` build has no `release`
 * dir and vice versa).
 * @param {string[]} dirs
 * @returns {string[]} absolute paths, in the order `dirs` was given.
 */
export function findDmgCandidates(dirs) {
  const found = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".dmg")) {
        found.push(path.join(dir, name));
      }
    }
  }
  return found;
}

/**
 * Tauri's macOS bundler always writes to `<target>/<profile>/bundle/dmg/`;
 * `release` is checked first since that's what a real signing/notarization
 * pass targets.
 * @param {string} srcTauriDir absolute path to `apps/desktop/src-tauri`.
 * @returns {string[]} the two candidate `bundle/dmg` directories to search.
 */
export function dmgSearchDirs(srcTauriDir) {
  return [
    path.join(srcTauriDir, "target", "release", "bundle", "dmg"),
    path.join(srcTauriDir, "target", "debug", "bundle", "dmg"),
  ];
}

// --- credential resolution (pure, unit-tested) ------------------------------

/**
 * Mirrors notarytool's three supported auth modes (see the research doc):
 * ASC API key, Apple-ID + app-specific password, or a `notarytool
 * store-credentials`-created keychain profile. Never returns the secret
 * values themselves in any field meant for logging -- `mode` is the only
 * thing this script prints.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ mode: "api-key" | "apple-id" | "keychain-profile" | null, args: string[] }}
 */
export function resolveNotarizeCredentials(env) {
  if (env.APPLE_API_KEY && env.APPLE_API_ISSUER && env.APPLE_API_KEY_PATH) {
    return {
      mode: "api-key",
      args: ["--key", env.APPLE_API_KEY_PATH, "--key-id", env.APPLE_API_KEY, "--issuer", env.APPLE_API_ISSUER],
    };
  }
  if (env.APPLE_ID && env.APPLE_PASSWORD && env.APPLE_TEAM_ID) {
    return {
      mode: "apple-id",
      args: ["--apple-id", env.APPLE_ID, "--password", env.APPLE_PASSWORD, "--team-id", env.APPLE_TEAM_ID],
    };
  }
  if (env.APPLE_KEYCHAIN_PROFILE) {
    return { mode: "keychain-profile", args: ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE] };
  }
  return { mode: null, args: [] };
}

/**
 * @param {string} dmgPath
 * @param {{ mode: string, args: string[] }} creds a resolved (non-null mode) credential set.
 * @returns {string[]} argv for `xcrun notarytool submit <dmgPath> --wait <credArgs...>`.
 */
export function buildNotarytoolSubmitArgs(dmgPath, creds) {
  return ["notarytool", "submit", dmgPath, "--wait", ...creds.args];
}

// --- main --------------------------------------------------------------------

function log(message) {
  process.stdout.write(`[notarize-staple-dmg] ${message}\n`);
}

function assertXcrunAvailable() {
  try {
    execFileSync("xcrun", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "notarize-staple-dmg: `xcrun` is not available on PATH. This script requires the Xcode " +
        "command line tools (notarytool + stapler) and only runs on macOS.",
    );
  }
}

function resolveDmgPath(srcTauriDir, argv) {
  const explicitIdx = argv.indexOf("--dmg");
  if (explicitIdx !== -1) {
    const explicit = argv[explicitIdx + 1];
    if (!explicit) {
      throw new Error("notarize-staple-dmg: --dmg requires a path argument.");
    }
    if (!existsSync(explicit)) {
      throw new Error(`notarize-staple-dmg: --dmg path does not exist: ${explicit}`);
    }
    return explicit;
  }

  const candidates = findDmgCandidates(dmgSearchDirs(srcTauriDir));
  if (candidates.length === 0) {
    throw new Error(
      "notarize-staple-dmg: no .dmg found under target/{release,debug}/bundle/dmg/. " +
        "Run `tauri build` (with the dmg bundle target) first, or pass --dmg <path> explicitly.",
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `notarize-staple-dmg: found ${candidates.length} .dmg candidates, refusing to guess: ` +
        `${candidates.join(", ")}. Pass --dmg <path> to disambiguate.`,
    );
  }
  return candidates[0];
}

export function main(argv = process.argv.slice(2)) {
  assertXcrunAvailable();

  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const srcTauriDir = path.join(desktopRoot, "src-tauri");
  const dmgPath = resolveDmgPath(srcTauriDir, argv);
  const wantsNotarize = argv.includes("--notarize");

  if (wantsNotarize) {
    const creds = resolveNotarizeCredentials(process.env);
    if (!creds.mode) {
      throw new Error(
        "notarize-staple-dmg: --notarize requires Apple credentials in env -- set either " +
          "APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH (ASC API key, CI-recommended), " +
          "APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID (Apple-ID + app-specific password), or " +
          "APPLE_KEYCHAIN_PROFILE (a `notarytool store-credentials` profile name).",
      );
    }
    log(`submitting ${path.basename(dmgPath)} for notarization (credential mode: ${creds.mode})...`);
    execFileSync("xcrun", buildNotarytoolSubmitArgs(dmgPath, creds), { stdio: "inherit" });
    log("notarization submission accepted.");
  }

  log(`stapling ${path.basename(dmgPath)}...`);
  execFileSync("xcrun", ["stapler", "staple", dmgPath], { stdio: "inherit" });
  log("staple complete.");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[notarize-staple-dmg] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
