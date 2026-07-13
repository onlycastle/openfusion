export const SESSION_STATUSES = [
  "created",
  "running",
  "waiting-approval",
  "interrupted",
  "needs-recovery",
  "completed",
  "failed",
  "cancelled",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_KINDS = [
  "orchestrate",
  "worker",
  "child",
  "review",
  "escalation",
] as const;

export type SessionKind = (typeof SESSION_KINDS)[number];

export type ResumeCapability = "exact" | "worktree-only" | "locked";

/**
 * Public, metadata-only representation of a durable runtime session. Task
 * text, prompts, model messages, diffs, and tool output never appear here.
 */
export interface RuntimeSession {
  id: string;
  runId: string;
  parentSessionId?: string;
  kind: SessionKind;
  status: SessionStatus;
  version: number;
  resumeCapability: ResumeCapability;
  projectDir: string;
  worktreePath?: string;
  baseSha?: string;
  modelFingerprint?: string;
  configurationFingerprint?: string;
  budgetSteps?: number;
  budgetDeadlineAt?: string;
  usedSteps: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  outcome?: string;
}

export type LockedValue<T> =
  | { state: "absent" }
  | { state: "locked" }
  | { state: "available"; value: T };

export interface RuntimeEvent<T = unknown> {
  sessionId: string;
  seq: number;
  type: string;
  at: string;
  metadata: Record<string, unknown>;
  payload: LockedValue<T>;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "cancelled";

export interface RuntimeApproval<TRequest = unknown, TResponse = unknown> {
  id: string;
  sessionId: string;
  eventSeq: number;
  policySource: string;
  status: ApprovalStatus;
  scope: Record<string, unknown>;
  request: LockedValue<TRequest>;
  response: LockedValue<TResponse>;
  createdAt: string;
  respondedAt?: string;
}

export type ArtifactRetentionState = "active" | "expired" | "deleted";

export interface RuntimeArtifact {
  id: string;
  sessionId: string;
  type: string;
  size: number;
  retentionState: ArtifactRetentionState;
  createdAt: string;
  expiresAt?: string;
}

export interface RuntimeCheckpoint {
  sessionId: string;
  seq: number;
  baseSha: string;
  worktreeFingerprint: string;
  patchArtifactId: string;
  createdAt: string;
}

export interface RuntimeConfiguration {
  traceEnabled: boolean;
  retentionDays: number;
  retentionBytes: number;
  sandboxGrants: string[];
  enabledExtensions: string[];
  childrenEnabled: boolean;
}

export const DEFAULT_RUNTIME_CONFIGURATION: RuntimeConfiguration = {
  traceEnabled: false,
  retentionDays: 7,
  retentionBytes: 2 * 1024 * 1024 * 1024,
  sandboxGrants: [],
  enabledExtensions: [],
  childrenEnabled: false,
};

/** Safe notification shape. Content-bearing fields are intentionally absent. */
export interface SessionChangedNotification {
  projectDir: string;
  sessionId: string;
  runId: string;
  kind: SessionKind;
  status: SessionStatus;
  version: number;
  resumeCapability: ResumeCapability;
  updatedAt: string;
  outcome?: string;
}

export function toSessionChangedNotification(
  session: RuntimeSession,
): SessionChangedNotification {
  return {
    projectDir: session.projectDir,
    sessionId: session.id,
    runId: session.runId,
    kind: session.kind,
    status: session.status,
    version: session.version,
    resumeCapability: session.resumeCapability,
    updatedAt: session.updatedAt,
    ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
  };
}
