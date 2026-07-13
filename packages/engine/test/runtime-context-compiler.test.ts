import { describe, expect, it } from "vitest";
import {
  ContextCompiler,
  MAX_INLINE_CONTEXT_BYTES,
} from "../src/runtime/context-compiler.js";

const BASE_SHA = "a".repeat(40);
const WIKI_DIGEST = `sha256:${"b".repeat(64)}`;

describe("ContextCompiler", () => {
  it("orders stable and retrieved context before volatile task content", () => {
    const compiled = new ContextCompiler().compile({
      snapshot: { baseSha: BASE_SHA, snapshotId: "snapshot-1", wikiDigest: WIKI_DIGEST },
      instructions: "stable instructions",
      approvedProjectContext: "approved card",
      retrievedWiki: {
        content: "task-matched symbols",
        snapshotDigest: WIKI_DIGEST,
        queryId: "wiki-map:task",
      },
      task: "volatile task",
    });
    const content = compiled.messages[0]!.content as string;
    expect(content.indexOf("stable instructions")).toBeLessThan(content.indexOf("approved card"));
    expect(content.indexOf("approved card")).toBeLessThan(content.indexOf("task-matched symbols"));
    expect(content.indexOf("task-matched symbols")).toBeLessThan(content.indexOf("volatile task"));
    expect(compiled.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(compiled.sources.map((source) => source.kind)).toEqual([
      "instructions",
      "project",
      "wiki",
      "task",
    ]);
  });

  it("binds retrieved wiki context to the captured wiki snapshot", () => {
    expect(() => new ContextCompiler().compile({
      snapshot: { baseSha: BASE_SHA, wikiDigest: WIKI_DIGEST },
      instructions: "stable",
      task: "task",
      retrievedWiki: {
        content: "stale map",
        snapshotDigest: `sha256:${"c".repeat(64)}`,
        queryId: "wiki-map:task",
      },
    })).toThrow("does not match the task snapshot");
  });

  it("rejects oversized inline output and accepts content-free artifact references", () => {
    expect(() => new ContextCompiler().compile({
      snapshot: { baseSha: BASE_SHA },
      instructions: "stable",
      task: "task",
      approvedProjectContext: "x".repeat(MAX_INLINE_CONTEXT_BYTES + 1),
    })).toThrow("use an artifact reference");

    const compiled = new ContextCompiler().compile({
      snapshot: { baseSha: BASE_SHA },
      instructions: "stable",
      task: "task",
      artifactRefs: [{ id: "artifact-1", digest: `sha256:${"d".repeat(64)}` }],
    });
    const content = compiled.messages[0]!.content as string;
    expect(content).toContain("artifact-1");
    expect(compiled.sources.at(-1)).toMatchObject({ kind: "artifact", bytes: 0 });
  });

  it("changes identity when task or selected context changes", () => {
    const compiler = new ContextCompiler();
    const base = {
      snapshot: { baseSha: BASE_SHA },
      instructions: "stable",
      task: "task one",
    };
    expect(compiler.compile(base).fingerprint).not.toBe(
      compiler.compile({ ...base, task: "task two" }).fingerprint,
    );
  });
});
