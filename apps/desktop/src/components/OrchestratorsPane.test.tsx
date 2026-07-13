import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";

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
    const [claudeRow, codexRow] = screen.getAllByRole("listitem");
    await waitFor(() => expect(within(claudeRow!).getByText(/connected/i)).toBeTruthy());
    expect(within(claudeRow!).getByRole("button", { name: /sign out/i })).toBeTruthy();
    expect(within(codexRow!).getByRole("button", { name: /sign out/i })).toBeTruthy();
  });

  it("shows Connect when disconnected, and launches login then re-probes", async () => {
    const onSettingsChanged = vi.fn();
    let claudeChecks = 0;
    statusMock.mockImplementation((engine: string) => Promise.resolve(
      engine === "claude-code"
        ? { state: ++claudeChecks === 1 ? "disconnected" : "connected" }
        : { state: "not-installed" },
    ));
    render(<OrchestratorsPane onSettingsChanged={onSettingsChanged} />);
    const [claudeRow] = screen.getAllByRole("listitem");
    const connect = await within(claudeRow!).findByRole("button", { name: /^connect$/i });
    fireEvent.click(connect);
    await waitFor(() => expect(loginMock).toHaveBeenCalledWith("claude-code"));
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(within(claudeRow!).getByRole("button", { name: /sign out/i })).toBeTruthy());
  });

  it("shows an install hint (no Connect) when the CLI is not installed", async () => {
    statusMock.mockResolvedValue({ state: "not-installed" });
    render(<OrchestratorsPane />);
    await waitFor(() => expect(screen.getAllByText(/isn't installed/i)).toHaveLength(2));
    expect(screen.queryByRole("button", { name: /^connect$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /sign in with chatgpt/i })).toBeNull();
  });

  it("shows the Codex ChatGPT login and invokes the Codex CLI flow", async () => {
    let codexChecks = 0;
    statusMock.mockImplementation((engine: string) => Promise.resolve(
      engine === "codex"
        ? { state: ++codexChecks === 1 ? "disconnected" : "connected" }
        : { state: "connected" },
    ));
    render(<OrchestratorsPane />);

    const [, codexRow] = screen.getAllByRole("listitem");
    expect(within(codexRow!).getByText("OpenAI Codex")).toBeTruthy();
    const signIn = await within(codexRow!).findByRole("button", { name: /sign in with chatgpt/i });
    fireEvent.click(signIn);

    await waitFor(() => expect(loginMock).toHaveBeenCalledWith("codex"));
    await waitFor(() => expect(within(codexRow!).getByText(/connected/i)).toBeTruthy());
  });
});
