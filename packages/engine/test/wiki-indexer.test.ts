import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildIndex, getHeadSha } from "../src/wiki/indexer.js";
import { WikiParser } from "../src/wiki/parser.js";
import { openWikiStore, type WikiStore } from "../src/wiki/store.js";

let parser: WikiParser;
beforeAll(async () => {
  parser = await WikiParser.create();
}, 30_000);
afterAll(() => parser.dispose());

let dir: string;
let store: WikiStore;
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): void {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-idx-"));
  execFileSync("git", ["init", "-q", dir]);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.ts"), "export function alpha() {}\n");
  writeFileSync(path.join(dir, "b.ts"), "export function beta() { alpha(); }\n");
  writeFileSync(path.join(dir, "note.md"), "# not code\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  store = openWikiStore(dir);
}

describe("buildIndex", () => {
  it("indexes tracked supported files and stamps the head sha", async () => {
    makeRepo();
    const stats = await buildIndex(dir, store, parser);
    expect(stats.filesSeen).toBe(2);
    expect(stats.filesIndexed).toBe(2);
    expect(stats.filesSkipped).toBe(0);
    expect(stats.filesFailed).toBe(0);
    expect(stats.symbols).toBeGreaterThanOrEqual(2);
    expect(stats.headSha).toBe(getHeadSha(dir));
    expect(store.getMeta("head_sha")).toBe(stats.headSha);
    expect(store.symbolsByName("alpha")[0]?.file).toBe("a.ts");
  });

  it("skips unchanged files on rebuild and re-indexes modified ones", async () => {
    makeRepo();
    await buildIndex(dir, store, parser);
    writeFileSync(path.join(dir, "b.ts"), "export function betaTwo() {}\n");
    git("add", "-A");
    git("commit", "-qm", "edit b");
    const stats = await buildIndex(dir, store, parser);
    expect(stats.filesSkipped).toBe(1);
    expect(stats.filesIndexed).toBe(1);
    expect(store.symbolsByName("beta")).toEqual([]);
    expect(store.symbolsByName("betaTwo")).toHaveLength(1);
  });

  it("removes entries for deleted files", async () => {
    makeRepo();
    await buildIndex(dir, store, parser);
    git("rm", "-q", "b.ts");
    git("commit", "-qm", "rm b");
    const stats = await buildIndex(dir, store, parser);
    expect(stats.filesRemoved).toBe(1);
    expect(store.listFiles()).toEqual(["a.ts"]);
  });

  it("keeps entries for tracked files that become oversized (skip, not removal)", async () => {
    makeRepo();
    await buildIndex(dir, store, parser);
    expect(store.symbolsByName("alpha")).toHaveLength(1);
    writeFileSync(
      path.join(dir, "a.ts"),
      `export function alpha() {}\n// ${"x".repeat(1024 * 1024)}\n`,
    );
    git("add", "-A");
    git("commit", "-qm", "grow a");
    const stats = await buildIndex(dir, store, parser);
    expect(stats.filesRemoved).toBe(0);
    expect(store.listFiles()).toContain("a.ts");
    expect(store.symbolsByName("alpha")).toHaveLength(1);
  });

  it("yields the event loop during large builds (concurrent timer fires mid-build)", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-idx-big-"));
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    for (let i = 0; i < 60; i += 1) {
      writeFileSync(path.join(dir, `f${i}.ts`), `export function fn${i}() {}\n`);
    }
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "many"]);
    store = openWikiStore(dir);
    let timerFired = false;
    const timer = setImmediate(() => {
      timerFired = true;
    });
    const stats = await buildIndex(dir, store, parser);
    clearImmediate(timer);
    expect(stats.filesIndexed).toBe(60);
    expect(timerFired).toBe(true);
  }, 30_000);

  it("yields during mostly-skipped incremental rebuilds", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-idx-skip-"));
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    for (let i = 0; i < 60; i += 1) {
      writeFileSync(path.join(dir, `s${i}.ts`), `export function sk${i}() {}\n`);
    }
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "many"]);
    store = openWikiStore(dir);
    await buildIndex(dir, store, parser);
    let timerFired = false;
    const timer = setImmediate(() => {
      timerFired = true;
    });
    const stats = await buildIndex(dir, store, parser);
    clearImmediate(timer);
    expect(stats.filesSkipped).toBe(60);
    expect(stats.filesIndexed).toBe(0);
    expect(timerFired).toBe(true);
  }, 30_000);
});

describe("buildIndex — onProgress callback (M7c Task 1)", () => {
  it("emits a bounded number of progress calls for a many-file repo, never one per file", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-idx-progress-"));
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    const fileCount = 120;
    for (let i = 0; i < fileCount; i += 1) {
      writeFileSync(path.join(dir, `f${i}.ts`), `export function fn${i}() {}\n`);
    }
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "many"]);
    store = openWikiStore(dir);

    const calls: string[] = [];
    const stats = await buildIndex(dir, store, parser, (detail) => calls.push(detail));

    expect(stats.filesIndexed).toBe(fileCount);
    expect(calls.length).toBeGreaterThan(0);
    // Bounded cadence: nowhere near one notification per file (120 files) —
    // generously bounded well under half the file count so this can't flake
    // on cadence tuning, while still proving it isn't O(files).
    expect(calls.length).toBeLessThan(fileCount / 2);
    for (const detail of calls) {
      expect(typeof detail).toBe("string");
      expect(detail.length).toBeGreaterThan(0);
    }
    // The final summary call carries the total count.
    expect(calls.some((d) => d.includes(`${fileCount}`))).toBe(true);
  }, 30_000);

  it("never includes file CONTENT in a progress detail — only paths/counts", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-idx-progress-content-"));
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    const SENTINEL = "SUPER_SECRET_FILE_CONTENT_SENTINEL_9f3a";
    writeFileSync(path.join(dir, "secret.ts"), `// ${SENTINEL}\nexport function withSecret() {}\n`);
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(path.join(dir, `f${i}.ts`), `export function fn${i}() {}\n`);
    }
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "with secret"]);
    store = openWikiStore(dir);

    const calls: string[] = [];
    await buildIndex(dir, store, parser, (detail) => calls.push(detail));

    expect(calls.length).toBeGreaterThan(0);
    for (const detail of calls) {
      expect(detail).not.toContain(SENTINEL);
    }
  });
});

describe("getHeadSha", () => {
  it("throws outside a git repository", () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), "of-nogit-"));
    try {
      expect(() => getHeadSha(plain)).toThrow();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
