// Unit tests for the parts of notarize-staple-dmg.mjs that don't require
// actual Apple credentials/notarization: .dmg discovery (against a fixture
// dir tree) and credential-mode resolution. The actual `xcrun notarytool` /
// `xcrun stapler` invocations are an OPERATOR step (needs real Apple
// Developer credentials + network access) and are intentionally NOT
// exercised here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildNotarytoolSubmitArgs,
  dmgSearchDirs,
  findDmgCandidates,
  resolveNotarizeCredentials,
} from "./notarize-staple-dmg.mjs";

describe("findDmgCandidates", () => {
  let root;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("finds a .dmg in the release bundle dir and ignores non-.dmg files", () => {
    root = mkdtempSync(path.join(tmpdir(), "dmg-fixture-"));
    const releaseDmgDir = path.join(root, "target", "release", "bundle", "dmg");
    mkdirSync(releaseDmgDir, { recursive: true });
    writeFileSync(path.join(releaseDmgDir, "OpenFusion_0.0.1_aarch64.dmg"), "fake dmg content");
    writeFileSync(path.join(releaseDmgDir, ".DS_Store"), "not a dmg");

    const found = findDmgCandidates(dmgSearchDirs(root));
    expect(found).toEqual([path.join(releaseDmgDir, "OpenFusion_0.0.1_aarch64.dmg")]);
  });

  it("silently skips a missing bundle/dmg directory instead of throwing", () => {
    root = mkdtempSync(path.join(tmpdir(), "dmg-fixture-missing-"));
    // Neither target/release nor target/debug exists at all.
    expect(findDmgCandidates(dmgSearchDirs(root))).toEqual([]);
  });

  it("checks release before debug (dmgSearchDirs ordering)", () => {
    root = "/some/src-tauri";
    const dirs = dmgSearchDirs(root);
    expect(dirs[0]).toBe(path.join(root, "target", "release", "bundle", "dmg"));
    expect(dirs[1]).toBe(path.join(root, "target", "debug", "bundle", "dmg"));
  });

  it("returns multiple candidates when both release and debug dmgs exist, for main() to reject", () => {
    root = mkdtempSync(path.join(tmpdir(), "dmg-fixture-multi-"));
    for (const profile of ["release", "debug"]) {
      const dir = path.join(root, "target", profile, "bundle", "dmg");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `OpenFusion_0.0.1_aarch64_${profile}.dmg`), "fake");
    }
    expect(findDmgCandidates(dmgSearchDirs(root))).toHaveLength(2);
  });
});

describe("resolveNotarizeCredentials", () => {
  it("resolves the ASC API-key mode when all three vars are present", () => {
    const creds = resolveNotarizeCredentials({
      APPLE_API_KEY: "KEYID123",
      APPLE_API_ISSUER: "issuer-uuid",
      APPLE_API_KEY_PATH: "/path/to/AuthKey.p8",
    });
    expect(creds.mode).toBe("api-key");
    expect(creds.args).toEqual(["--key", "/path/to/AuthKey.p8", "--key-id", "KEYID123", "--issuer", "issuer-uuid"]);
  });

  it("resolves the Apple-ID mode when all three vars are present", () => {
    const creds = resolveNotarizeCredentials({
      APPLE_ID: "dev@example.com",
      APPLE_PASSWORD: "@keychain:AC_PASSWORD",
      APPLE_TEAM_ID: "TEAMID1234",
    });
    expect(creds.mode).toBe("apple-id");
    expect(creds.args).toEqual([
      "--apple-id",
      "dev@example.com",
      "--password",
      "@keychain:AC_PASSWORD",
      "--team-id",
      "TEAMID1234",
    ]);
  });

  it("resolves the keychain-profile mode from a single var", () => {
    const creds = resolveNotarizeCredentials({ APPLE_KEYCHAIN_PROFILE: "openfusion-notary" });
    expect(creds.mode).toBe("keychain-profile");
    expect(creds.args).toEqual(["--keychain-profile", "openfusion-notary"]);
  });

  it("resolves to null (fail loudly territory) when no credential set is complete", () => {
    expect(resolveNotarizeCredentials({}).mode).toBeNull();
    // Partial API-key set (missing APPLE_API_KEY_PATH) must not half-match.
    expect(resolveNotarizeCredentials({ APPLE_API_KEY: "x", APPLE_API_ISSUER: "y" }).mode).toBeNull();
  });

  it("prefers api-key over apple-id when both happen to be fully set", () => {
    const creds = resolveNotarizeCredentials({
      APPLE_API_KEY: "KEYID123",
      APPLE_API_ISSUER: "issuer-uuid",
      APPLE_API_KEY_PATH: "/path/to/AuthKey.p8",
      APPLE_ID: "dev@example.com",
      APPLE_PASSWORD: "pw",
      APPLE_TEAM_ID: "TEAMID1234",
    });
    expect(creds.mode).toBe("api-key");
  });
});

describe("buildNotarytoolSubmitArgs", () => {
  it("builds `notarytool submit <dmg> --wait <credArgs...>`", () => {
    const args = buildNotarytoolSubmitArgs("/path/OpenFusion.dmg", {
      mode: "keychain-profile",
      args: ["--keychain-profile", "openfusion-notary"],
    });
    expect(args).toEqual(["notarytool", "submit", "/path/OpenFusion.dmg", "--wait", "--keychain-profile", "openfusion-notary"]);
  });
});
