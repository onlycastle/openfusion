import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { tool } from "ai";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkerLoop } from "../src/worker/loop.js";
import { createWorkerTools } from "../src/worker/tools.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// realpath up front: macOS's os.tmpdir() is itself a symlink
// (/tmp -> /private/tmp), and createWorkerTools() computes its own
// canonical root internally via fs.realpathSync -- resolving here keeps
// test-side path arithmetic agreeing with what the containment gate
// actually compares against (same pattern as worker-tools.test.ts).
function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "of-loop-"));
  return realpathSync(root);
}

// Flattens a provider-spec prompt (array of messages, each with either a
// plain string or an array of content parts) into its text, so tests can
// assert on prompt CONTENTS without depending on exactly how many
// messages/parts the SDK's string->prompt conversion produces. Typed
// structurally (not against the real `LanguageModelV4CallOptions`) so this
// file doesn't need `@ai-sdk/provider` as a direct dependency -- `ai/test`
// is the only test double this suite imports, matching
// models-complete.test.ts's convention of leaving doGenerate return values
// untyped and letting MockLanguageModelV4's constructor contextually type
// them.
function promptText(options: { prompt: Array<{ content: unknown }> }): string {
  return options.prompt
    .flatMap((m) => (typeof m.content === "string" ? [m.content] : (m.content as unknown[])))
    .map((part) =>
      typeof part === "string" ? part : part && typeof part === "object" && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("\n");
}

// Simulates a hung model call: the returned promise never settles on its
// own, mirroring a provider that accepted the request but never responds.
// It DOES honor the `abortSignal` generateText attaches to the call (real
// provider adapters reject when their signal fires, via fetch) so that
// runWorkerLoop's `abortSignal` plumbing has something real to abort --
// MockLanguageModelV4 itself does not race the signal against its
// doGenerate implementation, so without this the promise would hang forever
// regardless of the signal (mirrors models-complete.test.ts's own
// `hungFetch` helper, one layer up the stack).
function makeHangingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    // `return`ed (not `await`ed then fallen off the end) so the arrow
    // function's inferred return type stays `Promise<never>` -- which IS
    // structurally assignable to the doGenerate contract's
    // `PromiseLike<LanguageModelV4GenerateResult>` (never being the bottom
    // type), whereas `await`-then-implicit-return infers `Promise<void>`,
    // which is not.
    doGenerate: async ({ abortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(abortSignal.reason);
          return;
        }
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
      }),
  });
}

const USAGE_A = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 50, text: 0, reasoning: undefined },
};
const USAGE_B = {
  inputTokens: { total: 200, noCache: 200, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 30, text: 30, reasoning: undefined },
};

describe("runWorkerLoop", () => {
  it("drives a tool-call step then a final-text step, summing usage and writing the real file", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });

    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++;
        if (call === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "write_file",
                input: JSON.stringify({ path: "greet.txt", content: "function greet() {}" }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: USAGE_A,
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "Added greet()" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: USAGE_B,
          warnings: [],
        };
      },
    });

    const onStepCalls: Array<{ step: number; toolCalls: number; text?: string }> = [];

    const result = await runWorkerLoop({
      model,
      task: "add a greet function to greet.txt",
      tools,
      maxSteps: 5,
      onStep: (s) => onStepCalls.push(s),
    });

    expect(result.summary).toBe("Added greet()");
    expect(result.steps).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.finishReason).toBe("stop");
    // usage is CUMULATIVE across both doGenerate calls (v7 result.usage is a
    // sum, not just the final step) -- 100+200 input, 50+30 output.
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 80, cacheReadTokens: 0 });

    // Proves the loop actually wired the real createWorkerTools execute
    // closure through generateText's tool-call -> tool-result round trip,
    // not just that the mock claimed a tool call happened.
    expect(existsSync(path.join(dir, "greet.txt"))).toBe(true);
    expect(readFileSync(path.join(dir, "greet.txt"), "utf8")).toBe("function greet() {}");

    // onStep fires once per step, in order, with that step's own zero-based
    // index and tool-call count (verified empirically against MockLanguageModelV4:
    // StepResult.stepNumber is zero-based, and a tool-call-only step's text is "").
    expect(onStepCalls).toHaveLength(2);
    expect(onStepCalls[0]).toEqual({ step: 0, toolCalls: 1, text: "" });
    expect(onStepCalls[1]).toEqual({ step: 1, toolCalls: 0, text: "Added greet()" });
  });

  it("awaits durable response-batch persistence before making the next model call", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });
    const order: string[] = [];
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1;
        order.push(`model:${call}`);
        if (call === 1) {
          return {
            content: [{
              type: "tool-call",
              toolCallId: "persist-1",
              toolName: "read_file",
              input: JSON.stringify({ path: "missing.txt" }),
            }],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: USAGE_A,
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: USAGE_B,
          warnings: [],
        };
      },
    });

    await runWorkerLoop({
      model,
      task: "read",
      tools,
      onResponseBatch: async ({ step }) => {
        await Promise.resolve();
        order.push(`persist:${step + 1}`);
      },
    });

    expect(order).toEqual(["model:1", "persist:1", "model:2", "persist:2"]);
  });

  it("stops on an AI SDK approval request and resumes from the exact message history", async () => {
    dir = makeRoot();
    let executions = 0;
    const tools = {
      dangerous: tool({
        description: "A mutating test tool",
        inputSchema: z.object({ value: z.string() }),
        needsApproval: true,
        execute: async ({ value }) => {
          executions += 1;
          return { value };
        },
      }),
    };
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1;
        if (call === 1) {
          return {
            content: [{
              type: "tool-call",
              toolCallId: "approval-call",
              toolName: "dangerous",
              input: JSON.stringify({ value: "run" }),
            }],
            finishReason: { unified: "tool-calls", raw: "tool_calls" },
            usage: USAGE_A,
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "approved and done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: USAGE_B,
          warnings: [],
        };
      },
    });

    const paused = await runWorkerLoop({ model, task: "mutate", tools, maxSteps: 5 });
    expect(paused.pendingApproval).toMatchObject({
      toolCallId: "approval-call",
      toolName: "dangerous",
      input: { value: "run" },
    });
    expect(executions).toBe(0);

    const resumed = await runWorkerLoop({
      model,
      task: "ignored because history is supplied",
      tools,
      messages: paused.messages,
      approvalResponse: {
        approvalId: paused.pendingApproval!.approvalId,
        approved: true,
      },
      maxSteps: 5,
    });
    expect(executions).toBe(1);
    expect(resumed.summary).toBe("approved and done");
  });

  it("finishes in a single step when the model replies with final text immediately (no tool call)", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "Nothing to change." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      }),
    });

    const result = await runWorkerLoop({ model, task: "no-op task", tools });

    expect(result.summary).toBe("Nothing to change.");
    expect(result.steps).toBe(1);
    expect(result.toolCallCount).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 });
  });

  it("caps at maxSteps when the model always emits a tool call, without hanging", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });

    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++;
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${call}`,
              toolName: "read_file",
              input: JSON.stringify({ path: "nope.txt" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 0, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    const result = await runWorkerLoop({ model, task: "loop forever", tools, maxSteps: 3 });

    expect(result.steps).toBe(3);
    expect(result.toolCallCount).toBe(3);
    // Cumulative usage across all 3 forced steps.
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 3, cacheReadTokens: 0 });
  }, 10_000);

  it("onStep never receives raw/untruncated model text beyond a short cap", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });
    const longText = "x".repeat(5000);

    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: longText }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });

    const onStepCalls: Array<{ step: number; toolCalls: number; text?: string }> = [];
    const result = await runWorkerLoop({
      model,
      task: "produce a huge reply",
      tools,
      onStep: (s) => onStepCalls.push(s),
    });

    // The RESULT keeps the full text -- only the onStep progress relay is
    // truncated.
    expect(result.summary).toBe(longText);
    expect(onStepCalls).toHaveLength(1);
    expect(onStepCalls[0]?.text?.length).toBeLessThan(longText.length);
  });

  it("includes the wikiDigest in the prompt when provided, and omits it when absent", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });
    const digestSentinel = "WIKI_DIGEST_SENTINEL_4f2a";
    const taskSentinel = "TASK_SENTINEL_9b1c";

    const makeModel = () =>
      new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ type: "text", text: "done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        }),
      });

    const withDigest = makeModel();
    await runWorkerLoop({
      model: withDigest,
      task: taskSentinel,
      wikiDigest: digestSentinel,
      tools,
    });

    const withDigestPrompt = promptText(withDigest.doGenerateCalls[0]!);
    expect(withDigestPrompt).toContain(taskSentinel);
    expect(withDigestPrompt).toContain(digestSentinel);
    // Also pins the specialist worker instruction is actually in the prompt.
    expect(withDigestPrompt.toLowerCase()).toContain("coding worker");

    const withoutDigest = makeModel();
    await runWorkerLoop({ model: withoutDigest, task: taskSentinel, tools });

    const withoutDigestPrompt = promptText(withoutDigest.doGenerateCalls[0]!);
    expect(withoutDigestPrompt).toContain(taskSentinel);
    expect(withoutDigestPrompt).not.toContain(digestSentinel);
  });

  // M5b Task 0: runWorkerLoop must accept an `abortSignal` and actually wire
  // it into generateText -- without this, a hung model call has no way to
  // be interrupted, and engine.worker.run's timeoutMs / close-abort (built
  // on top of this) would have nothing to fire.
  it("rejects when the given abortSignal fires mid-generate, instead of hanging forever", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });
    const model = makeHangingModel();
    const controller = new AbortController();

    const resultPromise = runWorkerLoop({
      model,
      task: "hang forever",
      tools,
      abortSignal: controller.signal,
    });

    // Let the mock's doGenerate actually start and register its abort
    // listener before firing the signal, so this exercises the "abort
    // arrives while in flight" path rather than the "already aborted"
    // shortcut.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort(new Error("test abort"));

    await expect(resultPromise).rejects.toThrow();
  });
});
