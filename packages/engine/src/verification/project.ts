import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { StageReport } from "@openfusion/shared";
import { stageMessageId } from "../harness/registry.js";
import { enforceStagePolicy } from "./policy.js";

export type TrackedSourceState =
  | { path: string; state: "readable"; hash: string; size: number }
  | { path: string; state: "oversized"; size: number }
  | { path: string; state: "unreadable" };

export interface ProjectSnapshot {
  projectDir: string;
  headSha: string;
  headStable: boolean;
  dirty: boolean;
  trackedFiles: number;
  readableFiles: number;
  oversizedFiles: number;
  unreadableFiles: number;
  sourceFingerprint: string;
  snapshotDigest: string;
  files: TrackedSourceState[];
}

export interface CaptureProjectSnapshotOptions {
  includePath?: (relativePath: string) => boolean;
  maxFileBytes?: number;
}

export interface HeadTreeEntry {
  path: string;
  mode: string;
  type: string;
  objectId: string;
  size: number | null;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function getProjectHeadSha(projectDir: string): string {
  return execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function listTrackedProjectFiles(projectDir: string): string[] {
  const out = execFileSync("git", ["-C", projectDir, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((entry) => entry.length > 0).sort();
}

export function listHeadTreeEntries(projectDir: string): HeadTreeEntry[] {
  const out = execFileSync(
    "git",
    ["-C", projectDir, "ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const entries: HeadTreeEntry[] = [];
  for (const record of out.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, objectId, sizeText] = record.slice(0, tab).trim().split(/ +/);
    if (mode === undefined || type === undefined || objectId === undefined) continue;
    const parsedSize = sizeText === undefined ? Number.NaN : Number(sizeText);
    entries.push({
      path: record.slice(tab + 1),
      mode,
      type,
      objectId,
      size: Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : null,
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function readGitBlobs(
  projectDir: string,
  objectIds: readonly string[],
): Map<string, Buffer> {
  if (objectIds.length === 0) return new Map();
  const output = execFileSync("git", ["-C", projectDir, "cat-file", "--batch"], {
    input: `${objectIds.join("\n")}\n`,
    maxBuffer: 128 * 1024 * 1024,
  });
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  for (const requestedId of objectIds) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) throw new Error("git cat-file returned a truncated header");
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const [, type, sizeText] = header.split(" ");
    const size = Number(sizeText);
    if (type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("git cat-file returned an invalid blob header");
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
      throw new Error("git cat-file returned truncated blob content");
    }
    blobs.set(requestedId, Buffer.from(output.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }
  return blobs;
}

export function readGitBlobsBatched(
  projectDir: string,
  entries: readonly Pick<HeadTreeEntry, "objectId" | "size">[],
): Map<string, Buffer> {
  const unique = new Map(entries.map((entry) => [entry.objectId, entry]));
  const result = new Map<string, Buffer>();
  let batch: string[] = [];
  let batchBytes = 0;
  const flush = (): void => {
    for (const [objectId, content] of readGitBlobs(projectDir, batch)) {
      result.set(objectId, content);
    }
    batch = [];
    batchBytes = 0;
  };
  for (const entry of unique.values()) {
    const size = entry.size ?? 1024 * 1024;
    if (batch.length > 0 && (batch.length >= 128 || batchBytes + size > 32 * 1024 * 1024)) {
      flush();
    }
    batch.push(entry.objectId);
    batchBytes += size;
  }
  if (batch.length > 0) flush();
  return result;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function fingerprintTrackedSources(files: readonly TrackedSourceState[]): string {
  const canonical = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => {
      if (file.state === "readable") return [file.path, file.state, file.hash, file.size];
      if (file.state === "oversized") return [file.path, file.state, file.size];
      return [file.path, file.state];
    });
  return sha256(JSON.stringify(canonical));
}

export function snapshotDigest(headSha: string, sourceFingerprint: string): string {
  return sha256(JSON.stringify({ headSha, sourceFingerprint }));
}

export function captureProjectSnapshot(
  projectDir: string,
  options: CaptureProjectSnapshotOptions = {},
): ProjectSnapshot {
  const root = realpathSync(path.resolve(projectDir));
  const headSha = getProjectHeadSha(root);
  const maxFileBytes = options.maxFileBytes ?? Number.POSITIVE_INFINITY;
  const tracked = listTrackedProjectFiles(root).filter((relativePath) =>
    options.includePath?.(relativePath) ?? true,
  );
  const files: TrackedSourceState[] = [];

  for (const relativePath of tracked) {
    const absolutePath = path.resolve(root, relativePath);
    if (!isContained(root, absolutePath)) {
      files.push({ path: relativePath, state: "unreadable" });
      continue;
    }

    let size: number;
    try {
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        files.push({ path: relativePath, state: "unreadable" });
        continue;
      }
      size = stat.size;
    } catch {
      files.push({ path: relativePath, state: "unreadable" });
      continue;
    }
    if (size > maxFileBytes) {
      files.push({ path: relativePath, state: "oversized", size });
      continue;
    }
    try {
      const content = readFileSync(absolutePath);
      files.push({ path: relativePath, state: "readable", hash: sha256(content), size });
    } catch {
      files.push({ path: relativePath, state: "unreadable" });
    }
  }

  const finishHeadSha = getProjectHeadSha(root);
  const sourceFingerprint = fingerprintTrackedSources(files);
  const dirty = execFileSync(
    "git",
    ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=no"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).length > 0;

  return {
    projectDir: root,
    headSha,
    headStable: headSha === finishHeadSha,
    dirty,
    trackedFiles: files.length,
    readableFiles: files.filter((file) => file.state === "readable").length,
    oversizedFiles: files.filter((file) => file.state === "oversized").length,
    unreadableFiles: files.filter((file) => file.state === "unreadable").length,
    sourceFingerprint,
    snapshotDigest: snapshotDigest(headSha, sourceFingerprint),
    files,
  };
}

/**
 * Capture the exact committed tree that HEAD names. Unlike
 * captureProjectSnapshot, tracked working-tree edits are deliberately ignored:
 * worker worktrees are also created from HEAD, so this is the identity the wiki
 * must describe to avoid pointing an agent at code absent from its worktree.
 */
export function captureHeadProjectSnapshot(
  projectDir: string,
  options: CaptureProjectSnapshotOptions = {},
): ProjectSnapshot {
  const root = realpathSync(path.resolve(projectDir));
  const headSha = getProjectHeadSha(root);
  const maxFileBytes = options.maxFileBytes ?? Number.POSITIVE_INFINITY;
  const entries = listHeadTreeEntries(root).filter((entry) =>
    options.includePath?.(entry.path) ?? true,
  );
  const files: TrackedSourceState[] = [];
  const readableEntries = entries.filter(
    (entry) =>
      entry.type === "blob" &&
      entry.mode !== "120000" &&
      (entry.size === null || entry.size <= maxFileBytes),
  );
  let blobs = new Map<string, Buffer>();
  try {
    blobs = readGitBlobsBatched(root, readableEntries);
  } catch {
    // Per-entry handling below records the unavailable blobs without
    // publishing raw Git error text into verification evidence.
  }

  for (const entry of entries) {
    if (entry.type !== "blob" || entry.mode === "120000") {
      files.push({ path: entry.path, state: "unreadable" });
      continue;
    }
    if (entry.size !== null && entry.size > maxFileBytes) {
      files.push({ path: entry.path, state: "oversized", size: entry.size });
      continue;
    }
    const content = blobs.get(entry.objectId);
    if (content === undefined) {
      files.push({ path: entry.path, state: "unreadable" });
      continue;
    }
    if (content.length > maxFileBytes) {
      files.push({ path: entry.path, state: "oversized", size: content.length });
      continue;
    }
    files.push({
      path: entry.path,
      state: "readable",
      hash: sha256(content),
      size: content.length,
    });
  }

  const finishHeadSha = getProjectHeadSha(root);
  const sourceFingerprint = fingerprintTrackedSources(files);
  const dirty = execFileSync(
    "git",
    ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=no"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  ).length > 0;

  return {
    projectDir: root,
    headSha,
    headStable: headSha === finishHeadSha,
    dirty,
    trackedFiles: files.length,
    readableFiles: files.filter((file) => file.state === "readable").length,
    oversizedFiles: files.filter((file) => file.state === "oversized").length,
    unreadableFiles: files.filter((file) => file.state === "unreadable").length,
    sourceFingerprint,
    snapshotDigest: snapshotDigest(headSha, sourceFingerprint),
    files,
  };
}

export function verifyProjectSnapshot(
  projectDir: string,
  options: CaptureProjectSnapshotOptions = {},
): { snapshot: ProjectSnapshot | null; report: StageReport } {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const requestDigest = sha256(path.resolve(projectDir));
  let snapshot: ProjectSnapshot | null = null;
  try {
    snapshot = captureProjectSnapshot(projectDir, options);
  } catch {
    // The durable report carries only a stable category. Raw filesystem/Git
    // error text can contain project paths or command output and must not
    // enter verification evidence.
  }

  const report = enforceStagePolicy({
    schemaVersion: 2,
    stageId: "setup.project",
    policyVersion: 2,
    attempt: 1,
    inputRef: { id: "project-request", digest: requestDigest },
    ...(snapshot === null
      ? {}
      : { outputRef: { id: "project-snapshot", digest: snapshot.snapshotDigest } }),
    execution: "completed",
    verdict: snapshot === null || !snapshot.headStable ? "failed" : "passed",
    checks: [
      {
        id: "project.git-repository",
        required: true,
        status: snapshot === null ? "failed" : "passed",
        messageId: stageMessageId("project.git-repository", snapshot === null ? "failed" : "passed"),
        ...(snapshot === null ? { evidence: { reasonCode: "project-unavailable" } } : {}),
      },
      {
        id: "project.head-resolved",
        required: true,
        status: snapshot === null ? "failed" : "passed",
        messageId: stageMessageId("project.head-resolved", snapshot === null ? "failed" : "passed"),
        ...(snapshot === null ? { evidence: { reasonCode: "project-unavailable" } } : {}),
      },
      {
        id: "project.snapshot-stable",
        required: true,
        status: snapshot === null ? "inconclusive" : snapshot.headStable ? "passed" : "failed",
        messageId: stageMessageId(
          "project.snapshot-stable",
          snapshot === null ? "inconclusive" : snapshot.headStable ? "passed" : "failed",
        ),
        ...(snapshot === null
          ? { evidence: { reasonCode: "snapshot-unavailable" } }
          : snapshot.headStable
            ? {}
            : { evidence: { reasonCode: "head-changed" } }),
      },
      {
        id: "project.scope-allowed",
        required: true,
        status: snapshot === null ? "inconclusive" : snapshot.unreadableFiles === 0 ? "passed" : "failed",
        messageId: stageMessageId(
          "project.scope-allowed",
          snapshot === null ? "inconclusive" : snapshot.unreadableFiles === 0 ? "passed" : "failed",
        ),
        ...(snapshot === null
          ? { evidence: { reasonCode: "snapshot-unavailable" } }
          : snapshot.unreadableFiles === 0
            ? { evidence: { count: 0, expectedCount: 0 } }
            : {
                evidence: {
                  count: snapshot.unreadableFiles,
                  expectedCount: 0,
                  reasonCode: "path-unreadable",
                },
              }),
      },
    ],
    startedAt,
    durationMs: Date.now() - started,
  });

  return { snapshot, report };
}
