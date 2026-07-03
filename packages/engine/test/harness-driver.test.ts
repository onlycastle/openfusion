import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HarnessGenError, promptForJson, type DriverNotice } from "../src/harness/driver.js";
import type { FrontierEvent, FrontierPromptHandle, FrontierSession } from "../src/engines/types.js";

// A minimal FrontierResultEvent builder — every test that wants to end a
// turn "cleanly" (as any real adapter always does) appends one of these to
// its scripted event list. costUsd/usage/etc default to null-ish/zero
// values a test doesn't care about, overridable per test.
function resultEvent(overrides: Partial<Extract<FrontierEvent, { type: "result" }>> = {}): FrontierEvent {
  return {
    type: "result",
    resultText: "",
    costUsd: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    numTurns: 1,
    durationMs: 1,
    engineSessionId: null,
    ...overrides,
  };
}

function textEvent(text: string): FrontierEvent {
  return { type: "text", text };
}

// Scripted fake FrontierSession: the Nth call to session.prompt() returns
// the Nth entry of `scripts` as its event stream (clamped to the last entry
// if prompt() is called more times than scripts provided, so a
// mis-scripted test fails loudly on its assertions rather than throwing on
// an out-of-bounds read). Captures every prompt string sent, in order, so
// retry-prompt content can be asserted directly.
function makeScriptedSession(scripts: FrontierEvent[][]): {
  session: FrontierSession;
  prompts: string[];
} {
  const prompts: string[] = [];
  let callIndex = 0;
  const session: FrontierSession = {
    id: "fake-session",
    projectDir: "/fake/project",
    prompt(text: string): FrontierPromptHandle {
      prompts.push(text);
      const events = scripts[Math.min(callIndex, scripts.length - 1)] ?? [];
      callIndex += 1;
      async function* gen(): AsyncGenerator<FrontierEvent> {
        for (const event of events) yield event;
      }
      return { events: gen(), abort: () => {} };
    },
    async close(): Promise<void> {},
  };
  return { session, prompts };
}

const PointSchema = z.object({ a: z.number() });

describe("promptForJson — happy path extraction", () => {
  it("extracts a JSON code block on the first attempt", async () => {
    const { session, prompts } = makeScriptedSession([
      [textEvent('```json\n{"a": 1}\n```'), resultEvent({ costUsd: 0.01 })],
    ]);

    const result = await promptForJson(session, "give me a point", PointSchema);

    expect(result.value).toEqual({ a: 1 });
    expect(result.attempts).toBe(1);
    expect(result.costUsd).toBe(0.01);
    expect(prompts).toEqual(["give me a point"]);
  });

  it("extracts the fenced block even when surrounded by explanatory prose", async () => {
    const { session } = makeScriptedSession([
      [
        textEvent(
          "Sure, here's the point you asked for.\n\n```json\n{\"a\": 42}\n```\n\nLet me know if you need anything else!",
        ),
        resultEvent(),
      ],
    ]);

    const result = await promptForJson(session, "give me a point", PointSchema);

    expect(result.value).toEqual({ a: 42 });
    expect(result.attempts).toBe(1);
  });

  it("uses the LAST fenced json block when multiple are present", async () => {
    const { session } = makeScriptedSession([
      [
        textEvent(
          'Thinking out loud, an early draft: ```json\n{"a": 999}\n```\n\nActually, the correct answer is:\n```json\n{"a": 7}\n```',
        ),
        resultEvent(),
      ],
    ]);

    const result = await promptForJson(session, "give me a point", PointSchema);

    expect(result.value).toEqual({ a: 7 });
  });

  it("falls back to whole-text JSON.parse when no fence is present", async () => {
    const { session } = makeScriptedSession([[textEvent('  {"a": 3}  '), resultEvent()]]);

    const result = await promptForJson(session, "give me a point", PointSchema);

    expect(result.value).toEqual({ a: 3 });
    expect(result.attempts).toBe(1);
  });
});

describe("promptForJson — validation-feedback retry", () => {
  it("retries with an issue-describing prompt and succeeds on the corrected attempt", async () => {
    const { session, prompts } = makeScriptedSession([
      [textEvent('```json\n{"a": "not-a-number"}\n```'), resultEvent()],
      [textEvent('```json\n{"a": 5}\n```'), resultEvent()],
    ]);

    const result = await promptForJson(session, "give me a point", PointSchema);

    expect(result.value).toEqual({ a: 5 });
    expect(result.attempts).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe("give me a point");
    // The re-prompt must carry the zod issue text verbatim (not a
    // paraphrase) and the exact required corrective sentence.
    expect(prompts[1]).toContain("Invalid input: expected number, received string");
    expect(prompts[1]).toContain("Respond with ONLY a corrected JSON code block.");
  });

  it("throws HarnessGenError with issues and attempts on retry exhaustion", async () => {
    const { session, prompts } = makeScriptedSession([
      [textEvent('```json\n{"a": "nope"}\n```'), resultEvent()],
      [textEvent('```json\n{"a": "still-nope"}\n```'), resultEvent()],
    ]);

    await expect(promptForJson(session, "give me a point", PointSchema)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(HarnessGenError);
      const genErr = err as HarnessGenError;
      expect(genErr.attempts).toBe(2);
      expect(genErr.issues.length).toBeGreaterThan(0);
      return true;
    });
    expect(prompts).toHaveLength(2);
  });

  it("stamps opts.stage onto the thrown HarnessGenError", async () => {
    const { session } = makeScriptedSession([[textEvent("not json at all"), resultEvent()]]);

    await expect(
      promptForJson(session, "give me a point", PointSchema, { retries: 0, stage: "overview" }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(HarnessGenError);
      expect((err as HarnessGenError).stage).toBe("overview");
      expect((err as HarnessGenError).attempts).toBe(1);
      return true;
    });
  });

  it("respects a custom retries count (0 retries = exactly one attempt)", async () => {
    const { session, prompts } = makeScriptedSession([
      [textEvent('```json\n{"a": "nope"}\n```'), resultEvent()],
      [textEvent('```json\n{"a": 1}\n```'), resultEvent()],
    ]);

    await expect(promptForJson(session, "give me a point", PointSchema, { retries: 0 })).rejects.toBeInstanceOf(
      HarnessGenError,
    );
    // Never sent the second (would-be-corrective) prompt — no retries allowed.
    expect(prompts).toHaveLength(1);
  });
});

describe("promptForJson — cost aggregation", () => {
  it("sums numeric costUsd across attempts (first attempt's number, second attempt null)", async () => {
    const { session } = makeScriptedSession([
      [textEvent('```json\n{"a": "nope"}\n```'), resultEvent({ costUsd: 0.02 })],
      [textEvent('```json\n{"a": 1}\n```'), resultEvent({ costUsd: null })],
    ]);

    const result = await promptForJson(session, "p", PointSchema);

    expect(result.costUsd).toBe(0.02);
  });

  it("sums numeric costUsd across attempts (first null, second a number)", async () => {
    const { session } = makeScriptedSession([
      [textEvent('```json\n{"a": "nope"}\n```'), resultEvent({ costUsd: null })],
      [textEvent('```json\n{"a": 1}\n```'), resultEvent({ costUsd: 0.05 })],
    ]);

    const result = await promptForJson(session, "p", PointSchema);

    expect(result.costUsd).toBe(0.05);
  });

  it("stays null when every attempt's costUsd is null", async () => {
    const { session } = makeScriptedSession([
      [textEvent('```json\n{"a": "nope"}\n```'), resultEvent({ costUsd: null })],
      [textEvent('```json\n{"a": 1}\n```'), resultEvent({ costUsd: null })],
    ]);

    const result = await promptForJson(session, "p", PointSchema);

    expect(result.costUsd).toBeNull();
  });
});

describe("promptForJson — notify callback", () => {
  it("fires an 'attempt' notice per attempt and a 'notice' notice for a FrontierEvent notice", async () => {
    const { session } = makeScriptedSession([
      [
        { type: "notice", kind: "rate_limit", message: "Claude API rate limit reported for this turn." },
        textEvent('```json\n{"a": "nope"}\n```'),
        resultEvent(),
      ],
      [textEvent('```json\n{"a": 9}\n```'), resultEvent()],
    ]);

    const notices: DriverNotice[] = [];
    const result = await promptForJson(session, "p", PointSchema, { notify: (n) => notices.push(n) });

    expect(result.value).toEqual({ a: 9 });

    const attemptNotices = notices.filter((n) => n.kind === "attempt");
    expect(attemptNotices).toHaveLength(2);

    const rawNotices = notices.filter((n) => n.kind === "notice");
    expect(rawNotices).toHaveLength(1);
    expect(rawNotices[0]!.detail).toBe("Claude API rate limit reported for this turn.");

    const retryNotices = notices.filter((n) => n.kind === "validation-retry");
    expect(retryNotices).toHaveLength(1);

    // Ordering: attempt(1), notice, validation-retry, attempt(2) — the
    // notify calls happen in the order the driver observes them.
    const kinds = notices.map((n) => n.kind);
    expect(kinds).toEqual(["attempt", "notice", "validation-retry", "attempt"]);
  });

  it("does not fire a validation-retry notice on the final (exhausted) attempt", async () => {
    const { session } = makeScriptedSession([[textEvent("not json"), resultEvent()]]);

    const notices: DriverNotice[] = [];
    await expect(
      promptForJson(session, "p", PointSchema, { retries: 0, notify: (n) => notices.push(n) }),
    ).rejects.toBeInstanceOf(HarnessGenError);

    expect(notices.filter((n) => n.kind === "validation-retry")).toHaveLength(0);
    expect(notices.filter((n) => n.kind === "attempt")).toHaveLength(1);
  });
});

describe("promptForJson — error events", () => {
  it("rethrows immediately (not retried) on a FrontierEvent error", async () => {
    const { session, prompts } = makeScriptedSession([
      [{ type: "error", message: "boom" }],
      [textEvent('```json\n{"a": 1}\n```'), resultEvent()],
    ]);

    await expect(promptForJson(session, "p", PointSchema)).rejects.toThrow(/boom/);
    // Only the first (failing) prompt was ever sent — an error event is not
    // a validation problem, so it does not trigger the retry-with-feedback
    // path.
    expect(prompts).toHaveLength(1);
  });

  it("aborts the prompt handle when an error event occurs", async () => {
    let abortCalled = false;
    const session: FrontierSession = {
      id: "fake-session",
      projectDir: "/fake/project",
      prompt(text: string): FrontierPromptHandle {
        async function* gen(): AsyncGenerator<FrontierEvent> {
          yield { type: "error", message: "session error" };
        }
        return {
          events: gen(),
          abort: () => {
            abortCalled = true;
          },
        };
      },
      async close(): Promise<void> {},
    };

    await expect(promptForJson(session, "p", PointSchema)).rejects.toThrow(/session error/);
    expect(abortCalled).toBe(true);
  });

  it("does not abort the handle on a successful completion", async () => {
    let abortCalled = false;
    const session: FrontierSession = {
      id: "fake-session",
      projectDir: "/fake/project",
      prompt(text: string): FrontierPromptHandle {
        async function* gen(): AsyncGenerator<FrontierEvent> {
          yield textEvent('```json\n{"a": 1}\n```');
          yield resultEvent();
        }
        return {
          events: gen(),
          abort: () => {
            abortCalled = true;
          },
        };
      },
      async close(): Promise<void> {},
    };

    const result = await promptForJson(session, "p", PointSchema);
    expect(result.value).toEqual({ a: 1 });
    expect(abortCalled).toBe(false);
  });
});

describe("promptForJson — json fence extraction", () => {
  it("does not extract a json5 fence as a json block (falls back to whole-text)", async () => {
    const { session } = makeScriptedSession([
      [textEvent("Some text\n```json5\n{\"a\": 1}\n```"), resultEvent()],
    ]);

    // The json5 fence should not be extracted, so the parser falls back to
    // whole-text, which is "Some text\n```json5\n{\"a\": 1}\n```", which is
    // not valid JSON, so it should fail.
    await expect(promptForJson(session, "p", PointSchema)).rejects.toBeInstanceOf(HarnessGenError);
  });

  it("does not extract a jsonc fence as a json block (falls back to whole-text)", async () => {
    const { session } = makeScriptedSession([
      [textEvent("Some text\n```jsonc\n{\"a\": 1}\n```"), resultEvent()],
    ]);

    // The jsonc fence should not be extracted, so it falls back to whole-text
    // which fails to parse.
    await expect(promptForJson(session, "p", PointSchema)).rejects.toBeInstanceOf(HarnessGenError);
  });

  it("extracts a normal json fence correctly", async () => {
    const { session } = makeScriptedSession([
      [textEvent("```json\n{\"a\": 1}\n```"), resultEvent()],
    ]);

    const result = await promptForJson(session, "p", PointSchema);
    expect(result.value).toEqual({ a: 1 });
  });

  it("uses the last of two json blocks", async () => {
    const { session } = makeScriptedSession([
      [
        textEvent(
          'First: ```json\n{"a": 999}\n```\n\nSecond: ```json\n{"a": 1}\n```',
        ),
        resultEvent(),
      ],
    ]);

    const result = await promptForJson(session, "p", PointSchema);
    expect(result.value).toEqual({ a: 1 });
  });

  it("extracts json fence without trailing newline before the closing fence", async () => {
    const { session } = makeScriptedSession([
      [textEvent("```json\n{\"a\": 2}```"), resultEvent()],
    ]);

    const result = await promptForJson(session, "p", PointSchema);
    expect(result.value).toEqual({ a: 2 });
  });
});
