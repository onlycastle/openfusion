import Database from "better-sqlite3";
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
  type CipherGCM,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { ensureGitignoreGuard } from "../util/gitignore-guard.js";
import {
  assertRuntimeKey,
  decodeJson,
  decryptRecord,
  encodeJson,
  encryptRecord,
  RuntimeContentLockedError,
  type EncryptedRecord,
} from "./crypto.js";
import {
  DEFAULT_RUNTIME_CONFIGURATION,
  type ApprovalStatus,
  type ArtifactRetentionState,
  type LockedValue,
  type ResumeCapability,
  type RuntimeApproval,
  type RuntimeArtifact,
  type RuntimeCheckpoint,
  type RuntimeConfiguration,
  type RuntimeEvent,
  type RuntimeSession,
  type SessionKind,
  type SessionStatus,
} from "./types.js";

const LATEST_SCHEMA_VERSION = 4;
const ARTIFACT_FORMAT_VERSION = 1;
const ARTIFACT_NONCE_BYTES = 12;
const MAX_METADATA_BYTES = 16 * 1024;
const DEFAULT_EVENT_LIMIT = 500;
const MAX_EVENT_LIMIT = 5_000;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_ARTIFACT_BYTES = 256 * 1024 * 1024;

const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        parent_session_id TEXT REFERENCES sessions(id),
        kind TEXT NOT NULL CHECK (kind IN ('orchestrate','worker','child','review','escalation')),
        status TEXT NOT NULL CHECK (status IN ('created','running','waiting-approval','interrupted','needs-recovery','completed','failed','cancelled')),
        version INTEGER NOT NULL CHECK (version >= 1),
        trace_enabled INTEGER NOT NULL CHECK (trace_enabled IN (0,1)),
        worktree_path TEXT,
        base_sha TEXT,
        model_fingerprint TEXT,
        configuration_fingerprint TEXT,
        budget_steps INTEGER,
        budget_deadline_at TEXT,
        used_steps INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        outcome TEXT
      );
      CREATE INDEX sessions_run_idx ON sessions(run_id);
      CREATE INDEX sessions_parent_idx ON sessions(parent_session_id);
      CREATE INDEX sessions_status_idx ON sessions(status, updated_at DESC);

      CREATE TABLE events (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        payload_ciphertext BLOB,
        payload_nonce BLOB,
        payload_tag BLOB,
        payload_version INTEGER,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX events_type_idx ON events(session_id, type, seq);

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        digest TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        retention_state TEXT NOT NULL CHECK (retention_state IN ('active','expired','deleted')),
        encrypted_path TEXT NOT NULL,
        encryption_aad TEXT NOT NULL,
        nonce BLOB NOT NULL,
        tag BLOB NOT NULL,
        format_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX artifacts_digest_idx ON artifacts(digest, type, retention_state);
      CREATE INDEX artifacts_retention_idx ON artifacts(retention_state, expires_at, created_at);

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        event_seq INTEGER NOT NULL,
        policy_source TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','cancelled')),
        scope_json TEXT NOT NULL,
        request_ciphertext BLOB,
        request_nonce BLOB,
        request_tag BLOB,
        response_ciphertext BLOB,
        response_nonce BLOB,
        response_tag BLOB,
        created_at TEXT NOT NULL,
        responded_at TEXT
      );
      CREATE UNIQUE INDEX approvals_pending_idx ON approvals(session_id) WHERE status = 'pending';

      CREATE TABLE checkpoints (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        base_sha TEXT NOT NULL,
        worktree_fingerprint TEXT NOT NULL,
        patch_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );

      CREATE TABLE children (
        parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        child_session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
        parent_version_at_start INTEGER NOT NULL,
        parent_checkpoint_seq INTEGER,
        patch_import_state TEXT NOT NULL CHECK (patch_import_state IN ('not-requested','pending','imported','conflict','rejected')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (parent_session_id, child_session_id)
      );

      CREATE TABLE runtime_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE projections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(path, payload_json)
      );
      CREATE INDEX projections_path_idx ON projections(path, id);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE extensions (
        kind TEXT NOT NULL CHECK (kind IN ('skill','mcp','hook')),
        id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        config_json TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE INDEX extensions_fingerprint_idx ON extensions(fingerprint);

      CREATE TABLE extension_approvals (
        fingerprint TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('skill','mcp','hook')),
        extension_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('approved','revoked')),
        responded_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE experiment_trials (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        match_id TEXT NOT NULL,
        variant TEXT NOT NULL,
        repeat_index INTEGER NOT NULL CHECK (repeat_index >= 0),
        seed INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','running','completed','measurement-failure')),
        features_json TEXT NOT NULL,
        metrics_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(experiment_id, match_id, variant, repeat_index)
      );
      CREATE INDEX experiment_trials_status_idx ON experiment_trials(experiment_id, status, id);

      CREATE TABLE routing_candidates (
        id TEXT PRIMARY KEY,
        harness_digest TEXT NOT NULL,
        evidence_digest TEXT NOT NULL,
        table_json TEXT NOT NULL,
        gate_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed','shadowed','promoted','rejected','rolled-back')),
        shadow_completed INTEGER NOT NULL CHECK (shadow_completed IN (0,1)),
        previous_candidate_id TEXT REFERENCES routing_candidates(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        promoted_at TEXT
      );

      CREATE TABLE routing_active (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        candidate_id TEXT REFERENCES routing_candidates(id),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE human_feedback (
        id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL CHECK (subject_type IN ('session','candidate','routing')),
        subject_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected','abandoned')),
        reason_code TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX human_feedback_subject_idx ON human_feedback(subject_type, subject_id, created_at);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE experiment_definitions (
        id TEXT PRIMARY KEY,
        configuration_digest TEXT NOT NULL,
        configuration_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

interface SessionRow {
  id: string;
  run_id: string;
  project_dir: string;
  parent_session_id: string | null;
  kind: SessionKind;
  status: SessionStatus;
  version: number;
  trace_enabled: number;
  worktree_path: string | null;
  base_sha: string | null;
  model_fingerprint: string | null;
  configuration_fingerprint: string | null;
  budget_steps: number | null;
  budget_deadline_at: string | null;
  used_steps: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  outcome: string | null;
}

interface EventRow {
  session_id: string;
  seq: number;
  type: string;
  at: string;
  metadata_json: string;
  payload_ciphertext: Buffer | null;
  payload_nonce: Buffer | null;
  payload_tag: Buffer | null;
}

interface ArtifactRow {
  id: string;
  session_id: string;
  type: string;
  digest: string;
  size: number;
  retention_state: ArtifactRetentionState;
  encrypted_path: string;
  encryption_aad: string;
  nonce: Buffer;
  tag: Buffer;
  format_version: number;
  created_at: string;
  expires_at: string | null;
}

interface ApprovalRow {
  id: string;
  session_id: string;
  event_seq: number;
  policy_source: string;
  status: ApprovalStatus;
  scope_json: string;
  request_ciphertext: Buffer | null;
  request_nonce: Buffer | null;
  request_tag: Buffer | null;
  response_ciphertext: Buffer | null;
  response_nonce: Buffer | null;
  response_tag: Buffer | null;
  created_at: string;
  responded_at: string | null;
}

interface CheckpointRow {
  session_id: string;
  seq: number;
  base_sha: string;
  worktree_fingerprint: string;
  patch_artifact_id: string;
  created_at: string;
}

export interface RuntimeStoreOptions {
  projectDir: string;
  /** Optional host-private root for encrypted artifacts. SQLite remains project-local. */
  storageDir?: string;
  /** Root used to persist recoverable worktree locations as relative identifiers. */
  worktreeRoot?: string;
  key?: Buffer;
  now?: () => Date;
}

export interface CreateSessionInput {
  id?: string;
  runId?: string;
  parentSessionId?: string;
  kind: SessionKind;
  worktreePath?: string;
  baseSha?: string;
  modelFingerprint?: string;
  configurationFingerprint?: string;
  budgetSteps?: number;
  budgetDeadlineAt?: string;
  initialPayload?: unknown;
  parentCheckpointSeq?: number;
}

export interface SessionUpdate {
  status?: SessionStatus;
  worktreePath?: string | null;
  baseSha?: string | null;
  usedSteps?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  outcome?: string | null;
  modelFingerprint?: string | null;
  configurationFingerprint?: string | null;
}

export interface ListSessionsOptions {
  status?: SessionStatus;
  kind?: SessionKind;
  parentSessionId?: string | null;
  limit?: number;
}

export interface AppendEventInput {
  type: string;
  metadata?: Record<string, unknown>;
  payload?: unknown;
  at?: string;
}

export interface PutArtifactOptions {
  expiresAt?: string;
  deduplicate?: boolean;
}

export interface ArtifactPage {
  artifactId: string;
  offset: number;
  nextOffset?: number;
  totalBytes: number;
  content: string;
  encoding: "utf8" | "base64";
}

export type RuntimeExtensionKind = "skill" | "mcp" | "hook";

export interface RuntimeExtensionRegistration {
  kind: RuntimeExtensionKind;
  id: string;
  fingerprint: string;
  config: Record<string, unknown>;
  diagnostics: Array<{ code: string; message: string }>;
  approvalStatus: "pending" | "approved" | "revoked";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ChildPatchImportState = "not-requested" | "pending" | "imported" | "conflict" | "rejected";

export interface RuntimeChildRelation {
  parentSessionId: string;
  childSessionId: string;
  parentVersionAtStart: number;
  parentCheckpointSeq?: number;
  patchImportState: ChildPatchImportState;
  createdAt: string;
  updatedAt: string;
}

export class RuntimeVersionConflictError extends Error {
  readonly sessionId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number | null;

  constructor(sessionId: string, expectedVersion: number, actualVersion: number | null) {
    super(
      actualVersion === null
        ? `runtime session not found: ${sessionId}`
        : `runtime session ${sessionId} version conflict: expected ${expectedVersion}, actual ${actualVersion}`,
    );
    this.name = "RuntimeVersionConflictError";
    this.sessionId = sessionId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class RuntimeInvalidTransitionError extends Error {
  constructor(from: SessionStatus, to: SessionStatus) {
    super(`invalid runtime session transition: ${from} -> ${to}`);
    this.name = "RuntimeInvalidTransitionError";
  }
}

export class RuntimeArtifactLimitError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`tool output exceeded the ${limitBytes}-byte artifact limit`);
    this.name = "RuntimeArtifactLimitError";
    this.limitBytes = limitBytes;
  }
}

export function runtimeDbPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), ".openfusion", "cache", "runtime.db");
}

function artifactsDir(projectDir: string, storageDir?: string): string {
  return storageDir === undefined
    ? path.join(path.resolve(projectDir), ".openfusion", "cache", "artifacts")
    : path.join(path.resolve(storageDir), "artifacts");
}

function asIso(now: () => Date): string {
  return now().toISOString();
}

function assertSafeJson(value: unknown, label: string): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error(`${label} must be JSON serializable`);
  if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
    throw new Error(`${label} exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  return json;
}

function parseObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime metadata is not a JSON object");
  }
  return value as Record<string, unknown>;
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function artifactAad(row: Pick<ArtifactRow, "id" | "session_id" | "type">): string {
  return `openfusion:artifact:v${ARTIFACT_FORMAT_VERSION}:${row.id}:${row.session_id}:${row.type}`;
}

function eventAad(sessionId: string, seq: number, type: string): string {
  return `openfusion:event:v1:${sessionId}:${seq}:${type}`;
}

function approvalAad(id: string, part: "request" | "response"): string {
  return `openfusion:approval:v1:${id}:${part}`;
}

function encryptedValue<T>(
  key: Buffer | undefined,
  ciphertext: Buffer | null,
  nonce: Buffer | null,
  tag: Buffer | null,
  aad: string,
): LockedValue<T> {
  if (ciphertext === null || nonce === null || tag === null) return { state: "absent" };
  if (key === undefined) return { state: "locked" };
  return {
    state: "available",
    value: decodeJson(decryptRecord(key, { ciphertext, nonce, tag }, aad)) as T,
  };
}

function sessionFromRow(
  row: SessionRow,
  keyAvailable: boolean,
  projectDir: string,
  decodeWorktreePath: (value: string) => string,
): RuntimeSession {
  const resumeCapability: ResumeCapability = row.trace_enabled === 0
    ? "worktree-only"
    : keyAvailable
      ? "exact"
      : "locked";
  return {
    id: row.id,
    runId: row.run_id,
    ...(row.parent_session_id === null ? {} : { parentSessionId: row.parent_session_id }),
    kind: row.kind,
    status: row.status,
    version: row.version,
    resumeCapability,
    projectDir,
    ...(row.worktree_path === null ? {} : { worktreePath: decodeWorktreePath(row.worktree_path) }),
    ...(row.base_sha === null ? {} : { baseSha: row.base_sha }),
    ...(row.model_fingerprint === null ? {} : { modelFingerprint: row.model_fingerprint }),
    ...(row.configuration_fingerprint === null
      ? {}
      : { configurationFingerprint: row.configuration_fingerprint }),
    ...(row.budget_steps === null ? {} : { budgetSteps: row.budget_steps }),
    ...(row.budget_deadline_at === null ? {} : { budgetDeadlineAt: row.budget_deadline_at }),
    usedSteps: row.used_steps,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
  };
}

function artifactFromRow(row: ArtifactRow): RuntimeArtifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    size: row.size,
    retentionState: row.retention_state,
    createdAt: row.created_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  };
}

function checkpointFromRow(row: CheckpointRow): RuntimeCheckpoint {
  return {
    sessionId: row.session_id,
    seq: row.seq,
    baseSha: row.base_sha,
    worktreeFingerprint: row.worktree_fingerprint,
    patchArtifactId: row.patch_artifact_id,
    createdAt: row.created_at,
  };
}

const ALLOWED_TRANSITIONS: Readonly<Record<SessionStatus, ReadonlySet<SessionStatus>>> = {
  created: new Set(["running", "failed", "cancelled"]),
  running: new Set([
    "waiting-approval",
    "interrupted",
    "needs-recovery",
    "completed",
    "failed",
    "cancelled",
  ]),
  "waiting-approval": new Set(["running", "failed", "cancelled"]),
  interrupted: new Set(["running", "needs-recovery", "failed", "cancelled"]),
  "needs-recovery": new Set(["running", "interrupted", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

/**
 * Authoritative per-project runtime state. All public methods are synchronous
 * because better-sqlite3 transactions are synchronous; artifact creation
 * still follows the durable file-before-row ordering required for crash
 * safety.
 */
export class RuntimeStore {
  readonly projectDir: string;
  readonly dbPath: string;
  readonly artifactRoot: string;
  readonly #db: Database.Database;
  readonly #now: () => Date;
  readonly #projectDigest: string;
  readonly #worktreeRoot: string | undefined;
  #key: Buffer | undefined;
  #closed = false;

  constructor(options: RuntimeStoreOptions) {
    this.projectDir = path.resolve(options.projectDir);
    this.dbPath = runtimeDbPath(this.projectDir);
    this.artifactRoot = artifactsDir(this.projectDir, options.storageDir);
    this.#projectDigest = `sha256:${createHash("sha256").update(this.projectDir).digest("hex")}`;
    if (options.worktreeRoot !== undefined) mkdirSync(options.worktreeRoot, { recursive: true, mode: 0o700 });
    this.#worktreeRoot = options.worktreeRoot === undefined
      ? undefined
      : realpathSync(path.resolve(options.worktreeRoot));
    this.#now = options.now ?? (() => new Date());
    this.#key = options.key === undefined ? undefined : assertRuntimeKey(options.key);

    const openfusionDir = path.join(this.projectDir, ".openfusion");
    ensureGitignoreGuard(openfusionDir, ["cache/"]);
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    mkdirSync(path.join(this.artifactRoot, ".tmp"), { recursive: true });

    this.#db = new Database(this.dbPath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.pragma("foreign_keys = ON");
    this.#db.pragma("busy_timeout = 5000");
    this.#migrate();
    this.#ensureDefaultConfiguration();
    this.#validateConfiguredKey();
    this.collectOrphanedArtifactFiles();
    this.markInterruptedAfterStartup();
    this.#db.prepare(
      "UPDATE experiment_trials SET status = 'pending', updated_at = ? WHERE status = 'running'",
    ).run(asIso(this.#now));
  }

  get keyAvailable(): boolean {
    return this.#key !== undefined;
  }

  setKey(key: Buffer | undefined): void {
    this.#key = key === undefined ? undefined : assertRuntimeKey(key);
    this.#validateConfiguredKey();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  schemaVersion(): number {
    const row = this.#db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    return row.version ?? 0;
  }

  integrityCheck(): { ok: boolean; messages: string[] } {
    const rows = this.#db.pragma("quick_check") as Array<{ quick_check: string }>;
    const messages = rows.map((row) => row.quick_check);
    return { ok: messages.length === 1 && messages[0] === "ok", messages };
  }

  durabilityStatus(): { journalMode: string; synchronous: number } {
    return {
      journalMode: this.#db.pragma("journal_mode", { simple: true }) as string,
      synchronous: this.#db.pragma("synchronous", { simple: true }) as number,
    };
  }

  configure(update: Partial<RuntimeConfiguration>): RuntimeConfiguration {
    const current = this.getConfiguration();
    const next: RuntimeConfiguration = {
      traceEnabled: update.traceEnabled ?? current.traceEnabled,
      retentionDays: update.retentionDays ?? current.retentionDays,
      retentionBytes: update.retentionBytes ?? current.retentionBytes,
      sandboxGrants: update.sandboxGrants ?? current.sandboxGrants,
      enabledExtensions: update.enabledExtensions ?? current.enabledExtensions,
      childrenEnabled: update.childrenEnabled ?? current.childrenEnabled,
    };
    if (!Number.isInteger(next.retentionDays) || next.retentionDays < 1 || next.retentionDays > 3650) {
      throw new Error("retentionDays must be an integer between 1 and 3650");
    }
    if (!Number.isInteger(next.retentionBytes) || next.retentionBytes < 1024 * 1024) {
      throw new Error("retentionBytes must be an integer of at least 1 MiB");
    }
    if (next.traceEnabled && this.#key === undefined) {
      throw new RuntimeContentLockedError();
    }
    const write = this.#db.prepare(
      `INSERT INTO runtime_settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    );
    this.#db.transaction(() => {
      write.run("traceEnabled", JSON.stringify(next.traceEnabled));
      if (next.traceEnabled) {
        write.run("runtimeKeyDigest", JSON.stringify(this.#runtimeKeyDigest(this.#key!)));
      }
      write.run("retentionDays", JSON.stringify(next.retentionDays));
      write.run("retentionBytes", JSON.stringify(next.retentionBytes));
      write.run("sandboxGrants", JSON.stringify([...new Set(next.sandboxGrants)].sort()));
      write.run("enabledExtensions", JSON.stringify([...new Set(next.enabledExtensions)].sort()));
      write.run("childrenEnabled", JSON.stringify(next.childrenEnabled));
    })();
    return this.getConfiguration();
  }

  getConfiguration(): RuntimeConfiguration {
    const rows = this.#db
      .prepare("SELECT key, value_json FROM runtime_settings")
      .all() as Array<{ key: keyof RuntimeConfiguration; value_json: string }>;
    const values = new Map(rows.map((row) => [row.key, JSON.parse(row.value_json) as unknown]));
    return {
      traceEnabled: values.get("traceEnabled") as boolean ?? DEFAULT_RUNTIME_CONFIGURATION.traceEnabled,
      retentionDays: values.get("retentionDays") as number ?? DEFAULT_RUNTIME_CONFIGURATION.retentionDays,
      retentionBytes: values.get("retentionBytes") as number ?? DEFAULT_RUNTIME_CONFIGURATION.retentionBytes,
      sandboxGrants: values.get("sandboxGrants") as string[] ?? [],
      enabledExtensions: values.get("enabledExtensions") as string[] ?? [],
      childrenEnabled: values.get("childrenEnabled") as boolean ?? false,
    };
  }

  createSession(input: CreateSessionInput): RuntimeSession {
    const id = input.id ?? randomUUID();
    const runId = input.runId ?? id;
    const now = asIso(this.#now);
    const traceEnabled = this.getConfiguration().traceEnabled;
    if (traceEnabled && this.#key === undefined) throw new RuntimeContentLockedError();
    const insert = this.#db.prepare(
      `INSERT INTO sessions (
         id, run_id, project_dir, parent_session_id, kind, status, version,
         trace_enabled, worktree_path, base_sha, model_fingerprint,
         configuration_fingerprint, budget_steps, budget_deadline_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'created', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#db.transaction(() => {
      insert.run(
        id,
        runId,
        this.#projectDigest,
        input.parentSessionId ?? null,
        input.kind,
        traceEnabled ? 1 : 0,
        this.#encodeWorktreePath(input.worktreePath ?? null),
        input.baseSha ?? null,
        input.modelFingerprint ?? null,
        input.configurationFingerprint ?? null,
        input.budgetSteps ?? null,
        input.budgetDeadlineAt ?? null,
        now,
        now,
      );
      this.#appendEventTx(id, {
        type: "session.created",
        metadata: { kind: input.kind },
        ...(input.initialPayload === undefined ? {} : { payload: input.initialPayload }),
        at: now,
      });
      if (input.parentSessionId !== undefined) {
        const parent = this.#sessionRow(input.parentSessionId);
        if (parent === undefined) throw new Error(`parent session not found: ${input.parentSessionId}`);
        this.#db.prepare(
          `INSERT INTO children (
             parent_session_id, child_session_id, parent_version_at_start,
             parent_checkpoint_seq, patch_import_state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'not-requested', ?, ?)`,
        ).run(input.parentSessionId, id, parent.version, input.parentCheckpointSeq ?? null, now, now);
      }
    })();
    return this.requireSession(id);
  }

  getSession(id: string): RuntimeSession | null {
    const row = this.#sessionRow(id);
    return row === undefined
      ? null
      : sessionFromRow(row, this.#key !== undefined, this.projectDir, (value) => this.#decodeWorktreePath(value));
  }

  requireSession(id: string): RuntimeSession {
    const session = this.getSession(id);
    if (session === null) throw new Error(`runtime session not found: ${id}`);
    return session;
  }

  listSessions(options: ListSessionsOptions = {}): RuntimeSession[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.status !== undefined) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.parentSessionId !== undefined) {
      clauses.push(options.parentSessionId === null ? "parent_session_id IS NULL" : "parent_session_id = ?");
      if (options.parentSessionId !== null) params.push(options.parentSessionId);
    }
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = this.#db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC, id LIMIT ?`)
      .all(...params, limit) as SessionRow[];
    return rows.map((row) =>
      sessionFromRow(row, this.#key !== undefined, this.projectDir, (value) => this.#decodeWorktreePath(value))
    );
  }

  updateSession(id: string, expectedVersion: number, update: SessionUpdate): RuntimeSession {
    return this.#db.transaction(() => {
      const current = this.#sessionRow(id);
      if (current === undefined || current.version !== expectedVersion) {
        throw new RuntimeVersionConflictError(id, expectedVersion, current?.version ?? null);
      }
      if (update.status !== undefined && update.status !== current.status) {
        if (!ALLOWED_TRANSITIONS[current.status].has(update.status)) {
          throw new RuntimeInvalidTransitionError(current.status, update.status);
        }
      }
      const nextStatus = update.status ?? current.status;
      const now = asIso(this.#now);
      const startedAt = current.started_at ?? (nextStatus === "running" ? now : null);
      const terminal = nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled";
      const result = this.#db.prepare(
        `UPDATE sessions SET
           status = ?, version = version + 1, updated_at = ?, started_at = ?,
           ended_at = ?, worktree_path = ?, base_sha = ?, used_steps = ?,
           input_tokens = ?, output_tokens = ?, cost_usd = ?, outcome = ?,
           model_fingerprint = ?, configuration_fingerprint = ?
         WHERE id = ? AND version = ?`,
      ).run(
        nextStatus,
        now,
        startedAt,
        terminal ? (current.ended_at ?? now) : current.ended_at,
        update.worktreePath === undefined
          ? current.worktree_path
          : this.#encodeWorktreePath(update.worktreePath),
        update.baseSha === undefined ? current.base_sha : update.baseSha,
        update.usedSteps ?? current.used_steps,
        update.inputTokens ?? current.input_tokens,
        update.outputTokens ?? current.output_tokens,
        update.costUsd === undefined ? current.cost_usd : update.costUsd,
        update.outcome === undefined ? current.outcome : update.outcome,
        update.modelFingerprint === undefined ? current.model_fingerprint : update.modelFingerprint,
        update.configurationFingerprint === undefined
          ? current.configuration_fingerprint
          : update.configurationFingerprint,
        id,
        expectedVersion,
      );
      if (result.changes !== 1) {
        const actual = this.#sessionRow(id);
        throw new RuntimeVersionConflictError(id, expectedVersion, actual?.version ?? null);
      }
      if (nextStatus !== current.status) {
        this.#appendEventTx(id, {
          type: "session.status-changed",
          metadata: { from: current.status, to: nextStatus },
          at: now,
        });
      }
      if (terminal && current.trace_enabled === 0) this.#expireArtifactsForSession(id);
      return sessionFromRow(
        this.#sessionRow(id)!,
        this.#key !== undefined,
        this.projectDir,
        (value) => this.#decodeWorktreePath(value),
      );
    })();
  }

  appendEvent(sessionId: string, input: AppendEventInput): RuntimeEvent {
    return this.#db.transaction(() => this.#appendEventTx(sessionId, input))();
  }

  listEvents(
    sessionId: string,
    options: { afterSeq?: number; limit?: number } = {},
  ): RuntimeEvent[] {
    this.requireSession(sessionId);
    const afterSeq = Math.max(0, Math.trunc(options.afterSeq ?? 0));
    const limit = Math.max(1, Math.min(MAX_EVENT_LIMIT, options.limit ?? DEFAULT_EVENT_LIMIT));
    const rows = this.#db.prepare(
      "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    ).all(sessionId, afterSeq, limit) as EventRow[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      seq: row.seq,
      type: row.type,
      at: row.at,
      metadata: parseObject(row.metadata_json),
      payload: encryptedValue(
        this.#key,
        row.payload_ciphertext,
        row.payload_nonce,
        row.payload_tag,
        eventAad(row.session_id, row.seq, row.type),
      ),
    }));
  }

  latestEvent(sessionId: string, type?: string): RuntimeEvent | null {
    const row = (type === undefined
      ? this.#db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(sessionId)
      : this.#db.prepare(
          "SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY seq DESC LIMIT 1",
        ).get(sessionId, type)) as EventRow | undefined;
    if (row === undefined) return null;
    return {
      sessionId: row.session_id,
      seq: row.seq,
      type: row.type,
      at: row.at,
      metadata: parseObject(row.metadata_json),
      payload: encryptedValue(
        this.#key,
        row.payload_ciphertext,
        row.payload_nonce,
        row.payload_tag,
        eventAad(row.session_id, row.seq, row.type),
      ),
    };
  }

  requestApproval(
    sessionId: string,
    expectedVersion: number,
    input: {
      id?: string;
      policySource: string;
      scope: Record<string, unknown>;
      request: unknown;
    },
  ): { session: RuntimeSession; approval: RuntimeApproval } {
    if (this.#key === undefined) throw new RuntimeContentLockedError();
    return this.#db.transaction(() => {
      const current = this.#sessionRow(sessionId);
      if (current === undefined || current.version !== expectedVersion) {
        throw new RuntimeVersionConflictError(sessionId, expectedVersion, current?.version ?? null);
      }
      if (current.status !== "running") {
        throw new RuntimeInvalidTransitionError(current.status, "waiting-approval");
      }
      const id = input.id ?? randomUUID();
      const now = asIso(this.#now);
      const event = this.#appendEventTx(sessionId, {
        type: "approval.requested",
        metadata: { approvalId: id, policySource: input.policySource },
        payload: input.request,
        at: now,
      });
      const encrypted = encryptRecord(this.#key!, encodeJson(input.request), approvalAad(id, "request"));
      this.#db.prepare(
        `INSERT INTO approvals (
           id, session_id, event_seq, policy_source, status, scope_json,
           request_ciphertext, request_nonce, request_tag, created_at
         ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      ).run(
        id,
        sessionId,
        event.seq,
        input.policySource,
        assertSafeJson(input.scope, "approval scope"),
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        now,
      );
      this.#db.prepare(
        `UPDATE sessions SET status = 'waiting-approval', version = version + 1,
           updated_at = ? WHERE id = ? AND version = ?`,
      ).run(now, sessionId, expectedVersion);
      return {
        session: sessionFromRow(
          this.#sessionRow(sessionId)!,
          true,
          this.projectDir,
          (value) => this.#decodeWorktreePath(value),
        ),
        approval: this.#approvalFromRow(this.#approvalRow(id)!),
      };
    })();
  }

  respondApproval(
    sessionId: string,
    expectedVersion: number,
    approvalId: string,
    approved: boolean,
    response?: unknown,
  ): { session: RuntimeSession; approval: RuntimeApproval } {
    return this.#db.transaction(() => {
      const current = this.#sessionRow(sessionId);
      if (current === undefined || current.version !== expectedVersion) {
        throw new RuntimeVersionConflictError(sessionId, expectedVersion, current?.version ?? null);
      }
      if (current.status !== "waiting-approval") {
        throw new RuntimeInvalidTransitionError(current.status, "running");
      }
      const approval = this.#approvalRow(approvalId);
      if (approval === undefined || approval.session_id !== sessionId || approval.status !== "pending") {
        throw new Error(`pending approval not found: ${approvalId}`);
      }
      if (current.trace_enabled === 1 && this.#key === undefined) {
        throw new RuntimeContentLockedError();
      }
      const now = asIso(this.#now);
      let encrypted: EncryptedRecord | undefined;
      if (response !== undefined) {
        if (this.#key === undefined) throw new RuntimeContentLockedError();
        encrypted = encryptRecord(this.#key, encodeJson(response), approvalAad(approvalId, "response"));
      }
      this.#db.prepare(
        `UPDATE approvals SET status = ?, response_ciphertext = ?, response_nonce = ?,
           response_tag = ?, responded_at = ? WHERE id = ? AND status = 'pending'`,
      ).run(
        approved ? "approved" : "denied",
        encrypted?.ciphertext ?? null,
        encrypted?.nonce ?? null,
        encrypted?.tag ?? null,
        now,
        approvalId,
      );
      this.#appendEventTx(sessionId, {
        type: "approval.responded",
        metadata: { approvalId, approved },
        ...(response === undefined ? {} : { payload: response }),
        at: now,
      });
      this.#db.prepare(
        `UPDATE sessions SET status = 'running', version = version + 1,
           updated_at = ? WHERE id = ? AND version = ?`,
      ).run(now, sessionId, expectedVersion);
      return {
        session: sessionFromRow(
          this.#sessionRow(sessionId)!,
          this.#key !== undefined,
          this.projectDir,
          (value) => this.#decodeWorktreePath(value),
        ),
        approval: this.#approvalFromRow(this.#approvalRow(approvalId)!),
      };
    })();
  }

  /**
   * Responds to a child's approval while atomically resuming both the child
   * and its waiting parent. The caller supplies the addressed parent or
   * child's optimistic version; both rows are guarded again inside the same
   * SQLite transaction.
   */
  respondChildApproval(
    addressedSessionId: string,
    expectedAddressedVersion: number,
    approvalId: string,
    approved: boolean,
    response?: unknown,
    options: { resumeParent?: boolean } = {},
  ): { parent: RuntimeSession; child: RuntimeSession; approval: RuntimeApproval } {
    return this.#db.transaction(() => {
      const addressed = this.#sessionRow(addressedSessionId);
      if (addressed === undefined || addressed.version !== expectedAddressedVersion) {
        throw new RuntimeVersionConflictError(
          addressedSessionId,
          expectedAddressedVersion,
          addressed?.version ?? null,
        );
      }
      const approval = this.#approvalRow(approvalId);
      if (approval === undefined || approval.status !== "pending") {
        throw new Error(`pending approval not found: ${approvalId}`);
      }
      const child = this.#sessionRow(approval.session_id);
      const parent = child?.parent_session_id === null || child?.parent_session_id === undefined
        ? undefined
        : this.#sessionRow(child.parent_session_id);
      if (
        child === undefined ||
        parent === undefined ||
        (addressed.id !== child.id && addressed.id !== parent.id) ||
        child.status !== "waiting-approval"
      ) {
        throw new Error(`approval ${approvalId} is not owned by the addressed session tree`);
      }
      const resumeParent = options.resumeParent !== false;
      if (resumeParent && parent.status !== "waiting-approval") {
        throw new RuntimeInvalidTransitionError(parent.status, "running");
      }
      if (!resumeParent && ["completed", "failed", "cancelled"].includes(parent.status)) {
        throw new Error("cannot respond through a terminal parent session");
      }
      if (child.trace_enabled === 1 && this.#key === undefined) {
        throw new RuntimeContentLockedError();
      }

      const now = asIso(this.#now);
      let encrypted: EncryptedRecord | undefined;
      if (response !== undefined) {
        if (this.#key === undefined) throw new RuntimeContentLockedError();
        encrypted = encryptRecord(this.#key, encodeJson(response), approvalAad(approvalId, "response"));
      }
      const approvalUpdate = this.#db.prepare(
        `UPDATE approvals SET status = ?, response_ciphertext = ?, response_nonce = ?,
           response_tag = ?, responded_at = ? WHERE id = ? AND status = 'pending'`,
      ).run(
        approved ? "approved" : "denied",
        encrypted?.ciphertext ?? null,
        encrypted?.nonce ?? null,
        encrypted?.tag ?? null,
        now,
        approvalId,
      );
      if (approvalUpdate.changes !== 1) throw new Error(`pending approval not found: ${approvalId}`);
      this.#appendEventTx(child.id, {
        type: "approval.responded",
        metadata: { approvalId, approved },
        ...(response === undefined ? {} : { payload: response }),
        at: now,
      });
      const childUpdate = this.#db.prepare(
        `UPDATE sessions SET status = 'running', version = version + 1,
           updated_at = ? WHERE id = ? AND version = ? AND status = 'waiting-approval'`,
      ).run(now, child.id, child.version);
      const parentUpdate = resumeParent
        ? this.#db.prepare(
            `UPDATE sessions SET status = 'running', version = version + 1,
               updated_at = ? WHERE id = ? AND version = ? AND status = 'waiting-approval'`,
          ).run(now, parent.id, parent.version)
        : this.#db.prepare(
            `UPDATE sessions SET version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND status = ?`,
          ).run(now, parent.id, parent.version, parent.status);
      if (childUpdate.changes !== 1 || parentUpdate.changes !== 1) {
        throw new RuntimeVersionConflictError(
          childUpdate.changes !== 1 ? child.id : parent.id,
          childUpdate.changes !== 1 ? child.version : parent.version,
          this.#sessionRow(childUpdate.changes !== 1 ? child.id : parent.id)?.version ?? null,
        );
      }
      this.#appendEventTx(parent.id, {
        type: "approval.child-responded",
        metadata: { approvalId, childSessionId: child.id, approved },
        at: now,
      });
      return {
        parent: sessionFromRow(
          this.#sessionRow(parent.id)!,
          this.#key !== undefined,
          this.projectDir,
          (value) => this.#decodeWorktreePath(value),
        ),
        child: sessionFromRow(
          this.#sessionRow(child.id)!,
          this.#key !== undefined,
          this.projectDir,
          (value) => this.#decodeWorktreePath(value),
        ),
        approval: this.#approvalFromRow(this.#approvalRow(approvalId)!),
      };
    })();
  }

  getPendingApproval(sessionId: string): RuntimeApproval | null {
    const row = this.#db.prepare(
      "SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    ).get(sessionId) as ApprovalRow | undefined;
    return row === undefined ? null : this.#approvalFromRow(row);
  }

  getApproval(id: string): RuntimeApproval | null {
    const row = this.#approvalRow(id);
    return row === undefined ? null : this.#approvalFromRow(row);
  }

  /** Direct approval, or the first pending approval owned by a child. */
  getPendingApprovalInTree(sessionId: string): RuntimeApproval | null {
    const direct = this.getPendingApproval(sessionId);
    if (direct !== null) return direct;
    const row = this.#db.prepare(
      `SELECT a.* FROM approvals a
       JOIN children c ON c.child_session_id = a.session_id
       WHERE c.parent_session_id = ? AND a.status = 'pending'
       ORDER BY a.created_at, a.id LIMIT 1`,
    ).get(sessionId) as ApprovalRow | undefined;
    return row === undefined ? null : this.#approvalFromRow(row);
  }

  putArtifact(
    sessionId: string,
    type: string,
    plaintext: Buffer,
    options: PutArtifactOptions = {},
  ): RuntimeArtifact {
    this.requireSession(sessionId);
    if (this.#key === undefined) throw new RuntimeContentLockedError();
    if (plaintext.length > MAX_ARTIFACT_BYTES) {
      throw new RuntimeArtifactLimitError(MAX_ARTIFACT_BYTES);
    }
    if (plaintext.length > this.#remainingArtifactBytes(sessionId)) {
      throw new RuntimeArtifactLimitError(MAX_SESSION_ARTIFACT_BYTES);
    }
    const digest = createHash("sha256").update(plaintext).digest("hex");
    if (options.deduplicate !== false) {
      const existing = this.#db.prepare(
        `SELECT * FROM artifacts WHERE digest = ? AND type = ? AND retention_state = 'active'
         ORDER BY created_at LIMIT 1`,
      ).get(digest, type) as ArtifactRow | undefined;
      if (existing !== undefined && existsSync(this.#artifactFile(existing.encrypted_path))) {
        const id = randomUUID();
        const now = asIso(this.#now);
        this.#db.prepare(
          `INSERT INTO artifacts (
             id, session_id, type, digest, size, retention_state,
             encrypted_path, encryption_aad, nonce, tag, format_version, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          sessionId,
          type,
          digest,
          plaintext.length,
          existing.encrypted_path,
          existing.encryption_aad,
          existing.nonce,
          existing.tag,
          existing.format_version,
          now,
          options.expiresAt ?? null,
        );
        return artifactFromRow(this.#artifactRow(id)!);
      }
    }
    const writer = this.beginArtifact(sessionId, type, {
      maxBytes: Math.max(plaintext.length, 1),
      expiresAt: options.expiresAt,
    });
    writer.write(plaintext);
    return writer.finish();
  }

  beginArtifact(
    sessionId: string,
    type: string,
    options: { maxBytes: number; expiresAt?: string },
  ): RuntimeArtifactWriter {
    this.requireSession(sessionId);
    if (this.#key === undefined) throw new RuntimeContentLockedError();
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new Error("artifact maxBytes must be a positive integer");
    }
    const maxBytes = Math.min(
      options.maxBytes,
      MAX_ARTIFACT_BYTES,
      this.#remainingArtifactBytes(sessionId),
    );
    if (maxBytes < 1) throw new RuntimeArtifactLimitError(MAX_SESSION_ARTIFACT_BYTES);
    return new RuntimeArtifactWriter(this, {
      sessionId,
      type,
      maxBytes,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      key: this.#key,
    });
  }

  getArtifact(id: string): RuntimeArtifact | null {
    const row = this.#artifactRow(id);
    return row === undefined ? null : artifactFromRow(row);
  }

  readArtifact(id: string): Buffer {
    const row = this.#artifactRow(id);
    if (row === undefined || row.retention_state !== "active") {
      throw new Error(`runtime artifact not found: ${id}`);
    }
    if (this.#key === undefined) throw new RuntimeContentLockedError();
    const ciphertext = readFileSync(this.#artifactFile(row.encrypted_path));
    return decryptRecord(
      this.#key,
      { ciphertext, nonce: row.nonce, tag: row.tag },
      row.encryption_aad,
    );
  }

  readArtifactPage(
    id: string,
    options: { offset?: number; limit?: number; encoding?: "utf8" | "base64" } = {},
  ): ArtifactPage {
    const plaintext = this.readArtifact(id);
    const offset = Math.max(0, Math.min(plaintext.length, Math.trunc(options.offset ?? 0)));
    const limit = Math.max(1, Math.min(1024 * 1024, Math.trunc(options.limit ?? 64 * 1024)));
    const end = Math.min(plaintext.length, offset + limit);
    const encoding = options.encoding ?? "utf8";
    const page = plaintext.subarray(offset, end);
    return {
      artifactId: id,
      offset,
      ...(end < plaintext.length ? { nextOffset: end } : {}),
      totalBytes: plaintext.length,
      content: page.toString(encoding),
      encoding,
    };
  }

  putCheckpoint(input: {
    sessionId: string;
    baseSha: string;
    worktreeFingerprint: string;
    patch: Buffer;
  }): RuntimeCheckpoint {
    const compressed = gzipSync(input.patch, { level: 9 });
    const artifact = this.putArtifact(input.sessionId, "checkpoint-patch-gzip", compressed, {
      deduplicate: true,
    });
    return this.#db.transaction(() => {
      const row = this.#db.prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM checkpoints WHERE session_id = ?",
      ).get(input.sessionId) as { seq: number };
      const now = asIso(this.#now);
      this.#db.prepare(
        `INSERT INTO checkpoints (
           session_id, seq, base_sha, worktree_fingerprint, patch_artifact_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.sessionId,
        row.seq,
        input.baseSha,
        input.worktreeFingerprint,
        artifact.id,
        now,
      );
      this.#appendEventTx(input.sessionId, {
        type: "checkpoint.created",
        metadata: { checkpointSeq: row.seq, artifactId: artifact.id },
        at: now,
      });
      return checkpointFromRow(this.#checkpointRow(input.sessionId, row.seq)!);
    })();
  }

  latestCheckpoint(sessionId: string): RuntimeCheckpoint | null {
    const row = this.#db.prepare(
      "SELECT * FROM checkpoints WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
    ).get(sessionId) as CheckpointRow | undefined;
    return row === undefined ? null : checkpointFromRow(row);
  }

  listChildren(parentSessionId: string): RuntimeSession[] {
    const rows = this.#db.prepare(
      `SELECT s.* FROM sessions s JOIN children c ON c.child_session_id = s.id
       WHERE c.parent_session_id = ? ORDER BY c.created_at, s.id`,
    ).all(parentSessionId) as SessionRow[];
    return rows.map((row) =>
      sessionFromRow(row, this.#key !== undefined, this.projectDir, (value) => this.#decodeWorktreePath(value))
    );
  }

  getChildRelation(childSessionId: string): RuntimeChildRelation | null {
    const row = this.#db.prepare(
      "SELECT * FROM children WHERE child_session_id = ?",
    ).get(childSessionId) as {
      parent_session_id: string;
      child_session_id: string;
      parent_version_at_start: number;
      parent_checkpoint_seq: number | null;
      patch_import_state: ChildPatchImportState;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (row === undefined) return null;
    return {
      parentSessionId: row.parent_session_id,
      childSessionId: row.child_session_id,
      parentVersionAtStart: row.parent_version_at_start,
      ...(row.parent_checkpoint_seq === null ? {} : { parentCheckpointSeq: row.parent_checkpoint_seq }),
      patchImportState: row.patch_import_state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  updateChildImportState(
    childSessionId: string,
    state: ChildPatchImportState,
  ): RuntimeChildRelation {
    const result = this.#db.prepare(
      "UPDATE children SET patch_import_state = ?, updated_at = ? WHERE child_session_id = ?",
    ).run(state, asIso(this.#now), childSessionId);
    if (result.changes !== 1) throw new Error(`child relationship not found: ${childSessionId}`);
    return this.getChildRelation(childSessionId)!;
  }

  refreshChildStartPoints(
    parentSessionId: string,
    parentVersion: number,
    parentCheckpointSeq?: number,
  ): number {
    return this.#db.prepare(
      `UPDATE children SET parent_version_at_start = ?, parent_checkpoint_seq = ?, updated_at = ?
       WHERE parent_session_id = ? AND patch_import_state = 'not-requested'`,
    ).run(
      parentVersion,
      parentCheckpointSeq ?? null,
      asIso(this.#now),
      parentSessionId,
    ).changes;
  }

  registerExtension(input: {
    kind: RuntimeExtensionKind;
    id: string;
    fingerprint: string;
    config: Record<string, unknown>;
    diagnostics?: Array<{ code: string; message: string }>;
  }): RuntimeExtensionRegistration {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.id)) {
      throw new Error("extension id is invalid");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.fingerprint)) {
      throw new Error("extension fingerprint is invalid");
    }
    const configJson = assertSafeJson(input.config, "extension configuration");
    if (/"(?:api[_-]?key|password|secret|token|credential)"\s*:/i.test(configJson)) {
      throw new Error("extension configuration must contain credential references, not secret values");
    }
    const diagnostics = input.diagnostics ?? [];
    const diagnosticsJson = assertSafeJson({ diagnostics }, "extension diagnostics");
    const now = asIso(this.#now);
    const existing = this.#db.prepare(
      "SELECT created_at FROM extensions WHERE kind = ? AND id = ?",
    ).get(input.kind, input.id) as { created_at: string } | undefined;
    const approval = this.#db.prepare(
      "SELECT status FROM extension_approvals WHERE fingerprint = ?",
    ).get(input.fingerprint) as { status: "approved" | "revoked" } | undefined;
    this.#db.prepare(
      `INSERT INTO extensions (
         kind, id, fingerprint, config_json, diagnostics_json, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         config_json = excluded.config_json,
         diagnostics_json = excluded.diagnostics_json,
         enabled = CASE
           WHEN extensions.fingerprint = excluded.fingerprint THEN extensions.enabled
           ELSE 0
         END,
         updated_at = excluded.updated_at`,
    ).run(
      input.kind,
      input.id,
      input.fingerprint,
      configJson,
      diagnosticsJson,
      existing?.created_at ?? now,
      now,
    );
    const registered = this.getExtension(input.kind, input.id)!;
    return { ...registered, approvalStatus: approval?.status ?? "pending" };
  }

  approveExtension(
    kind: RuntimeExtensionKind,
    id: string,
    fingerprint: string,
    approved: boolean,
  ): RuntimeExtensionRegistration {
    const extension = this.getExtension(kind, id);
    if (extension === null || extension.fingerprint !== fingerprint) {
      throw new Error("extension fingerprint is stale");
    }
    const now = asIso(this.#now);
    this.#db.transaction(() => {
      this.#db.prepare(
        `INSERT INTO extension_approvals (fingerprint, kind, extension_id, status, responded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           status = excluded.status, responded_at = excluded.responded_at`,
      ).run(fingerprint, kind, id, approved ? "approved" : "revoked", now);
      if (!approved) {
        this.#db.prepare(
          "UPDATE extensions SET enabled = 0, updated_at = ? WHERE kind = ? AND id = ?",
        ).run(now, kind, id);
      }
    })();
    return this.getExtension(kind, id)!;
  }

  setExtensionEnabled(
    kind: RuntimeExtensionKind,
    id: string,
    fingerprint: string,
    enabled: boolean,
  ): RuntimeExtensionRegistration {
    const extension = this.getExtension(kind, id);
    if (extension === null || extension.fingerprint !== fingerprint) {
      throw new Error("extension fingerprint is stale");
    }
    if (enabled && extension.approvalStatus !== "approved") {
      throw new Error("extension fingerprint is not approved");
    }
    this.#db.prepare(
      "UPDATE extensions SET enabled = ?, updated_at = ? WHERE kind = ? AND id = ? AND fingerprint = ?",
    ).run(enabled ? 1 : 0, asIso(this.#now), kind, id, fingerprint);
    return this.getExtension(kind, id)!;
  }

  getExtension(kind: RuntimeExtensionKind, id: string): RuntimeExtensionRegistration | null {
    const row = this.#db.prepare(
      `SELECT e.*, a.status AS approval_status
       FROM extensions e LEFT JOIN extension_approvals a ON a.fingerprint = e.fingerprint
       WHERE e.kind = ? AND e.id = ?`,
    ).get(kind, id) as {
      kind: RuntimeExtensionKind;
      id: string;
      fingerprint: string;
      config_json: string;
      diagnostics_json: string;
      enabled: number;
      created_at: string;
      updated_at: string;
      approval_status: "approved" | "revoked" | null;
    } | undefined;
    if (row === undefined) return null;
    const parsedDiagnostics = parseObject(row.diagnostics_json).diagnostics;
    return {
      kind: row.kind,
      id: row.id,
      fingerprint: row.fingerprint,
      config: parseObject(row.config_json),
      diagnostics: Array.isArray(parsedDiagnostics)
        ? parsedDiagnostics.filter((entry): entry is { code: string; message: string } =>
            typeof entry === "object" && entry !== null &&
            typeof (entry as { code?: unknown }).code === "string" &&
            typeof (entry as { message?: unknown }).message === "string")
        : [],
      approvalStatus: row.approval_status ?? "pending",
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listExtensions(kind?: RuntimeExtensionKind): RuntimeExtensionRegistration[] {
    const rows = this.#db.prepare(
      kind === undefined
        ? "SELECT kind, id FROM extensions ORDER BY kind, id"
        : "SELECT kind, id FROM extensions WHERE kind = ? ORDER BY id",
    ).all(...(kind === undefined ? [] : [kind])) as Array<{ kind: RuntimeExtensionKind; id: string }>;
    return rows.map((row) => this.getExtension(row.kind, row.id)!);
  }

  approvedExtensionFingerprints(): Set<string> {
    const rows = this.#db.prepare(
      "SELECT fingerprint FROM extension_approvals WHERE status = 'approved'",
    ).all() as Array<{ fingerprint: string }>;
    return new Set(rows.map((row) => row.fingerprint));
  }

  recordProjection(relativePath: string, payload: Record<string, unknown>): void {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
      throw new Error("projection path must be relative to the project cache directory");
    }
    const json = assertSafeJson(payload, "projection payload");
    this.#db.prepare(
      "INSERT OR IGNORE INTO projections (path, payload_json) VALUES (?, ?)",
    ).run(relativePath, json);
  }

  rebuildProjections(): { files: number; records: number } {
    const rows = this.#db.prepare(
      "SELECT path, payload_json FROM projections ORDER BY path, id",
    ).all() as Array<{ path: string; payload_json: string }>;
    const grouped = new Map<string, string[]>();
    for (const row of rows) {
      const current = grouped.get(row.path) ?? [];
      current.push(row.payload_json);
      grouped.set(row.path, current);
    }
    const cacheDir = path.dirname(this.dbPath);
    for (const [relativePath, payloads] of grouped) {
      const target = path.join(cacheDir, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${randomUUID()}`;
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, `${payloads.join("\n")}\n`, undefined, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, target);
      fsyncDirectory(path.dirname(target));
    }
    return { files: grouped.size, records: rows.length };
  }

  collectOrphanedArtifactFiles(): { temporary: number; unreferenced: number } {
    const tmpDir = path.join(this.artifactRoot, ".tmp");
    mkdirSync(tmpDir, { recursive: true });
    let temporary = 0;
    for (const name of readdirSync(tmpDir)) {
      rmSync(path.join(tmpDir, name), { recursive: true, force: true });
      temporary += 1;
    }
    const referenced = new Set(
      (this.#db.prepare("SELECT DISTINCT encrypted_path FROM artifacts WHERE retention_state != 'deleted'").all() as Array<{ encrypted_path: string }>).map(
        (row) => this.#artifactFile(row.encrypted_path),
      ),
    );
    let unreferenced = 0;
    for (const name of readdirSync(this.artifactRoot)) {
      if (name === ".tmp") continue;
      const candidate = path.resolve(this.artifactRoot, name);
      if (!referenced.has(candidate)) {
        rmSync(candidate, { recursive: true, force: true });
        unreferenced += 1;
      }
    }
    return { temporary, unreferenced };
  }

  enforceRetention(): { expired: number; deletedBytes: number } {
    const config = this.getConfiguration();
    const now = asIso(this.#now);
    const candidates = this.#db.prepare(
      `SELECT a.* FROM artifacts a JOIN sessions s ON s.id = a.session_id
       WHERE a.retention_state = 'active'
         AND s.status IN ('completed','failed','cancelled')
       ORDER BY a.created_at`,
    ).all() as ArtifactRow[];
    let total = (this.#db.prepare(
      "SELECT COALESCE(SUM(size), 0) AS total FROM artifacts WHERE retention_state = 'active'",
    ).get() as { total: number }).total;
    let expired = 0;
    let deletedBytes = 0;
    for (const row of candidates) {
      const ageDeadline = new Date(row.created_at);
      ageDeadline.setUTCDate(ageDeadline.getUTCDate() + config.retentionDays);
      const overAge = (row.expires_at !== null && row.expires_at <= now) || ageDeadline.toISOString() <= now;
      const overBudget = total > config.retentionBytes;
      if (!overAge && !overBudget) continue;
      this.#db.prepare("UPDATE artifacts SET retention_state = 'expired' WHERE id = ?").run(row.id);
      const otherReference = this.#db.prepare(
        `SELECT 1 FROM artifacts WHERE encrypted_path = ? AND id != ?
         AND retention_state = 'active' LIMIT 1`,
      ).get(row.encrypted_path, row.id);
      if (otherReference === undefined) {
        rmSync(this.#artifactFile(row.encrypted_path), { force: true });
      }
      total -= row.size;
      expired += 1;
      deletedBytes += row.size;
    }
    return { expired, deletedBytes };
  }

  markInterruptedAfterStartup(): number {
    const rows = this.#db.prepare("SELECT * FROM sessions WHERE status = 'running'").all() as SessionRow[];
    let changed = 0;
    const update = this.#db.transaction((row: SessionRow) => {
      const incomplete = this.#db.prepare(
        `SELECT
           SUM(CASE WHEN type = 'tool.started' THEN 1 ELSE 0 END) AS starts,
           SUM(CASE WHEN type IN ('tool.finished','tool.failed') THEN 1 ELSE 0 END) AS terminals
         FROM events WHERE session_id = ?`,
      ).get(row.id) as { starts: number | null; terminals: number | null };
      const hasIncompleteTool = (incomplete.starts ?? 0) > (incomplete.terminals ?? 0);
      const contentPersisted = row.trace_enabled === 1;
      const status: SessionStatus = hasIncompleteTool ? "needs-recovery" : "interrupted";
      const now = asIso(this.#now);
      this.#db.prepare(
        "UPDATE sessions SET status = ?, version = version + 1, updated_at = ?, outcome = ? WHERE id = ?",
      ).run(
        status,
        now,
        contentPersisted ? "interrupted" : "interrupted-nonresumable",
        row.id,
      );
      this.#appendEventTx(row.id, {
        type: "session.interrupted",
        metadata: { incompleteSideEffect: hasIncompleteTool, resumable: contentPersisted },
        at: now,
      });
      if (!contentPersisted) this.#expireArtifactsForSession(row.id);
    });
    for (const row of rows) {
      update(row);
      changed += 1;
    }
    return changed;
  }

  /** Internal durable insertion used only after an artifact file is renamed. */
  _commitArtifact(row: ArtifactRow): RuntimeArtifact {
    if (row.size > MAX_ARTIFACT_BYTES || row.size > this.#remainingArtifactBytes(row.session_id)) {
      throw new RuntimeArtifactLimitError(
        row.size > MAX_ARTIFACT_BYTES ? MAX_ARTIFACT_BYTES : MAX_SESSION_ARTIFACT_BYTES,
      );
    }
    const storedPath = this.#artifactIdentifier(row.encrypted_path);
    this.#db.prepare(
      `INSERT INTO artifacts (
         id, session_id, type, digest, size, retention_state, encrypted_path,
         encryption_aad, nonce, tag, format_version, created_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.session_id,
      row.type,
      row.digest,
      row.size,
      row.retention_state,
      storedPath,
      row.encryption_aad,
      row.nonce,
      row.tag,
      row.format_version,
      row.created_at,
      row.expires_at,
    );
    return artifactFromRow(row);
  }

  _nowIso(): string {
    return asIso(this.#now);
  }

  #encodeWorktreePath(value: string | null): string | null {
    if (value === null) return null;
    const resolved = path.resolve(value);
    const absolute = existsSync(resolved) ? realpathSync(resolved) : resolved;
    if (this.#worktreeRoot === undefined) return absolute;
    const relative = path.relative(this.#worktreeRoot, absolute);
    if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("runtime worktree must be inside host application storage");
    }
    return `worktree:${relative.split(path.sep).join("/")}`;
  }

  #decodeWorktreePath(value: string): string {
    if (!value.startsWith("worktree:") || this.#worktreeRoot === undefined) return path.resolve(value);
    const relative = value.slice("worktree:".length);
    const absolute = path.resolve(this.#worktreeRoot, ...relative.split("/"));
    if (absolute !== this.#worktreeRoot && !absolute.startsWith(`${this.#worktreeRoot}${path.sep}`)) {
      throw new Error("runtime worktree identifier escapes application storage");
    }
    return absolute;
  }

  #remainingArtifactBytes(sessionId: string): number {
    const used = (this.#db.prepare(
      "SELECT COALESCE(SUM(size), 0) AS total FROM artifacts WHERE session_id = ? AND retention_state = 'active'",
    ).get(sessionId) as { total: number }).total;
    return Math.max(0, MAX_SESSION_ARTIFACT_BYTES - used);
  }

  #artifactIdentifier(value: string): string {
    if (value.startsWith("artifact:")) return value;
    const absolute = path.resolve(value);
    const relative = path.relative(this.artifactRoot, absolute);
    if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("runtime artifact must be inside the artifact store");
    }
    return `artifact:${relative.split(path.sep).join("/")}`;
  }

  #artifactFile(identifier: string): string {
    if (path.isAbsolute(identifier)) return path.resolve(identifier); // legacy reader
    if (!identifier.startsWith("artifact:")) throw new Error("invalid runtime artifact identifier");
    const relative = identifier.slice("artifact:".length);
    const absolute = path.resolve(this.artifactRoot, ...relative.split("/"));
    if (absolute !== this.artifactRoot && !absolute.startsWith(`${this.artifactRoot}${path.sep}`)) {
      throw new Error("runtime artifact identifier escapes the artifact store");
    }
    return absolute;
  }

  #expireArtifactsForSession(sessionId: string): void {
    const rows = this.#db.prepare(
      "SELECT * FROM artifacts WHERE session_id = ? AND retention_state = 'active'",
    ).all(sessionId) as ArtifactRow[];
    for (const row of rows) {
      this.#db.prepare("UPDATE artifacts SET retention_state = 'expired' WHERE id = ?").run(row.id);
      const otherReference = this.#db.prepare(
        `SELECT 1 FROM artifacts WHERE encrypted_path = ? AND id != ?
         AND retention_state = 'active' LIMIT 1`,
      ).get(row.encrypted_path, row.id);
      if (otherReference === undefined) rmSync(this.#artifactFile(row.encrypted_path), { force: true });
    }
  }

  #migrate(): void {
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         applied_at TEXT NOT NULL
       )`,
    );
    const current = (this.#db.prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    ).get() as { version: number }).version;
    if (current > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `runtime database schema ${current} is newer than supported ${LATEST_SCHEMA_VERSION}`,
      );
    }
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.#db.transaction(() => {
        this.#db.exec(migration.sql);
        this.#db.prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        ).run(migration.version, asIso(this.#now));
      })();
    }
  }

  #ensureDefaultConfiguration(): void {
    const insert = this.#db.prepare(
      "INSERT OR IGNORE INTO runtime_settings (key, value_json) VALUES (?, ?)",
    );
    this.#db.transaction(() => {
      for (const [key, value] of Object.entries(DEFAULT_RUNTIME_CONFIGURATION)) {
        insert.run(key, JSON.stringify(value));
      }
    })();
  }

  #runtimeKeyDigest(key: Buffer): string {
    return createHash("sha256").update("openfusion-runtime-key-v1\0").update(key).digest("hex");
  }

  #validateConfiguredKey(): void {
    if (this.#key === undefined) return;
    const row = this.#db.prepare(
      "SELECT value_json FROM runtime_settings WHERE key = 'runtimeKeyDigest'",
    ).get() as { value_json: string } | undefined;
    if (row === undefined) return;
    const expected: unknown = JSON.parse(row.value_json);
    if (typeof expected !== "string" || expected !== this.#runtimeKeyDigest(this.#key)) {
      this.#key = undefined;
    }
  }

  #sessionRow(id: string): SessionRow | undefined {
    return this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  #artifactRow(id: string): ArtifactRow | undefined {
    return this.#db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
  }

  #checkpointRow(sessionId: string, seq: number): CheckpointRow | undefined {
    return this.#db.prepare(
      "SELECT * FROM checkpoints WHERE session_id = ? AND seq = ?",
    ).get(sessionId, seq) as CheckpointRow | undefined;
  }

  #approvalRow(id: string): ApprovalRow | undefined {
    return this.#db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  }

  #approvalFromRow(row: ApprovalRow): RuntimeApproval {
    return {
      id: row.id,
      sessionId: row.session_id,
      eventSeq: row.event_seq,
      policySource: row.policy_source,
      status: row.status,
      scope: parseObject(row.scope_json),
      request: encryptedValue(
        this.#key,
        row.request_ciphertext,
        row.request_nonce,
        row.request_tag,
        approvalAad(row.id, "request"),
      ),
      response: encryptedValue(
        this.#key,
        row.response_ciphertext,
        row.response_nonce,
        row.response_tag,
        approvalAad(row.id, "response"),
      ),
      createdAt: row.created_at,
      ...(row.responded_at === null ? {} : { respondedAt: row.responded_at }),
    };
  }

  #appendEventTx(sessionId: string, input: AppendEventInput): RuntimeEvent {
    const session = this.#sessionRow(sessionId);
    if (session === undefined) throw new Error(`runtime session not found: ${sessionId}`);
    const next = this.#db.prepare(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?",
    ).get(sessionId) as { seq: number };
    const type = input.type.trim();
    if (type.length === 0 || type.length > 128) throw new Error("runtime event type is invalid");
    const metadata = input.metadata ?? {};
    const metadataJson = assertSafeJson(metadata, "runtime event metadata");
    const at = input.at ?? asIso(this.#now);
    let encrypted: EncryptedRecord | undefined;
    if (input.payload !== undefined && session.trace_enabled === 1) {
      if (this.#key === undefined) throw new RuntimeContentLockedError();
      encrypted = encryptRecord(
        this.#key,
        encodeJson(input.payload),
        eventAad(sessionId, next.seq, type),
      );
    }
    this.#db.prepare(
      `INSERT INTO events (
         session_id, seq, type, at, metadata_json, payload_ciphertext,
         payload_nonce, payload_tag, payload_version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      next.seq,
      type,
      at,
      metadataJson,
      encrypted?.ciphertext ?? null,
      encrypted?.nonce ?? null,
      encrypted?.tag ?? null,
      encrypted === undefined ? null : 1,
    );
    return {
      sessionId,
      seq: next.seq,
      type,
      at,
      metadata,
      payload: input.payload === undefined || session.trace_enabled === 0
        ? { state: "absent" }
        : { state: "available", value: input.payload },
    };
  }
}

interface ArtifactWriterOptions {
  sessionId: string;
  type: string;
  maxBytes: number;
  expiresAt?: string;
  key: Buffer;
}

/** Streaming AES-GCM artifact writer with a hard plaintext byte ceiling. */
export class RuntimeArtifactWriter {
  readonly id = randomUUID();
  readonly #store: RuntimeStore;
  readonly #options: ArtifactWriterOptions;
  readonly #nonce = randomBytes(ARTIFACT_NONCE_BYTES);
  readonly #cipher: CipherGCM;
  readonly #digest = createHash("sha256");
  readonly #tmpPath: string;
  readonly #finalPath: string;
  #fd: number;
  #bytes = 0;
  #limitReached = false;
  #finished = false;

  constructor(store: RuntimeStore, options: ArtifactWriterOptions) {
    this.#store = store;
    this.#options = options;
    this.#tmpPath = path.join(store.artifactRoot, ".tmp", `${this.id}.tmp`);
    this.#finalPath = path.join(store.artifactRoot, `${this.id}.bin`);
    this.#fd = openSync(this.#tmpPath, "wx", 0o600);
    this.#cipher = createCipheriv("aes-256-gcm", assertRuntimeKey(options.key), this.#nonce);
    this.#cipher.setAAD(Buffer.from(artifactAad({
      id: this.id,
      session_id: options.sessionId,
      type: options.type,
    }), "utf8"));
  }

  get bytesWritten(): number {
    return this.#bytes;
  }

  get limitReached(): boolean {
    return this.#limitReached;
  }

  write(chunk: Buffer | string): { acceptedBytes: number; limitReached: boolean } {
    if (this.#finished) throw new Error("artifact writer is already finished");
    const value = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const remaining = this.#options.maxBytes - this.#bytes;
    const accepted = value.subarray(0, Math.max(0, remaining));
    if (accepted.length > 0) {
      this.#digest.update(accepted);
      const ciphertext = this.#cipher.update(accepted);
      if (ciphertext.length > 0) writeSync(this.#fd, ciphertext);
      this.#bytes += accepted.length;
    }
    if (accepted.length < value.length) this.#limitReached = true;
    return { acceptedBytes: accepted.length, limitReached: this.#limitReached };
  }

  finish(): RuntimeArtifact {
    if (this.#finished) throw new Error("artifact writer is already finished");
    this.#finished = true;
    try {
      const final = this.#cipher.final();
      if (final.length > 0) writeSync(this.#fd, final);
      fsyncSync(this.#fd);
      closeSync(this.#fd);
      this.#fd = -1;
      renameSync(this.#tmpPath, this.#finalPath);
      fsyncDirectory(this.#store.artifactRoot);
      return this.#store._commitArtifact({
        id: this.id,
        session_id: this.#options.sessionId,
        type: this.#options.type,
        digest: this.#digest.digest("hex"),
        size: this.#bytes,
        retention_state: "active",
        encrypted_path: this.#finalPath,
        encryption_aad: artifactAad({
          id: this.id,
          session_id: this.#options.sessionId,
          type: this.#options.type,
        }),
        nonce: this.#nonce,
        tag: this.#cipher.getAuthTag(),
        format_version: ARTIFACT_FORMAT_VERSION,
        created_at: this.#store._nowIso(),
        expires_at: this.#options.expiresAt ?? null,
      });
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  abort(): void {
    if (this.#fd >= 0) {
      try {
        closeSync(this.#fd);
      } catch {
        // Best-effort cleanup after a failed write/fsync.
      }
      this.#fd = -1;
    }
    rmSync(this.#tmpPath, { force: true });
    if (this.#finished) rmSync(this.#finalPath, { force: true });
    this.#finished = true;
  }
}
