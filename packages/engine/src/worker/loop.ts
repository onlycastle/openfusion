// Open-model worker tool loop owned by OpenFusion. Each AI SDK generateText
// invocation is deliberately capped at ONE response-message batch; the
// completed batch can then be durably persisted before this module decides
// whether to continue. `model` and
// `tools` are dependency-injected (see WorkerRunInput) so this module never
// picks a provider or a toolset itself -- CI drives it with
// MockLanguageModelV4 (see test/worker-loop.test.ts); WorkerService (M5a
// Task 5) wires a real provider model + createWorkerTools.
//
// Verified against installed ai@7.0.11 (docs/research/2026-07-04-m5-api-
// verification.md): loop control is `stopWhen: isStepCount(n)` -- NOT
// `maxSteps`, which does not exist on v7's generateText. generateText
// DEFAULTS `stopWhen` to `isStepCount(1)`, so a tool loop with no explicit
// `stopWhen` would silently stop after one step -- `runWorkerLoop` always
// passes one explicitly. `result.usage` is CUMULATIVE across every step in
// v7 (summed, not final-step-only), which is what gets metered here via
// the same `normalizeUsage` the frontier-model path uses.
import {
  generateText,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  type Tool,
  type ToolApprovalConfiguration,
} from "ai";
import { normalizeUsage, type NormalizedUsage } from "../models/pricing.js";
import { compactModelHistory, type CompactedHistory } from "../runtime/context.js";

export interface WorkerRunInput {
  model: LanguageModel;
  task: string;
  wikiDigest?: string;
  tools: Record<string, Tool>;
  maxSteps?: number;
  // Dialect-pack system/instruction block (Phase 1). When omitted, falls
  // back to the historical WORKER_INSTRUCTIONS constant so unit tests that
  // inject tools directly keep working.
  instructions?: string;
  // Forwarded straight through to generateText's own `abortSignal` (see the
  // call below). The caller (engine.worker.run, worker/methods.ts) owns
  // building this -- a combined timeoutMs deadline + a per-run
  // AbortController it can fire on engine.close() -- runWorkerLoop itself
  // stays deadline-agnostic and just plumbs whatever signal it's given.
  abortSignal?: AbortSignal;
  /** Central provider admission/cancellation wrapper for each model batch. */
  executeModelCall?: <T>(operation: (signal: AbortSignal | undefined) => Promise<T>) => Promise<T>;
  onStep?: (s: { step: number; toolCalls: number; text?: string }) => void;
  onModelStart?: (s: { step: number }) => Promise<void> | void;
  beforeModelMessages?: () => Promise<ModelMessage[]> | ModelMessage[];
  /** Existing authoritative history when resuming an exact trace. */
  messages?: ModelMessage[];
  /** A response to the pending approval at the end of `messages`. */
  approvalResponse?: {
    approvalId: string;
    approved: boolean;
    reason?: string;
  };
  /** AI SDK v7 approval policy, normally derived from PolicyEvaluator. */
  toolApproval?: ToolApprovalConfiguration<Record<string, Tool>, Record<string, unknown>>;
  /** Model-family context limit used by the 70% derived-view compactor. */
  contextWindow?: number;
  onCompaction?: (compaction: CompactedHistory) => Promise<void> | void;
  /** Awaited before the next model call, making persistence load-bearing. */
  onResponseBatch?: (batch: {
    step: number;
    messages: ModelMessage[];
    usage: NormalizedUsage;
    finishReason: string;
    toolCalls: number;
  }) => Promise<void> | void;
}

export interface WorkerRunResult {
  summary: string;
  steps: number;
  usage: NormalizedUsage;
  finishReason: string;
  toolCallCount: number;
  messages: ModelMessage[];
  pendingApproval?: {
    approvalId: string;
    toolCallId: string;
    toolName: string;
    input: unknown;
  };
}

const DEFAULT_MAX_STEPS = 30;

// Progress relayed via `onStep` is observability metadata for a caller's
// UI/log, not the model's real output -- capped hard so a huge model reply
// can never flow through unbounded. `runWorkerLoop`'s RETURNED `summary`
// keeps the model's full final text; only the step-by-step relay is
// truncated.
const ON_STEP_TEXT_TRUNCATE_CHARS = 200;

const WORKER_INSTRUCTIONS =
  "You are a coding worker. Use the provided tools to make the requested " +
  "change in the working directory. Keep going until the task is done, " +
  "then reply with a short summary of what you changed. Do not run `git " +
  "commit`, `git add`, or any git command that changes history or the " +
  "index -- leave all your changes as uncommitted working-tree edits so " +
  "they can be reviewed.";

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

// Builds the single worker prompt: the specialist instruction, then
// (optionally) the wiki digest as repository context, then the task
// itself -- in that order, so the model reads its marching orders before
// any task-specific detail.
function buildPrompt(
  input: Pick<WorkerRunInput, "task" | "wikiDigest" | "instructions">,
): string {
  const sections = [input.instructions ?? WORKER_INSTRUCTIONS];
  if (input.wikiDigest !== undefined && input.wikiDigest.length > 0) {
    sections.push(`# Repository context\n\n${input.wikiDigest}`);
  }
  sections.push(`# Task\n\n${input.task}`);
  return sections.join("\n\n");
}

/** Deterministic initial history used by both a fresh run and exact replay. */
export function createInitialWorkerMessages(
  input: Pick<WorkerRunInput, "task" | "wikiDigest" | "instructions">,
): ModelMessage[] {
  return [{ role: "user", content: buildPrompt(input) }];
}

export async function runWorkerLoop(input: WorkerRunInput): Promise<WorkerRunResult> {
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  let messages: ModelMessage[] = input.messages === undefined
    ? createInitialWorkerMessages(input)
    : [...input.messages];
  if (input.approvalResponse !== undefined) {
    messages.push({
      role: "tool",
      content: [{
        type: "tool-approval-response",
        approvalId: input.approvalResponse.approvalId,
        approved: input.approvalResponse.approved,
        ...(input.approvalResponse.reason === undefined
          ? {}
          : { reason: input.approvalResponse.reason }),
      }],
    });
  }

  let summary = "";
  let finishReason = "other";
  let toolCallCount = 0;
  let steps = 0;
  let usage: NormalizedUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let pendingApproval: WorkerRunResult["pendingApproval"];

  while (steps < maxSteps) {
    const incoming = await input.beforeModelMessages?.();
    if (incoming !== undefined && incoming.length > 0) messages.push(...incoming);
    if (input.contextWindow !== undefined) {
      const compacted = compactModelHistory(messages, input.contextWindow);
      if (compacted !== null) {
        await input.onCompaction?.(compacted);
        messages = compacted.messages;
      }
    }
    // The SDK owns provider normalization and execution of this one batch;
    // OpenFusion owns every continuation decision outside the call.
    await input.onModelStart?.({ step: steps });
    const call = (signal: AbortSignal | undefined) => generateText({
        model: input.model,
        tools: input.tools,
        messages,
        stopWhen: isStepCount(1),
        abortSignal: signal,
        toolApproval: input.toolApproval,
      });
    const result = input.executeModelCall === undefined
      ? await call(input.abortSignal)
      : await input.executeModelCall(call);
    const stepUsage = normalizeUsage(result.usage);
    usage = {
      inputTokens: usage.inputTokens + stepUsage.inputTokens,
      outputTokens: usage.outputTokens + stepUsage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens + stepUsage.cacheReadTokens,
    };
    const batch = result.responseMessages as ModelMessage[];
    await input.onResponseBatch?.({
      step: steps,
      messages: batch,
      usage: stepUsage,
      finishReason: result.finishReason,
      toolCalls: result.toolCalls.length,
    });
    messages.push(...batch);

    summary = result.text;
    finishReason = result.finishReason;
    toolCallCount += result.toolCalls.length;
    input.onStep?.({
      step: steps,
      toolCalls: result.toolCalls.length,
      text: truncate(result.text, ON_STEP_TEXT_TRUNCATE_CHARS),
    });
    steps += 1;

    const approval = result.content.find(
      (part) => part.type === "tool-approval-request" && part.isAutomatic !== true,
    );
    if (approval?.type === "tool-approval-request") {
      pendingApproval = {
        approvalId: approval.approvalId,
        toolCallId: approval.toolCall.toolCallId,
        toolName: approval.toolCall.toolName,
        input: approval.toolCall.input,
      };
      break;
    }
    if (result.toolCalls.length === 0) break;
  }

  return {
    summary,
    steps,
    usage,
    finishReason,
    toolCallCount,
    messages,
    ...(pendingApproval === undefined ? {} : { pendingApproval }),
  };
}
