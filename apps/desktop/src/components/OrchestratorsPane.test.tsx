import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

afterEach(cleanup);

const { statusMock, loginMock, logoutMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  loginMock: vi.fn(),
  logoutMock: vi.fn(),
}));

vi.mock("../engineClient", () => ({
  frontierLoginStatus: statusMock,
  frontierLogin: loginMock,
  frontierLogout: logoutMock,
}));

import { OrchestratorsPane } from "./OrchestratorsPane";

beforeEach(() => {
  statusMock.mockReset();
  loginMock.mockReset();
  logoutMock.mockReset();
  loginMock.mockResolvedValue(undefined);
  logoutMock.mockResolvedValue(undefined);
});

describe("OrchestratorsPane", () => {
  it("shows Connected with a Sign out button when the CLI is logged in", async () => {
    statusMock.mockResolvedValue({ state: "connected" });
    render(<OrchestratorsPane />);
    await waitFor(() => expect(screen.getByText(/connected/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();
  });

  it("shows Connect when disconnected, and launches login then re-probes", async () => {
    statusMock.mockResolvedValueOnce({ state: "disconnected" }).mockResolvedValueOnce({ state: "connected" });
    render(<OrchestratorsPane />);
    const connect = await screen.findByRole("button", { name: /^connect$/i });
    fireEvent.click(connect);
    await waitFor(() => expect(loginMock).toHaveBeenCalledWith("claude-code"));
    await waitFor(() => expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy());
  });

  it("shows an install hint (no Connect) when the CLI is not installed", async () => {
    statusMock.mockResolvedValue({ state: "not-installed" });
    render(<OrchestratorsPane />);
    await waitFor(() => expect(screen.getByText(/isn't installed/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^connect$/i })).toBeNull();
  });
});
