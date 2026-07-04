import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Headless proof that `packages/engine/scripts/build-sidecar.mjs`'s output
// (a compiled, self-contained sidecar binary — the artifact Tauri's M8
// bundle spawns as `bundle.externalBin`) is a WORKING engine: this spawns
// the REAL compiled executable (not `dist/main.js` under plain node) as a
// child process, feeds it a JSON-RPC request over stdin, and checks a
// well-formed response comes back over stdout.
//
// `engine.wiki.build` is the load-bearing choice of method here rather than
// something like `engine.ping` (pure JS, proves nothing about packaging) or
// `engine.models.list` (also pure JS — no DB, no wasm): wiki.build opens a
// real better-sqlite3 database (the native `.node` addon — the whole reason
// this milestone chose `@yao-pkg/pkg` over embedding it) AND runs it through
// the tree-sitter wasm parser (both the core `web-tree-sitter.wasm` runtime
// and a per-language grammar `.wasm`) to extract symbols/refs. A method that
// only touched pure JS would leave the actual risk (does the native addon +
// wasm load from a compiled binary?) unproven.
//
// Gated on the binary already existing: building it (tsc → esbuild bundle →
// pkg compile → fetch a Node-24-ABI-matched better-sqlite3 prebuilt) takes
// long enough, and needs enough network access on a cold cache, that running
// it automatically from every `pnpm test` would make the suite flaky/slow
// for no benefit — run `pnpm --filter @openfusion/engine build:sidecar`
// first, then this test runs for real instead of skipping. See
// .superpowers/sdd/m7a-task-1-report.md for the full build-tool writeup.
const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Mirrors build-sidecar.mjs's targetTriple() (Rust/Tauri naming). Kept as an
// inline duplicate rather than a shared import: build-sidecar.mjs is a
// standalone build tool outside the tsc project (tsconfig.test.json only
// includes src/ + test/), so importing it here would pull an unchecked .mjs
// file into the strict-TS typecheck project.
function targetTriple(): string | null {
  const table: Record<string, string> = {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:arm64": "aarch64-unknown-linux-gnu",
    "linux:x64": "x86_64-unknown-linux-gnu",
    "win32:x64": "x86_64-pc-windows-msvc",
  };
  return table[`${os.platform()}:${os.arch()}`] ?? null;
}

const triple = targetTriple();
const binaryPath =
  triple !== null ? path.join(engineRoot, "dist-sidecar", `openfusion-engine-${triple}`) : null;
const binaryExists = binaryPath !== null && existsSync(binaryPath);

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// Spawns the compiled binary, writes one JSON-RPC request line, and resolves
// with the FIRST ndjson line on stdout whose `id` matches the request — the
// engine may also emit server-initiated notification lines (no `id`), which
// this deliberately ignores rather than assuming the response is the first
// line.
function callSidecar(
  bin: string,
  request: { jsonrpc: "2.0"; id: number; method: string; params: unknown },
  extraEnv?: Record<string, string>,
): Promise<{ response: JsonRpcResponse; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: extraEnv === undefined ? process.env : { ...process.env, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error(`sidecar timed out waiting for a response.\nstderr:\n${stderr}\nstdout:\n${stdout}`));
      });
    }, 25_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (settled) return;
      for (const line of stdout.split("\n")) {
        if (line.length === 0) continue;
        let parsed: JsonRpcResponse;
        try {
          parsed = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }
        if (parsed.id === request.id) {
          finish(() => {
            resolve({ response: parsed, stdout, stderr });
            child.stdin.end();
            child.kill();
          });
          return;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish(() => reject(err));
    });

    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

describe("compiled sidecar binary", () => {
  let dir: string;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!binaryExists)(
    "loads better-sqlite3 (native addon) + tree-sitter wasm from a compiled binary and returns a well-formed JSON-RPC result over stdout only",
    async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "of-sidecar-"));
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
      execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
      writeFileSync(path.join(dir, "x.ts"), "export function xray() {}\nxray();\n");
      execFileSync("git", ["-C", dir, "add", "-A"]);
      execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);

      const { response, stdout } = await callSidecar(binaryPath!, {
        jsonrpc: "2.0",
        id: 1,
        method: "engine.wiki.build",
        params: { projectDir: dir },
      });

      expect(response.error).toBeUndefined();
      expect(response).toMatchObject({ jsonrpc: "2.0", id: 1 });
      const result = response.result as {
        filesIndexed: number;
        symbols: number;
        refs: number;
        headSha: string;
      };
      // Load-bearing assertions: a real row got written to the sqlite file
      // (better-sqlite3's native addon loaded and executed) and at least one
      // symbol/ref got extracted (the tree-sitter wasm parser — both the
      // core web-tree-sitter.wasm runtime and the TypeScript grammar wasm —
      // actually ran). A stub/empty result would mean the binary started
      // but neither dependency actually worked.
      expect(result.filesIndexed).toBe(1);
      expect(result.symbols).toBeGreaterThanOrEqual(1);
      expect(result.refs).toBeGreaterThanOrEqual(1);
      expect(typeof result.headSha).toBe("string");

      // stdout-purity: every non-empty line on stdout must be valid JSON.
      // Compile tooling (pkg's own banner, esbuild diagnostics, a stray
      // console.log from a bundled dependency) writing ANYTHING else to
      // stdout would corrupt the ndjson stream Tauri's Command.spawn()
      // parses line-by-line — see main.ts's own stdout-purity contract.
      const lines = stdout.split("\n").filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    },
    30_000,
  );

  // THE LOAD-BEARING PROOF for M8 Blocker B: in the packaged `.app`, Tauri
  // stages the sidecar binary at `Contents/MacOS/openfusion-engine` (no
  // sibling `.assets/` dir there at all — `bundle.resources` ships it into
  // the DIFFERENT `Contents/Resources/` dir instead), so `${execPath}.
  // assets` self-location (the default proven above) cannot work in the
  // packaged app. This test simulates exactly that: it HIDES the binary's
  // real sibling `.assets/` dir (rename, not delete, so it's restored for
  // any other test/run afterward), copies its contents to an unrelated tmp
  // dir, and spawns the SAME compiled binary with `OPENFUSION_ASSETS_DIR`
  // pointed at that relocated copy — proving the env var alone is
  // sufficient even when the binary's own default self-location has
  // nothing there to find.
  it.skipIf(!binaryExists)(
    "with OPENFUSION_ASSETS_DIR pointed at a relocated assets dir (simulating the packaged-.app layout) and no sibling .assets dir present, still loads the native addon + wasm and returns a well-formed result",
    async () => {
      const realAssetsDir = `${binaryPath}.assets`;
      const hiddenAssetsDir = `${realAssetsDir}.hidden-for-relocation-test`;
      const relocatedRoot = mkdtempSync(path.join(os.tmpdir(), "of-relocated-assets-"));
      const relocatedAssetsDir = path.join(relocatedRoot, "assets");

      renameSync(realAssetsDir, hiddenAssetsDir);
      try {
        execFileSync("cp", ["-R", hiddenAssetsDir, relocatedAssetsDir]);
        // Sanity-check the simulated packaged layout: the binary's default
        // self-location target must genuinely be gone, or this test would
        // pass for the wrong reason (falling back to it instead of using
        // OPENFUSION_ASSETS_DIR).
        expect(existsSync(realAssetsDir)).toBe(false);

        dir = mkdtempSync(path.join(os.tmpdir(), "of-sidecar-relocated-"));
        execFileSync("git", ["init", "-q", dir]);
        execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
        execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
        writeFileSync(path.join(dir, "x.ts"), "export function xray() {}\nxray();\n");
        execFileSync("git", ["-C", dir, "add", "-A"]);
        execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);

        const { response } = await callSidecar(
          binaryPath!,
          {
            jsonrpc: "2.0",
            id: 3,
            method: "engine.wiki.build",
            params: { projectDir: dir },
          },
          { OPENFUSION_ASSETS_DIR: relocatedAssetsDir },
        );

        expect(response.error).toBeUndefined();
        const result = response.result as {
          filesIndexed: number;
          symbols: number;
          refs: number;
        };
        // Same load-bearing assertions as the default-self-location proof
        // above: a real row got written (native addon loaded) and at least
        // one symbol/ref got extracted (wasm parser ran) — from the
        // RELOCATED dir, with no sibling .assets dir in sight.
        expect(result.filesIndexed).toBe(1);
        expect(result.symbols).toBeGreaterThanOrEqual(1);
        expect(result.refs).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(relocatedRoot, { recursive: true, force: true });
        renameSync(hiddenAssetsDir, realAssetsDir);
      }
    },
    30_000,
  );

  it.skipIf(!binaryExists)("emits nothing on stdout before the response for a trivial call", async () => {
    const { response, stdout } = await callSidecar(binaryPath!, {
      jsonrpc: "2.0",
      id: 2,
      method: "engine.ping",
      params: {},
    });
    expect(response).toEqual({ jsonrpc: "2.0", id: 2, result: { pong: true, version: expect.any(String) } });
    expect(stdout).toBe(`${JSON.stringify(response)}\n`);
  });
});
