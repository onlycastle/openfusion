import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import {
  McpConfigurationError,
  McpManager,
  fingerprintMcpConfiguration,
  mcpTransportClaims,
  validateMcpHttpUrl,
  type McpServerConfiguration,
} from "../src/runtime/mcp.js";
import { PolicyEvaluator } from "../src/runtime/policy.js";
import { createToolInvocationClaim, ToolGateway } from "../src/tools/gateway.js";

class FakeMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly toolDescription: string;

  constructor(toolDescription: string) {
    this.toolDescription = toolDescription;
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!("id" in message) || !("method" in message)) return;
    const request = message as { id: string | number; method: string };
    let result: unknown;
    if (request.method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      };
    } else if (request.method === "tools/list") {
      result = {
        tools: [{
          name: "echo",
          description: this.toolDescription,
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        }],
      };
    } else if (request.method === "ping") {
      result = {};
    } else {
      result = {};
    }
    queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id: request.id, result } as JSONRPCMessage));
  }
}

describe("MCP runtime", () => {
  it("declares approved HTTP transport and credential use as dynamic gateway claims", () => {
    const config: McpServerConfiguration = {
      id: "fixture",
      transport: "streamable-http",
      url: "https://example.test/mcp",
      credentialRef: "mcp-fixture",
    };
    const claims = mcpTransportClaims(config);
    expect(claims).toEqual([
      { kind: "network", resource: "https://example.test" },
      { kind: "secret", resource: "mcp-fixture" },
    ]);
    const invocation = createToolInvocationClaim("mcp__fixture__echo", claims);
    const policies = [
      { policyId: "parent", claims },
      { policyId: "role", claims },
      { policyId: "tool", claims },
    ];
    const denied = new ToolGateway();
    denied.registerTool(invocation.toolId, "dangerous");
    expect(denied.authorize({ invocation, policies, sandboxed: false }).decision).toBe("deny");

    const allowed = new ToolGateway({
      evaluator: new PolicyEvaluator({
        projectGrants: {
          id: "approved-mcp",
          rules: [
            { id: "network", capability: "network", resource: "https://example.test", decision: "allow" },
            { id: "secret", capability: "secret.use", resource: "mcp-fixture", decision: "allow" },
          ],
        },
      }),
    });
    allowed.registerTool(invocation.toolId, "dangerous");
    expect(allowed.authorize({ invocation, policies, sandboxed: false }).decision).toBe("allow");
  });

  it("allows HTTPS and loopback HTTP only", () => {
    expect(validateMcpHttpUrl("https://example.test/mcp").protocol).toBe("https:");
    expect(validateMcpHttpUrl("http://127.0.0.1:3000/mcp").hostname).toBe("127.0.0.1");
    expect(() => validateMcpHttpUrl("http://example.test/mcp")).toThrow(McpConfigurationError);
    expect(() => validateMcpHttpUrl("https://user:pass@example.test/mcp")).toThrow(/credentials/);
  });

  it("requires approval for configuration and then the discovered schema fingerprint", async () => {
    const config: McpServerConfiguration = {
      id: "fixture",
      transport: "streamable-http",
      url: "https://example.test/mcp",
      credentialRef: "mcp-fixture",
    };
    let description = "first";
    const manager = new McpManager({
      transportFactory: async () => ({ transport: new FakeMcpTransport(description) }),
    });
    const configFingerprint = fingerprintMcpConfiguration(config);
    await expect(manager.connect({ config, approvedFingerprints: new Set() })).resolves.toMatchObject({
      status: "configuration-approval-required",
      configurationFingerprint: configFingerprint,
    });
    const discovered = await manager.connect({
      config,
      approvedFingerprints: new Set([configFingerprint]),
      credentialResolver: async () => "memory-only",
    });
    expect(discovered).toMatchObject({ status: "inventory-approval-required" });
    const inventoryFingerprint = discovered.inventoryFingerprint!;
    await expect(manager.connect({
      config,
      approvedFingerprints: new Set([configFingerprint, inventoryFingerprint]),
    })).resolves.toMatchObject({ status: "connected" });

    await manager.disconnect(config.id);
    description = "schema drift";
    const drift = await manager.connect({
      config,
      approvedFingerprints: new Set([configFingerprint, inventoryFingerprint]),
    });
    expect(drift.status).toBe("inventory-approval-required");
    expect(drift.inventoryFingerprint).not.toBe(inventoryFingerprint);
    await manager.close();
  });
});
