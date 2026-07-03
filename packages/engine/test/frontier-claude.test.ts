import { describe, expect, it } from "vitest";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeAdapter } from "../src/engines/claude.js";
import type { FrontierPromptHandle } from "../src/engines/types.js";
import { CostMeter } from "../src/models/meter.js";

// Fake SDK message fixtures per the M3 task-3 brief's Step 2 script: a
// system message (ignored), one assistant message with a text block and a
// tool_use block, then a result message. These are cast through
// `as unknown as SDKMessage` rather than built as fully spec-compliant
// BetaMessage/SDKSystemMessage objects (which carry a dozen fields our
// mapping code never reads, like `container` or `mcp_servers`) — only the
// shape our adapter actually reads is filled in.
const SYSTEM_MSG = { type: "system", subtype: "init" } as unknown as SDKMessage;

const ASSISTANT_MSG = {
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "checking the repo" },
      { type: "tool_use", id: "tu_1", name: "Grep", input: { pattern: "foo" } },
    ],
  },
} as unknown as SDKMessage;

const RESULT_MSG = {
  type: "result",
  subtype: "success",
  duration_ms: 4200,
  duration_api_ms: 4000,
  is_error: false,
  num_turns: 3,
  result: "done answer",
  stop_reason: null,
  total_cost_usd: 0.12,
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 0,
  },
  modelUsage: {
    "claude-fable-5": {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.12,
      contextWindow: 200000,
      maxOutputTokens: 8192,
    },
  },
  permission_denials: [],
  session_id: "sess-abc",
  uuid: "11111111-1111-1111-1111-111111111111",
} as unknown as SDKMessage;

// Minimal `Query` fake: an async generator over a fixed script, plus a
// `close()` spy. `Query` extends AsyncGenerator and adds ~20 CLI-control
// methods (rewindFiles, setMcpServers, streamInput, ...) our adapter never
// calls — only `close()` and iteration are exercised here, so the rest of
// the interface is satisfied via `as unknown as Query` rather than stubbed
// out method-by-method.
class FakeQuery {
  #messages: SDKMessage[];
  #index = 0;
  closeCalls = 0;

  constructor(messages: SDKMessage[]) {
    this.#messages = messages;
  }

  async next(): Promise<IteratorResult<SDKMessage, void>> {
    if (this.#index < this.#messages.length) {
      return { value: this.#messages[this.#index++]!, done: false };
    }
    return { value: undefined, done: true };
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.#index = this.#messages.length;
    return { value: undefined, done: true };
  }

  async throw(err: unknown): Promise<IteratorResult<SDKMessage, void>> {
    throw err;
  }

  [Symbol.asyncIterator](): FakeQuery {
    return this;
  }

  close(): void {
    this.closeCalls += 1;
  }
}

// Builds a `queryFn` that returns one scripted `FakeQuery` per call (in
// call order), capturing the `options` object passed on each call so tests
// can assert on `resume`, `mcpServers`, `allowedTools`, `canUseTool`, etc.
function makeQueryFn(scripts: SDKMessage[][]): {
  queryFn: typeof import("@anthropic-ai/claude-agent-sdk").query;
  captured: Options[];
  queries: FakeQuery[];
} {
  const captured: Options[] = [];
  const queries: FakeQuery[] = [];
  let call = 0;
  const queryFn = ((params: { prompt: string; options?: Options }) => {
    captured.push(params.options ?? {});
    const script = scripts[call] ?? [];
    call += 1;
    const q = new FakeQuery(script);
    queries.push(q);
    return q as unknown as Query;
  }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
  return { queryFn, captured, queries };
}

async function drain(handle: FrontierPromptHandle) {
  const events = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

const noopLog = () => {};

describe("createClaudeAdapter", () => {
  it("has kind claude-code", () => {
    const { queryFn } = makeQueryFn([]);
    expect(createClaudeAdapter({ queryFn }).kind).toBe("claude-code");
  });

  it("maps SDK messages to text, tool_use, then result FrontierEvents", async () => {
    const { queryFn } = makeQueryFn([[SYSTEM_MSG, ASSISTANT_MSG, RESULT_MSG]]);
    const adapter = createClaudeAdapter({ queryFn });
    const session = await adapter.createSession({ projectDir: "/repo", wikiMcpUrl: null, log: noopLog });

    const events = await drain(session.prompt("hi"));

    expect(events.map((e) => e.type)).toEqual(["text", "tool_use", "result"]);
    expect(events[0]).toEqual({ type: "text", text: "checking the repo" });
    expect(events[1]).toEqual({
      type: "tool_use",
      name: "Grep",
      summary: JSON.stringify({ pattern: "foo" }).slice(0, 200),
    });
    expect(events[2]).toEqual({
      type: "result",
      resultText: "done answer",
      costUsd: 0.12,
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300 },
      numTurns: 3,
      durationMs: 4200,
      engineSessionId: "sess-abc",
    });
  });

  it("captures engineSessionId from the result and passes it as resume on the next prompt", async () => {
    const { queryFn, captured } = makeQueryFn([[RESULT_MSG], [RESULT_MSG]]);
    const adapter = createClaudeAdapter({ queryFn });
    const session = await adapter.createSession({ projectDir: "/repo", wikiMcpUrl: null, log: noopLog });

    await drain(session.prompt("first"));
    expect(captured[0]?.resume).toBeUndefined();

    await drain(session.prompt("second"));
    expect(captured[1]?.resume).toBe("sess-abc");
  });

  it("passes mcpServers.wiki when wikiMcpUrl is set, and omits mcpServers when null", async () => {
    const withWiki = makeQueryFn([[RESULT_MSG]]);
    const adapterWithWiki = createClaudeAdapter({ queryFn: withWiki.queryFn });
    const sessionWithWiki = await adapterWithWiki.createSession({
      projectDir: "/repo",
      wikiMcpUrl: "http://127.0.0.1:9999/mcp",
      log: noopLog,
    });
    await drain(sessionWithWiki.prompt("hi"));
    expect(withWiki.captured[0]?.mcpServers).toEqual({
      wiki: { type: "http", url: "http://127.0.0.1:9999/mcp" },
    });

    const noWiki = makeQueryFn([[RESULT_MSG]]);
    const adapterNoWiki = createClaudeAdapter({ queryFn: noWiki.queryFn });
    const sessionNoWiki = await adapterNoWiki.createSession({
      projectDir: "/repo",
      wikiMcpUrl: null,
      log: noopLog,
    });
    await drain(sessionNoWiki.prompt("hi"));
    expect(noWiki.captured[0]?.mcpServers).toBeUndefined();
  });

  it("requests read-only tools with permissionMode default, and canUseTool denies everything", async () => {
    const { queryFn, captured } = makeQueryFn([[RESULT_MSG]]);
    const adapter = createClaudeAdapter({ queryFn });
    const session = await adapter.createSession({ projectDir: "/repo", wikiMcpUrl: null, log: noopLog });
    await drain(session.prompt("hi"));

    expect(captured[0]?.allowedTools).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash(git log*)",
      "mcp__wiki__wiki_query",
      "mcp__wiki__wiki_map",
    ]);
    expect(captured[0]?.permissionMode).toBe("default");

    const canUseTool = captured[0]?.canUseTool;
    expect(typeof canUseTool).toBe("function");
    const result = await canUseTool!("Write", { file_path: "x" }, {
      signal: new AbortController().signal,
      toolUseID: "tu_1",
    });
    expect(result).toEqual({
      behavior: "deny",
      message: expect.stringContaining("read-only") as unknown as string,
    });
  });

  it("invokes onResult with the dominant modelUsage key so the caller can record cost (kind frontier-claude)", async () => {
    const { queryFn } = makeQueryFn([[RESULT_MSG]]);
    const meter = new CostMeter();
    const adapter = createClaudeAdapter({
      queryFn,
      onResult: (result, model) => {
        meter.record({
          providerId: "claude-code",
          kind: "frontier-claude",
          model,
          usage: result.usage,
          costUsd: result.costUsd,
          at: Date.now(),
        });
      },
    });
    const session = await adapter.createSession({ projectDir: "/repo", wikiMcpUrl: null, log: noopLog });
    await drain(session.prompt("hi"));

    const totals = meter.totals();
    expect(totals.calls).toBe(1);
    expect(totals.byModel["frontier-claude/claude-fable-5"]).toEqual({
      calls: 1,
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.12,
    });
  });

  it("abort() aborts the AbortController passed to queryFn", async () => {
    const { queryFn, captured } = makeQueryFn([[RESULT_MSG]]);
    const adapter = createClaudeAdapter({ queryFn });
    const session = await adapter.createSession({ projectDir: "/repo", wikiMcpUrl: null, log: noopLog });

    const handle = session.prompt("hi");
    expect(captured[0]?.abortController?.signal.aborted).toBe(false);
    handle.abort();
    expect(captured[0]?.abortController?.signal.aborted).toBe(true);
  });

  it("close() terminates the active query and drops resume state", async () => {
    const { queryFn, captured, queries } = makeQueryFn([[RESULT_MSG], [RESULT_MSG]]);
    const adapter = createClaudeAdapter({ queryFn });
    const session = await adapter.createSession({ projectDir: "/repo", wikiMcpUrl: null, log: noopLog });

    await drain(session.prompt("first"));
    await session.close();
    expect(queries[0]?.closeCalls).toBe(1);

    await drain(session.prompt("second"));
    expect(captured[1]?.resume).toBeUndefined();
  });
});
