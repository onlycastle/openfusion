import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { harnessStatusMock, harnessReadMock, updateModelMock, updateEscMock, listConfigsMock } = vi.hoisted(() => ({
  harnessStatusMock: vi.fn(), harnessReadMock: vi.fn(), updateModelMock: vi.fn(), updateEscMock: vi.fn(), listConfigsMock: vi.fn(),
}));
vi.mock("../engineClient", () => ({
  engineClient: {
    harnessStatus: harnessStatusMock, harnessRead: harnessReadMock,
    harnessUpdateAgentModel: updateModelMock, harnessUpdateEscalation: updateEscMock,
  },
  listProviderConfigs: listConfigsMock,
}));
vi.mock("../ProjectContext", () => ({ useProject: () => ({ activeProjectDir: "/r/alpha" }) }));

import { HarnessSettingPanel } from "./HarnessSettingPanel";

afterEach(cleanup);
beforeEach(() => {
  for (const m of [harnessStatusMock, harnessReadMock, updateModelMock, updateEscMock, listConfigsMock]) m.mockReset();
  harnessStatusMock.mockResolvedValue({ present: true, structural: "pass", headSha: "abc" });
  harnessReadMock.mockResolvedValue({
    agents: [
      { name: "coder", role: "writes code", taskClasses: ["codegen"], model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" } },
      { name: "fallback", role: "default", taskClasses: ["docs"], model: "frontier" },
    ],
    defaultAgent: "fallback", escalation: 2,
  });
  listConfigsMock.mockResolvedValue([
    { id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash" },
    { id: "moonshot", kind: "moonshot", model: "kimi-k2.7-code" },
  ]);
  updateModelMock.mockResolvedValue({ updated: true });
  updateEscMock.mockResolvedValue({ updated: true });
});

describe("HarnessSettingPanel", () => {
  it("renders the agent team with model selects once ready", async () => {
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText("coder")).toBeTruthy());
    expect(screen.getByText("fallback")).toBeTruthy();
    // task-class chips are read-only text
    expect(screen.getByText("codegen")).toBeTruthy();
  });

  it("reassigns an agent's model on select change (optimistic)", async () => {
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText("coder")).toBeTruthy());
    const select = screen.getByLabelText(/model for coder/i);
    fireEvent.change(select, { target: { value: "moonshot" } });
    await waitFor(() => expect(updateModelMock).toHaveBeenCalledWith(
      "/r/alpha", "coder", { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" },
    ));
  });

  it("updates escalation on change", async () => {
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText("coder")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/escalate to frontier/i), { target: { value: "3" } });
    await waitFor(() => expect(updateEscMock).toHaveBeenCalledWith("/r/alpha", 3));
  });

  it("shows a generate prompt when no harness exists", async () => {
    harnessStatusMock.mockResolvedValue({ present: false, structural: "pass", headSha: "abc" });
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText(/no harness yet/i)).toBeTruthy());
  });
});
