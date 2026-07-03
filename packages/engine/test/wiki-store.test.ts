import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openWikiStore } from "../src/wiki/store.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeStore() {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-store-"));
  return openWikiStore(dir);
}

describe("openWikiStore", () => {
  it("creates cache dir, db file, and a .gitignore guarding cache/", () => {
    const store = makeStore();
    expect(existsSync(path.join(dir, ".openfusion/cache/wiki.db"))).toBe(true);
    expect(readFileSync(path.join(dir, ".openfusion/.gitignore"), "utf8")).toContain(
      "cache/",
    );
    store.close();
  });
});

describe("WikiStore", () => {
  it("round-trips symbols and refs for a file", () => {
    const store = makeStore();
    store.upsertFile(
      "src/a.ts",
      "hash1",
      "typescript",
      [{ name: "foo", kind: "function", row: 3, col: 9 }],
      [{ name: "bar", kind: "call", row: 4, col: 2 }],
    );
    expect(store.getFileHash("src/a.ts")).toBe("hash1");
    expect(store.symbolsByName("foo")).toEqual([
      { file: "src/a.ts", name: "foo", kind: "function", row: 3, col: 9 },
    ]);
    expect(store.refsByName("bar")).toHaveLength(1);
    expect(store.counts()).toEqual({ files: 1, symbols: 1, refs: 1 });
    store.close();
  });

  it("upsert replaces prior rows for the same file", () => {
    const store = makeStore();
    store.upsertFile("a.ts", "h1", "typescript", [
      { name: "old", kind: "function", row: 0, col: 0 },
    ], []);
    store.upsertFile("a.ts", "h2", "typescript", [
      { name: "new", kind: "function", row: 1, col: 0 },
    ], []);
    expect(store.symbolsByName("old")).toEqual([]);
    expect(store.symbolsByName("new")).toHaveLength(1);
    expect(store.getFileHash("a.ts")).toBe("h2");
    store.close();
  });

  it("removeFile deletes the file and its rows; listFiles reflects state", () => {
    const store = makeStore();
    store.upsertFile("a.ts", "h", "typescript", [
      { name: "s", kind: "class", row: 0, col: 0 },
    ], []);
    expect(store.listFiles()).toEqual(["a.ts"]);
    store.removeFile("a.ts");
    expect(store.listFiles()).toEqual([]);
    expect(store.symbolsByName("s")).toEqual([]);
    store.close();
  });

  it("meta round-trips and returns null when missing", () => {
    const store = makeStore();
    expect(store.getMeta("head_sha")).toBeNull();
    store.setMeta("head_sha", "abc123");
    expect(store.getMeta("head_sha")).toBe("abc123");
    store.setMeta("head_sha", "def456");
    expect(store.getMeta("head_sha")).toBe("def456");
    store.close();
  });

  it("stamps schema version 1 in the database", () => {
    const store = makeStore();
    store.close();
    const db = new Database(path.join(dir, ".openfusion/cache/wiki.db"));
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    db.close();
  });
});
