import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";

afterEach(cleanup);

const { statusMock, modelsListMock, frontierModelsMock, listProviderConfigsMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  modelsListMock: vi.fn(),
  frontierModelsMock: vi.fn(),
  listProviderConfigsMock: vi.fn(),
}));

vi.mock("../engineClient", () => ({
  engineClient: { modelsList: modelsListMock, modelsConfigure: vi.fn(), frontierModels: frontierModelsMock },
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
  frontierModelsMock.mockResolvedValue({ models: [], unavailable: [] });
  listProviderConfigsMock.mockResolvedValue([]);
});

describe("SettingsDialog", () => {
  it("renders Connections, Lead models, and Worker models panes when open", async () => {
    render(<SettingsDialog open onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: /openfusion settings/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /connections/i })).toBeTruthy();
    await waitFor(() => expect(statusMock).toHaveBeenCalledWith("claude-code"));
    const connectionsTab = screen.getByRole("tab", { name: /connections/i });
    connectionsTab.focus();
    fireEvent.keyDown(connectionsTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /lead models/i, selected: true })).toBe(document.activeElement);
    expect(screen.getByRole("heading", { name: /lead models/i })).toBeTruthy();
  });

  it("renders nothing when closed", () => {
    render(<SettingsDialog open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
