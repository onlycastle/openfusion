import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { WikiParser } from "./parser.js";
import type { WikiStore } from "./store.js";

export interface IndexStats {
  filesSeen: number;
  filesIndexed: number;
  filesSkipped: number;
  filesRemoved: number;
  symbols: number;
  refs: number;
  headSha: string;
}

const MAX_FILE_BYTES = 1024 * 1024;

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
): Promise<IndexStats> {
  const headSha = getHeadSha(projectDir);
  const extensions = parser.supportedExtensions();
  const tracked = listTrackedFiles(projectDir).filter((p) =>
    extensions.has(path.extname(p)),
  );

  let filesIndexed = 0;
  let filesSkipped = 0;
  const seen = new Set<string>();

  for (const relPath of tracked) {
    const absPath = path.join(projectDir, relPath);
    let size: number;
    try {
      size = statSync(absPath).size;
    } catch {
      continue; // tracked but missing on disk (mid-operation); skip
    }
    if (size > MAX_FILE_BYTES) continue;
    seen.add(relPath);
    const source = readFileSync(absPath, "utf8");
    const hash = createHash("sha256").update(source).digest("hex");
    if (store.getFileHash(relPath) === hash) {
      filesSkipped += 1;
      continue;
    }
    const result = parser.parseFile(relPath, source);
    if (result === null) continue;
    store.upsertFile(
      relPath,
      hash,
      parser.languageFor(relPath) ?? "unknown",
      result.symbols,
      result.refs,
    );
    filesIndexed += 1;
  }

  let filesRemoved = 0;
  for (const known of store.listFiles()) {
    if (!seen.has(known)) {
      store.removeFile(known);
      filesRemoved += 1;
    }
  }

  store.setMeta("head_sha", headSha);
  store.setMeta("indexed_at", String(Date.now()));

  const counts = store.counts();
  return {
    filesSeen: seen.size,
    filesIndexed,
    filesSkipped,
    filesRemoved,
    symbols: counts.symbols,
    refs: counts.refs,
    headSha,
  };
}
