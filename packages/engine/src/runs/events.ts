// Metadata-only per-run event stream. This is deliberately separate from
// runs.jsonl: the ledger is a compact history index, while this stream keeps
// ordered diagnostic events without task text, arguments, paths, prompts,
// diffs, source, stdout, stderr, or test output.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureGitignoreGuard } from "../util/gitignore-guard.js";

const SafeRunIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const ToolErrorKindSchema = z.enum([
  "not_found",
  "not_unique",
  "containment",
  "invalid_args",
  "io",
  "timeout",
  "output_limit",
  "policy_denied",
  "aborted",
  "unknown",
]);

const RunEventPayloadSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("run.started"),
      kind: z.enum(["worker", "orchestrate", "evals", "generate", "card", "experiment"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("run.finished"),
      outcome: z.enum(["succeeded", "failed", "error"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("run.cancelled"),
      reason: z.enum(["user", "timeout", "shutdown", "unknown"]),
    })
    .strict(),
  z.object({
    type: z.literal("context.selected"),
    variant: z.enum(["none", "card", "wiki", "card+wiki"]),
    wikiAttached: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("context.compacted"),
    removedTokens: z.number().int().min(0),
    preservedTokens: z.number().int().min(0),
  }).strict(),
  z.object({
    type: z.literal("route.selected"),
    routeId: z.string().min(1).max(128),
    agent: z.string().min(1).max(128),
    family: z.string().min(1).max(128).optional(),
    dialectPack: z.string().min(1).max(128).optional(),
  }).strict(),
  z.object({ type: z.literal("tool.started"), tool: z.string().min(1).max(128) }).strict(),
  z.object({
    type: z.literal("tool.finished"),
    tool: z.string().min(1).max(128),
    durationMs: z.number().int().min(0),
    resultBytes: z.number().int().min(0),
    truncated: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("tool.failed"),
    tool: z.string().min(1).max(128),
    durationMs: z.number().int().min(0),
    resultBytes: z.number().int().min(0),
    truncated: z.boolean(),
    errorKind: ToolErrorKindSchema,
  }).strict(),
  z.object({ type: z.literal("attempt.started"), attempt: z.number().int().min(1) }).strict(),
  z.object({
    type: z.literal("attempt.finished"),
    attempt: z.number().int().min(1),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
  }).strict(),
  z.object({
    type: z.literal("review.finished"),
    decision: z.enum(["approve", "request-changes", "error"]),
    reasonCount: z.number().int().min(0),
  }).strict(),
  z.object({
    type: z.literal("verifier.finished"),
    outcome: z.enum(["passed", "failed", "measurement-failure", "policy-violation"]),
  }).strict(),
]);
export type RunEventPayload = z.infer<typeof RunEventPayloadSchema>;

const RunEventBaseSchema = z.object({
  v: z.literal(1),
  runId: SafeRunIdSchema,
  seq: z.number().int().min(1),
  at: z.iso.datetime(),
  elapsedMs: z.number().int().min(0),
});

const BASE_EVENT_KEYS = ["v", "runId", "seq", "at", "elapsedMs", "type"] as const;
const EVENT_PAYLOAD_KEYS: Record<RunEventPayload["type"], readonly string[]> = {
  "run.started": ["kind"],
  "run.finished": ["outcome"],
  "run.cancelled": ["reason"],
  "context.selected": ["variant", "wikiAttached"],
  "context.compacted": ["removedTokens", "preservedTokens"],
  "route.selected": ["routeId", "agent", "family", "dialectPack"],
  "tool.started": ["tool"],
  "tool.finished": ["tool", "durationMs", "resultBytes", "truncated"],
  "tool.failed": ["tool", "durationMs", "resultBytes", "truncated", "errorKind"],
  "attempt.started": ["attempt"],
  "attempt.finished": ["attempt", "outcome"],
  "review.finished": ["decision", "reasonCount"],
  "verifier.finished": ["outcome"],
};

const RunEventKeyGuardSchema = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  const type = input.type;
  if (typeof type !== "string" || !(type in EVENT_PAYLOAD_KEYS)) return;
  const allowed = new Set([
    ...BASE_EVENT_KEYS,
    ...EVENT_PAYLOAD_KEYS[type as RunEventPayload["type"]],
  ]);
  const unknownKeys = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    ctx.addIssue({
      code: "custom",
      message: `event contains forbidden fields: ${unknownKeys.join(", ")}`,
    });
  }
});

export const RunEventSchema = RunEventKeyGuardSchema.pipe(
  z.intersection(RunEventBaseSchema, RunEventPayloadSchema),
);
export type RunEvent = z.infer<typeof RunEventSchema>;

export function runEventsPath(projectDir: string, runId: string): string {
  const safeRunId = SafeRunIdSchema.parse(runId);
  return path.join(
    path.resolve(projectDir),
    ".openfusion",
    "cache",
    "runs",
    safeRunId,
    "events.jsonl",
  );
}

export function appendRunEvent(projectDir: string, event: RunEvent): void {
  const parsed = RunEventSchema.parse(event);
  const filePath = runEventsPath(projectDir, parsed.runId);
  const openfusionDir = path.join(path.resolve(projectDir), ".openfusion");
  ensureGitignoreGuard(openfusionDir, ["cache/"]);
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
}

export function readRunEvents(
  projectDir: string,
  runId: string,
): { events: RunEvent[]; skipped: number } {
  const filePath = runEventsPath(projectDir, runId);
  if (!existsSync(filePath)) return { events: [], skipped: 0 };

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { events: [], skipped: 0 };
  }

  const events: RunEvent[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = RunEventSchema.safeParse(JSON.parse(line));
      if (!parsed.success || parsed.data.runId !== runId) {
        skipped += 1;
        continue;
      }
      events.push(parsed.data);
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}

export interface RunEventRecorderOptions {
  now?: () => number;
}

/**
 * Observer-only event recorder. The first validation or write error disables
 * the recorder and emits one bounded log line; it never fails the real run.
 */
export class RunEventRecorder {
  readonly #projectDir: string;
  readonly #runId: string;
  readonly #log: (message: string) => void;
  readonly #now: () => number;
  readonly #startedAt: number;
  #seq: number;
  #disabled = false;

  constructor(
    engine: { log: (message: string) => void },
    projectDir: string,
    runId: string,
    options: RunEventRecorderOptions = {},
  ) {
    this.#projectDir = projectDir;
    this.#runId = runId;
    this.#log = engine.log;
    this.#now = options.now ?? Date.now;
    const now = this.#now();
    let startedAt = now;
    try {
      const existing = readRunEvents(projectDir, runId).events;
      this.#seq = existing.reduce((max, event) => Math.max(max, event.seq), 0);
      const first = existing.reduce<RunEvent | undefined>(
        (earliest, event) =>
          earliest === undefined || event.seq < earliest.seq ? event : earliest,
        undefined,
      );
      if (first !== undefined) {
        const inferredStart = Date.parse(first.at) - first.elapsedMs;
        if (Number.isFinite(inferredStart)) startedAt = inferredStart;
      }
    } catch {
      this.#seq = 0;
      this.#disable();
    }
    this.#startedAt = startedAt;
  }

  record(payload: RunEventPayload): RunEvent | undefined {
    if (this.#disabled) return undefined;
    try {
      const now = this.#now();
      const parsedPayload = RunEventPayloadSchema.parse(payload);
      const event = RunEventSchema.parse({
        ...parsedPayload,
        v: 1,
        runId: this.#runId,
        seq: this.#seq + 1,
        at: new Date(now).toISOString(),
        elapsedMs: Math.max(0, Math.round(now - this.#startedAt)),
      });
      appendRunEvent(this.#projectDir, event);
      this.#seq = event.seq;
      return event;
    } catch {
      this.#disable();
      return undefined;
    }
  }

  #disable(): void {
    if (this.#disabled) return;
    this.#disabled = true;
    try {
      this.#log("run-events: recorder disabled after observer failure");
    } catch {
      // A diagnostic sink is observation too; it cannot become load-bearing.
    }
  }
}
