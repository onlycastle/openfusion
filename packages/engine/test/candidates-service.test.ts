import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApprovalGrant, TaskContract, TaskSnapshotRef } from "@openfusion/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalizeCandidate,
  type PreparedCandidate,
  type VerificationRunner,
} from "../src/candidates/service.js";
import { createEngine, type Engine } from "../src/engine.js";
import { captureTaskSnapshot } from "../src/runtime/snapshot.js";
import type { Worktree, WorktreeManager } from "../src/worker/worktree.js";

const roots: string[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
  const root = tempRoot("of-candidate-repo-");
  execFileSync("git", ["init", "-q", root]);
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "OpenFusion Test");
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "base");
  return root;
}

const passingRunner: VerificationRunner = {
  async status() {
    return { available: true };
  },
  async run() {
    return { exitCode: 0 };
  },
};

const contract: TaskContract = {
  schemaVersion: 1,
  requirements: ["add the requested file", "preserve the existing readme"],
  constraints: ["do not create a commit"],
  verificationCommands: [["git", "status", "--short"]],
};

interface CandidateFixture {
  engine: Engine;
  projectDir: string;
  snapshot: TaskSnapshotRef;
  manager: WorktreeManager;
  worktree: Worktree;
  prepared: PreparedCandidate;
}

async function makePreparedCandidate(input: {
  relativePath?: string;
  content?: string | Buffer;
  runner?: VerificationRunner;
} = {}): Promise<CandidateFixture> {
  const appStorageDir = tempRoot("of-candidate-storage-");
  const projectDir = makeRepo();
  const engine = createEngine({
    appStorageDir,
    verificationRunner: input.runner ?? passingRunner,
  });
  engines.push(engine);
  const snapshot = await captureTaskSnapshot(engine, projectDir);
  const manager = await engine.worker.getManager(projectDir);
  const worktree = await manager.create(`candidate-${randomUUID()}`, snapshot.baseSha);
  const target = path.join(worktree.path, input.relativePath ?? "candidate.txt");
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, input.content ?? "approved content\n");
  const prepared = await engine.candidates.prepare(engine, {
    projectDir,
    worktree,
    snapshot,
    contract,
  });
  return { engine, projectDir, snapshot, manager, worktree, prepared };
}

function mint(fixture: CandidateFixture, reviewerSessionId = "reviewer-session") {
  return fixture.engine.candidates.mint({
    projectDir: fixture.projectDir,
    worktree: fixture.worktree,
    snapshot: fixture.snapshot,
    prepared: fixture.prepared,
    authorAttemptId: "attempt-1",
    authorSessionId: "author-session",
    reviewerSessionId,
    verdict: { decision: "approve", reasons: [], severity: "none" },
  });
}

describe("CandidateService approval binding", () => {
  it("binds coverage evidence, returns defensive copies, applies once, and rejects a reused grant", async () => {
    const fixture = await makePreparedCandidate();
    const ref = mint(fixture);
    ref.lifecycle = "rejected";
    const read = await fixture.engine.candidates.read(ref.candidateId);
    expect(read.candidateRef.lifecycle).toBe("approved");
    expect(read.reports.find((report) => report.stageId === "task.coverage")?.checks[0]).toMatchObject({
      status: "passed",
      evidence: {
        artifactDigest: fixture.prepared.contractDigest,
        count: contract.requirements.length,
        expectedCount: contract.requirements.length,
      },
    });

    const grant = await fixture.engine.candidates.prepareApply(ref.candidateId, fixture.projectDir);
    const authenticGrant = structuredClone(grant);
    grant.baseSha = "0".repeat(40);
    await expect(
      fixture.engine.candidates.apply(ref.candidateId, grant, fixture.projectDir),
    ).rejects.toThrow("approval grant is invalid");

    await fixture.engine.candidates.apply(ref.candidateId, authenticGrant, fixture.projectDir);
    expect(readFileSync(path.join(fixture.projectDir, "candidate.txt"), "utf8")).toBe("approved content\n");
    expect(existsSync(fixture.worktree.path)).toBe(false);
    await expect(
      fixture.engine.candidates.apply(ref.candidateId, authenticGrant, fixture.projectDir),
    ).rejects.toThrow("approval grant was already used");
  });

  it("rejects candidate substitution before a grant is minted", async () => {
    const fixture = await makePreparedCandidate();
    const ref = mint(fixture);
    writeFileSync(path.join(fixture.worktree.path, "candidate.txt"), "substituted\n");

    await expect(
      fixture.engine.candidates.prepareApply(ref.candidateId, fixture.projectDir),
    ).rejects.toThrow("candidate content changed after approval");
    await expect(fixture.engine.candidates.read(ref.candidateId)).rejects.toThrow("candidate is rejected");
  });

  it("rejects candidate substitution after a grant and consumes that one-use grant", async () => {
    const fixture = await makePreparedCandidate();
    const ref = mint(fixture);
    const grant = await fixture.engine.candidates.prepareApply(ref.candidateId, fixture.projectDir);
    writeFileSync(path.join(fixture.worktree.path, "candidate.txt"), "substituted after approval\n");

    await expect(
      fixture.engine.candidates.apply(ref.candidateId, grant, fixture.projectDir),
    ).rejects.toThrow("candidate diff changed after approval");
    await expect(
      fixture.engine.candidates.apply(ref.candidateId, grant, fixture.projectDir),
    ).rejects.toThrow("approval grant was already used");
  });

  it("requires an independent approving reviewer", async () => {
    const fixture = await makePreparedCandidate();
    expect(() => mint(fixture, "author-session")).toThrow("reviewer must be independent");
    expect(() => fixture.engine.candidates.mint({
      projectDir: fixture.projectDir,
      worktree: fixture.worktree,
      snapshot: fixture.snapshot,
      prepared: fixture.prepared,
      authorAttemptId: "attempt-1",
      authorSessionId: "author-session",
      reviewerSessionId: "reviewer-session",
      verdict: { decision: "request-changes", reasons: ["broken"], severity: "major" },
    })).toThrow("reviewer did not approve");
  });
});

describe("CandidateService freshness and final apply checks", () => {
  it("marks a candidate stale when destination HEAD changes", async () => {
    const fixture = await makePreparedCandidate();
    const ref = mint(fixture);
    writeFileSync(path.join(fixture.projectDir, "later.txt"), "later\n");
    git(fixture.projectDir, "add", "later.txt");
    git(fixture.projectDir, "commit", "-qm", "move head");

    await expect(
      fixture.engine.candidates.prepareApply(ref.candidateId, fixture.projectDir),
    ).rejects.toThrow("project HEAD changed");
    await expect(fixture.engine.candidates.read(ref.candidateId)).rejects.toThrow("candidate is stale");
  });

  it("blocks Apply when a candidate-touched destination path is dirty", async () => {
    const fixture = await makePreparedCandidate();
    const ref = mint(fixture);
    writeFileSync(path.join(fixture.projectDir, "candidate.txt"), "local edit\n");
    await expect(
      fixture.engine.candidates.prepareApply(ref.candidateId, fixture.projectDir),
    ).rejects.toThrow("candidate overlaps dirty destination paths");
  });

  it("binds the grant to its destination project", async () => {
    const fixture = await makePreparedCandidate();
    const ref = mint(fixture);
    const otherProject = makeRepo();
    await expect(
      fixture.engine.candidates.prepareApply(ref.candidateId, otherProject),
    ).rejects.toThrow("candidate belongs to a different project");
  });

  it("runs a final mechanical apply check before writing", async () => {
    const fixture = await makePreparedCandidate({ relativePath: "nested/candidate.txt" });
    const ref = mint(fixture);
    const grant = await fixture.engine.candidates.prepareApply(ref.candidateId, fixture.projectDir);
    // This untracked ancestor does not equal the touched path, but makes the
    // patch mechanically impossible. The final git apply --check must catch
    // it before any candidate content is written.
    writeFileSync(path.join(fixture.projectDir, "nested"), "path collision\n");
    await expect(
      fixture.engine.candidates.apply(ref.candidateId, grant, fixture.projectDir),
    ).rejects.toThrow("git apply failed");
    expect(readFileSync(path.join(fixture.projectDir, "nested"), "utf8")).toBe("path collision\n");
  });
});

describe("candidate diff policy", () => {
  async function rawWorktree(): Promise<{ worktree: Worktree; snapshot: TaskSnapshotRef }> {
    const appStorageDir = tempRoot("of-candidate-policy-");
    const projectDir = makeRepo();
    const engine = createEngine({ appStorageDir, verificationRunner: passingRunner });
    engines.push(engine);
    const snapshot = await captureTaskSnapshot(engine, projectDir);
    const manager = await engine.worker.getManager(projectDir);
    return {
      worktree: await manager.create(`policy-${randomUUID()}`, snapshot.baseSha),
      snapshot,
    };
  }

  it("rejects OpenFusion control-plane paths", async () => {
    const { worktree, snapshot } = await rawWorktree();
    mkdirSync(path.join(worktree.path, ".openfusion"));
    writeFileSync(path.join(worktree.path, ".openfusion", "override.json"), "{}\n");
    await expect(canonicalizeCandidate(worktree, snapshot.baseSha)).rejects.toThrow("control state");
  });

  it("rejects binary and symlink changes", async () => {
    const binary = await rawWorktree();
    writeFileSync(path.join(binary.worktree.path, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    await expect(canonicalizeCandidate(binary.worktree, binary.snapshot.baseSha)).rejects.toThrow("binary");

    const symlink = await rawWorktree();
    symlinkSync("README.md", path.join(symlink.worktree.path, "link"));
    await expect(canonicalizeCandidate(symlink.worktree, symlink.snapshot.baseSha)).rejects.toThrow("symlink");
  });

  it("fails closed when deterministic verification is unavailable or fails", async () => {
    const unavailable: VerificationRunner = {
      async status() {
        return { available: false, reason: "no certified backend" };
      },
      async run() {
        throw new Error("must not run");
      },
    };
    const unavailableFixture = await makePreparedCandidate({ runner: unavailable }).catch((error: unknown) => error);
    expect(unavailableFixture).toMatchObject({
      message: "candidate verification unavailable",
      data: { reasonCode: "backend-unsupported" },
    });

    let calls = 0;
    const failing: VerificationRunner = {
      async status() {
        return { available: true };
      },
      async run() {
        calls += 1;
        return { exitCode: calls === 1 ? 0 : 1 };
      },
    };
    await expect(makePreparedCandidate({ runner: failing })).rejects.toThrow("candidate verification failed");
  });
});
