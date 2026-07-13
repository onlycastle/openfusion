import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTEXT_SUMMARY_MAX_TOKENS,
  compactModelHistory,
  freezeRuntimeContext,
} from "../src/runtime/context.js";
import { RuntimeReadCache } from "../src/runtime/read-cache.js";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("runtime context", () => {
  it("fingerprints ordered frozen inputs deterministically", () => {
    const input = {
      instructionBundle: "stable",
      tools: [{ name: "read", inputSchema: { type: "object" } }],
      policy: { sandboxGrants: [], interactive: true },
      policyFingerprint: "sha256:" + "1".repeat(64),
      sandboxProfileId: "macos-worker-v1",
      skills: [{ id: "docs", fingerprint: "sha256:" + "2".repeat(64) }],
      mcpServers: [],
      hooks: [],
      adapters: [{ id: "ai-sdk", version: "7" }],
    };
    expect(freezeRuntimeContext(input).fingerprint).toBe(freezeRuntimeContext(input).fingerprint);
    expect(freezeRuntimeContext({ ...input, tools: [...input.tools, { name: "write", inputSchema: {} }] }).fingerprint)
      .not.toBe(freezeRuntimeContext(input).fingerprint);
  });

  it("compacts at 70%, keeps the stable prefix and recent messages, and bounds the summary", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "stable task contract" },
      ...Array.from({ length: 8 }, (_, index): ModelMessage => ({
        role: "assistant",
        content: [{ type: "text", text: `${index}:${"x".repeat(900)}` }],
      })),
    ];
    const compacted = compactModelHistory(messages, 1_000);
    expect(compacted).not.toBeNull();
    expect(compacted!.messages[0]).toEqual(messages[0]);
    expect(compacted!.messages.at(-1)).toEqual(messages.at(-1));
    expect(compacted!.summary.length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_TOKENS * 4);
    expect(compacted!.estimatedTokensAfter).toBeLessThan(compacted!.estimatedTokensBefore);
    expect(messages).toHaveLength(9);
  });

  it("deduplicates identical reads and advances a conservative mutation epoch", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-read-cache-"));
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "one", "utf8");
    const cache = new RuntimeReadCache();
    const first = cache.read(file, "1:20");
    const second = cache.read(file, "1:20");
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.digest).toBe(first.digest);
    expect(cache.invalidateAll()).toBe(1);
    expect(cache.read(file, "1:20")).toMatchObject({ cacheHit: false, mutationEpoch: 1 });
  });
});
