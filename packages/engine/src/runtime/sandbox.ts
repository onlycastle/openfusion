import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { RuntimeArtifactWriter } from "./store.js";
import type { RuntimeArtifact } from "./types.js";

type CapturedChild = ChildProcessByStdio<null, Readable, Readable>;

export const TOOL_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
export const TOOL_OUTPUT_PREVIEW_BYTES = 10 * 1024;

const TERMINATE_GRACE_MS = 1_000;
const SYSTEM_EXECUTABLE_DIRS = ["/bin", "/usr/bin", "/usr/sbin", "/sbin"] as const;
const SYSTEM_READ_PATHS = [
  "/bin",
  "/usr/bin",
  "/usr/lib",
  "/usr/share",
  "/System/Library",
  "/Library/Apple",
  "/private/var/db/dyld",
] as const;

export interface SandboxStatus {
  backend: "openfusion-sandbox";
  available: boolean;
  provisional: false;
  reason?: string;
}

export type SandboxProfile = "author" | "verify" | "review" | "scout" | "eval";

export interface SandboxedProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  privateTempDir: string;
  readablePaths?: string[];
  executablePaths?: string[];
  networkGranted?: boolean;
  environment?: Record<string, string>;
  profile?: SandboxProfile;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  output: RuntimeArtifactWriter;
}

export type SandboxedProcessFailure = "output-limit" | "timeout" | "cancelled" | "spawn";

export interface SandboxedProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  failure?: SandboxedProcessFailure;
  artifact: RuntimeArtifact;
  preview: string;
  previewTruncated: boolean;
  outputBytes: number;
}

export interface SandboxBackend {
  status(): Promise<SandboxStatus>;
  run(request: SandboxedProcessRequest): Promise<SandboxedProcessResult>;
}

export class SandboxUnavailableError extends Error {
  constructor(reason: string) {
    super(`sandboxed process execution is unavailable: ${reason}`);
    this.name = "SandboxUnavailableError";
  }
}

export interface MacOsSandboxBackendOptions {
  platform?: NodeJS.Platform;
  /** Native runner path. `sandboxExecutable` remains a one-cycle alias. */
  runnerExecutable?: string;
  sandboxExecutable?: string;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      detached: boolean;
      stdio: ["ignore", "pipe", "pipe"];
    },
  ) => CapturedChild;
  probe?: (runnerExecutable: string) => Promise<{ ok: boolean; reason?: string }>;
}

function schemeString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function canonicalExistingPath(value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`sandbox path must be absolute: ${value}`);
  return realpathSync(value);
}

function canonicalDirectory(value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`sandbox directory must be absolute: ${value}`);
  mkdirSync(value, { recursive: true, mode: 0o700 });
  return realpathSync(value);
}

function pathRule(operation: string, filter: "literal" | "subpath", value: string): string {
  return `(allow ${operation} (${filter} ${schemeString(value)}))`;
}

/**
 * Compatibility-only profile projection used by contract tests. Production
 * enforcement is built independently inside the native Rust runner.
 */
export function buildMacOsSandboxProfile(input: {
  cwd: string;
  privateTempDir: string;
  readablePaths?: string[];
  executablePaths?: string[];
  networkGranted?: boolean;
}): string {
  const cwd = canonicalExistingPath(input.cwd);
  const privateTempDir = canonicalDirectory(input.privateTempDir);
  const readable = [...new Set([
    cwd,
    privateTempDir,
    ...SYSTEM_READ_PATHS.filter(existsSync),
    ...(input.readablePaths ?? []).map(canonicalExistingPath),
  ])].sort();
  const executable = [...new Set([
    ...SYSTEM_EXECUTABLE_DIRS.filter(existsSync),
    ...(input.executablePaths ?? []).map(canonicalExistingPath),
  ])].sort();

  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow file-read-metadata)",
    "(allow file-read* (literal \"/dev/null\"))",
    "(allow file-read* (literal \"/dev/urandom\"))",
    "(allow file-write* (literal \"/dev/null\"))",
    ...readable.map((entry) => pathRule("file-read*", "subpath", entry)),
    ...executable.map((entry) => pathRule("process-exec", "subpath", entry)),
    pathRule("file-write*", "subpath", cwd),
    pathRule("file-write*", "subpath", privateTempDir),
    input.networkGranted === true ? "(allow network-outbound)" : "(deny network*)",
  ];
  return lines.join("\n");
}

/**
 * Builds a minimal child environment. No value from the engine environment is
 * inherited implicitly; callers must provide each non-runtime value.
 */
export function filterSandboxEnvironment(input: {
  cwd: string;
  privateTempDir: string;
  executablePaths?: string[];
  environment?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const executableDirs = (input.executablePaths ?? []).map((entry) => {
    const canonical = canonicalExistingPath(entry);
    return statSync(canonical).isDirectory() ? canonical : path.dirname(canonical);
  });
  const safeEnvironment: NodeJS.ProcessEnv = {
    PATH: [...new Set([...executableDirs, ...SYSTEM_EXECUTABLE_DIRS])].join(":"),
    HOME: input.privateTempDir,
    TMPDIR: input.privateTempDir,
    PWD: input.cwd,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
  for (const [name, value] of Object.entries(input.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid sandbox environment variable name: ${name}`);
    }
    safeEnvironment[name] = value;
  }
  return safeEnvironment;
}

class HeadTailPreview {
  readonly #headLimit = Math.ceil(TOOL_OUTPUT_PREVIEW_BYTES / 2);
  readonly #tailLimit = Math.floor(TOOL_OUTPUT_PREVIEW_BYTES / 2);
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);
  #total = 0;

  append(value: Buffer): void {
    this.#total += value.length;
    if (this.#head.length < this.#headLimit) {
      const missing = this.#headLimit - this.#head.length;
      this.#head = Buffer.concat([this.#head, value.subarray(0, missing)]);
    }
    this.#tail = Buffer.concat([this.#tail, value]);
    if (this.#tail.length > this.#tailLimit) {
      this.#tail = this.#tail.subarray(this.#tail.length - this.#tailLimit);
    }
  }

  render(): { text: string; truncated: boolean } {
    if (this.#total <= TOOL_OUTPUT_PREVIEW_BYTES) {
      const overlap = Math.max(0, this.#head.length + this.#tail.length - this.#total);
      return {
        text: Buffer.concat([this.#head, this.#tail.subarray(overlap)]).toString("utf8"),
        truncated: false,
      };
    }
    const omitted = this.#total - this.#head.length - this.#tail.length;
    return {
      text: `${this.#head.toString("utf8")}\n...[${omitted} bytes omitted; use read_tool_output]...\n${this.#tail.toString("utf8")}`,
      truncated: true,
    };
  }
}

function killProcessGroup(child: CapturedChild, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process tree may already have exited.
    }
  }
}

async function defaultProbe(sandboxExecutable: string): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const child = spawn(sandboxExecutable, ["--probe"], { stdio: "ignore" });
    child.once("error", (error) => resolve({ ok: false, reason: error.message }));
    child.once("close", (code) => resolve(
      code === 0
        ? { ok: true }
        : { ok: false, reason: `startup probe exited with code ${String(code)}` },
    ));
  });
}

function defaultRunnerExecutable(): string {
  const configured = process.env.OPENFUSION_SANDBOX_RUNNER;
  if (configured !== undefined && configured.length > 0) return path.resolve(configured);
  const executableName = path.basename(process.execPath);
  const runnerName = executableName.startsWith("openfusion-engine")
    ? executableName.replace("openfusion-engine", "openfusion-sandbox")
    : process.platform === "win32"
      ? "openfusion-sandbox.exe"
      : "openfusion-sandbox";
  return path.join(path.dirname(process.execPath), runnerName);
}

export interface NativeSandboxLaunch {
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  requestFile: string;
  cleanup(): void;
}

/**
 * Writes a mode-0600 launch request for the native runner. The Rust process
 * re-canonicalizes every path and rebuilds policy from this typed request;
 * this TypeScript projection is not a security decision point.
 */
export function createNativeSandboxLaunch(input: {
  runnerExecutable?: string;
  executable: string;
  args: string[];
  cwd: string;
  privateTempDir: string;
  readablePaths?: string[];
  executablePaths?: string[];
  networkGranted?: boolean;
  environment?: Record<string, string>;
  profile?: SandboxProfile;
}): NativeSandboxLaunch {
  const runnerExecutable = canonicalExistingPath(input.runnerExecutable ?? defaultRunnerExecutable());
  const cwd = canonicalExistingPath(input.cwd);
  const privateTempDir = canonicalDirectory(input.privateTempDir);
  const executable = canonicalExistingPath(input.executable);
  const executablePaths = [...(input.executablePaths ?? []), executable];
  const childEnvironment = filterSandboxEnvironment({
    cwd,
    privateTempDir,
    executablePaths,
    environment: input.environment,
  });
  const environment = Object.fromEntries(
    Object.entries(childEnvironment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const requestFile = path.join(privateTempDir, `sandbox-request-${randomUUID()}.json`);
  writeFileSync(requestFile, JSON.stringify({
    schemaVersion: 1,
    profile: input.profile ?? "author",
    executable,
    args: input.args,
    cwd,
    privateTempDir,
    readablePaths: input.readablePaths ?? [],
    executablePaths,
    networkGranted: input.networkGranted === true,
    environment,
  }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return {
    command: runnerExecutable,
    args: ["--request-file", requestFile],
    cwd,
    environment: {
      PATH: SYSTEM_EXECUTABLE_DIRS.join(":"),
      HOME: privateTempDir,
      TMPDIR: privateTempDir,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
    requestFile,
    cleanup: () => {
      try {
        unlinkSync(requestFile);
      } catch {
        // The private temp root may already have been removed by its owner.
      }
    },
  };
}

/** Certified macOS native containment backend. It has no unsandboxed fallback. */
export class MacOsSandboxBackend implements SandboxBackend {
  readonly #platform: NodeJS.Platform;
  readonly #runnerExecutable: string;
  readonly #spawnProcess: NonNullable<MacOsSandboxBackendOptions["spawnProcess"]>;
  readonly #probe: NonNullable<MacOsSandboxBackendOptions["probe"]>;
  #statusPromise: Promise<SandboxStatus> | undefined;

  constructor(options: MacOsSandboxBackendOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#runnerExecutable = path.resolve(
      options.runnerExecutable ?? options.sandboxExecutable ?? defaultRunnerExecutable(),
    );
    this.#spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
      spawn(command, args, spawnOptions));
    this.#probe = options.probe ?? defaultProbe;
  }

  status(): Promise<SandboxStatus> {
    this.#statusPromise ??= this.#checkStatus();
    return this.#statusPromise;
  }

  async run(request: SandboxedProcessRequest): Promise<SandboxedProcessResult> {
    const status = await this.status();
    if (!status.available) throw new SandboxUnavailableError(status.reason ?? "startup probe failed");
    const launch = createNativeSandboxLaunch({
      runnerExecutable: this.#runnerExecutable,
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      privateTempDir: request.privateTempDir,
      readablePaths: request.readablePaths,
      executablePaths: request.executablePaths,
      networkGranted: request.networkGranted,
      environment: request.environment,
      profile: request.profile,
    });

    return new Promise((resolve, reject) => {
      let child: CapturedChild;
      try {
        child = this.#spawnProcess(
          launch.command,
          launch.args,
          { cwd: launch.cwd, env: launch.environment, detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        launch.cleanup();
        request.output.abort();
        reject(error);
        return;
      }

      const preview = new HeadTailPreview();
      let failure: SandboxedProcessFailure | undefined;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => {
        failure ??= "timeout";
        killProcessGroup(child, "SIGTERM");
        killTimer ??= setTimeout(() => killProcessGroup(child, "SIGKILL"), TERMINATE_GRACE_MS);
      }, request.timeoutMs);

      const abort = (): void => {
        failure ??= "cancelled";
        killProcessGroup(child, "SIGTERM");
        killTimer ??= setTimeout(() => killProcessGroup(child, "SIGKILL"), TERMINATE_GRACE_MS);
      };
      if (request.abortSignal?.aborted === true) abort();
      else request.abortSignal?.addEventListener("abort", abort, { once: true });

      const onChunk = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        const framed = Buffer.concat([Buffer.from(`\n[${stream}]\n`, "utf8"), chunk]);
        preview.append(framed);
        const written = request.output.write(framed);
        if (written.limitReached && failure === undefined) {
          failure = "output-limit";
          killProcessGroup(child, "SIGTERM");
          killTimer ??= setTimeout(() => killProcessGroup(child, "SIGKILL"), TERMINATE_GRACE_MS);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => onChunk("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => onChunk("stderr", chunk));

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        failure = "spawn";
        clearTimeout(timeout);
        if (killTimer !== undefined) clearTimeout(killTimer);
        request.abortSignal?.removeEventListener("abort", abort);
        launch.cleanup();
        request.output.abort();
        reject(error);
      });

      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer !== undefined) clearTimeout(killTimer);
        request.abortSignal?.removeEventListener("abort", abort);
        launch.cleanup();
        try {
          const artifact = request.output.finish();
          const rendered = preview.render();
          resolve({
            exitCode: code,
            signal,
            ...(failure === undefined ? {} : { failure }),
            artifact,
            preview: rendered.text,
            previewTruncated: rendered.truncated || request.output.limitReached,
            outputBytes: request.output.bytesWritten,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async #checkStatus(): Promise<SandboxStatus> {
    if (this.#platform !== "darwin") {
      return {
        backend: "openfusion-sandbox",
        available: false,
        provisional: false,
        reason: `unsupported platform: ${this.#platform}`,
      };
    }
    if (!existsSync(this.#runnerExecutable)) {
      return {
        backend: "openfusion-sandbox",
        available: false,
        provisional: false,
        reason: `${this.#runnerExecutable} is missing`,
      };
    }
    const probe = await this.#probe(this.#runnerExecutable);
    return {
      backend: "openfusion-sandbox",
      available: probe.ok,
      provisional: false,
      ...(probe.reason === undefined ? {} : { reason: probe.reason }),
    };
  }
}
