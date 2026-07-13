import { createHash } from "node:crypto";
import type { RuntimeCapabilities } from "@openfusion/shared";

export type RuntimeCapabilityInput = Omit<RuntimeCapabilities, "schemaVersion" | "capabilityDigest">;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function runtimeCapabilities(input: RuntimeCapabilityInput): RuntimeCapabilities {
  const stable = { schemaVersion: 1 as const, ...input };
  return {
    ...stable,
    capabilityDigest: `sha256:${createHash("sha256").update(canonicalJson(stable)).digest("hex")}`,
  };
}

export function unknownRuntimeCapabilities(runtimeId: string): RuntimeCapabilities {
  return runtimeCapabilities({
    runtimeId,
    runtimeVersion: "unknown",
    protocolVersion: "unknown",
    structuredOutput: false,
    toolCalls: true,
    pathAwareApprovals: false,
    mcp: false,
    resume: false,
    fork: false,
    compaction: false,
    sandboxCompatibility: "unsupported",
  });
}
