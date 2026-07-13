// The frontier review gate (M5b Task 3): the quality backstop the
// cost-at-held-quality thesis depends on. A worker (cheaper model) produces
// a diff; before that diff is accepted, the frontier reviews it against the
// original task and the worker's own summary, and returns a structured
// verdict — approve, or request-changes with reasons. Built entirely
// against the M4 promptForJson driver and the FrontierSession contract
// (engines/types.ts), so it is fully testable with a scripted fake session
// — no real adapter, no network, no subprocess.
import { z } from "zod";
import type { FrontierSession } from "../engines/types.js";
import { promptForJson } from "../harness/driver.js";
import { buildReviewPrompt } from "./review-policy.js";

export const ReviewVerdictSchema = z.object({
  decision: z.enum(["approve", "request-changes"]),
  reasons: z.array(z.string()),
  severity: z.enum(["none", "minor", "major"]),
}).refine(
  (verdict) => verdict.decision !== "request-changes" || verdict.reasons.length > 0,
  { message: "request-changes requires at least one reason" },
);

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export interface ReviewDiffInput {
  task: string;
  diff: string;
  summary: string;
  verifierEvidence?: string;
}

export interface ReviewDiffOpts {
  /** Reserve the owning run budget once for every prompt/retry attempt. */
  beforePrompt?: () => void;
  /** Observe truthful per-attempt pricing, including missing prices. */
  onAttemptCost?: (costUsd: number | null) => void;
  // Per-attempt deadline for the review turn — threaded straight through to
  // promptForJson's own opts.timeoutMs (src/harness/driver.ts), which passes
  // it to session.prompt(text, { timeoutMs }) on EACH attempt. See that
  // module's own doc comment for why this is a PER-ATTEMPT bound (not a
  // whole-call one): a validation-feedback retry gets its own fresh
  // deadline, so total worst case is `(1 + retries) * timeoutMs`. Wired by
  // M5b Task 4's orchestrator, which owns overall run deadlines and is the
  // first caller to actually pass a value here.
  timeoutMs?: number;
  // M7b Task 2: this run's own cancellation signal (orchestrate.ts's
  // cancelSignal, a READ-ONLY get() off engine.cancelRegistry) — forwarded
  // verbatim to promptForJson's own opts.abortSignal, which applies it
  // per-attempt (see driver.ts's own doc comment). Absent -> undefined ->
  // every downstream `abortSignal?.` check is a no-op, so an un-cancellable
  // review call behaves exactly as before this task.
  //
  // IMPORTANT -- pair this with `timeoutMs` (this opts type's own field
  // above): per driver.ts's PromptForJsonOpts.abortSignal doc comment, the
  // forced-subprocess-kill-on-abort guarantee only holds when a timeoutMs
  // is ALSO armed -- the real Claude adapter (engines/claude.ts) only wires
  // an abort into its combined, force-killing signal when a timeout is
  // set; an abortSignal without a timeoutMs degrades to a cooperative
  // abort a wedged subprocess could simply ignore. Any caller passing
  // abortSignal here for review-call cancellation MUST also pass
  // timeoutMs to get an actual kill guarantee, not just a polite request.
  abortSignal?: AbortSignal;
}

// reviewDiff deliberately does NOT special-case an empty diff. Reviewing an
// empty diff (the worker made no change at all) is a perfectly valid call —
// the frontier will generally come back with request-changes — it's just a
// WASTEFUL one, since it burns a frontier prompt confirming something the
// caller already knows. The CALLER (M5b Task 4's orchestrator) is expected
// to treat an empty worker diff as an automatic failure BEFORE ever calling
// reviewDiff, so this function stays a pure "hand the frontier a diff, get
// back a verdict" primitive with no such policy embedded in it.
//
// The session passed in is expected to be READ-ONLY: the caller starts it
// without a toolPolicy (see FrontierAdapter.createSession in
// engines/types.ts), so the reviewer can read the workspace but cannot edit
// it — reviewing is strictly an observe-and-judge operation.
export async function reviewDiff(
  session: FrontierSession,
  input: ReviewDiffInput,
  opts: ReviewDiffOpts = {},
): Promise<{ verdict: ReviewVerdict; costUsd: number | null; unpricedCalls: number }> {
  const prompt = buildReviewPrompt(input);
  const result = await promptForJson(session, prompt, ReviewVerdictSchema, {
    stage: "review",
    timeoutMs: opts.timeoutMs,
    abortSignal: opts.abortSignal,
    beforePrompt: opts.beforePrompt,
    onAttemptCost: opts.onAttemptCost,
  });
  return {
    verdict: result.value,
    costUsd: result.costUsd,
    unpricedCalls: result.unpricedCalls,
  };
}
