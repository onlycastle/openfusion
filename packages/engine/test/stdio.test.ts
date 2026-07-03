import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/main.js",
);

function requestOnce(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout waiting for response; stdout so far: ${out}`));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("\n")) {
        clearTimeout(timer);
        child.stdin.end();
        resolve(out.slice(0, out.indexOf("\n")));
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.write(payload);
  });
}

describe("stdio transport", () => {
  it("answers engine.ping over ndjson", async () => {
    const line = await requestOnce(
      '{"jsonrpc":"2.0","id":1,"method":"engine.ping"}\n',
    );
    const response = JSON.parse(line) as {
      id: number;
      result: { pong: boolean; version: string };
    };
    expect(response.id).toBe(1);
    expect(response.result.pong).toBe(true);
  }, 15_000);

  it("answers a parse error for garbage input", async () => {
    const line = await requestOnce("this is not json\n");
    const response = JSON.parse(line) as {
      id: null;
      error: { code: number };
    };
    expect(response.id).toBeNull();
    expect(response.error.code).toBe(-32700);
  }, 15_000);

  it("produces no stdout for notifications, only for the trailing request", async () => {
    const child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const stdout = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("timeout waiting for process exit"));
      }, 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString());
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.stdin.write(
        '{"jsonrpc":"2.0","method":"engine.ping"}\n{"jsonrpc":"2.0","id":9,"method":"engine.ping"}\n',
      );
      child.stdin.end();
    });
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const [line] = lines;
    if (line === undefined) {
      throw new Error("expected exactly one stdout line");
    }
    const response = JSON.parse(line) as { id: number };
    expect(response.id).toBe(9);
  }, 15_000);

  it("exits with code 0 when stdin closes", async () => {
    const child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("timeout waiting for exit"));
      }, 10_000);
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(code).toBe(0);
  }, 10_000);
});
