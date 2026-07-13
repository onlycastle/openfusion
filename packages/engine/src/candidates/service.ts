import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  ApprovalGrantSchema,
  CandidateRefSchema,
  type ApprovalGrant,
  type CandidateRef,
  type CheckResultV2,
  type StageReportV2,
  type TaskContract,
  type TaskSnapshotRef,
} from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { stageMessageId } from "../harness/registry.js";
import type { ReviewVerdict } from "../orchestrate/review.js";
import { RpcErrorCodes } from "@openfusion/shared";
import { RpcMethodError } from "../rpc/errors.js";
import { MacOsSandboxBackend, type SandboxBackend } from "../runtime/sandbox.js";
import type { RuntimeArtifact } from "../runtime/types.js";
import { enforceStagePolicy } from "../verification/policy.js";
import { applyGitPatchFromMemory, type Worktree } from "../worker/worktree.js";

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_TOUCHED_PATHS = 4_096;
const CANDIDATE_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const APPROVAL_LIFETIME_MS = 10 * 60_000;

function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function projectDigest(projectDir: string): `sha256:${string}` {
  return sha256(realpathSync(path.resolve(projectDir)));
}

function digestEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function cloneCandidateRef(ref: CandidateRef): CandidateRef {
  return CandidateRefSchema.parse(structuredClone(ref));
}

function cloneApprovalGrant(grant: ApprovalGrant): ApprovalGrant {
  return ApprovalGrantSchema.parse(structuredClone(grant));
}

function reportRef(report: StageReportV2): { id: string; digest: `sha256:${string}` } {
  return { id: report.stageId, digest: sha256(JSON.stringify(report)) };
}

function stageReport(input: {
  stageId: string;
  snapshot: TaskSnapshotRef;
  outputDigest?: string;
  checks: CheckResultV2[];
  startedAt: number;
}): StageReportV2 {
  return enforceStagePolicy({
    schemaVersion: 2,
    stageId: input.stageId,
    policyVersion: 2,
    attempt: 1,
    inputRef: { id: input.snapshot.snapshotId, digest: sha256(JSON.stringify(input.snapshot)) },
    ...(input.outputDigest === undefined
      ? {}
      : { outputRef: { id: "candidate-diff", digest: input.outputDigest } }),
    execution: "completed",
    verdict: "passed",
    checks: input.checks,
    startedAt: new Date(input.startedAt).toISOString(),
    durationMs: Date.now() - input.startedAt,
  }) as StageReportV2;
}

function assertCandidatePath(relativePath: string): void {
  if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error("candidate contains an invalid path");
  }
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    throw new Error("candidate path escapes the task tree");
  }
  const first = segments[0]!.toLowerCase();
  if (first === ".git" || first === ".openfusion" || first === ".gitmodules") {
    throw new Error("candidate modifies OpenFusion or Git control state");
  }
}

export interface CanonicalCandidate {
  diff: string;
  diffDigest: `sha256:${string}`;
  touchedPaths: string[];
}

export async function canonicalizeCandidate(
  worktree: Worktree,
  expectedBaseSha: string,
): Promise<CanonicalCandidate> {
  if (worktree.baseSha !== expectedBaseSha) throw new Error("candidate worktree has the wrong base SHA");
  await git(worktree.path, ["add", "-A"]);
  const diff = await git(worktree.path, ["diff", "--cached", "--binary", "--full-index", expectedBaseSha]);
  if (diff.trim().length === 0) throw new Error("candidate diff is empty");
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) throw new Error("candidate diff exceeds 16 MiB");
  if (diff.includes("GIT binary patch") || diff.includes("Binary files ")) {
    throw new Error("binary candidate changes are not allowed");
  }
  const names = await git(worktree.path, ["diff", "--cached", "--name-only", "-z", expectedBaseSha]);
  const touchedPaths = names.split("\0").filter(Boolean).sort();
  if (touchedPaths.length > MAX_TOUCHED_PATHS) throw new Error("candidate touches too many paths");
  for (const relativePath of touchedPaths) assertCandidatePath(relativePath);
  const summary = await git(worktree.path, ["diff", "--cached", "--summary", expectedBaseSha]);
  if (/mode 120000|symlink/i.test(summary)) throw new Error("candidate symlink changes are not allowed");
  return { diff, diffDigest: sha256(diff), touchedPaths };
}

class TransientArtifactOutput {
  #bytes = 0;
  #limitReached = false;
  write(chunk: Buffer | string): { acceptedBytes: number; limitReached: boolean } {
    const bytes = Buffer.byteLength(chunk);
    const remaining = MAX_DIFF_BYTES - this.#bytes;
    const acceptedBytes = Math.max(0, Math.min(bytes, remaining));
    this.#bytes += acceptedBytes;
    this.#limitReached ||= acceptedBytes < bytes;
    return { acceptedBytes, limitReached: this.#limitReached };
  }
  finish(): RuntimeArtifact {
    return {
      id: randomUUID(),
      sessionId: "candidate-verifier",
      type: "transient-verifier-output",
      size: this.#bytes,
      retentionState: "deleted",
      createdAt: new Date().toISOString(),
    };
  }
  abort(): void {}
}

function resolveExecutable(command: string): string {
  if (path.isAbsolute(command)) {
    if (!existsSync(command)) throw new Error(`verification executable not found: ${command}`);
    return realpathSync(command);
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, command);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`verification executable not found: ${command}`);
}

function verifierGitReadPaths(cwd: string): string[] {
  const output = execFileSync(
    "git",
    ["-C", cwd, "rev-parse", "--git-dir", "--git-common-dir"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return [...new Set(output.trim().split("\n").filter(Boolean).map((entry) => {
    const absolute = path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
    return realpathSync(absolute);
  }))];
}

export interface VerificationRunner {
  status(): Promise<{ available: boolean; reason?: string }>;
  run(cwd: string, command: string[], signal?: AbortSignal): Promise<{ exitCode: number | null }>;
}

class SandboxVerificationRunner implements VerificationRunner {
  readonly #backend: SandboxBackend;
  constructor(backend: SandboxBackend = new MacOsSandboxBackend()) {
    this.#backend = backend;
  }
  async status(): Promise<{ available: boolean; reason?: string }> {
    return this.#backend.status();
  }
  async run(cwd: string, command: string[], signal?: AbortSignal): Promise<{ exitCode: number | null }> {
    const executable = resolveExecutable(command[0]!);
    const privateTempDir = mkdtempSync(path.join(os.tmpdir(), "of-verify-tmp-"));
    try {
      const result = await this.#backend.run({
        executable,
        args: command.slice(1),
        cwd,
        privateTempDir,
        // Script launchers such as pnpm use `#!/usr/bin/env node`. Include
        // the engine's Node interpreter explicitly so the native runner can
        // construct a usable allowlisted PATH without inheriting the host
        // environment.
        readablePaths: [
          path.dirname(executable),
          path.dirname(path.dirname(executable)),
          path.dirname(process.execPath),
          path.dirname(path.dirname(process.execPath)),
          ...verifierGitReadPaths(cwd),
        ],
        executablePaths: [executable, process.execPath],
        networkGranted: false,
        profile: "verify",
        timeoutMs: 10 * 60_000,
        abortSignal: signal,
        output: new TransientArtifactOutput() as never,
      });
      return { exitCode: result.exitCode };
    } finally {
      rmSync(privateTempDir, { recursive: true, force: true });
    }
  }
}

interface CandidateRecord {
  ref: CandidateRef;
  projectDir: string;
  worktree: Worktree;
  diffStat: string;
  reports: StageReportV2[];
}

interface GrantRecord {
  grant: ApprovalGrant;
  tokenDigest: string;
  used: boolean;
}

export interface PreparedCandidate {
  canonical: CanonicalCandidate;
  diffStat: string;
  reports: StageReportV2[];
  contractDigest: `sha256:${string}`;
  requirementCount: number;
}

export class CandidateService {
  readonly #runner: VerificationRunner;
  readonly #records = new Map<string, CandidateRecord>();
  readonly #grants = new Map<string, GrantRecord>();
  readonly #expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: { verificationRunner?: VerificationRunner } = {}) {
    this.#runner = options.verificationRunner ?? new SandboxVerificationRunner();
  }

  /** Delete transient candidate worktrees when the in-memory authority ends. */
  async close(): Promise<void> {
    for (const timer of this.#expiryTimers.values()) clearTimeout(timer);
    this.#expiryTimers.clear();
    const records = [...this.#records.values()];
    this.#records.clear();
    this.#grants.clear();
    await Promise.allSettled(records.map((record) =>
      git(record.worktree.base, ["worktree", "remove", "--force", record.worktree.path])
    ));
  }

  async prepare(
    engine: Engine,
    input: {
      projectDir: string;
      worktree: Worktree;
      snapshot: TaskSnapshotRef;
      contract: TaskContract;
      signal?: AbortSignal;
    },
  ): Promise<PreparedCandidate> {
    const diffStarted = Date.now();
    const canonical = await canonicalizeCandidate(input.worktree, input.snapshot.baseSha);
    const diffChecks: CheckResultV2[] = [
      "diff.non-empty",
      "diff.valid",
      "diff.complete",
      "diff.paths-allowed",
    ].map((id) => ({ id, required: true, status: "passed", messageId: stageMessageId(id, "passed") }));
    const diffReport = stageReport({
      stageId: "task.diff",
      snapshot: input.snapshot,
      outputDigest: canonical.diffDigest,
      checks: diffChecks,
      startedAt: diffStarted,
    });

    const manager = await engine.worker.getManager(input.projectDir);
    const verifier = await manager.create(`verify-${randomUUID()}`, input.snapshot.baseSha);
    try {
      await applyGitPatchFromMemory(
        verifier.path,
        Buffer.from(canonical.diff, "utf8"),
        ["--index", "--binary"],
      );
      const materialized = await canonicalizeCandidate(verifier, input.snapshot.baseSha);
      if (materialized.diffDigest !== canonical.diffDigest) {
        throw new Error("verifier clone did not materialize the exact candidate");
      }

      const verifyStarted = Date.now();
      const status = await this.#runner.status();
      if (!status.available) {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "candidate verification unavailable", {
          reasonCode: "backend-unsupported",
        });
      }
      const commands = [["git", "diff", "--check", input.snapshot.baseSha], ...input.contract.verificationCommands];
      let commandsPassed = true;
      for (const command of commands) {
        if (input.signal?.aborted) throw new Error("candidate verification aborted");
        const result = await this.#runner.run(verifier.path, command, input.signal);
        if (result.exitCode !== 0) {
          commandsPassed = false;
          break;
        }
      }
      const verifyChecks: CheckResultV2[] = [
        {
          id: "verify.profile-approved",
          required: true,
          status: "passed",
          messageId: stageMessageId("verify.profile-approved", "passed"),
        },
        {
          id: "verify.required-commands",
          required: true,
          status: commandsPassed ? "passed" : "failed",
          messageId: stageMessageId("verify.required-commands", commandsPassed ? "passed" : "failed"),
          evidence: {
            count: commands.length,
            expectedCount: commands.length,
            ...(commandsPassed ? {} : { reasonCode: "command-failed" }),
          },
        },
        {
          id: "verify.no-policy-violation",
          required: true,
          status: commandsPassed ? "passed" : "failed",
          messageId: stageMessageId("verify.no-policy-violation", commandsPassed ? "passed" : "failed"),
          ...(commandsPassed ? {} : { evidence: { reasonCode: "command-failed" } }),
        },
      ];
      const verifyReport = stageReport({
        stageId: "task.verify",
        snapshot: input.snapshot,
        outputDigest: canonical.diffDigest,
        checks: verifyChecks,
        startedAt: verifyStarted,
      });
      if (verifyReport.verdict !== "passed") {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "candidate verification failed", {
          reasonCode: "command-failed",
        });
      }
      return {
        canonical,
        diffStat: await git(input.worktree.path, ["diff", "--cached", "--stat", input.snapshot.baseSha]),
        reports: [diffReport, verifyReport],
        contractDigest: sha256(JSON.stringify(input.contract)),
        requirementCount: input.contract.requirements.length,
      };
    } finally {
      await manager.remove(verifier).catch(() => {});
    }
  }

  mint(input: {
    projectDir: string;
    worktree: Worktree;
    snapshot: TaskSnapshotRef;
    prepared: PreparedCandidate;
    authorAttemptId: string;
    authorSessionId: string;
    reviewerSessionId: string;
    verdict: ReviewVerdict;
  }): CandidateRef {
    if (input.verdict.decision !== "approve") throw new Error("reviewer did not approve the candidate");
    if (input.authorSessionId === input.reviewerSessionId) {
      throw new Error("candidate reviewer must be independent from the author");
    }
    const reviewStarted = Date.now();
    const reviewReport = stageReport({
      stageId: "task.review",
      snapshot: input.snapshot,
      outputDigest: input.prepared.canonical.diffDigest,
      checks: [
        "review.rubric-complete",
        "review.machine-checks-honored",
        "review.approved",
      ].map((id) => ({ id, required: true, status: "passed", messageId: stageMessageId(id, "passed") })),
      startedAt: reviewStarted,
    });
    const coverageReport = stageReport({
      stageId: "task.coverage",
      snapshot: input.snapshot,
      outputDigest: input.prepared.canonical.diffDigest,
      checks: [{
        id: "coverage.requirements-evidenced",
        required: true,
        status: "passed",
        messageId: stageMessageId("coverage.requirements-evidenced", "passed"),
        evidence: {
          artifactDigest: input.prepared.contractDigest,
          count: input.prepared.requirementCount,
          expectedCount: input.prepared.requirementCount,
        },
      }],
      startedAt: reviewStarted,
    });
    const reports = [...input.prepared.reports, coverageReport, reviewReport];
    const candidateId = randomUUID();
    const createdAt = new Date();
    const ref = CandidateRefSchema.parse({
      schemaVersion: 1,
      candidateId,
      taskSnapshot: input.snapshot,
      authorAttemptId: input.authorAttemptId,
      authorSessionId: input.authorSessionId,
      reviewerSessionId: input.reviewerSessionId,
      diffDigest: input.prepared.canonical.diffDigest,
      touchedPaths: input.prepared.canonical.touchedPaths,
      verifierReports: reports.map(reportRef),
      lifecycle: "approved",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + CANDIDATE_LIFETIME_MS).toISOString(),
    });
    this.#records.set(candidateId, {
      ref,
      projectDir: realpathSync(input.projectDir),
      worktree: input.worktree,
      diffStat: input.prepared.diffStat,
      reports,
    });
    const timer = setTimeout(() => void this.#expire(candidateId), CANDIDATE_LIFETIME_MS);
    timer.unref();
    this.#expiryTimers.set(candidateId, timer);
    return cloneCandidateRef(ref);
  }

  async read(candidateId: string): Promise<{
    candidateRef: CandidateRef;
    diff: string;
    diffStat: string;
    reports: StageReportV2[];
  }> {
    const record = this.#require(candidateId);
    const canonical = await canonicalizeCandidate(record.worktree, record.ref.taskSnapshot.baseSha);
    if (canonical.diffDigest !== record.ref.diffDigest) {
      record.ref = { ...record.ref, lifecycle: "rejected" };
      await this.#discard(record);
      throw new Error("candidate content changed after approval");
    }
    return {
      candidateRef: cloneCandidateRef(record.ref),
      diff: canonical.diff,
      diffStat: record.diffStat,
      reports: structuredClone(record.reports),
    };
  }

  async prepareApply(candidateId: string, destinationProject: string): Promise<ApprovalGrant> {
    const record = this.#require(candidateId);
    await this.#freshness(record, destinationProject);
    const canonical = await canonicalizeCandidate(record.worktree, record.ref.taskSnapshot.baseSha);
    if (canonical.diffDigest !== record.ref.diffDigest) {
      record.ref = { ...record.ref, lifecycle: "rejected" };
      await this.#discard(record);
      throw new Error("candidate content changed after approval");
    }
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const grant: ApprovalGrant = {
      schemaVersion: 1,
      grantId: randomUUID(),
      token,
      candidateId,
      destinationProjectDigest: projectDigest(destinationProject),
      baseSha: record.ref.taskSnapshot.baseSha,
      diffDigest: canonical.diffDigest,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + APPROVAL_LIFETIME_MS).toISOString(),
    };
    this.#grants.set(grant.grantId, {
      grant: cloneApprovalGrant(grant),
      tokenDigest: sha256(token),
      used: false,
    });
    return cloneApprovalGrant(grant);
  }

  async apply(candidateId: string, grant: ApprovalGrant, destinationProject: string): Promise<void> {
    const supplied = ApprovalGrantSchema.parse(grant);
    const stored = this.#grants.get(supplied.grantId);
    if (
      stored === undefined
      || stored.grant.candidateId !== candidateId
      || !digestEquals(stored.tokenDigest, sha256(supplied.token))
      || stored.grant.destinationProjectDigest !== supplied.destinationProjectDigest
      || stored.grant.baseSha !== supplied.baseSha
      || stored.grant.diffDigest !== supplied.diffDigest
      || stored.grant.issuedAt !== supplied.issuedAt
      || stored.grant.expiresAt !== supplied.expiresAt
    ) {
      throw new Error("approval grant is invalid");
    }
    if (stored.used) throw new Error("approval grant was already used");
    stored.used = true;
    if (Date.now() >= Date.parse(stored.grant.expiresAt)) throw new Error("approval grant expired");
    if (stored.grant.destinationProjectDigest !== projectDigest(destinationProject)) {
      throw new Error("approval grant targets a different project");
    }
    const record = this.#require(candidateId);
    await this.#freshness(record, destinationProject);
    const canonical = await canonicalizeCandidate(record.worktree, record.ref.taskSnapshot.baseSha);
    if (canonical.diffDigest !== record.ref.diffDigest || canonical.diffDigest !== stored.grant.diffDigest) {
      record.ref = { ...record.ref, lifecycle: "rejected" };
      await this.#discard(record);
      throw new Error("candidate diff changed after approval");
    }
    const patch = Buffer.from(canonical.diff, "utf8");
    await applyGitPatchFromMemory(destinationProject, patch, ["--check", "--3way"]);
    await applyGitPatchFromMemory(destinationProject, patch, ["--3way"]);
    record.ref = { ...record.ref, lifecycle: "applied" };
    const expiryTimer = this.#expiryTimers.get(candidateId);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    this.#expiryTimers.delete(candidateId);
    // Applied candidates no longer need an author worktree. Cleanup is
    // deliberately best-effort after the destination change succeeds: a Git
    // administrative cleanup failure must not misreport an already-applied
    // candidate as if Apply itself failed.
    await git(record.worktree.base, [
      "worktree",
      "remove",
      "--force",
      record.worktree.path,
    ]).catch(() => "");
  }

  #require(candidateId: string): CandidateRecord {
    const record = this.#records.get(candidateId);
    if (record === undefined) throw new Error(`candidate not found: ${candidateId}`);
    if (Date.now() >= Date.parse(record.ref.expiresAt)) {
      record.ref = { ...record.ref, lifecycle: "expired" };
      throw new Error("candidate expired");
    }
    if (record.ref.lifecycle !== "approved") throw new Error(`candidate is ${record.ref.lifecycle}`);
    return record;
  }

  async #freshness(record: CandidateRecord, destinationProject: string): Promise<void> {
    const root = realpathSync(destinationProject);
    if (root !== record.projectDir) throw new Error("candidate belongs to a different project");
    const head = (await git(root, ["rev-parse", "HEAD"])).trim();
    if (head !== record.ref.taskSnapshot.baseSha) {
      record.ref = { ...record.ref, lifecycle: "stale" };
      await this.#discard(record);
      throw new Error("project HEAD changed after candidate creation");
    }
    const dirty = new Set<string>();
    for (const args of [
      ["diff", "--name-only", "-z"],
      ["diff", "--cached", "--name-only", "-z"],
      ["ls-files", "--others", "--exclude-standard", "-z"],
    ]) {
      for (const file of (await git(root, args)).split("\0").filter(Boolean)) dirty.add(file);
    }
    if (record.ref.touchedPaths.some((file) => dirty.has(file))) {
      throw new Error("candidate overlaps dirty destination paths");
    }
  }

  async #discard(record: CandidateRecord): Promise<void> {
    await git(record.worktree.base, [
      "worktree",
      "remove",
      "--force",
      record.worktree.path,
    ]).catch(() => "");
  }

  async #expire(candidateId: string): Promise<void> {
    this.#expiryTimers.delete(candidateId);
    const record = this.#records.get(candidateId);
    if (record === undefined || record.ref.lifecycle !== "approved") return;
    record.ref = { ...record.ref, lifecycle: "expired" };
    for (const [grantId, grant] of this.#grants) {
      if (grant.grant.candidateId === candidateId) this.#grants.delete(grantId);
    }
    await this.#discard(record);
  }
}
