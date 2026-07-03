import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

// Shared by both write-scope describe blocks below (lexical containment and
// symlink-canonical containment) so the two suites exercise canUseTool
// through the exact same setup helper.
const signalOpts = { signal: new AbortController().signal, toolUseID: "tu_1" };

async function getCanUseTool(toolPolicy: { writeScope?: string[] } | undefined, projectDir = "/repo") {
  const { queryFn, captured } = makeQueryFn([[RESULT_MSG]]);
  const adapter = createClaudeAdapter({ queryFn });
  const session = await adapter.createSession({ projectDir, wikiMcpUrl: null, log: noopLog, toolPolicy });
  await drain(session.prompt("hi"));
  const canUseTool = captured[0]?.canUseTool;
  expect(typeof canUseTool).toBe("function");
  return { canUseTool: canUseTool!, captured };
}

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

    // M3 final review, Important 3: "Bash(git log*)" was dropped from the
    // v1 allowlist — `git log --output=/path` writes a file, which breaches
    // the read-only posture this list exists to enforce.
    expect(captured[0]?.allowedTools).toEqual([
      "Read",
      "Grep",
      "Glob",
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

// M4 task-1: path-scoped write capability. `toolPolicy.writeScope` is
// absent by default (today's read-only posture, unchanged); when present,
// canUseTool allows Write/Edit/MultiEdit/NotebookEdit calls whose resolved
// target path lands inside one of the scope directories, and keeps denying
// everything else — including the same tools outside scope. Per the
// corrected M3 tool-policy record in claude.ts, write tools must never
// appear in `allowedTools` even when writeScope is set, since that would
// bypass canUseTool entirely.
describe("canUseTool write-scope policy (toolPolicy.writeScope)", () => {
  it("allows Write when file_path resolves inside a writeScope dir", async () => {
    const { canUseTool } = await getCanUseTool({ writeScope: ["/repo/scratch"] }, "/repo");
    const result = await canUseTool(
      "Write",
      { file_path: "/repo/scratch/notes.txt", content: "x" },
      signalOpts,
    );
    expect(result).toEqual({ behavior: "allow" });
  });

  it("denies Write when file_path resolves outside every writeScope dir", async () => {
    const { canUseTool } = await getCanUseTool({ writeScope: ["/repo/scratch"] }, "/repo");
    const result = await canUseTool(
      "Write",
      { file_path: "/repo/other/notes.txt", content: "x" },
      signalOpts,
    );
    expect(result).toEqual({
      behavior: "deny",
      message: expect.stringContaining("read-only") as unknown as string,
    });
  });

  it("denies a `../` traversal that escapes the writeScope dir", async () => {
    const { canUseTool } = await getCanUseTool({ writeScope: ["/repo/scratch"] }, "/repo");
    const result = await canUseTool(
      "Write",
      { file_path: "/repo/scratch/../../etc/passwd", content: "x" },
      signalOpts,
    );
    expect(result.behavior).toBe("deny");
  });

  it("does not treat a sibling dir sharing a string prefix as in-scope (/a/b vs /a/bad)", async () => {
    const { canUseTool } = await getCanUseTool({ writeScope: ["/a/b"] }, "/a");
    const result = await canUseTool("Write", { file_path: "/a/bad/file.txt", content: "x" }, signalOpts);
    expect(result.behavior).toBe("deny");
  });

  it("allows Edit in-scope via file_path", async () => {
    const { canUseTool } = await getCanUseTool({ writeScope: ["/repo/scratch"] }, "/repo");
    const result = await canUseTool(
      "Edit",
      { file_path: "/repo/scratch/a.ts", old_string: "a", new_string: "b" },
      signalOpts,
    );
    expect(result).toEqual({ behavior: "allow" });
  });

  it("allows MultiEdit in-scope via file_path", async () => {
    const { canUseTool } = await getCanUseTool({ writeScope: ["/repo/scratch"] }, "/repo");
    const result = await canUseTool(
      "MultiEdit",
      { file_path: "/repo/scratch/a.ts", edits: [{ old_string: "a", new_string: "b" }] },
      signalOpts,
    );
    expect(result).toEqual({ behavior: "allow" });
  });

  it("allows NotebookEdit in-scope via notebook_path", async () => {
    const { canUseTool } = await getCanUseTool({ writeScope: ["/repo/scratch"] }, "/repo");
    const result = await canUseTool(
      "NotebookEdit",
      { notebook_path: "/repo/scratch/nb.ipynb", new_source: "print(1)", cell_id: "c1" },
      signalOpts,
    );
    expect(result).toEqual({ behavior: "allow" });
  });

  it("denies NotebookEdit outside scope", async () => {
    const { canUseTool } = await getCanUseTool({ writeScope: ["/repo/scratch"] }, "/repo");
    const result = await canUseTool(
      "NotebookEdit",
      { notebook_path: "/repo/other/nb.ipynb", new_source: "print(1)" },
      signalOpts,
    );
    expect(result.behavior).toBe("deny");
  });

  it("still denies non-write tools even inside the writeScope dir", async () => {
    const { canUseTool } = await getCanUseTool({ writeScope: ["/repo/scratch"] }, "/repo");
    const result = await canUseTool("Bash", { command: "rm -rf /repo/scratch" }, signalOpts);
    expect(result.behavior).toBe("deny");
  });

  it("with no toolPolicy at all, still denies write tools (default deny-all unchanged)", async () => {
    const { canUseTool } = await getCanUseTool(undefined, "/repo");
    const result = await canUseTool("Write", { file_path: "/repo/anything.txt", content: "x" }, signalOpts);
    expect(result).toEqual({
      behavior: "deny",
      message: expect.stringContaining("read-only") as unknown as string,
    });
  });

  it("with toolPolicy set but writeScope empty/absent, still denies write tools", async () => {
    const { canUseTool } = await getCanUseTool({}, "/repo");
    const result = await canUseTool("Write", { file_path: "/repo/anything.txt", content: "x" }, signalOpts);
    expect(result.behavior).toBe("deny");
  });

  it("never adds write tools to allowedTools even when writeScope is set", async () => {
    const { captured } = await getCanUseTool({ writeScope: ["/repo/scratch"] }, "/repo");
    expect(captured[0]?.allowedTools).toEqual([
      "Read",
      "Grep",
      "Glob",
      "mcp__wiki__wiki_query",
      "mcp__wiki__wiki_map",
    ]);
  });
});

// M4 task-1 review round 1, Finding 2 (Important): isPathInScope is purely
// lexical — a symlink INSIDE a writeScope dir pointing OUTSIDE it let a
// write "resolve inside scope" lexically while actually landing outside.
// canUseTool now canonicalizes the target (walk up to the deepest existing
// ancestor, fs.realpathSync it, re-join the non-existent tail — see
// ./path-scope.ts's canonicalizePath) before the containment check, and the
// scope dirs themselves are realpath'd once at session creation. Uses real
// tmp dirs (not the "/repo" fixture the suite above uses) since this needs
// actual symlinks and actual existing/non-existing paths on disk.
describe("canUseTool symlink-canonical path checks (Finding 2)", () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot !== undefined) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("denies a write whose path traverses a pre-existing symlink pointing outside the scope dir", async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "of-claude-symlink-"));
    const scopeDir = path.join(tmpRoot, "S");
    const outsideDir = path.join(tmpRoot, "outside");
    mkdirSync(scopeDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, path.join(scopeDir, "link"));

    const { canUseTool } = await getCanUseTool({ writeScope: [scopeDir] }, tmpRoot);
    const result = await canUseTool(
      "Write",
      { file_path: path.join(scopeDir, "link", "file.txt"), content: "x" },
      signalOpts,
    );
    expect(result.behavior).toBe("deny");
  });

  it("allows a write to a not-yet-existing nested path inside scope (non-existent tail handled)", async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "of-claude-symlink-"));
    const scopeDir = path.join(tmpRoot, "S");
    mkdirSync(scopeDir, { recursive: true });

    const { canUseTool } = await getCanUseTool({ writeScope: [scopeDir] }, tmpRoot);
    // "sub" does not exist yet — the target path's tail is created by the
    // write itself, so containment must be checked against the deepest
    // EXISTING ancestor (scopeDir) rather than failing to canonicalize.
    const result = await canUseTool(
      "Write",
      { file_path: path.join(scopeDir, "sub", "new.txt"), content: "x" },
      signalOpts,
    );
    expect(result).toEqual({ behavior: "allow" });
  });

  it("still allows writes when the scope dir itself is a symlink (scope dirs realpath'd at session creation)", async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "of-claude-symlink-"));
    const realScopeDir = path.join(tmpRoot, "real-scope");
    const scopeLink = path.join(tmpRoot, "scope-link");
    mkdirSync(realScopeDir, { recursive: true });
    symlinkSync(realScopeDir, scopeLink);

    const { canUseTool } = await getCanUseTool({ writeScope: [scopeLink] }, tmpRoot);
    const result = await canUseTool(
      "Write",
      { file_path: path.join(scopeLink, "note.txt"), content: "x" },
      signalOpts,
    );
    expect(result).toEqual({ behavior: "allow" });
  });
});

// M4 task-1 re-review round 2 (Important regression): Finding 2's fix (the
// describe block above) realpath's each writeScope dir at session creation
// so a scope dir that is ITSELF a symlink still resolves correctly — but it
// never re-checked the realpath'd result against projectDir. methods.ts's
// RPC-layer writeScope validation only checks the LEXICAL resolution of
// each entry against projectDir (see methods.ts's engine.frontier.start) —
// it has no way to see through a symlink from string paths alone. So a
// pre-existing symlink named as a writeScope entry, lexically inside
// projectDir, that actually points OUTSIDE projectDir sails through that
// RPC check, then gets realpath'd here into the external target and
// trusted outright as a scope dir — a deterministic full containment
// escape, worse than the bug Finding 2 closed (that one needed a target
// path to traverse a symlink; this one needs nothing but naming the
// symlink itself as the writeScope entry). Closed by re-verifying
// containment of each realpath'd scope dir against the canonical project
// root and dropping any that fail it (see claude.ts's writeScopeDirs).
describe("writeScope entry that is itself a symlink out of the project (review round 2 regression)", () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot !== undefined) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("denies writes through a writeScope entry that symlinks outside the project (containment escape)", async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "of-claude-scope-escape-"));
    const projectDir = path.join(tmpRoot, "project");
    const outsideDir = path.join(tmpRoot, "outside");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, path.join(projectDir, "link-out"));

    const { canUseTool } = await getCanUseTool(
      { writeScope: [path.join(projectDir, "link-out")] },
      projectDir,
    );

    const direct = await canUseTool(
      "Write",
      { file_path: path.join(outsideDir, "x.txt"), content: "x" },
      signalOpts,
    );
    expect(direct.behavior).toBe("deny");

    const throughLink = await canUseTool(
      "Write",
      { file_path: path.join(projectDir, "link-out", "x.txt"), content: "x" },
      signalOpts,
    );
    expect(throughLink.behavior).toBe("deny");
  });

  it("still allows writes when the writeScope symlink points inside the project (legitimate case preserved)", async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "of-claude-scope-escape-"));
    const projectDir = path.join(tmpRoot, "project");
    const realScopeDir = path.join(projectDir, "real-scope");
    const scopeLink = path.join(projectDir, "scope-link");
    mkdirSync(realScopeDir, { recursive: true });
    symlinkSync(realScopeDir, scopeLink);

    const { canUseTool } = await getCanUseTool({ writeScope: [scopeLink] }, projectDir);
    const result = await canUseTool(
      "Write",
      { file_path: path.join(scopeLink, "note.txt"), content: "x" },
      signalOpts,
    );
    expect(result).toEqual({ behavior: "allow" });
  });
});

// M5a task-1 (M4 T1 deferred, day-one critical for worker worktrees): a
// writeScope entry that does NOT exist on disk yet gets its realpath
// fallback built from the RAW projectDir string, while the containment
// baseline (canonicalProjectDir) IS realpath'd — see claude.ts's
// writeScopeDirs. On a symlinked project root (macOS os.tmpdir() ->
// /var/folders, which is really /private/var/folders; worker worktrees live
// under os.tmpdir()) that compares a lexical path against a canonical one,
// they never match, and the entry is silently dropped: every write to a
// not-yet-existing scope dir is denied. Reproduced with an EXPLICIT symlink
// here rather than relying on os.tmpdir()'s own symlink, since that's not
// guaranteed on every CI runner (e.g. Linux).
describe("writeScope entry that does not exist yet under a symlinked project root (M5a task-1)", () => {
  let tmpRoot: string;

  afterEach(() => {
    if (tmpRoot !== undefined) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("allows a write to a not-yet-existing writeScope dir reached through a symlinked project root", async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "of-claude-scope-notexist-"));
    const realBase = path.join(tmpRoot, "real-base");
    const linkBase = path.join(tmpRoot, "link-base");
    mkdirSync(realBase, { recursive: true });
    symlinkSync(realBase, linkBase);

    const projectDir = path.join(linkBase, "proj");
    mkdirSync(projectDir, { recursive: true });
    // "scratch" deliberately does NOT exist yet — realpathSync on it throws,
    // exercising the not-yet-existing-scope-dir fallback path this test
    // guards.

    const { canUseTool } = await getCanUseTool({ writeScope: ["scratch"] }, projectDir);
    const result = await canUseTool(
      "Write",
      { file_path: path.join(projectDir, "scratch", "x.txt"), content: "x" },
      signalOpts,
    );
    expect(result).toEqual({ behavior: "allow" });
  });
});

// M4 task-1: rate-limit visibility. SDKAssistantMessage carries an optional
// top-level `error?: SDKAssistantMessageError` tag (inspected in
// @anthropic-ai/claude-agent-sdk@0.3.198's sdk.d.ts) — a bare string enum
// with no accompanying message text, unlike a typical error object. The
// adapter maps that tag to a FrontierEvent `notice`, synthesizing its own
// human-readable `message`. This is NOT terminal: the mapping loop keeps
// running afterward (proven here by asserting the stream still reaches a
// `result` event).
describe("assistant-message API-error -> notice event mapping", () => {
  function assistantErrorMsg(error: string): SDKMessage {
    return {
      type: "assistant",
      message: { content: [] },
      error,
    } as unknown as SDKMessage;
  }

  // M4 task-1 review round 1, Finding 3 (Important): the old copy ("...the
  // request will be retried automatically") asserted retry semantics never
  // verified against the SDK — that belongs to SDKAPIRetryMessage, a
  // different message type this adapter doesn't map. The notice message is
  // now purely factual (no remediation claim), asserted here with an exact
  // match rather than a loose substring so the copy can't drift back toward
  // an unverified claim unnoticed.
  it("maps a rate_limit assistant error to a notice event, then continues to result", async () => {
    const { queryFn } = makeQueryFn([[assistantErrorMsg("rate_limit"), RESULT_MSG]]);
    const adapter = createClaudeAdapter({ queryFn });
    const session = await adapter.createSession({ projectDir: "/repo", wikiMcpUrl: null, log: noopLog });

    const events = await drain(session.prompt("hi"));

    expect(events.map((e) => e.type)).toEqual(["notice", "result"]);
    expect(events[0]).toEqual({
      type: "notice",
      kind: "rate_limit",
      message: "Claude API rate limit reported for this turn.",
    });
  });

  it("maps an overloaded assistant error to a notice event, then continues to result", async () => {
    const { queryFn } = makeQueryFn([[assistantErrorMsg("overloaded"), RESULT_MSG]]);
    const adapter = createClaudeAdapter({ queryFn });
    const session = await adapter.createSession({ projectDir: "/repo", wikiMcpUrl: null, log: noopLog });

    const events = await drain(session.prompt("hi"));

    expect(events.map((e) => e.type)).toEqual(["notice", "result"]);
    expect(events[0]).toEqual({
      type: "notice",
      kind: "overloaded",
      message: "Claude API overloaded for this turn.",
    });
  });

  it("maps any other assistant-message error tag to kind api_error", async () => {
    const { queryFn } = makeQueryFn([[assistantErrorMsg("server_error"), RESULT_MSG]]);
    const adapter = createClaudeAdapter({ queryFn });
    const session = await adapter.createSession({ projectDir: "/repo", wikiMcpUrl: null, log: noopLog });

    const events = await drain(session.prompt("hi"));

    expect(events.map((e) => e.type)).toEqual(["notice", "result"]);
    expect(events[0]).toEqual({
      type: "notice",
      kind: "api_error",
      message: expect.stringContaining("server_error") as unknown as string,
    });
  });

  it("an assistant message without an error tag maps its content as before (no spurious notice)", async () => {
    const { queryFn } = makeQueryFn([[ASSISTANT_MSG, RESULT_MSG]]);
    const adapter = createClaudeAdapter({ queryFn });
    const session = await adapter.createSession({ projectDir: "/repo", wikiMcpUrl: null, log: noopLog });

    const events = await drain(session.prompt("hi"));

    expect(events.map((e) => e.type)).toEqual(["text", "tool_use", "result"]);
  });
});
