import { z } from "zod";
import type { FrontierSession } from "../engines/types.js";
import { RunCancelledError } from "../rpc/cancel-registry.js";

// promptForJson (M4 Task 3) is the sole way harnessgen elicits structured
// content from a frontier session: it converts the caller's zod schema to
// JSON Schema for adapters with native structured-output support, prefers a
// returned `structuredOutput`, and otherwise extracts a JSON candidate from
// accumulated `text` events. Either path is validated against the original
// zod schema and — on a schema mismatch — re-prompts the SAME session with
// the validation issues folded back in, giving the model one (by default) or
// more chances to self-correct before giving up. Built entirely against the
// FrontierSession contract (engines/types.ts) so it is fully testable with a
// scripted fake session — no real adapter, no network, no subprocess.

// Surfaced by callers (M4 Task 4's generation pipeline) as
// `harness.progress` notifications: "attempt" fires once per prompt sent
// (including the first), "validation-retry" fires when a validation failure
// is about to trigger a re-prompt, "validation-failure" records the exhausted
// final attempt, and "notice" mirrors a FrontierEvent `notice`
// (rate_limit/overloaded/api_error) encountered mid-turn.
export type DriverNotice = {
  kind: "attempt" | "validation-retry" | "validation-failure" | "notice";
  detail: string;
};

// Thrown by promptForJson once every attempt (1 + opts.retries) has been
// exhausted without producing schema-valid JSON. `issues` carries the LAST
// attempt's validation problems — either zod issues (path + message) or, if
// the response never even contained parseable JSON, a single synthetic
// issue describing the parse failure — so a caller/log line can render
// exactly what was wrong with the final try. `attempts` is the total number
// of prompts sent (always equal to 1 + opts.retries on the exhaustion path).
// `stage` is never set by promptForJson itself — it has no notion of "which
// pipeline stage this call belongs to" — but a caller can pass `opts.stage`
// to have it stamped onto the error at construction time, so the M4 Task 4
// pipeline can report `data: { stage, issues }` without a second catch-and-
// reassign step.
export class HarnessGenError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly issues: unknown[] = [],
    readonly stage?: string,
  ) {
    super(message);
    this.name = "HarnessGenError";
  }
}

export interface PromptForJsonOpts {
  // Number of RE-prompts allowed after the first attempt fails validation —
  // i.e. total attempts made is `1 + retries`. Defaults to 1 (one retry,
  // two attempts total), matching the brief.
  retries?: number;
  notify?: (notice: DriverNotice) => void;
  /** Called immediately before each real prompt attempt, including retries. */
  beforePrompt?: () => void;
  /** Receives one complete-or-null price observation for each prompt attempt. */
  onAttemptCost?: (costUsd: number | null) => void;
  // Stamped onto HarnessGenError.stage if exhaustion is reached — see the
  // class comment above. promptForJson never inspects or derives this
  // itself.
  stage?: string;
  // Per-ATTEMPT deadline, threaded verbatim into
  // `session.prompt(currentPrompt, { timeoutMs })` on EACH attempt (M5b
  // Task 4) — NOT a whole-call budget: a fresh attempt (including any
  // validation-feedback retry) gets its own full `timeoutMs`, so the total
  // worst case across every attempt is `(1 + retries) * timeoutMs`. This is
  // deliberately simple (no cross-attempt budget tracking) — acceptable
  // because the attempt COUNT is already bounded by `retries`, and matches
  // the M5b Task 4 brief's explicit call: per-attempt semantics are simplest
  // and sufficient here. Undefined forwards `timeoutMs: undefined` to
  // session.prompt, which remains a harmless no-op for callers that do not
  // need a deadline. Harness generation supplies 600,000 ms explicitly.
  timeoutMs?: number;
  // M7b Task 2: this run's own cancellation signal — checked/threaded
  // per-ATTEMPT (see the loop below), matching timeoutMs's own per-attempt
  // semantics: a cancellation is checked before each attempt starts, listens
  // for `abort` during that attempt only (the listener is removed once the
  // attempt's own for-await loop settles), and is checked again in that
  // attempt's catch AND right after its loop ends normally. A cancelled
  // attempt throws RunCancelledError immediately — it is NEVER treated as
  // "produced malformed JSON, retry with validation feedback"; the
  // validation-retry path below is unreachable once this fires.
  //
  // IMPORTANT -- pair this with `timeoutMs`: this signal only reaches the
  // real Claude adapter (engines/claude.ts) as a call to `handle.abort()`,
  // which is just `abortController.abort()` -- a COOPERATIVE signal the
  // underlying SDK query/subprocess is expected to notice and unwind from
  // on its own. The adapter only force-kills the subprocess (`q.close()`)
  // from the combined-signal handler it builds around
  // `AbortSignal.timeout(opts.timeoutMs)`, and that handler is wired up
  // ONLY `if (opts?.timeoutMs !== undefined)`. So an `abortSignal` passed
  // here WITHOUT a `timeoutMs` degrades to a best-effort cooperative abort
  // that a genuinely wedged subprocess can simply ignore forever -- no
  // forced kill will ever fire. Any caller using `abortSignal` for
  // prompt-level cancellation MUST also pass `timeoutMs` to get the actual
  // kill guarantee.
  abortSignal?: AbortSignal;
}

// A validation problem in a schema/path/message shape uniform enough to
// cover both real zod issues (schema mismatch) and the synthetic
// single-issue case (response wasn't valid JSON at all) — so downstream
// formatting code (formatIssues) doesn't need to branch on which kind it's
// looking at.
interface Issue {
  path: PropertyKey[];
  message: string;
}

// Extracts the LAST ```json ... ``` fenced block in `text` (case-insensitive
// on the "json" tag; tolerant of a missing newline right after the fence
// marker). Models frequently wrap a JSON answer in explanatory prose and/or
// emit more than one fenced block while "thinking out loud" — the LAST one
// is taken as the actual answer, matching the brief. Returns null (not the
// original text) when no fence is present at all, so the caller can fall
// back to a whole-text JSON.parse attempt instead of trying to parse prose.
// The json tag must sit at a line boundary (followed by \r?\n or end-of-string)
// to prevent partial matches like ```json5 or ```jsonc.
function extractLastJsonFence(text: string): string | null {
  const fenceRe = /```json(?:\r?\n|$)([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fenceRe.exec(text)) !== null) {
    last = (match[1] ?? "").trim();
  }
  return last;
}

// The JSON text this attempt will try to parse: the last fenced block if
// one exists, else the accumulated text verbatim (trimmed) — the whole-text
// fallback for a model that answered with bare JSON and no fence at all.
function extractJsonCandidate(text: string): string {
  return extractLastJsonFence(text) ?? text.trim();
}

type ParseAttempt<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

function parseJsonCandidate<S extends z.ZodType>(text: string, schema: S): ParseAttempt<z.infer<S>> {
  const candidate = extractJsonCandidate(text);
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      issues: [
        {
          path: [],
          message: `response did not contain valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  return validateValue(json, schema);
}

function validateValue<S extends z.ZodType>(value: unknown, schema: S): ParseAttempt<z.infer<S>> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
  };
}

function formatIssues(issues: Issue[]): string {
  return issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("\n");
}

// Re-prompt text sent back to the SAME session after a validation failure.
// Deliberately includes the raw issue messages verbatim (not a paraphrase)
// so the model sees exactly what zod rejected, and ends with the brief's
// exact required sentence so a corrected reply stays parseable by the same
// fence-then-fallback extraction this driver uses on every attempt.
function buildRetryPrompt(issues: Issue[]): string {
  return [
    "Your previous response failed JSON validation with the following issues:",
    formatIssues(issues),
    "Respond with ONLY a corrected JSON code block.",
  ].join("\n\n");
}

// Null-safe cost accumulation across attempts/result-events: costUsd is
// estimate-class and can be null for a given turn (M3 inherit #3 — e.g. a
// timeout-aborted turn is unmetered). Null contributes nothing; if every
// attempt saw null the total stays null; the moment any attempt reports a
// number, the running total becomes (and stays) a number.
function addCost(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}

// Prompts `session` for JSON matching `schema`, retrying with validation
// feedback on failure. Uses ONLY the FrontierSession contract (prompt/
// events/abort) — no engine, adapter, or filesystem dependency — so it's
// fully testable with a scripted fake session.
//
// Per attempt: sends the current prompt text to the SAME session, collects
// every `text` event's content (concatenated, in order) as the portable
// fallback answer, captures native structured output from a `result` event
// when available, aggregates costUsd (see addCost), and forwards `notice`
// events to opts.notify as DriverNotice `{ kind: "notice" }`. A
// `type: "error"` event is treated as an unrecoverable session-level failure
// (not a validation problem to retry past) and rethrown immediately as a
// plain Error — an adapter/session-level failure, not a JSON-shape issue,
// so validation-feedback retry does not apply to it.
//
// Once the turn ends, structured output is zod-validated directly when it
// exists; otherwise accumulated text is parsed (fenced-JSON, else whole-text
// fallback) and zod-validated. No malformed JSON repair is attempted. On
// success, returns immediately.
// On failure with attempts remaining, notifies "validation-retry" and
// re-prompts with buildRetryPrompt's issue-feedback text. On failure with no
// attempts remaining, throws HarnessGenError carrying the total attempt
// count and the LAST attempt's issues.
export async function promptForJson<S extends z.ZodType>(
  session: FrontierSession,
  prompt: string,
  schema: S,
  opts: PromptForJsonOpts = {},
): Promise<{
  value: z.infer<S>;
  attempts: number;
  costUsd: number | null;
  pricedCalls: number;
  unpricedCalls: number;
}> {
  const maxAttempts = 1 + (opts.retries ?? 1);
  const notify = opts.notify ?? ((): void => {});
  const outputSchema = z.toJSONSchema(schema) as Record<string, unknown>;

  let currentPrompt = prompt;
  let costUsd: number | null = null;
  let pricedCalls = 0;
  let unpricedCalls = 0;
  let lastIssues: Issue[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (opts.abortSignal?.aborted) throw new RunCancelledError();
    opts.beforePrompt?.();
    notify({ kind: "attempt", detail: `prompt attempt ${attempt}/${maxAttempts}` });

    const handle = session.prompt(currentPrompt, { timeoutMs: opts.timeoutMs, outputSchema });
    const onCancel = (): void => handle.abort();
    opts.abortSignal?.addEventListener("abort", onCancel, { once: true });
    let text = "";
    let structuredOutput: unknown;
    let hasStructuredOutput = false;
    let attemptSawResult = false;
    let attemptUnpriced = false;
    let attemptKnownUsd = 0;
    try {
      for await (const event of handle.events) {
        switch (event.type) {
          case "text":
            text += event.text;
            break;
          case "result":
            attemptSawResult = true;
            costUsd = addCost(costUsd, event.costUsd);
            if (event.costUsd === null) attemptUnpriced = true;
            else attemptKnownUsd += event.costUsd;
            if ("structuredOutput" in event) {
              structuredOutput = event.structuredOutput;
              hasStructuredOutput = true;
            }
            break;
          case "notice":
            notify({ kind: "notice", detail: event.message });
            break;
          case "error":
            throw new Error(`frontier session error: ${event.message}`);
          case "tool_use":
            break;
        }
      }
    } catch (err) {
      handle.abort();
      if (opts.abortSignal?.aborted) throw new RunCancelledError();
      throw err;
    } finally {
      opts.abortSignal?.removeEventListener("abort", onCancel);
      const attemptCost = attemptSawResult && !attemptUnpriced ? attemptKnownUsd : null;
      if (attemptCost === null) unpricedCalls += 1;
      else pricedCalls += 1;
      opts.onAttemptCost?.(attemptCost);
    }
    // Checked right after this attempt's loop ends NORMALLY, before ever
    // falling through into JSON-parse/validation-retry logic — a
    // cancellation that happened to land exactly as the turn's own events
    // finished must never be scored as "produced malformed JSON, retry".
    if (opts.abortSignal?.aborted) throw new RunCancelledError();

    const attemptResult = hasStructuredOutput
      ? validateValue(structuredOutput, schema)
      : parseJsonCandidate(text, schema);
    if (attemptResult.ok) {
      return {
        value: attemptResult.value,
        attempts: attempt,
        costUsd,
        pricedCalls,
        unpricedCalls,
      };
    }

    lastIssues = attemptResult.issues;
    if (attempt < maxAttempts) {
      notify({
        kind: "validation-retry",
        detail: `validation failed on attempt ${attempt}/${maxAttempts}: ${formatIssues(lastIssues)}`,
      });
      currentPrompt = buildRetryPrompt(lastIssues);
    }
  }

  notify({
    kind: "validation-failure",
    detail: `validation failed on final attempt ${maxAttempts}/${maxAttempts}: ${formatIssues(lastIssues)}`,
  });

  throw new HarnessGenError(
    `promptForJson: exhausted ${maxAttempts} attempt(s) without producing schema-valid JSON`,
    maxAttempts,
    lastIssues,
    opts.stage,
  );
}
