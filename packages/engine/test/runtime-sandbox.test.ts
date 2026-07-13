import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMacOsSandboxProfile,
  createNativeSandboxLaunch,
  filterSandboxEnvironment,
  MacOsSandboxBackend,
  SandboxUnavailableError,
  TOOL_OUTPUT_MAX_BYTES,
} from "../src/runtime/sandbox.js";
import { RuntimeStore } from "../src/runtime/store.js";
import { createPassthroughSandboxRunner } from "./native-sandbox-fixture.js";

let dir: string | undefined;
let store: RuntimeStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function testBackend(root: string): MacOsSandboxBackend {
  return new MacOsSandboxBackend({
    platform: "darwin",
    runnerExecutable: createPassthroughSandboxRunner(root),
    probe: async () => ({ ok: true }),
  });
}

function roots(): { cwd: string; temp: string } {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-sandbox-"));
  const cwd = path.join(dir, "worktree");
  const temp = path.join(dir, "private-temp");
  mkdirSync(cwd);
  return { cwd, temp };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const stagedRunner = path.join(
  repoRoot,
  "apps/desktop/src-tauri/binaries",
  `openfusion-sandbox-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`,
);

describe("macOS sandbox profile", () => {
  it("keeps each tool-output stream bounded at 16 MiB", () => {
    expect(TOOL_OUTPUT_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  it("allows only the worktree/private temp writes and denies network by default", () => {
    const { cwd, temp } = roots();
    const profile = buildMacOsSandboxProfile({ cwd, privateTempDir: temp });

    expect(profile).toContain(`(allow file-write* (subpath \"${realpathSync(cwd)}\"))`);
    expect(profile).toContain(`(allow file-write* (subpath \"${realpathSync(temp)}\"))`);
    expect(profile).toContain("(deny network*)");
    expect(profile).not.toContain(os.homedir());
  });

  it("adds outbound network only after an explicit grant", () => {
    const { cwd, temp } = roots();
    expect(buildMacOsSandboxProfile({ cwd, privateTempDir: temp, networkGranted: true }))
      .toContain("(allow network-outbound)");
  });

  it("does not inherit host secrets into the child environment", () => {
    const { cwd, temp } = roots();
    const previous = process.env.OPENFUSION_SENTINEL_SECRET;
    process.env.OPENFUSION_SENTINEL_SECRET = "must-not-leak";
    try {
      const environment = filterSandboxEnvironment({ cwd, privateTempDir: temp });
      expect(environment.OPENFUSION_SENTINEL_SECRET).toBeUndefined();
      expect(environment.HOME).toBe(temp);
      expect(environment.PWD).toBe(cwd);
    } finally {
      if (previous === undefined) delete process.env.OPENFUSION_SENTINEL_SECRET;
      else process.env.OPENFUSION_SENTINEL_SECRET = previous;
    }
  });

  it("pins protected evaluator commands to the eval profile", () => {
    const { cwd, temp } = roots();
    const launch = createNativeSandboxLaunch({
      runnerExecutable: createPassthroughSandboxRunner(dir!),
      executable: process.execPath,
      args: ["--version"],
      cwd,
      privateTempDir: temp,
      profile: "eval",
    });
    try {
      const request = JSON.parse(readFileSync(launch.requestFile, "utf8")) as { profile: string };
      expect(request.profile).toBe("eval");
    } finally {
      launch.cleanup();
    }
  });
});

describe("MacOsSandboxBackend availability", () => {
  it("fails closed on unsupported platforms", async () => {
    const backend = new MacOsSandboxBackend({ platform: "linux" });
    await expect(backend.status()).resolves.toMatchObject({
      backend: "openfusion-sandbox",
      available: false,
      provisional: false,
    });
  });

  it("fails closed when its startup probe rejects the backend", async () => {
    const backend = new MacOsSandboxBackend({
      platform: "darwin",
      runnerExecutable: "/bin/sh",
      probe: async () => ({ ok: false, reason: "probe denied" }),
    });
    await expect(backend.status()).resolves.toMatchObject({ available: false, reason: "probe denied" });
  });

  it("streams process output into an encrypted artifact", async () => {
    const { cwd, temp } = roots();
    store = new RuntimeStore({ projectDir: dir!, key: Buffer.alloc(32, 8) });
    const session = store.createSession({ kind: "worker" });
    const backend = testBackend(dir!);
    const output = store.beginArtifact(session.id, "tool-output", { maxBytes: 4096 });

    const result = await backend.run({
      executable: "/bin/sh",
      args: ["-c", "printf 'BEGIN'; printf 'END' >&2"],
      cwd,
      privateTempDir: temp,
      timeoutMs: 2_000,
      output,
    });

    expect(result.failure).toBeUndefined();
    expect(result.preview).toContain("BEGIN");
    expect(result.preview).toContain("END");
    expect(store.readArtifact(result.artifact.id).toString("utf8")).toContain("[stdout]");
  });

  it("terminates the process tree with a typed output-limit failure", async () => {
    const { cwd, temp } = roots();
    store = new RuntimeStore({ projectDir: dir!, key: Buffer.alloc(32, 9) });
    const session = store.createSession({ kind: "worker" });
    const backend = testBackend(dir!);
    const output = store.beginArtifact(session.id, "tool-output", { maxBytes: 1024 });

    const result = await backend.run({
      executable: "/bin/sh",
      args: ["-c", "yes output"],
      cwd,
      privateTempDir: temp,
      timeoutMs: 5_000,
      output,
    });

    expect(result.failure).toBe("output-limit");
    expect(result.outputBytes).toBe(1024);
    expect(store.readArtifact(result.artifact.id)).toHaveLength(1024);
  });

  it.runIf(process.platform === "darwin" && existsSync(stagedRunner))(
    "executes through the staged Rust runner and cancels its descendant process group",
    async () => {
      const { cwd, temp } = roots();
      const outside = path.join(dir!, "outside.txt");
      writeFileSync(outside, "NATIVE_RUNNER_SECRET");
      symlinkSync(outside, path.join(cwd, "escape"));
      store = new RuntimeStore({ projectDir: dir!, key: Buffer.alloc(32, 10) });
      const session = store.createSession({ kind: "worker" });
      const backend = new MacOsSandboxBackend({ runnerExecutable: stagedRunner });
      await expect(backend.status()).resolves.toMatchObject({ available: true, provisional: false });

      const deniedOutput = store.beginArtifact(session.id, "tool-output", { maxBytes: 4096 });
      const denied = await backend.run({
        executable: "/bin/cat",
        args: [path.join(cwd, "escape")],
        cwd,
        privateTempDir: temp,
        timeoutMs: 2_000,
        output: deniedOutput,
      });
      expect(denied.exitCode).not.toBe(0);
      expect(store.readArtifact(denied.artifact.id).toString("utf8")).not.toContain("NATIVE_RUNNER_SECRET");

      const controller = new AbortController();
      const cancelledOutput = store.beginArtifact(session.id, "tool-output", { maxBytes: 4096 });
      const startedAt = Date.now();
      const pending = backend.run({
        executable: "/bin/sh",
        args: ["-c", "sleep 30 & wait"],
        cwd,
        privateTempDir: temp,
        timeoutMs: 5_000,
        abortSignal: controller.signal,
        output: cancelledOutput,
      });
      setTimeout(() => controller.abort(), 50);
      await expect(pending).resolves.toMatchObject({ failure: "cancelled" });
      expect(Date.now() - startedAt).toBeLessThan(2_500);
      expect(readdirSync(temp).some((name) => name.startsWith("sandbox-request-"))).toBe(false);
    },
    10_000,
  );
});
