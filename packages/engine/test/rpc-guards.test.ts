import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { providerKindOf, requireGitRepo, resolveProjectKey } from "../src/rpc/guards.js";
import { RpcMethodError } from "../src/rpc/errors.js";
import { ProviderRegistry } from "../src/models/providers.js";

let dir: string;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(prefix = "of-rpc-guards-"): string {
  const base = mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", base]);
  execFileSync("git", ["-C", base, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", base, "config", "user.name", "t"]);
  execFileSync("git", ["-C", base, "commit", "-q", "--allow-empty", "-m", "init"]);
  return base;
}

describe("requireGitRepo", () => {
  it("returns the current HEAD sha for a git repository", () => {
    dir = makeRepo();
    const expected = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(requireGitRepo(dir)).toBe(expected);
  });

  it("throws an RpcMethodError(SERVER_ERROR, 'not a git repository: <dir>') for a non-git directory", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-rpc-guards-nongit-"));
    let caught: unknown;
    try {
      requireGitRepo(dir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RpcMethodError);
    expect((caught as RpcMethodError).code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect((caught as RpcMethodError).message).toBe(`not a git repository: ${dir}`);
  });
});

describe("providerKindOf", () => {
  it("resolves a configured provider's kind by id", () => {
    const registry = new ProviderRegistry();
    registry.configure({ id: "p1", kind: "deepseek", apiKey: "sk-test-fixture-never-real" });
    expect(providerKindOf(registry, "p1")).toBe("deepseek");
  });

  it("falls back to the providerId itself for an unconfigured provider", () => {
    const registry = new ProviderRegistry();
    expect(providerKindOf(registry, "ghost")).toBe("ghost");
  });
});

describe("resolveProjectKey", () => {
  it("resolves to the realpath of an existing directory", () => {
    dir = makeRepo();
    expect(resolveProjectKey(dir)).toBe(realpathSync(path.resolve(dir)));
  });

  it("falls back to the resolved (non-realpathed) path when the directory doesn't exist", () => {
    const missing = path.join(os.tmpdir(), "of-rpc-guards-does-not-exist-xyz");
    expect(resolveProjectKey(missing)).toBe(path.resolve(missing));
  });

  it("two distinct relative spellings of the same directory resolve to the same key", () => {
    dir = makeRepo();
    const viaAbsolute = resolveProjectKey(dir);
    const viaTrailingSlash = resolveProjectKey(`${dir}${path.sep}`);
    expect(viaTrailingSlash).toBe(viaAbsolute);
  });
});
