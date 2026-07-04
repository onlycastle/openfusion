import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeBindingOption } from "../src/wiki/store.js";
import { queriesDir, wasmDir } from "../src/wiki/languages.js";
import { parserInitOptions } from "../src/wiki/parser.js";

// Proves all THREE asset consumers (the better-sqlite3 nativeBinding in
// wiki/store.ts, the tree-sitter locateFile hook in wiki/parser.ts, and the
// wasm/queries dirs in wiki/languages.ts) derive from the SAME resolved
// assets base (util/sidecar-runtime.ts's resolveAssetsBaseDir()) — so
// setting OPENFUSION_ASSETS_DIR once covers all of them. Each consumer
// exposes a small pure function specifically so this can be asserted
// directly (path equality) without needing a working native addon or real
// wasm bytes at the fake path — the end-to-end "it actually loads" proof
// with the REAL compiled binary lives in sidecar-binary.test.ts.

const ENV_KEY = "OPENFUSION_ASSETS_DIR";

describe("OPENFUSION_ASSETS_DIR covers all three asset consumers", () => {
  const originalEnv = process.env[ENV_KEY];
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
  });

  it("wiki/languages.ts: wasmDir()/queriesDir() resolve under the env dir", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "of-assets-consumers-"));
    process.env[ENV_KEY] = tmpDir;
    expect(wasmDir()).toBe(path.join(tmpDir, "wasm"));
    expect(queriesDir()).toBe(path.join(tmpDir, "queries"));
  });

  it("wiki/store.ts: nativeBindingOption() resolves better_sqlite3.node under the env dir", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "of-assets-consumers-"));
    process.env[ENV_KEY] = tmpDir;
    expect(nativeBindingOption()).toEqual({
      nativeBinding: path.join(tmpDir, "better_sqlite3.node"),
    });
  });

  it("wiki/parser.ts: parserInitOptions().locateFile resolves wasm/<file> under the env dir", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "of-assets-consumers-"));
    process.env[ENV_KEY] = tmpDir;
    const options = parserInitOptions();
    expect(options).toBeDefined();
    expect(options!.locateFile("web-tree-sitter.wasm")).toBe(
      path.join(tmpDir, "wasm", "web-tree-sitter.wasm"),
    );
  });

  it("all three consumers fall back to dev-mode (unset/undefined) when the env dir does not exist", () => {
    process.env[ENV_KEY] = path.join(os.tmpdir(), "of-assets-consumers-does-not-exist-xyz");
    expect(wasmDir()).not.toContain("of-assets-consumers-does-not-exist-xyz");
    expect(queriesDir()).not.toContain("of-assets-consumers-does-not-exist-xyz");
    expect(nativeBindingOption()).toBeUndefined();
    expect(parserInitOptions()).toBeUndefined();
  });
});
