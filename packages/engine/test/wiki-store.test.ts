import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openWikiStore, wikiDbPath } from "../src/wiki/store.js";

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
    expect(store.listFileRecords()).toEqual([
      { path: "src/a.ts", hash: "hash1", lang: "typescript" },
    ]);
    expect(store.integrityCheck()).toEqual({ ok: true, messages: ["ok"] });
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

  it("searches indexed paths and source text with FTS5", () => {
    const store = makeStore();
    store.upsertFile(
      "src/wiki/rebuild.ts",
      "h1",
      "typescript",
      [{ name: "refreshIndex", kind: "function", row: 2, col: 0 }],
      [],
      "export function refreshIndex() { return 'stale repository wiki'; }",
    );
    store.upsertFile(
      "src/payments/checkout.ts",
      "h2",
      "typescript",
      [{ name: "checkout", kind: "function", row: 0, col: 0 }],
      [],
      "export function checkout() { return 'payment'; }",
    );

    expect(store.searchFiles("stale wiki")[0]?.file).toBe("src/wiki/rebuild.ts");
    expect(store.searchFiles("rebuild")[0]?.file).toBe("src/wiki/rebuild.ts");
    expect(store.searchFiles("---")).toEqual([]);
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

  it("keeps an immutable task snapshot when the live index is rebuilt", () => {
    const store = makeStore();
    store.applyBuild(
      [{
        path: "src/version.ts",
        hash: "old-hash",
        lang: "typescript",
        symbols: [{ name: "oldVersion", kind: "function", row: 0, col: 0 }],
        refs: [],
        searchText: "old committed wiki content",
      }],
      [],
      {
        headSha: "a".repeat(40),
        sourceFingerprint: `sha256:${"a".repeat(64)}`,
      },
    );
    const snapshot = store.snapshot();

    store.applyBuild(
      [{
        path: "src/version.ts",
        hash: "new-hash",
        lang: "typescript",
        symbols: [{ name: "newVersion", kind: "function", row: 0, col: 0 }],
        refs: [],
        searchText: "new committed wiki content",
      }],
      [],
      {
        headSha: "b".repeat(40),
        sourceFingerprint: `sha256:${"b".repeat(64)}`,
      },
    );

    expect(snapshot.getSourceIdentity()).toEqual({
      headSha: "a".repeat(40),
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
    });
    expect(snapshot.symbolsByName("oldVersion")).toHaveLength(1);
    expect(snapshot.symbolsByName("newVersion")).toEqual([]);
    expect(snapshot.searchFiles("old committed")[0]?.file).toBe("src/version.ts");
    expect(store.getSourceIdentity().headSha).toBe("b".repeat(40));
    expect(store.symbolsByName("newVersion")).toHaveLength(1);
    snapshot.close();
    store.close();
  });

  it("stamps schema version 2 in the database", () => {
    const store = makeStore();
    store.close();
    const db = new Database(path.join(dir, ".openfusion/cache/wiki.db"));
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.close();
  });

  it("applyBuild applies updates, removals, and meta in one shot", () => {
    const store = makeStore();
    store.upsertFile("old.ts", "h0", "typescript", [
      { name: "gone", kind: "function", row: 0, col: 0 },
    ], []);
    store.applyBuild(
      [
        {
          path: "new.ts",
          hash: "h1",
          lang: "typescript",
          symbols: [{ name: "fresh", kind: "function", row: 1, col: 0 }],
          refs: [],
        },
      ],
      ["old.ts"],
      {
        headSha: "sha-xyz",
        sourceFingerprint: `sha256:${"a".repeat(64)}`,
        coverageJson: JSON.stringify({ supportedTracked: 1 }),
      },
    );
    expect(store.listFiles()).toEqual(["new.ts"]);
    expect(store.symbolsByName("gone")).toEqual([]);
    expect(store.symbolsByName("fresh")).toHaveLength(1);
    expect(store.getMeta("head_sha")).toBe("sha-xyz");
    expect(store.getMeta("source_fingerprint")).toBe(`sha256:${"a".repeat(64)}`);
    expect(store.getMeta("coverage")).toBe(JSON.stringify({ supportedTracked: 1 }));
  });

  it("recreates the database when schema version mismatches", () => {
    const store = makeStore();
    store.setMeta("marker", "will-vanish");
    store.close();
    const dbPath = path.join(dir, ".openfusion/cache/wiki.db");
    const raw = new Database(dbPath);
    raw.pragma("user_version = 99");
    raw.close();
    const reopened = openWikiStore(dir);
    expect(reopened.getMeta("marker")).toBeNull();
    reopened.close();
  });
});

describe("wikiDbPath", () => {
  it("returns the same path openWikiStore actually creates", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-store-path-"));
    const store = openWikiStore(dir);
    expect(existsSync(wikiDbPath(dir))).toBe(true);
    expect(wikiDbPath(dir)).toBe(path.join(dir, ".openfusion/cache/wiki.db"));
    store.close();
  });
});

// Fix 1: WAL-open race. busy_timeout does not cover the rollback→WAL
// journal_mode transition itself, so openWikiStore must retry that specific
// pragma on SQLITE_BUSY/"database is locked" rather than propagate it.
// Reproducing the exact cross-process race deterministically in-process is
// impractical (better-sqlite3 is a single connection per process and the
// transition is a single synchronous pragma call), so these two tests cover
// the transition path directly instead:
//   1. a fresh DELETE-mode db still lands in WAL after openWikiStore.
//   2. an already-WAL db skips the pragma entirely (no-op, stays WAL).
describe("openWikiStore WAL transition", () => {
  it("transitions a fresh DELETE-mode database to WAL", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-store-wal-"));
    const cacheDir = path.join(dir, ".openfusion", "cache");
    mkdirSync(cacheDir, { recursive: true });
    const dbPath = path.join(cacheDir, "wiki.db");
    const raw = new Database(dbPath);
    raw.pragma("journal_mode = DELETE");
    expect(raw.pragma("journal_mode", { simple: true })).toBe("delete");
    raw.close();

    const store = openWikiStore(dir);
    const check = new Database(dbPath);
    expect(check.pragma("journal_mode", { simple: true })).toBe("wal");
    check.close();
    store.close();
  });

  it("skips the WAL pragma when the database is already in WAL mode", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-store-wal-skip-"));
    const store = openWikiStore(dir);
    const dbPath = wikiDbPath(dir);
    store.close();

    // Reopen the same already-WAL db through openWikiStore again; the
    // pragma transition should be skipped (a no-op), and journal_mode must
    // remain "wal" either way.
    const reopened = openWikiStore(dir);
    const check = new Database(dbPath);
    expect(check.pragma("journal_mode", { simple: true })).toBe("wal");
    check.close();
    reopened.close();
  });
});
