import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { runtimeCapabilities } from "../runtime/capabilities.js";
import type { FrontierAdapter, FrontierEvent, FrontierModel, FrontierPromptHandle, FrontierSession } from "./types.js";

const CODEX_KIND = "codex";
const REQUEST_TIMEOUT_MS = 15_000;

type JsonObject = Record<string, unknown>;
type SpawnFn = typeof spawn;

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface RpcNotification {
  method: string;
  params?: JsonObject;
}

interface ActiveCodexTurn {
  queue: AsyncEventQueue;
  turnId?: string;
  text: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

class AsyncEventQueue implements AsyncIterable<FrontierEvent> {
  #values: FrontierEvent[] = [];
  #waiters: Array<(result: IteratorResult<FrontierEvent>) => void> = [];
  #ended = false;

  push(value: FrontierEvent): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ value, done: false });
    else this.#values.push(value);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<FrontierEvent> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class CodexAppServer {
  readonly child: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #listeners = new Set<(notification: RpcNotification) => void>();
  #closed = false;

  private constructor(child: ChildProcessWithoutNullStreams, log: (line: string) => void) {
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#onLine(line));
    // App-server diagnostics are intentionally not forwarded (they can carry
    // paths/config context), but the pipe must still be drained so a verbose
    // subprocess cannot deadlock on a full stderr buffer.
    child.stderr.on("data", () => {});
    child.once("error", (err) => this.#failAll(new Error(`could not start Codex app-server: ${err.message}`)));
    child.once("exit", (code) => {
      if (!this.#closed && code !== 0) log(`codex app-server exited with status ${code ?? -1}`);
      this.#failAll(new Error(`Codex app-server exited with status ${code ?? -1}`));
    });
  }

  static async start(spawnFn: SpawnFn, log: (line: string) => void): Promise<CodexAppServer> {
    const child = spawnFn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    const server = new CodexAppServer(child, log);
    await server.request("initialize", {
      clientInfo: { name: "openfusion", title: "OpenFusion", version: "0.1.0" },
      capabilities: null,
    });
    server.notify("initialized", {});
    return server;
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Codex app-server is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ method, id, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.child.kill();
    this.#failAll(new Error("Codex app-server closed"));
  }

  #write(message: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const response = message as unknown as RpcResponse;
      const pending = this.#pending.get(response.id);
      if (pending === undefined) return;
      this.#pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error !== undefined) {
        pending.reject(new Error(response.error.message ?? `Codex request failed (${response.error.code ?? -1})`));
      } else {
        pending.resolve(response.result);
      }
      return;
    }
    if (typeof message.method === "string" && !("id" in message)) {
      const notification = message as unknown as RpcNotification;
      for (const listener of this.#listeners) listener(notification);
      return;
    }
    // Approval policy is always "never", so a server request is unexpected.
    // Reject it explicitly instead of leaving the app-server waiting forever.
    if (typeof message.method === "string" && (typeof message.id === "number" || typeof message.id === "string")) {
      this.#write({ id: message.id, error: { code: -32601, message: "OpenFusion does not support interactive app-server requests" } });
    }
  }

  #failAll(err: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null ? (value as JsonObject) : {};
}

function stringField(value: unknown, key: string): string | undefined {
  const field = asObject(value)[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  const field = asObject(value)[key];
  return typeof field === "number" ? field : undefined;
}

async function listCodexModels(spawnFn: SpawnFn): Promise<FrontierModel[]> {
  const server = await CodexAppServer.start(spawnFn, () => {});
  try {
    const models: FrontierModel[] = [];
    let cursor: string | null = null;
    do {
      const result = asObject(await server.request("model/list", { cursor, limit: 100, includeHidden: false }));
      const data = Array.isArray(result.data) ? result.data : [];
      for (const raw of data) {
        const model = asObject(raw);
        const id = typeof model.model === "string" ? model.model : typeof model.id === "string" ? model.id : undefined;
        if (id === undefined) continue;
        models.push({
          id,
          displayName: typeof model.displayName === "string" ? model.displayName : id,
          description: typeof model.description === "string" ? model.description : "",
          isDefault: model.isDefault === true,
        });
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
    } while (cursor !== null);
    return models;
  } finally {
    server.close();
  }
}

export interface CreateCodexAdapterOptions {
  spawnFn?: SpawnFn;
  onResult?: (result: Extract<FrontierEvent, { type: "result" }>, model: string, resultLabel?: string) => void;
}

export function createCodexAdapter(options: CreateCodexAdapterOptions = {}): FrontierAdapter {
  const spawnFn = options.spawnFn ?? spawn;
  return {
    kind: CODEX_KIND,
    capabilities: () => runtimeCapabilities({
      runtimeId: CODEX_KIND,
      runtimeVersion: "app-server",
      protocolVersion: "codex-app-server-v1",
      structuredOutput: false,
      toolCalls: true,
      pathAwareApprovals: true,
      mcp: true,
      resume: true,
      fork: false,
      compaction: false,
      // The adapter always supplies an explicit readOnly/workspaceWrite
      // sandboxPolicy with network disabled; protocol contract tests pin
      // that request. Treat this runtime path as certified for those roles.
      sandboxCompatibility: "certified",
    }),
    listModels: () => listCodexModels(spawnFn),

    async createSession({
      projectDir,
      wikiMcpUrl,
      wikiMcpBearerToken,
      log,
      model,
      toolPolicy,
      resultLabel,
    }): Promise<FrontierSession> {
      const server = await CodexAppServer.start(spawnFn, log);
      const writableRoots = toolPolicy?.writeScope ?? [];
      const writable = writableRoots.length > 0;
      const config = wikiMcpUrl === null
        ? undefined
        : {
            mcp_servers: {
              wiki: {
                url: wikiMcpUrl,
                ...(wikiMcpBearerToken === undefined
                  ? {}
                  : { http_headers: { Authorization: `Bearer ${wikiMcpBearerToken}` } }),
              },
            },
          };
      let threadResult: JsonObject;
      try {
        threadResult = asObject(await server.request("thread/start", {
          cwd: projectDir,
          ...(model !== undefined ? { model } : {}),
          approvalPolicy: "never",
          sandbox: writable ? "workspace-write" : "read-only",
          ephemeral: true,
          ...(config !== undefined ? { config } : {}),
        }));
      } catch (err) {
        server.close();
        throw err;
      }
      const threadId = stringField(threadResult.thread, "id");
      if (threadId === undefined) {
        server.close();
        throw new Error("Codex thread/start returned no thread id");
      }
      const resolvedModel = stringField(threadResult, "model") ?? model ?? CODEX_KIND;
      let closed = false;
      let active: ActiveCodexTurn | undefined;

      const unsubscribe = server.onNotification((notification) => {
        const current = active;
        if (current === undefined) return;
        const params = asObject(notification.params);
        if (stringField(params, "threadId") !== threadId) return;
        if (notification.method === "item/agentMessage/delta") {
          const delta = stringField(params, "delta") ?? "";
          current.text += delta;
          if (delta.length > 0) current.queue.push({ type: "text", text: delta });
          return;
        }
        if (notification.method === "item/started") {
          const item = asObject(params.item);
          const type = stringField(item, "type");
          if (type !== undefined && !["userMessage", "agentMessage", "reasoning", "plan"].includes(type)) {
            current.queue.push({ type: "tool_use", name: type, summary: `Codex ${type}` });
          }
          return;
        }
        if (notification.method === "thread/tokenUsage/updated") {
          const last = asObject(asObject(params.tokenUsage).last);
          current.usage = {
            inputTokens: numberField(last, "inputTokens") ?? 0,
            outputTokens: numberField(last, "outputTokens") ?? 0,
            cacheReadTokens: numberField(last, "cachedInputTokens") ?? 0,
          };
          return;
        }
        if (notification.method === "warning") {
          current.queue.push({ type: "notice", kind: "api_error", message: stringField(params, "message") ?? "Codex warning" });
          return;
        }
        if (notification.method !== "turn/completed") return;
        const turn = asObject(params.turn);
        const status = stringField(turn, "status");
        if (status !== "completed") {
          const error = asObject(turn.error);
          current.queue.push({ type: "error", message: stringField(error, "message") ?? `Codex turn ${status ?? "failed"}` });
          clearTimeout(current.timer);
          current.queue.end();
          active = undefined;
          return;
        }
        const result: Extract<FrontierEvent, { type: "result" }> = {
          type: "result",
          resultText: current.text,
          costUsd: null,
          usage: current.usage,
          numTurns: 1,
          durationMs: numberField(turn, "durationMs") ?? Date.now() - current.startedAt,
          engineSessionId: threadId,
        };
        current.queue.push(result);
        options.onResult?.(result, resolvedModel, resultLabel);
        clearTimeout(current.timer);
        current.queue.end();
        active = undefined;
      });

      return {
        id: threadId,
        projectDir,
        prompt(text, promptOptions): FrontierPromptHandle {
          if (closed) throw new Error("Codex session is closed");
          if (active !== undefined) throw new Error("Codex prompt already in flight");
          const queue = new AsyncEventQueue();
          const state: ActiveCodexTurn = {
            queue,
            text: "",
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
            startedAt: Date.now(),
          };
          active = state;
          if (promptOptions?.timeoutMs !== undefined) {
            state.timer = setTimeout(() => {
              const current = active;
              if (current !== state) return;
              if (state.turnId !== undefined) {
                void server.request("turn/interrupt", { threadId, turnId: state.turnId }).catch(() => {});
              } else {
                closed = true;
                server.close();
              }
              state.queue.push({ type: "error", message: "prompt timed out" });
              state.queue.end();
              active = undefined;
            }, promptOptions.timeoutMs);
          }
          void server
            .request(
              "turn/start",
              {
                threadId,
                input: [{ type: "text", text }],
                sandboxPolicy: writable
                  ? {
                      type: "workspaceWrite",
                      writableRoots,
                      networkAccess: false,
                      excludeTmpdirEnvVar: true,
                      excludeSlashTmp: true,
                    }
                  : { type: "readOnly", networkAccess: false },
              },
              promptOptions?.timeoutMs,
            )
            .then((value) => {
              const turnId = stringField(asObject(value).turn, "id");
              if (active === state && turnId !== undefined) state.turnId = turnId;
            })
            .catch((err: unknown) => {
              if (active !== state) return;
              state.queue.push({ type: "error", message: err instanceof Error ? err.message : String(err) });
              clearTimeout(state.timer);
              state.queue.end();
              active = undefined;
            });
          return {
            events: queue,
            abort(): void {
              if (active !== state) return;
              clearTimeout(state.timer);
              if (state.turnId !== undefined) {
                void server.request("turn/interrupt", { threadId, turnId: state.turnId }).catch(() => {});
              } else {
                closed = true;
                server.close();
              }
              state.queue.end();
              active = undefined;
            },
          };
        },
        async close(): Promise<void> {
          if (closed) return;
          closed = true;
          if (active !== undefined) {
            clearTimeout(active.timer);
            active.queue.end();
            active = undefined;
          }
          unsubscribe();
          server.close();
        },
      };
    },
  };
}
