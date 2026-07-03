import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SymbolEntry {
  name: string;
  kind: string;
  row: number;
  col: number;
}

export interface SymbolHit extends SymbolEntry {
  file: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, hash TEXT NOT NULL, lang TEXT NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL, row INTEGER NOT NULL, col INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL, row INTEGER NOT NULL, col INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file);
`;

const SCHEMA_VERSION = 1;

export class WikiStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  upsertFile(
    filePath: string,
    hash: string,
    lang: string,
    symbols: SymbolEntry[],
    refs: SymbolEntry[],
  ): void {
    const insertFile = this.#db.prepare(
      `INSERT INTO files (path, hash, lang, indexed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET hash = excluded.hash,
         lang = excluded.lang, indexed_at = excluded.indexed_at`,
    );
    const delSymbols = this.#db.prepare("DELETE FROM symbols WHERE file = ?");
    const delRefs = this.#db.prepare("DELETE FROM refs WHERE file = ?");
    const insSymbol = this.#db.prepare(
      "INSERT INTO symbols (file, name, kind, row, col) VALUES (?, ?, ?, ?, ?)",
    );
    const insRef = this.#db.prepare(
      "INSERT INTO refs (file, name, kind, row, col) VALUES (?, ?, ?, ?, ?)",
    );
    this.#db.transaction(() => {
      insertFile.run(filePath, hash, lang, Date.now());
      delSymbols.run(filePath);
      delRefs.run(filePath);
      for (const s of symbols) insSymbol.run(filePath, s.name, s.kind, s.row, s.col);
      for (const r of refs) insRef.run(filePath, r.name, r.kind, r.row, r.col);
    })();
  }

  removeFile(filePath: string): void {
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM symbols WHERE file = ?").run(filePath);
      this.#db.prepare("DELETE FROM refs WHERE file = ?").run(filePath);
      this.#db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
    })();
  }

  getFileHash(filePath: string): string | null {
    const row = this.#db
      .prepare("SELECT hash FROM files WHERE path = ?")
      .get(filePath) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  listFiles(): string[] {
    const rows = this.#db
      .prepare("SELECT path FROM files ORDER BY path")
      .all() as { path: string }[];
    return rows.map((r) => r.path);
  }

  symbolsByName(name: string): SymbolHit[] {
    return this.#db
      .prepare(
        "SELECT file, name, kind, row, col FROM symbols WHERE name = ? ORDER BY file, row",
      )
      .all(name) as SymbolHit[];
  }

  refsByName(name: string): SymbolHit[] {
    return this.#db
      .prepare(
        "SELECT file, name, kind, row, col FROM refs WHERE name = ? ORDER BY file, row",
      )
      .all(name) as SymbolHit[];
  }

  counts(): { files: number; symbols: number; refs: number } {
    const one = (sql: string): number =>
      (this.#db.prepare(sql).get() as { n: number }).n;
    return {
      files: one("SELECT COUNT(*) AS n FROM files"),
      symbols: one("SELECT COUNT(*) AS n FROM symbols"),
      refs: one("SELECT COUNT(*) AS n FROM refs"),
    };
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.#db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  close(): void {
    this.#db.close();
  }
}

export function openWikiStore(projectDir: string): WikiStore {
  const openfusionDir = path.join(projectDir, ".openfusion");
  const cacheDir = path.join(openfusionDir, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const gitignorePath = path.join(openfusionDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "cache/\n");
  }
  const db = new Database(path.join(cacheDir, "wiki.db"));
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return new WikiStore(db);
}
