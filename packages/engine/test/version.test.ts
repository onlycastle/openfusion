import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "../src/version.js";

describe("ENGINE_VERSION", () => {
  it("matches package.json version (drift guard)", () => {
    const manifestPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../package.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      version: string;
    };
    expect(ENGINE_VERSION).toBe(manifest.version);
  });
});
