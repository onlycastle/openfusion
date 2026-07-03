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
