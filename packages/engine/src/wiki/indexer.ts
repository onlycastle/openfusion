import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { WikiParser } from "./parser.js";
import type { FileUpdate, WikiStore } from "./store.js";

export interface IndexStats {
  filesSeen: number;
  filesIndexed: number;
  filesSkipped: number;
  filesFailed: number;
  filesRemoved: number;
  symbols: number;
  refs: number;
  headSha: string;
}

const MAX_FILE_BYTES = 1024 * 1024;

// M7c Task 1 (the M7b-flagged gap): buildIndex previously ran silently from
// the caller's point of view — engine.wiki.build had no progress signal at
// all, unlike engine.orchestrate/engine.evals.run's own `*.progress`
// notifications. `onProgress`, when supplied, is called with a short,
// human-readable phase/count string ("indexed 42/120 files (last:
// src/foo.ts)") — a PATH or COUNT, NEVER file contents (the loop below never
// passes file source text to it, only `relPath`/counters).
//
// CADENCE: reuses the SAME `PROGRESS_INTERVAL` (25 files) the loop already
// yields the event loop on, so this never floods a large repo with a
// notification per file. A caller gets: one "scanning N files" message up
// front, one "indexed X/N files" message every 25 processed files, and one
// final "indexed X/N files (skipped/failed)" summary — bounded to
// `~2 + floor(N/25)` calls regardless of repo size, not O(N).
export type BuildIndexProgress = (detail: string) => void;
const PROGRESS_INTERVAL = 25;

export function getHeadSha(projectDir: string): string {
  return execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function listTrackedFiles(projectDir: string): string[] {
  const out = execFileSync("git", ["-C", projectDir, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((p) => p.length > 0);
}

export async function buildIndex(
  projectDir: string,
  store: WikiStore,
  parser: WikiParser,
  onProgress?: BuildIndexProgress,
): Promise<IndexStats> {
  const headSha = getHeadSha(projectDir);
  const extensions = parser.supportedExtensions();
  const tracked = listTrackedFiles(projectDir).filter((p) =>
    extensions.has(path.extname(p)),
  );
  const total = tracked.length;
  onProgress?.(`scanning ${total} file${total === 1 ? "" : "s"}`);

  let filesIndexed = 0;
  let filesSkipped = 0;
  let filesFailed = 0;
  let processed = 0;
  const seen = new Set<string>();
  const updates: FileUpdate[] = [];

  for (const relPath of tracked) {
    seen.add(relPath);
    processed += 1;
    if (processed % PROGRESS_INTERVAL === 0) {
      onProgress?.(`indexed ${processed}/${total} files (last: ${relPath})`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const absPath = path.join(projectDir, relPath);
    let size: number;
    try {
      size = statSync(absPath).size;
    } catch {
      filesSkipped += 1; // tracked but momentarily unreadable: keep existing entries
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      filesSkipped += 1; // too large to parse: keep any existing entries
      continue;
    }
    let source: string;
    try {
      source = readFileSync(absPath, "utf8");
    } catch {
      filesSkipped += 1; // vanished between stat and read: keep existing entries
      continue;
    }
    const hash = createHash("sha256").update(source).digest("hex");
    if (store.getFileHash(relPath) === hash) {
      filesSkipped += 1;
      continue;
    }
    const result = parser.parseFile(relPath, source);
    if (result === null) {
      filesFailed += 1;
      continue;
    }
    updates.push({
      path: relPath,
      hash,
      lang: parser.languageFor(relPath) ?? "unknown",
      symbols: result.symbols,
      refs: result.refs,
    });
    filesIndexed += 1;
  }

  const removals = store.listFiles().filter((known) => !seen.has(known));
  store.applyBuild(updates, removals, { headSha });

  onProgress?.(
    `indexed ${filesIndexed}/${total} files (${filesSkipped} skipped, ${filesFailed} failed)`,
  );

  const counts = store.counts();
  return {
    filesSeen: seen.size,
    filesIndexed,
    filesSkipped,
    filesFailed,
    filesRemoved: removals.length,
    symbols: counts.symbols,
    refs: counts.refs,
    headSha,
  };
}
