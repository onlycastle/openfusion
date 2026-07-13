import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine, type FrontierAdapter } from "../src/engine.js";
import { runtimeCapabilities } from "../src/runtime/capabilities.js";
import { captureTaskSnapshot } from "../src/runtime/snapshot.js";

const roots: string[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "of-snapshot-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "OpenFusion Test"]);
  writeFileSync(path.join(root, "README.md"), "base\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "base"]);
  return root;
}

describe("captureTaskSnapshot", () => {
  it("rejects HEAD drift that occurs during an asynchronous capability probe", async () => {
    const projectDir = makeRepo();
    const engine = createEngine({ appStorageDir: mkdtempSync(path.join(os.tmpdir(), "of-snapshot-store-")) });
    roots.push(engine.appStorageDir);
    engines.push(engine);

    const adapter: FrontierAdapter = {
      kind: "claude-code",
      async capabilities() {
        writeFileSync(path.join(projectDir, "late.txt"), "drift\n");
        execFileSync("git", ["-C", projectDir, "add", "late.txt"]);
        execFileSync("git", ["-C", projectDir, "commit", "-qm", "late drift"]);
        return runtimeCapabilities({
          runtimeId: "snapshot-probe",
          runtimeVersion: "1",
          protocolVersion: "1",
          structuredOutput: false,
          toolCalls: false,
          pathAwareApprovals: false,
          mcp: false,
          resume: false,
          fork: false,
          compaction: false,
          sandboxCompatibility: "unsupported",
        });
      },
      async createSession() {
        throw new Error("not used");
      },
    };
    engine.frontier.registerAdapter(adapter);

    await expect(captureTaskSnapshot(engine, projectDir)).rejects.toThrow(
      "Git HEAD changed while the task snapshot was captured",
    );
  });
});
