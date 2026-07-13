import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeFingerprint } from "../src/runtime/context.js";
import { RuntimeStore } from "../src/runtime/store.js";

let dir: string | undefined;
let store: RuntimeStore | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("extension approvals", () => {
  it("disables changed fingerprints until the new configuration is approved", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-extensions-"));
    store = new RuntimeStore({ projectDir: dir });
    const firstFingerprint = runtimeFingerprint({ command: "/bin/one" });
    let extension = store.registerExtension({
      kind: "hook",
      id: "lint",
      fingerprint: firstFingerprint,
      config: { executable: "/bin/one", mode: "observational" },
    });
    expect(extension.approvalStatus).toBe("pending");
    extension = store.approveExtension("hook", "lint", firstFingerprint, true);
    extension = store.setExtensionEnabled("hook", "lint", firstFingerprint, true);
    expect(extension).toMatchObject({ approvalStatus: "approved", enabled: true });

    const changedFingerprint = runtimeFingerprint({ command: "/bin/two" });
    extension = store.registerExtension({
      kind: "hook",
      id: "lint",
      fingerprint: changedFingerprint,
      config: { executable: "/bin/two", mode: "observational" },
    });
    expect(extension).toMatchObject({ approvalStatus: "pending", enabled: false });
    expect(() => store!.setExtensionEnabled("hook", "lint", changedFingerprint, true))
      .toThrow(/not approved/);
  });

  it("rejects persisted secret values and applies migration two", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-extensions-"));
    store = new RuntimeStore({ projectDir: dir });
    expect(store.schemaVersion()).toBe(4);
    expect(() => store!.registerExtension({
      kind: "mcp",
      id: "unsafe",
      fingerprint: runtimeFingerprint({ id: "unsafe" }),
      config: { apiKey: "plaintext" },
    })).toThrow(/credential references/);
  });
});
