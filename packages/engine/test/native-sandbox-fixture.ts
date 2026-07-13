import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Test-only stand-in for the Rust runner; it exercises the request-file protocol. */
export function createPassthroughSandboxRunner(root: string, name = "sandbox-runner.mjs"): string {
  const runner = path.join(root, name);
  writeFileSync(
    runner,
    `#!${process.execPath}
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

if (process.argv[2] === "--probe") process.exit(0);
if (process.argv[2] !== "--request-file" || process.argv[3] === undefined) process.exit(64);
const request = JSON.parse(readFileSync(process.argv[3], "utf8"));
const child = spawn(request.executable, request.args, {
  cwd: request.cwd,
  env: request.environment,
  stdio: "inherit",
});
child.once("error", (error) => {
  process.stderr.write(String(error));
  process.exit(70);
});
child.once("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`,
    { encoding: "utf8", mode: 0o700 },
  );
  chmodSync(runner, 0o700);
  return runner;
}
