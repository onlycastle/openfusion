// Open-model worker tool loop: the AI SDK v7 multi-step generateText-with-
// tools call that drives an open model through a coding task. `model` and
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
import { generateText, isStepCount, type LanguageModel, type StepResult, type Tool } from "ai";
import { normalizeUsage, type NormalizedUsage } from "../models/pricing.js";

export interface WorkerRunInput {
  model: LanguageModel;
  task: string;
  wikiDigest?: string;
  tools: Record<string, Tool>;
  maxSteps?: number;
  // Forwarded straight through to generateText's own `abortSignal` (see the
  // call below). The caller (engine.worker.run, worker/methods.ts) owns
  // building this -- a combined timeoutMs deadline + a per-run
  // AbortController it can fire on engine.close() -- runWorkerLoop itself
  // stays deadline-agnostic and just plumbs whatever signal it's given.
  abortSignal?: AbortSignal;
  onStep?: (s: { step: number; toolCalls: number; text?: string }) => void;
}

export interface WorkerRunResult {
  summary: string;
  steps: number;
  usage: NormalizedUsage;
  finishReason: string;
  toolCallCount: number;
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
function buildPrompt(input: Pick<WorkerRunInput, "task" | "wikiDigest">): string {
  const sections = [WORKER_INSTRUCTIONS];
  if (input.wikiDigest !== undefined && input.wikiDigest.length > 0) {
    sections.push(`# Repository context\n\n${input.wikiDigest}`);
  }
  sections.push(`# Task\n\n${input.task}`);
  return sections.join("\n\n");
}

export async function runWorkerLoop(input: WorkerRunInput): Promise<WorkerRunResult> {
  const maxSteps = input.maxSteps ?? DEFAULT_MAX_STEPS;
  const prompt = buildPrompt(input);

  const result = await generateText({
    model: input.model,
    tools: input.tools,
    // This IS the runaway cap: without it generateText defaults to
    // isStepCount(1) and would never continue past a single tool call.
    stopWhen: isStepCount(maxSteps),
    prompt,
    abortSignal: input.abortSignal,
    onStepEnd: (step: StepResult<Record<string, Tool>>) => {
      input.onStep?.({
        step: step.stepNumber,
        toolCalls: step.toolCalls.length,
        text: truncate(step.text, ON_STEP_TEXT_TRUNCATE_CHARS),
      });
    },
  });

  const toolCallCount = result.steps.reduce((sum, step) => sum + step.toolCalls.length, 0);

  return {
    summary: result.text,
    steps: result.steps.length,
    // result.usage is the SUM across all steps in v7 -- exactly what a
    // multi-step worker run should meter.
    usage: normalizeUsage(result.usage),
    finishReason: result.finishReason,
    toolCallCount,
  };
}
