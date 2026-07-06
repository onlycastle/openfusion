import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

afterEach(cleanup);

const { statusMock, modelsListMock, listProviderConfigsMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  modelsListMock: vi.fn(),
  listProviderConfigsMock: vi.fn(),
}));

vi.mock("../engineClient", () => ({
  engineClient: { modelsList: modelsListMock, modelsConfigure: vi.fn() },
  frontierLoginStatus: statusMock,
  frontierLogin: vi.fn(),
  frontierLogout: vi.fn(),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  saveProviderConfig: vi.fn(),
  deleteProviderConfig: vi.fn(),
  listProviderConfigs: listProviderConfigsMock,
}));

import { SettingsDialog } from "./SettingsDialog";

beforeEach(() => {
  statusMock.mockResolvedValue({ state: "disconnected" });
  modelsListMock.mockResolvedValue({ providers: [] });
  listProviderConfigsMock.mockResolvedValue([]);
});

describe("SettingsDialog", () => {
  it("renders both groups when open", async () => {
    render(<SettingsDialog open onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /orchestrators/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /model providers/i })).toBeTruthy();
    await waitFor(() => expect(statusMock).toHaveBeenCalledWith("claude-code"));
  });

  it("renders nothing when closed", () => {
    render(<SettingsDialog open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
