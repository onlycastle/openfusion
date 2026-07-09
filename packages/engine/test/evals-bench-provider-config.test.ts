import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/engine.js";
import {
  configureBenchProviders,
  loadBenchProviderConfigs,
} from "../src/evals/bench/providerConfig.js";

let tmp: string | undefined;
let engine: Engine | undefined;

afterEach(async () => {
  if (engine !== undefined) await engine.close();
  engine = undefined;
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function writeJson(value: unknown): string {
  tmp = mkdtempSync(path.join(os.tmpdir(), "of-bench-providers-"));
  const file = path.join(tmp, "providers.json");
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

describe("bench provider config", () => {
  it("loads provider arrays and configures the engine without exposing api keys", () => {
    const file = writeJson({
      providers: [
        {
          id: "deepseek-bench",
          kind: "deepseek",
          apiKey: "sk-test-fixture-never-real",
        },
        {
          id: "openai-compatible-bench",
          kind: "openai-compatible",
          apiKey: "sk-test-fixture-never-real-2",
          baseURL: "https://example.test/v1",
        },
      ],
    });

    const configs = loadBenchProviderConfigs(file);
    expect(configs).toHaveLength(2);
    expect(configs[0]!.id).toBe("deepseek-bench");

    const logs: string[] = [];
    engine = createEngine();
    expect(configureBenchProviders(engine, file, (msg) => logs.push(msg))).toBe(2);
    expect(logs.join("\n")).not.toContain("sk-test");
    expect(engine.models.registry.list()).toEqual([
      { id: "deepseek-bench", kind: "deepseek", baseURL: undefined },
      { id: "openai-compatible-bench", kind: "openai-compatible", baseURL: "https://example.test/v1" },
    ]);
  });

  it("also accepts a single ProviderConfig object", () => {
    const file = writeJson({
      id: "moonshot-bench",
      kind: "moonshot",
      apiKey: "sk-test-fixture-never-real",
    });

    expect(loadBenchProviderConfigs(file).map((p) => p.id)).toEqual(["moonshot-bench"]);
  });

  it("rejects malformed config files", () => {
    const file = writeJson({ providers: [{ id: "missing-kind" }] });
    expect(() => loadBenchProviderConfigs(file)).toThrow(/schema validation/);
  });
});
