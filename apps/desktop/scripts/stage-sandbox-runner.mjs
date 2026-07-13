#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const manifest = path.join(repoRoot, "native", "sandbox-runner", "Cargo.toml");
const targetRoot = path.join(repoRoot, "native", "sandbox-runner", "target", "release");
const binariesDir = path.join(desktopRoot, "src-tauri", "binaries");

function targetTriple() {
  const table = {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:arm64": "aarch64-unknown-linux-gnu",
    "linux:x64": "x86_64-unknown-linux-gnu",
    "win32:x64": "x86_64-pc-windows-msvc",
  };
  const key = `${os.platform()}:${os.arch()}`;
  const triple = table[key];
  if (triple === undefined) throw new Error(`no sandbox-runner target mapping for ${key}`);
  return triple;
}

function main() {
  execFileSync("cargo", ["build", "--release", "--manifest-path", manifest], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  const executable = os.platform() === "win32" ? "openfusion-sandbox.exe" : "openfusion-sandbox";
  const destinationName = os.platform() === "win32"
    ? `openfusion-sandbox-${targetTriple()}.exe`
    : `openfusion-sandbox-${targetTriple()}`;
  mkdirSync(binariesDir, { recursive: true });
  const destination = path.join(binariesDir, destinationName);
  copyFileSync(path.join(targetRoot, executable), destination);
  chmodSync(destination, 0o755);
  process.stdout.write(`[stage-sandbox-runner] staged ${destinationName}\n`);
}

main();
