import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeHookBus, runProcessHook } from "../src/runtime/hooks.js";
import type { SandboxBackend } from "../src/runtime/sandbox.js";
import { RuntimeStore } from "../src/runtime/store.js";

let dir: string | undefined;
let store: RuntimeStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("runtime hooks", () => {
  it("isolates in-process observer failures", async () => {
    const bus = new RuntimeHookBus();
    let observed = false;
    bus.on("model.before", () => { throw new Error("observer failed"); });
    bus.on("model.before", () => { observed = true; });
    await expect(bus.emit("model.before", { sessionId: "s", step: 1 })).resolves.toBeUndefined();
    expect(observed).toBe(true);
  });

  it("turns enforcing process failures into ask interactively and deny headlessly", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-hooks-"));
    store = new RuntimeStore({ projectDir: dir, key: Buffer.alloc(32, 1) });
    store.configure({ traceEnabled: true });
    const session = store.createSession({ kind: "worker" });
    const sandbox: SandboxBackend = {
      async status() { return { backend: "openfusion-sandbox", available: true, provisional: false }; },
      async run(request) {
        request.output.write("hook failed");
        const artifact = request.output.finish();
        return {
          exitCode: 1,
          signal: null,
          artifact,
          preview: "hook failed",
          previewTruncated: false,
          outputBytes: 11,
        };
      },
    };
    const common = {
      hook: {
        id: "guard",
        fingerprint: "sha256:" + "a".repeat(64),
        mode: "enforcing" as const,
        executable: "/bin/false",
      },
      facts: { schemaVersion: 1 as const, event: "tool.before" as const, risk: ["process" as const] },
      sandbox,
      store,
      sessionId: session.id,
      cwd: dir,
      approvedFingerprints: new Set(["sha256:" + "a".repeat(64)]),
    };
    await expect(runProcessHook({ ...common, interactive: true })).resolves.toMatchObject({ decision: "ask" });
    await expect(runProcessHook({ ...common, interactive: false })).resolves.toMatchObject({ decision: "deny" });
  });
});
