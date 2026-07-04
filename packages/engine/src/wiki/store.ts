import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { ensureGitignoreGuard } from "../util/gitignore-guard.js";
import { packagedAssetPath, resolveAssetsBaseDir } from "../util/sidecar-runtime.js";

export interface SymbolEntry {
  name: string;
  kind: string;
  row: number;
  col: number;
}

export interface SymbolHit extends SymbolEntry {
  file: string;
}

export interface FileUpdate {
  path: string;
  hash: string;
  lang: string;
  symbols: SymbolEntry[];
  refs: SymbolEntry[];
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

  #applyFileTx(
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
    insertFile.run(filePath, hash, lang, Date.now());
    delSymbols.run(filePath);
    delRefs.run(filePath);
    for (const s of symbols) insSymbol.run(filePath, s.name, s.kind, s.row, s.col);
    for (const r of refs) insRef.run(filePath, r.name, r.kind, r.row, r.col);
  }

  upsertFile(
    filePath: string,
    hash: string,
    lang: string,
    symbols: SymbolEntry[],
    refs: SymbolEntry[],
  ): void {
    this.#db.transaction(() => {
      this.#applyFileTx(filePath, hash, lang, symbols, refs);
    })();
  }

  #removeFileTx(filePath: string): void {
    this.#db.prepare("DELETE FROM symbols WHERE file = ?").run(filePath);
    this.#db.prepare("DELETE FROM refs WHERE file = ?").run(filePath);
    this.#db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
  }

  removeFile(filePath: string): void {
    this.#db.transaction(() => {
      this.#removeFileTx(filePath);
    })();
  }

  applyBuild(
    updates: FileUpdate[],
    removals: string[],
    meta: { headSha: string },
  ): void {
    this.#db.transaction(() => {
      for (const u of updates) {
        this.#applyFileTx(u.path, u.hash, u.lang, u.symbols, u.refs);
      }
      for (const r of removals) this.#removeFileTx(r);
      this.#setMetaTx("head_sha", meta.headSha);
      this.#setMetaTx("indexed_at", String(Date.now()));
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

  allSymbols(): SymbolHit[] {
    return this.#db
      .prepare(
        "SELECT file, name, kind, row, col FROM symbols ORDER BY file, row",
      )
      .all() as SymbolHit[];
  }

  allRefs(): SymbolHit[] {
    return this.#db
      .prepare(
        "SELECT file, name, kind, row, col FROM refs ORDER BY file, row",
      )
      .all() as SymbolHit[];
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

  #setMetaTx(key: string, value: string): void {
    this.#db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  setMeta(key: string, value: string): void {
    this.#setMetaTx(key, value);
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

// Single source of truth for where a project's wiki db lives, so callers
// that only need the path (existence checks, cache-coherence guards) don't
// duplicate this join and risk drifting from what openWikiStore actually
// creates.
export function wikiDbPath(projectDir: string): string {
  return path.join(projectDir, ".openfusion", "cache", "wiki.db");
}

// better-sqlite3's busy_timeout pragma does NOT cover the rollback→WAL
// journal_mode transition itself: when two processes race to create the
// store, one can hit SQLITE_BUSY / "database is locked" on the pragma call
// even with busy_timeout already set. Retry that specific pragma with a
// small synchronous backoff (openWikiStore is sync, so no async retry) and
// give up after a bounded number of attempts, rethrowing anything that
// isn't a busy/lock error immediately.
const WAL_RETRY_ATTEMPTS = 10;
const WAL_RETRY_BACKOFF_MS = 50;

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
  return err.message.includes("database is locked") || code === "SQLITE_BUSY";
}

function ensureWalMode(db: Database.Database): void {
  // Skip entirely if another process already completed the transition —
  // avoids taking the write lock the pragma requires when there's nothing
  // to do.
  if (db.pragma("journal_mode", { simple: true }) === "wal") return;

  for (let attempt = 1; attempt <= WAL_RETRY_ATTEMPTS; attempt++) {
    try {
      db.pragma("journal_mode = WAL");
      return;
    } catch (err) {
      if (!isBusyError(err) || attempt === WAL_RETRY_ATTEMPTS) throw err;
      sleepSync(WAL_RETRY_BACKOFF_MS);
    }
  }
}

// Exported for direct unit-testing (test/sidecar-assets-env.test.ts) without
// needing a working native addon at the fake path: proves the nativeBinding
// option derives from the SAME resolved assets base as wiki/parser.ts's
// parserInitOptions() and wiki/languages.ts's wasmDir()/queriesDir() — see
// util/sidecar-runtime.ts's resolveAssetsBaseDir() for the shared
// precedence.
export function nativeBindingOption(): { nativeBinding: string } | undefined {
  return resolveAssetsBaseDir() !== null
    ? { nativeBinding: packagedAssetPath("better_sqlite3.node") }
    : undefined;
}

export function openWikiStore(projectDir: string): WikiStore {
  const openfusionDir = path.join(projectDir, ".openfusion");
  const cacheDir = path.join(openfusionDir, "cache");
  mkdirSync(cacheDir, { recursive: true });
  ensureGitignoreGuard(openfusionDir, ["cache/"]);
  const dbPath = wikiDbPath(projectDir);
  // Resolved-assets case: better-sqlite3's own bindings-package auto-locate
  // searches candidate paths INSIDE the pkg virtual snapshot (which never
  // contains the real .node — native addons can't be embedded in a V8
  // snapshot, only shipped alongside it), so it always fails there. Passing
  // `nativeBinding` is better-sqlite3's own documented escape hatch for
  // exactly this bundler/pkg scenario: it skips the auto-locate entirely and
  // requires the given real absolute path directly. build-sidecar.mjs copies
  // the real better_sqlite3.node to "<assets-base>/better_sqlite3.node" —
  // see nativeBindingOption() above and util/sidecar-runtime.ts's
  // resolveAssetsBaseDir() for where <assets-base> comes from.
  const db = new Database(dbPath, nativeBindingOption());
  // busy_timeout must be set before attempting the WAL transition: it
  // covers ordinary statement contention, and setting it first means
  // ensureWalMode's own retry loop is only needed for the pragma's narrower
  // busy window that busy_timeout doesn't reach.
  db.pragma("busy_timeout = 5000");
  ensureWalMode(db);

  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion !== SCHEMA_VERSION) {
    const filesTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get();
    if (filesTable !== undefined) {
      // Schema drifted from a prior version: drop and rebuild rather than migrate.
      db.close();
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      return openWikiStore(projectDir);
    }
  }

  db.exec(SCHEMA);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  return new WikiStore(db);
}
