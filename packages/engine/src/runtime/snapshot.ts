import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { RuntimeCapabilities, TaskSnapshotRef } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { HARNESS_REGISTRY } from "../harness/registry.js";
import { loadHarnessSnapshot } from "../harness/store.js";
import { wikiDbPath } from "../wiki/store.js";
import { unknownRuntimeCapabilities } from "./capabilities.js";

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function wikiSourceIdentityDigest(identity: {
  headSha: string | null;
  sourceFingerprint: string | null;
}): `sha256:${string}` | null {
  if (identity.headSha === null || identity.sourceFingerprint === null) return null;
  return sha256(JSON.stringify({
    headSha: identity.headSha,
    sourceFingerprint: identity.sourceFingerprint,
  }));
}

function git(projectDir: string, args: string[]): string {
  return execFileSync("git", ["-C", projectDir, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function dirtyState(projectDir: string): TaskSnapshotRef["dirtyState"] {
  const raw = git(projectDir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const entries = raw.split("\0").filter(Boolean);
  const hasUntracked = entries.some((entry) => entry.startsWith("??"));
  const hasTracked = entries.some((entry) => !entry.startsWith("??"));
  const category = hasTracked && hasUntracked
    ? "mixed"
    : hasTracked
      ? "tracked"
      : hasUntracked
        ? "untracked"
        : "clean";
  return { category, digest: sha256(raw) };
}

async function runtimeRefs(engine: Engine): Promise<RuntimeCapabilities[]> {
  const runtimes = await Promise.all(
    engine.frontier.adapters().map(async (adapter) => {
      try {
        return await (adapter.capabilities?.() ?? unknownRuntimeCapabilities(adapter.kind));
      } catch {
        return unknownRuntimeCapabilities(adapter.kind);
      }
    }),
  );
  return runtimes.sort((a, b) => (a.runtimeId < b.runtimeId ? -1 : a.runtimeId > b.runtimeId ? 1 : 0));
}

/**
 * Capture the immutable identity used by every attempt in a top-level run.
 * Only digests and stable identifiers leave this function; working-tree
 * paths and status records are deliberately not persisted in the ref.
 */
export async function captureTaskSnapshot(
  engine: Engine,
  projectDir: string,
  sandboxPolicyId = HARNESS_REGISTRY.policies.sandbox,
): Promise<TaskSnapshotRef> {
  const root = realpathSync(path.resolve(projectDir));
  const baseSha = git(root, ["rev-parse", "HEAD"]).trim();
  const tree = git(root, ["ls-tree", "-r", "--full-tree", "HEAD"]);
  const dirty = dirtyState(root);

  let harnessFingerprint: string | null = null;
  let harnessGeneration: string | null = null;
  try {
    const harness = loadHarnessSnapshot(root);
    harnessFingerprint = harness?.fingerprint.digest ?? null;
    harnessGeneration = harness?.generationId ?? null;
  } catch {
    harnessFingerprint = null;
    harnessGeneration = null;
  }

  let wikiHeadSha: string | null = null;
  let wikiDigest: string | null = null;
  try {
    if (existsSync(wikiDbPath(root))) {
      const store = engine.wiki.getStore(root);
      const identity = store.getSourceIdentity();
      wikiHeadSha = identity.headSha;
      wikiDigest = wikiSourceIdentityDigest(identity);
    }
  } catch {
    wikiHeadSha = null;
    wikiDigest = null;
  }

  const runtimes = await runtimeRefs(engine);
  const finishSha = git(root, ["rev-parse", "HEAD"]).trim();
  if (finishSha !== baseSha) throw new Error("Git HEAD changed while the task snapshot was captured");

  return {
    schemaVersion: 1,
    snapshotId: randomUUID(),
    projectDigest: sha256(root),
    baseSha,
    baseTreeDigest: sha256(tree),
    dirtyState: dirty,
    harnessGeneration,
    harnessFingerprint,
    wikiHeadSha,
    wikiDigest,
    toolRegistryDigest: HARNESS_REGISTRY.toolRegistryDigest,
    sandboxPolicyId,
    runtimes,
    capturedAt: new Date().toISOString(),
  };
}
