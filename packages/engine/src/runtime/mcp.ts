import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { jsonSchema, tool, type Tool } from "ai";
import { createNativeSandboxLaunch, TOOL_OUTPUT_MAX_BYTES } from "./sandbox.js";
import { canonicalRuntimeJson, runtimeFingerprint } from "./context.js";
import type { RuntimeHookBus } from "./hooks.js";
import type { PolicyEvaluator } from "./policy.js";
import type { RuntimeStore } from "./store.js";
import {
  createToolInvocationClaim,
  type ToolClaimPolicy,
  type ToolGateway,
  type ToolResourceClaim,
} from "../tools/gateway.js";

export type McpServerConfiguration =
  | {
      id: string;
      transport: "stdio";
      command: string;
      args?: string[];
      cwd: string;
      environment?: Record<string, string>;
    }
  | {
      id: string;
      transport: "streamable-http";
      url: string;
      credentialRef?: string;
    };

export interface McpToolInventory {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpConnectionResult {
  serverId: string;
  configurationFingerprint: string;
  inventoryFingerprint?: string;
  status: "configuration-approval-required" | "inventory-approval-required" | "connected";
  tools: McpToolInventory[];
}

interface LiveConnection {
  client: Client;
  transport: Transport;
  inventoryFingerprint: string;
  configurationFingerprint: string;
  tools: McpToolInventory[];
  config: McpServerConfiguration;
  cleanup?: () => void | Promise<void>;
}

export function mcpTransportClaims(config: McpServerConfiguration): ToolResourceClaim[] {
  if (config.transport === "stdio") {
    return [{ kind: "process", resource: fs.realpathSync(config.command) }];
  }
  const origin = validateMcpHttpUrl(config.url).origin;
  return [
    { kind: "network", resource: origin },
    ...(config.credentialRef === undefined
      ? []
      : [{ kind: "secret" as const, resource: config.credentialRef }]),
  ];
}

export interface McpManagerOptions {
  transportFactory?: (
    config: McpServerConfiguration,
    credential?: string,
  ) => Promise<{ transport: Transport; cleanup?: () => void | Promise<void> }>;
  fetch?: typeof globalThis.fetch;
  sandboxRunnerExecutable?: string;
  /** @deprecated Use sandboxRunnerExecutable. */
  sandboxExecutable?: string;
}

export class McpConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpConfigurationError";
  }
}

export class McpOutputLimitError extends Error {
  readonly artifactId: string;
  constructor(artifactId: string) {
    super(`MCP result exceeded ${TOOL_OUTPUT_MAX_BYTES} bytes`);
    this.name = "McpOutputLimitError";
    this.artifactId = artifactId;
  }
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function validateMcpHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpConfigurationError("MCP URL is invalid");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new McpConfigurationError("MCP URL must not contain credentials");
  }
  if (url.hash.length > 0) throw new McpConfigurationError("MCP URL must not contain a fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new McpConfigurationError("MCP HTTP requires HTTPS or loopback HTTP");
  }
  return url;
}

export function fingerprintMcpConfiguration(config: McpServerConfiguration): string {
  const normalized = config.transport === "stdio"
    ? {
        id: config.id,
        transport: config.transport,
        command: path.resolve(config.command),
        args: config.args ?? [],
        cwd: path.resolve(config.cwd),
        environmentNames: Object.keys(config.environment ?? {}).sort(),
      }
    : {
        id: config.id,
        transport: config.transport,
        url: validateMcpHttpUrl(config.url).toString(),
        credentialRef: config.credentialRef ?? null,
      };
  return runtimeFingerprint({ profile: config.transport === "stdio" ? "mcp-local-v1" : "mcp-http-v1", ...normalized });
}

function inventoryFingerprint(configFingerprint: string, tools: readonly McpToolInventory[]): string {
  return runtimeFingerprint({
    configFingerprint,
    tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)),
  });
}

function boundedPreview(bytes: Buffer): string {
  const limit = 10 * 1024;
  if (bytes.length <= limit) return bytes.toString("utf8");
  const half = Math.floor(limit / 2);
  return `${bytes.subarray(0, half).toString("utf8")}\n...[${bytes.length - limit} bytes omitted]...\n${bytes.subarray(bytes.length - half).toString("utf8")}`;
}

export class McpManager {
  readonly #options: McpManagerOptions;
  readonly #connections = new Map<string, LiveConnection>();

  constructor(options: McpManagerOptions = {}) {
    this.#options = options;
  }

  async connect(input: {
    config: McpServerConfiguration;
    executionCwd?: string;
    approvedFingerprints: ReadonlySet<string>;
    credentialResolver?: (reference: string) => Promise<string | undefined>;
  }): Promise<McpConnectionResult> {
    const configurationFingerprint = fingerprintMcpConfiguration(input.config);
    if (!input.approvedFingerprints.has(configurationFingerprint)) {
      return {
        serverId: input.config.id,
        configurationFingerprint,
        status: "configuration-approval-required",
        tools: [],
      };
    }
    const live = this.#connections.get(input.config.id);
    if (
      live !== undefined &&
      live.configurationFingerprint === configurationFingerprint &&
      input.approvedFingerprints.has(live.inventoryFingerprint)
    ) {
      return {
        serverId: input.config.id,
        configurationFingerprint,
        inventoryFingerprint: live.inventoryFingerprint,
        status: "connected",
        tools: live.tools,
      };
    }
    await this.disconnect(input.config.id);
    const credential = input.config.transport === "streamable-http" && input.config.credentialRef !== undefined
      ? await input.credentialResolver?.(input.config.credentialRef)
      : undefined;
    const created = this.#options.transportFactory === undefined
      ? await this.#createTransport(input.config, credential, input.executionCwd)
      : await this.#options.transportFactory(input.config, credential);
    const client = new Client({ name: "openfusion", version: "0.0.1" }, { capabilities: {} });
    try {
      await client.connect(created.transport);
      const tools: McpToolInventory[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout: 10_000 });
        tools.push(...result.tools.map((entry) => ({
          name: entry.name,
          ...(entry.description === undefined ? {} : { description: entry.description }),
          inputSchema: entry.inputSchema,
          ...(entry.annotations === undefined ? {} : { annotations: entry.annotations as Record<string, unknown> }),
        })));
        cursor = result.nextCursor;
      } while (cursor !== undefined);
      const discovered = inventoryFingerprint(configurationFingerprint, tools);
      if (!input.approvedFingerprints.has(discovered)) {
        await client.close();
        await created.cleanup?.();
        return {
          serverId: input.config.id,
          configurationFingerprint,
          inventoryFingerprint: discovered,
          status: "inventory-approval-required",
          tools,
        };
      }
      this.#connections.set(input.config.id, {
        client,
        transport: created.transport,
        inventoryFingerprint: discovered,
        configurationFingerprint,
        tools,
        config: input.config,
        ...(created.cleanup === undefined ? {} : { cleanup: created.cleanup }),
      });
      return {
        serverId: input.config.id,
        configurationFingerprint,
        inventoryFingerprint: discovered,
        status: "connected",
        tools,
      };
    } catch (error) {
      await created.transport.close().catch(() => {});
      await created.cleanup?.();
      throw error;
    }
  }

  tools(input: {
    serverId: string;
    store: RuntimeStore;
    sessionId: string;
    policy: PolicyEvaluator;
    interactive: boolean;
    hooks?: RuntimeHookBus;
    gateway: ToolGateway;
    claimPolicies: readonly ToolClaimPolicy[];
    timeoutMs?: number;
  }): Record<string, Tool> {
    const connection = this.#connections.get(input.serverId);
    if (connection === undefined) throw new Error(`MCP server is not connected: ${input.serverId}`);
    return Object.fromEntries(connection.tools.map((definition) => {
      const name = `mcp__${input.serverId}__${definition.name}`;
      const claims = mcpTransportClaims(connection.config);
      input.gateway.registerTool(name, "dangerous");
      const projected = tool({
        description: definition.description ?? `Invoke ${definition.name} on MCP server ${input.serverId}.`,
        inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
        needsApproval: () => input.policy.evaluate({
          capability: "mcp.tool",
          resource: `${input.serverId}:${definition.name}`,
          interactive: input.interactive,
          registered: true,
          sandboxed: true,
        }).decision === "ask",
        execute: async (args, { abortSignal }) => {
          const gatewayDecision = input.gateway.authorize({
            invocation: createToolInvocationClaim(name, claims),
            policies: [
              ...input.claimPolicies,
              { policyId: `tool:${name}`, claims },
            ],
            sandboxed: connection.config.transport === "stdio",
          });
          if (gatewayDecision.decision !== "allow") {
            return { error: "MCP invocation denied by resource policy", errorKind: "policy_denied" };
          }
          const decision = input.policy.evaluate({
            capability: "mcp.tool",
            resource: `${input.serverId}:${definition.name}`,
            interactive: input.interactive,
            registered: true,
            sandboxed: true,
          });
          await input.hooks?.emit("policy.evaluated", {
            sessionId: input.sessionId,
            capability: "mcp.tool",
            decision: decision.decision,
          });
          if (decision.decision === "deny") return { error: decision.reason, errorKind: "policy_denied" };
          const result = await connection.client.callTool(
            { name: definition.name, arguments: args as Record<string, unknown> },
            undefined,
            { signal: abortSignal, timeout: input.timeoutMs ?? 30_000 },
          );
          const bytes = Buffer.from(canonicalRuntimeJson(result), "utf8");
          if (bytes.length > TOOL_OUTPUT_MAX_BYTES) {
            const writer = input.store.beginArtifact(input.sessionId, "mcp-result", {
              maxBytes: TOOL_OUTPUT_MAX_BYTES,
            });
            writer.write(bytes);
            const artifact = writer.finish();
            throw new McpOutputLimitError(artifact.id);
          }
          const artifact = input.store.putArtifact(input.sessionId, "mcp-result", bytes);
          return {
            artifactId: artifact.id,
            outputBytes: bytes.length,
            preview: boundedPreview(bytes),
            truncated: bytes.length > 10 * 1024,
          };
        },
      });
      return [name, projected];
    }));
  }

  async disconnect(serverId: string): Promise<void> {
    const connection = this.#connections.get(serverId);
    if (connection === undefined) return;
    this.#connections.delete(serverId);
    await connection.client.close().catch(() => connection.transport.close().catch(() => {}));
    await connection.cleanup?.();
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#connections.keys()].map((id) => this.disconnect(id)));
  }

  async #createTransport(
    config: McpServerConfiguration,
    credential?: string,
    executionCwd?: string,
  ): Promise<{ transport: Transport; cleanup?: () => void }> {
    if (config.transport === "streamable-http") {
      const base = validateMcpHttpUrl(config.url);
      const baseFetch = this.#options.fetch ?? globalThis.fetch;
      const guardedFetch: typeof globalThis.fetch = async (resource, init) => {
        const requested = validateMcpHttpUrl(String(resource));
        if (requested.origin !== base.origin) throw new McpConfigurationError("MCP request changed origin");
        const response = await baseFetch(resource, { ...init, redirect: "manual" });
        if (response.status >= 300 && response.status < 400) {
          throw new McpConfigurationError("MCP redirects are rejected");
        }
        return response;
      };
      return {
        transport: new StreamableHTTPClientTransport(base, {
          fetch: guardedFetch,
          ...(credential === undefined ? {} : { requestInit: { headers: { Authorization: `Bearer ${credential}` } } }),
        }),
      };
    }
    if (!path.isAbsolute(config.command) || !fs.existsSync(config.command)) {
      throw new McpConfigurationError("MCP stdio command must be an existing absolute path");
    }
    const cwd = fs.realpathSync(executionCwd ?? config.cwd);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openfusion-mcp-"));
    let launch;
    try {
      launch = createNativeSandboxLaunch({
        runnerExecutable: this.#options.sandboxRunnerExecutable ?? this.#options.sandboxExecutable,
        executable: config.command,
        args: config.args ?? [],
        cwd,
        privateTempDir: temp,
        readablePaths: [path.dirname(config.command)],
        executablePaths: [config.command],
        networkGranted: false,
        environment: config.environment,
        profile: "review",
      });
    } catch {
      fs.rmSync(temp, { recursive: true, force: true });
      throw new McpConfigurationError("mcp-local-v1 sandbox backend is unavailable");
    }
    return {
      transport: new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        env: launch.environment as Record<string, string>,
        cwd: launch.cwd,
        stderr: "pipe",
      }),
      cleanup: () => {
        launch.cleanup();
        fs.rmSync(temp, { recursive: true, force: true });
      },
    };
  }
}
