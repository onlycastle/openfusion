import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {},
}));

import { EngineClient } from "./engineClient";

beforeEach(() => invokeMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe("harness read/update wrappers", () => {
  it("harnessRead calls engine.harness.read", async () => {
    const team = { agents: [], defaultAgent: "coder", escalation: 2 };
    invokeMock.mockResolvedValue(team);
    const client = new EngineClient();
    await expect(client.harnessRead("/r/a")).resolves.toEqual(team);
    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.harness.read", params: { projectDir: "/r/a" }, timeoutMs: undefined,
    });
  });

  it("harnessUpdateAgentModel forwards agentName + model", async () => {
    invokeMock.mockResolvedValue({ updated: true });
    const client = new EngineClient();
    await client.harnessUpdateAgentModel("/r/a", "coder", { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" });
    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.harness.updateAgentModel",
      params: { projectDir: "/r/a", agentName: "coder", model: { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" } },
      timeoutMs: undefined,
    });
  });

  it("harnessUpdateEscalation forwards the count", async () => {
    invokeMock.mockResolvedValue({ updated: true });
    const client = new EngineClient();
    await client.harnessUpdateEscalation("/r/a", 3);
    expect(invokeMock).toHaveBeenCalledWith("engine_call", {
      method: "engine.harness.updateEscalation",
      params: { projectDir: "/r/a", failuresBeforeFrontier: 3 }, timeoutMs: undefined,
    });
  });
});
