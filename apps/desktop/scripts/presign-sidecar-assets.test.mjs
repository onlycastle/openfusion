/** @vitest-environment node */
// Unit tests for the parts of presign-sidecar-assets.mjs that don't require
// an actual codesign identity/cert: Mach-O magic-byte detection (against
// fixtures written to a temp dir) and the sign/skip/fail gate. The actual
// `codesign --sign ...` invocation is an OPERATOR step (needs a real Apple
// Developer ID cert) and is intentionally NOT exercised here.
//
// This file does real filesystem/exec work (mkdtempSync, execFileSync), so
// it needs the `node` test environment, not the project-wide `jsdom`
// default (see vite.config.ts) -- the docblock above opts it in per-file.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  decideSigningAction,
  findFilesRecursive,
  formatTopLevelError,
  isMachOBuffer,
  isMachOFile,
  runSigningTool,
  SigningToolError,
} from "./presign-sidecar-assets.mjs";

describe("isMachOBuffer", () => {
  it("recognizes 64-bit Mach-O (MH_MAGIC_64)", () => {
    expect(isMachOBuffer(Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0]))).toBe(true);
  });

  it("recognizes 32-bit Mach-O (MH_MAGIC)", () => {
    expect(isMachOBuffer(Buffer.from([0xfe, 0xed, 0xfa, 0xce]))).toBe(true);
  });

  it("recognizes byte-swapped Mach-O magics (MH_CIGAM / MH_CIGAM_64)", () => {
    expect(isMachOBuffer(Buffer.from([0xce, 0xfa, 0xed, 0xfe]))).toBe(true);
    expect(isMachOBuffer(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))).toBe(true);
  });

  it("recognizes universal/fat binary magics (FAT_MAGIC / FAT_CIGAM)", () => {
    expect(isMachOBuffer(Buffer.from([0xca, 0xfe, 0xba, 0xbe]))).toBe(true);
    expect(isMachOBuffer(Buffer.from([0xbe, 0xba, 0xfe, 0xca]))).toBe(true);
  });

  it("rejects a WebAssembly file (\\0asm magic)", () => {
    expect(isMachOBuffer(Buffer.from([0x00, 0x61, 0x73, 0x6d]))).toBe(false);
  });

  it("rejects JSON/text content", () => {
    expect(isMachOBuffer(Buffer.from('{"a":1}'))).toBe(false);
  });

  it("rejects an ELF binary (unrelated native format)", () => {
    expect(isMachOBuffer(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe(false);
  });

  it("rejects buffers shorter than 4 bytes instead of throwing", () => {
    expect(isMachOBuffer(Buffer.from([0xfe, 0xed]))).toBe(false);
    expect(isMachOBuffer(Buffer.alloc(0))).toBe(false);
  });
});

describe("isMachOFile + findFilesRecursive (fixture directory)", () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("finds only the Mach-O file among mixed fixture content, recursing into subdirectories", () => {
    dir = mkdtempSync(path.join(tmpdir(), "presign-fixture-"));
    mkdirSync(path.join(dir, "nested"), { recursive: true });

    const machoPath = path.join(dir, "nested", "better_sqlite3.node");
    writeFileSync(machoPath, Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 1, 2, 3, 4]));

    const wasmPath = path.join(dir, "tree-sitter.wasm");
    writeFileSync(wasmPath, Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));

    const textPath = path.join(dir, "tags.scm");
    writeFileSync(textPath, "; a query file\n");

    const allFiles = findFilesRecursive(dir);
    expect(allFiles.sort()).toEqual([machoPath, textPath, wasmPath].sort());

    expect(isMachOFile(machoPath)).toBe(true);
    expect(isMachOFile(wasmPath)).toBe(false);
    expect(isMachOFile(textPath)).toBe(false);
  });

  it("does not throw on a zero-byte file", () => {
    dir = mkdtempSync(path.join(tmpdir(), "presign-fixture-empty-"));
    const emptyPath = path.join(dir, "empty.bin");
    writeFileSync(emptyPath, Buffer.alloc(0));
    expect(isMachOFile(emptyPath)).toBe(false);
  });
});

describe("decideSigningAction", () => {
  it("signs whenever APPLE_SIGNING_IDENTITY is set, regardless of TAURI_ENV_DEBUG", () => {
    expect(decideSigningAction({ identity: "Developer ID Application: Foo", tauriEnvDebug: undefined }).action).toBe(
      "sign",
    );
    expect(decideSigningAction({ identity: "Developer ID Application: Foo", tauriEnvDebug: "true" }).action).toBe(
      "sign",
    );
  });

  it("skips (with a reason, for a warning) when unsigned AND it's a `tauri build --debug` bundle", () => {
    const decision = decideSigningAction({ identity: undefined, tauriEnvDebug: "true" });
    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/debug/i);
  });

  it("fails loudly when unsigned AND not a debug build (a real release attempt)", () => {
    expect(decideSigningAction({ identity: undefined, tauriEnvDebug: undefined }).action).toBe("fail");
    expect(decideSigningAction({ identity: undefined, tauriEnvDebug: "false" }).action).toBe("fail");
  });

  it("never echoes an identity value into its reason string", () => {
    const secretLookingIdentity = "Developer ID Application: SUPER SECRET TEAM (ABCDE12345)";
    const decision = decideSigningAction({ identity: secretLookingIdentity, tauriEnvDebug: undefined });
    expect(decision.reason).not.toContain(secretLookingIdentity);
  });
});

// --- Fix 2: same execFileSync-echoes-full-argv pattern as notarize-staple- --
// dmg.mjs's Fix 1. The module doc comment claims "NEVER logs the identity
// value" -- that was FALSE before this fix, since a `codesign` failure's
// caught `err.message` embeds the full argv (including `--sign <identity>`)
// and the old top-level catch printed it verbatim.
describe("execFileSync's own thrown error (the underlying leak this script must never surface)", () => {
  it("embeds the full argv -- including a secret-looking identity value -- in `.message`", () => {
    let caught;
    try {
      execFileSync(process.execPath, ["-e", "process.exit(3)", "Developer ID Application: SUPER SECRET TEAM"], {
        stdio: "ignore",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toContain("SUPER SECRET TEAM");
  });
});

describe("runSigningTool (the no-leak regression test -- load-bearing)", () => {
  it("never lets the codesign identity value in argv reach the thrown error's message", () => {
    let caught;
    try {
      runSigningTool("codesign", process.execPath, [
        "-e",
        "process.exit(3)",
        "Developer ID Application: SUPER SECRET TEAM",
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SigningToolError);
    expect(caught.message).not.toContain("SUPER SECRET TEAM");
    expect(caught.message).toContain("codesign");
    expect(caught.message).toContain("exit code 3");
  });

  it("does not throw when the underlying command succeeds", () => {
    expect(() => runSigningTool("codesign", process.execPath, ["-e", "process.exit(0)"])).not.toThrow();
  });
});

describe("formatTopLevelError (defense in depth for the top-level catch)", () => {
  it("redacts APPLE_SIGNING_IDENTITY if it ever appears in an error message", () => {
    const identity = "Developer ID Application: SUPER SECRET TEAM (ABCDE12345)";
    const err = new Error(`codesign failed near ${identity}`);
    const formatted = formatTopLevelError(err, { APPLE_SIGNING_IDENTITY: identity });
    expect(formatted).not.toContain(identity);
    expect(formatted).toContain("[REDACTED]");
  });

  it("never leaks a SigningToolError's message either (already sanitized upstream)", () => {
    const identity = "Developer ID Application: SUPER SECRET TEAM (ABCDE12345)";
    const err = new SigningToolError("codesign", 1);
    const formatted = formatTopLevelError(err, { APPLE_SIGNING_IDENTITY: identity });
    expect(formatted).not.toContain(identity);
    expect(formatted).toContain("codesign");
    expect(formatted).toContain("exit code 1");
  });
});
