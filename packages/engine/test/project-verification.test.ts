import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureProjectSnapshot,
  verifyProjectSnapshot,
} from "../src/verification/project.js";

let dir = "";
afterEach(() => {
  if (dir.length > 0) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): void {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-project-verify-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(path.join(dir, "a.ts"), "export function alpha() {}\n");
  writeFileSync(path.join(dir, "notes.md"), "# Notes\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
}

describe("project snapshot verification", () => {
  it("captures a deterministic clean snapshot", () => {
    makeRepo();
    const first = captureProjectSnapshot(dir);
    const second = captureProjectSnapshot(dir);
    expect(first.snapshotDigest).toBe(second.snapshotDigest);
    expect(first.headStable).toBe(true);
    expect(first.dirty).toBe(false);
    expect(first.trackedFiles).toBe(2);
    expect(first.sourceFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("detects tracked working-tree changes even when HEAD is unchanged", () => {
    makeRepo();
    const before = captureProjectSnapshot(dir);
    writeFileSync(path.join(dir, "a.ts"), "export function changed() {}\n");
    const after = captureProjectSnapshot(dir);
    expect(after.headSha).toBe(before.headSha);
    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
    expect(after.dirty).toBe(true);
  });

  it("supports a bounded source selection for wiki snapshots", () => {
    makeRepo();
    const snapshot = captureProjectSnapshot(dir, {
      includePath: (relativePath) => relativePath.endsWith(".ts"),
    });
    expect(snapshot.trackedFiles).toBe(1);
    expect(snapshot.files.map((file) => file.path)).toEqual(["a.ts"]);
  });

  it("returns a policy-complete passing stage report", () => {
    makeRepo();
    const result = verifyProjectSnapshot(dir);
    expect(result.report.verdict).toBe("passed");
    expect(result.report.checks).toHaveLength(4);
    expect(result.report.outputRef?.digest).toBe(result.snapshot?.snapshotDigest);
  });

  it("fails closed for a non-Git directory", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-project-verify-nogit-"));
    const result = verifyProjectSnapshot(dir);
    expect(result.snapshot).toBeNull();
    expect(result.report.verdict).toBe("failed");
    expect(
      result.report.checks.find((check) => check.id === "project.git-repository")?.status,
    ).toBe("failed");
  });
});

