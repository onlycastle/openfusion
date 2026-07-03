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
  let filesFailed = 0;
  const seen = new Set<string>();
  const updates: FileUpdate[] = [];

  for (const relPath of tracked) {
    seen.add(relPath);
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
