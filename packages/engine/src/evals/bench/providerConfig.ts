// Worker provider config loading for the benchmark CLI.
//
// The desktop app persists providers through Keychain-backed UI state, but
// openfusion-bench is a standalone bin with a fresh in-memory Engine. This
// helper is the explicit bridge from a gitignored local JSON file into that
// Engine's ProviderRegistry.

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Engine } from "../../engine.js";
import { ProviderConfigSchema, type ProviderConfig } from "../../models/providers.js";

const ProviderConfigFileSchema = z.union([
  ProviderConfigSchema,
  z.array(ProviderConfigSchema).min(1),
  z.object({ providers: z.array(ProviderConfigSchema).min(1) }),
]);

export type BenchProviderConfigFile = ProviderConfig | ProviderConfig[] | { providers: ProviderConfig[] };

export function loadBenchProviderConfigs(filePath: string): ProviderConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`failed to read benchmark provider config ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = ProviderConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`benchmark provider config failed schema validation: ${result.error.message}`);
  }

  const value = result.data;
  if (Array.isArray(value)) return value;
  if ("providers" in value) return value.providers;
  return [value];
}

export function configureBenchProviders(
  engine: Engine,
  filePath: string | undefined,
  log: (msg: string) => void = () => {},
): number {
  if (filePath === undefined || filePath.length === 0) return 0;
  const configs = loadBenchProviderConfigs(filePath);
  for (const config of configs) {
    engine.models.registry.configure(config);
  }
  log(`configured ${configs.length} benchmark worker provider(s)`);
  return configs.length;
}
