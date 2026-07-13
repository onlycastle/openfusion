import { createHash } from "node:crypto";
import path from "node:path";
import {
  fingerprintTrackedSources,
  getProjectHeadSha,
  listHeadTreeEntries,
  readGitBlobsBatched,
  type TrackedSourceState,
} from "../verification/project.js";
import type { WikiParser } from "./parser.js";
import type { FileUpdate, WikiStore } from "./store.js";

export interface WikiCoverage {
  supportedTracked: number;
  currentEntries: number;
  unchanged: number;
  oversized: number;
  unreadable: number;
  parseFailed: number;
  removed: number;
}

export interface IndexStats {
  filesSeen: number;
  filesIndexed: number;
  filesSkipped: number;
  filesFailed: number;
  filesRemoved: number;
  symbols: number;
  refs: number;
  headSha: string;
  sourceFingerprint: string;
  coverage: WikiCoverage;
}

export const MAX_WIKI_FILE_BYTES = 1024 * 1024;

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
  return getProjectHeadSha(projectDir);
}

export async function buildIndex(
  projectDir: string,
  store: WikiStore,
  parser: WikiParser,
  onProgress?: BuildIndexProgress,
): Promise<IndexStats> {
  const headSha = getProjectHeadSha(projectDir);
  const extensions = parser.supportedExtensions();
  const tracked = listHeadTreeEntries(projectDir).filter((entry) =>
    extensions.has(path.extname(entry.path)),
  );
  const total = tracked.length;
  onProgress?.(`scanning ${total} file${total === 1 ? "" : "s"}`);

  let filesIndexed = 0;
  let filesSkipped = 0;
  let filesFailed = 0;
  let unchanged = 0;
  let oversized = 0;
  let unreadable = 0;
  let processed = 0;
  const seen = new Set<string>();
  const updates: FileUpdate[] = [];
  const sourceStates: TrackedSourceState[] = [];
  const invalidated = new Set<string>();
  const blobEntries = tracked.filter(
    (entry) =>
      entry.type === "blob" &&
      entry.mode !== "120000" &&
      (entry.size === null || entry.size <= MAX_WIKI_FILE_BYTES),
  );
  let blobs = new Map<string, Buffer>();
  try {
    blobs = readGitBlobsBatched(projectDir, blobEntries);
  } catch {
    // Missing blobs are categorized per file below. The build publishes
    // coverage evidence rather than leaking raw Git diagnostics.
  }

  for (const entry of tracked) {
    const relPath = entry.path;
    seen.add(relPath);
    processed += 1;
    if (processed % PROGRESS_INTERVAL === 0) {
      onProgress?.(`indexed ${processed}/${total} files (last: ${relPath})`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (entry.type !== "blob" || entry.mode === "120000") {
      unreadable += 1;
      filesSkipped += 1;
      sourceStates.push({ path: relPath, state: "unreadable" });
      invalidated.add(relPath);
      continue;
    }
    if (entry.size !== null && entry.size > MAX_WIKI_FILE_BYTES) {
      oversized += 1;
      filesSkipped += 1;
      sourceStates.push({ path: relPath, state: "oversized", size: entry.size });
      invalidated.add(relPath);
      continue;
    }
    const content = blobs.get(entry.objectId);
    if (content === undefined) {
      unreadable += 1;
      filesSkipped += 1;
      sourceStates.push({ path: relPath, state: "unreadable" });
      invalidated.add(relPath);
      continue;
    }
    const size = content.length;
    if (size > MAX_WIKI_FILE_BYTES) {
      oversized += 1;
      filesSkipped += 1;
      sourceStates.push({ path: relPath, state: "oversized", size });
      invalidated.add(relPath);
      continue;
    }
    const source = content.toString("utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    sourceStates.push({ path: relPath, state: "readable", hash: `sha256:${hash}`, size });
    if (store.getFileHash(relPath) === hash) {
      unchanged += 1;
      filesSkipped += 1;
      continue;
    }
    const result = parser.parseFile(relPath, source);
    if (result === null) {
      filesFailed += 1;
      invalidated.add(relPath);
      continue;
    }
    updates.push({
      path: relPath,
      hash,
      lang: parser.languageFor(relPath) ?? "unknown",
      searchText: source,
      symbols: result.symbols,
      refs: result.refs,
    });
    filesIndexed += 1;
  }

  const sourceFingerprint = fingerprintTrackedSources(sourceStates);
  if (getProjectHeadSha(projectDir) !== headSha) {
    throw new Error("wiki source HEAD changed during indexing; retry the build");
  }

  const removals = store
    .listFiles()
    .filter((known) => !seen.has(known) || invalidated.has(known));
  const currentPaths = new Set(store.listFiles());
  for (const removed of removals) currentPaths.delete(removed);
  for (const update of updates) currentPaths.add(update.path);
  const coverage: WikiCoverage = {
    supportedTracked: tracked.length,
    currentEntries: currentPaths.size,
    unchanged,
    oversized,
    unreadable,
    parseFailed: filesFailed,
    removed: removals.length,
  };
  store.applyBuild(updates, removals, {
    headSha,
    sourceFingerprint,
    coverageJson: JSON.stringify(coverage),
  });

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
    sourceFingerprint,
    coverage,
  };
}
