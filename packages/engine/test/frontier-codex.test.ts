import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createCodexAdapter } from "../src/engines/codex.js";
import type { FrontierEvent } from "../src/engines/types.js";

class FakeCodexProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  threadStartParams: Record<string, unknown> | undefined;
  turnStartParams: Record<string, unknown> | undefined;
  #input = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      this.#input += chunk.toString();
      let newline = this.#input.indexOf("\n");
      while (newline >= 0) {
        const line = this.#input.slice(0, newline);
        this.#input = this.#input.slice(newline + 1);
        if (line.length > 0) this.#handle(JSON.parse(line) as Record<string, unknown>);
        newline = this.#input.indexOf("\n");
      }
    });
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }

  #send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  #handle(message: Record<string, unknown>): void {
    const id = message.id;
    const method = message.method;
    if (method === "initialize") {
      this.#send({ id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } });
      return;
    }
    if (method === "model/list") {
      this.#send({
        id,
        result: {
          data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test", description: "A test model", isDefault: true }],
          nextCursor: null,
        },
      });
      return;
    }
    if (method === "thread/start") {
      this.threadStartParams = message.params as Record<string, unknown>;
      this.#send({ id, result: { thread: { id: "thread-1" }, model: "gpt-test", modelProvider: "openai" } });
      return;
    }
    if (method === "turn/start") {
      this.turnStartParams = message.params as Record<string, unknown>;
      this.#send({ id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
      queueMicrotask(() => {
        this.#send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "commandExecution", id: "item-1" } } });
        this.#send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-2", delta: "OK" } });
        this.#send({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: { last: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 } },
          },
        });
        this.#send({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", durationMs: 25, error: null } },
        });
      });
    }
  }
}

function fakeSpawn(processes: FakeCodexProcess[]): typeof spawn {
  return (() => {
    const child = new FakeCodexProcess();
    processes.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof spawn;
}

async function drain(events: AsyncIterable<FrontierEvent>): Promise<FrontierEvent[]> {
  const result: FrontierEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("createCodexAdapter", () => {
  it("discovers the app-server model catalog", async () => {
    const processes: FakeCodexProcess[] = [];
    const adapter = createCodexAdapter({ spawnFn: fakeSpawn(processes) });

    await expect(adapter.listModels?.()).resolves.toEqual([
      { id: "gpt-test", displayName: "GPT Test", description: "A test model", isDefault: true },
    ]);
    expect(processes).toHaveLength(1);
  });

  it("passes the selected model and exact write roots, then maps streamed events", async () => {
    const processes: FakeCodexProcess[] = [];
    const onResult = vi.fn();
    const adapter = createCodexAdapter({ spawnFn: fakeSpawn(processes), onResult });
    const session = await adapter.createSession({
      projectDir: "/repo",
      wikiMcpUrl: null,
      log: () => {},
      model: "gpt-test",
      toolPolicy: { writeScope: ["/repo/worktree"] },
      resultLabel: "frontier-escalate",
    });

    const events = await drain(
      session.prompt("reply OK", {
        outputSchema: { type: "object", properties: { reply: { type: "string" } } },
      }).events,
    );
    const process = processes[0]!;

    expect(process.threadStartParams).toMatchObject({ model: "gpt-test", cwd: "/repo", approvalPolicy: "never" });
    expect(process.turnStartParams).toMatchObject({
      sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/repo/worktree"], networkAccess: false },
    });
    expect(events.map((event) => event.type)).toEqual(["tool_use", "text", "result"]);
    expect(events.at(-1)).toMatchObject({
      resultText: "OK",
      usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4 },
      durationMs: 25,
    });
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ type: "result" }), "gpt-test", "frontier-escalate");
    await session.close();
  });

  it("passes loopback MCP authorization through Codex configuration", async () => {
    const processes: FakeCodexProcess[] = [];
    const adapter = createCodexAdapter({ spawnFn: fakeSpawn(processes) });
    const session = await adapter.createSession({
      projectDir: "/repo",
      wikiMcpUrl: "http://127.0.0.1:9999/mcp",
      wikiMcpBearerToken: "ephemeral-token",
      log: () => {},
    });

    expect(processes[0]!.threadStartParams).toMatchObject({
      config: {
        mcp_servers: {
          wiki: {
            url: "http://127.0.0.1:9999/mcp",
            http_headers: { Authorization: "Bearer ephemeral-token" },
          },
        },
      },
    });
    await session.close();
  });
});
