import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPackagedSidecar, resolveAssetsBaseDir } from "../src/util/sidecar-runtime.js";

// M8 Blocker B: in the packaged `.app`, the sidecar binary and its
// `bundle.resources`-shipped assets land in DIFFERENT directories
// (Contents/MacOS/ vs Contents/Resources/), so `${execPath}.assets`
// self-location can't find them. resolveAssetsBaseDir() is the single
// source of truth all three asset consumers (wiki/store.ts,
// wiki/parser.ts, wiki/languages.ts) derive from — these tests pin its
// precedence directly, independent of any of those consumers.

const ENV_KEY = "OPENFUSION_ASSETS_DIR";

function setPackaged(present: boolean): void {
  if (present) {
    Object.defineProperty(process, "pkg", { value: {}, configurable: true });
  } else {
    Reflect.deleteProperty(process, "pkg");
  }
}

describe("resolveAssetsBaseDir", () => {
  const originalEnv = process.env[ENV_KEY];
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    setPackaged(false);
  });

  it("precedence 1: returns the env dir when set and it exists, even when NOT a packaged sidecar", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "of-assets-env-"));
    process.env[ENV_KEY] = tmpDir;
    setPackaged(false);
    expect(isPackagedSidecar()).toBe(false);
    expect(resolveAssetsBaseDir()).toBe(tmpDir);
  });

  it("precedence 1 wins over precedence 2: env dir beats ${execPath}.assets when both apply", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "of-assets-env-"));
    process.env[ENV_KEY] = tmpDir;
    setPackaged(true);
    expect(resolveAssetsBaseDir()).toBe(tmpDir);
    expect(resolveAssetsBaseDir()).not.toBe(`${process.execPath}.assets`);
  });

  it("precedence 2 (UNCHANGED): env var unset + packaged sidecar -> ${execPath}.assets", () => {
    delete process.env[ENV_KEY];
    setPackaged(true);
    expect(resolveAssetsBaseDir()).toBe(`${process.execPath}.assets`);
  });

  it("precedence 3 (UNCHANGED): env var unset + not packaged -> null (dev engine)", () => {
    delete process.env[ENV_KEY];
    setPackaged(false);
    expect(resolveAssetsBaseDir()).toBeNull();
  });

  it("does not blindly trust a bad env var: falls through to precedence 2 when the dir does not exist", () => {
    process.env[ENV_KEY] = path.join(os.tmpdir(), "of-assets-env-does-not-exist-xyz");
    setPackaged(true);
    expect(resolveAssetsBaseDir()).toBe(`${process.execPath}.assets`);
  });

  it("does not blindly trust a bad env var: falls through to precedence 3 (null) when not packaged", () => {
    process.env[ENV_KEY] = path.join(os.tmpdir(), "of-assets-env-does-not-exist-xyz");
    setPackaged(false);
    expect(resolveAssetsBaseDir()).toBeNull();
  });
});
