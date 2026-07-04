import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// `test.globals` is `false` (see vite.config.ts) so RTL's auto-registered
// `afterEach(cleanup)` never fires — do it explicitly, same as App.test.tsx.
afterEach(cleanup);

// Mock the three free secret functions KeysScreen imports directly from
// `../engineClient` — the screen-level unit under test is the component's
// state machine (persist-default-off, write-only value field, error
// handling), not the invoke() plumbing (that's engineClient.test.ts's job).
const { setSecretMock, deleteSecretMock, listSecretIdsMock } = vi.hoisted(() => ({
  setSecretMock: vi.fn(),
  deleteSecretMock: vi.fn(),
  listSecretIdsMock: vi.fn(),
}));

vi.mock("../engineClient", () => ({
  setSecret: setSecretMock,
  deleteSecret: deleteSecretMock,
  listSecretIds: listSecretIdsMock,
}));

import { KeysScreen } from "./KeysScreen";

beforeEach(() => {
  setSecretMock.mockReset();
  deleteSecretMock.mockReset();
  listSecretIdsMock.mockReset();
  listSecretIdsMock.mockResolvedValue([]);
  setSecretMock.mockResolvedValue(undefined);
  deleteSecretMock.mockResolvedValue(undefined);
});

describe("KeysScreen", () => {
  it("defaults the persist toggle to OFF: submitting without touching it calls setSecret with persist=false", async () => {
    render(<KeysScreen />);
    await waitFor(() => expect(listSecretIdsMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/provider id/i), { target: { value: "anthropic" } });
    fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => expect(setSecretMock).toHaveBeenCalledWith("anthropic", "sk-test-123", false));
  });

  it("calls setSecret with persist=true once the Keychain toggle is explicitly checked", async () => {
    render(<KeysScreen />);
    await waitFor(() => expect(listSecretIdsMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/provider id/i), { target: { value: "openai" } });
    fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value: "sk-test-456" } });
    fireEvent.click(screen.getByLabelText(/keychain/i));
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => expect(setSecretMock).toHaveBeenCalledWith("openai", "sk-test-456", true));
  });

  it("clears the value field and resets persist to OFF after a successful add", async () => {
    render(<KeysScreen />);
    await waitFor(() => expect(listSecretIdsMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/provider id/i), { target: { value: "anthropic" } });
    const valueInput = screen.getByLabelText(/^value$/i) as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "sk-test-123" } });
    fireEvent.click(screen.getByLabelText(/keychain/i));
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => expect(setSecretMock).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByLabelText(/^value$/i) as HTMLInputElement).value).toBe(""));
    expect((screen.getByLabelText(/keychain/i) as HTMLInputElement).checked).toBe(false);
  });

  it("never renders a configured id's secret value: the value field is write-only", async () => {
    listSecretIdsMock.mockResolvedValue(["anthropic"]);
    render(<KeysScreen />);

    await waitFor(() => expect(screen.getByText("anthropic")).toBeTruthy());

    // The screen never fetches a value for a configured id at all (no
    // getSecret call anywhere in KeysScreen) — assert the DOM never contains
    // a stand-in "stored" value, and that the value input itself is a
    // password field starting empty (not pre-filled from anywhere).
    const wouldBeSecretValue = "sk-should-never-appear-anywhere";
    expect(document.body.textContent).not.toContain(wouldBeSecretValue);
    const valueInput = screen.getByLabelText(/^value$/i) as HTMLInputElement;
    expect(valueInput.type).toBe("password");
    expect(valueInput.value).toBe("");
  });

  it("shows a 'configured' state for existing ids without exposing a value", async () => {
    listSecretIdsMock.mockResolvedValue(["anthropic", "deepseek"]);
    render(<KeysScreen />);

    await waitFor(() => expect(screen.getByText("anthropic")).toBeTruthy());
    expect(screen.getAllByText(/configured/i).length).toBeGreaterThanOrEqual(2);
  });

  it("deletes a key and refreshes the list", async () => {
    listSecretIdsMock.mockResolvedValueOnce(["anthropic"]).mockResolvedValueOnce([]);
    render(<KeysScreen />);
    await waitFor(() => expect(screen.getByText("anthropic")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => expect(deleteSecretMock).toHaveBeenCalledWith("anthropic"));
    await waitFor(() => expect(screen.getByText(/no keys set yet/i)).toBeTruthy());
  });

  it("renders a friendly inline error (not a crash) when setSecret rejects with a plain string", async () => {
    setSecretMock.mockRejectedValueOnce("keychain is locked");
    render(<KeysScreen />);
    await waitFor(() => expect(listSecretIdsMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/provider id/i), { target: { value: "anthropic" } });
    fireEvent.change(screen.getByLabelText(/^value$/i), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/keychain is locked/i);
  });

  it("renders a friendly inline error (not a crash) when deleteSecret rejects", async () => {
    listSecretIdsMock.mockResolvedValue(["anthropic"]);
    deleteSecretMock.mockRejectedValueOnce("backend unavailable");
    render(<KeysScreen />);
    await waitFor(() => expect(screen.getByText("anthropic")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/backend unavailable/i);
  });

  it("does not call setSecret when the id or value is blank", async () => {
    render(<KeysScreen />);
    await waitFor(() => expect(listSecretIdsMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /add/i }));

    expect(setSecretMock).not.toHaveBeenCalled();
  });
});
