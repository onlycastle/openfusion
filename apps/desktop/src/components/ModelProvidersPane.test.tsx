import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

afterEach(cleanup);

const { modelsCheckConnectionMock, modelsConfigureMock, modelsUnconfigureMock, modelsListMock, setSecretMock, deleteSecretMock, saveProviderConfigMock, deleteProviderConfigMock, listProviderConfigsMock } = vi.hoisted(() => ({
  modelsCheckConnectionMock: vi.fn(),
  modelsConfigureMock: vi.fn(),
  modelsUnconfigureMock: vi.fn(),
  modelsListMock: vi.fn(),
  setSecretMock: vi.fn(),
  deleteSecretMock: vi.fn(),
  saveProviderConfigMock: vi.fn(),
  deleteProviderConfigMock: vi.fn(),
  listProviderConfigsMock: vi.fn(),
}));

vi.mock("../engineClient", () => ({
  engineClient: {
    modelsCheckConnection: modelsCheckConnectionMock,
    modelsConfigure: modelsConfigureMock,
    modelsUnconfigure: modelsUnconfigureMock,
    modelsList: modelsListMock,
  },
  setSecret: setSecretMock,
  deleteSecret: deleteSecretMock,
  saveProviderConfig: saveProviderConfigMock,
  deleteProviderConfig: deleteProviderConfigMock,
  listProviderConfigs: listProviderConfigsMock,
}));

import { ModelProvidersPane } from "./ModelProvidersPane";

beforeEach(() => {
  for (const m of [modelsCheckConnectionMock, modelsConfigureMock, modelsUnconfigureMock, modelsListMock, setSecretMock, deleteSecretMock, saveProviderConfigMock, deleteProviderConfigMock, listProviderConfigsMock]) m.mockReset();
  modelsListMock.mockResolvedValue({ providers: [] });
  listProviderConfigsMock.mockResolvedValue([]);
  modelsCheckConnectionMock.mockResolvedValue({ connected: true });
  modelsConfigureMock.mockResolvedValue({ configured: true });
  modelsUnconfigureMock.mockResolvedValue({ unconfigured: true });
  setSecretMock.mockResolvedValue(undefined);
  deleteSecretMock.mockResolvedValue(undefined);
  saveProviderConfigMock.mockResolvedValue(undefined);
  deleteProviderConfigMock.mockResolvedValue(undefined);
});

async function renderAndOpenProviderSheet() {
  render(<ModelProvidersPane />);
  await waitFor(() => expect(modelsListMock).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /add worker model/i }));
}

describe("ModelProvidersPane", () => {
  it("configures a DeepSeek provider and stores the key on Save (persist off by default)", async () => {
    const onSettingsChanged = vi.fn();
    render(<ModelProvidersPane onSettingsChanged={onSettingsChanged} />);
    await waitFor(() => expect(modelsListMock).toHaveBeenCalled());
    expect(screen.getByRole("heading", { name: /worker models/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add worker model/i }));

    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "deepseek-v4-flash" } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-deepseek" } });
    fireEvent.click(screen.getByRole("button", { name: /^add worker model$/i }));

    await waitFor(() => expect(modelsCheckConnectionMock).toHaveBeenCalledWith(
      { id: "deepseek", kind: "deepseek", apiKey: "sk-deepseek", baseURL: undefined, model: "deepseek-v4-flash" },
      { timeoutMs: 20_000 },
    ));
    await waitFor(() => expect(setSecretMock).toHaveBeenCalledWith("deepseek", "sk-deepseek", false));
    expect(modelsCheckConnectionMock.mock.invocationCallOrder[0]).toBeLessThan(setSecretMock.mock.invocationCallOrder[0]!);
    expect(modelsConfigureMock).toHaveBeenCalledWith({ id: "deepseek", kind: "deepseek", apiKey: "sk-deepseek", baseURL: undefined });
    // persist off => no metadata write
    expect(saveProviderConfigMock).not.toHaveBeenCalled();
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
  });

  it("persists metadata (with the key) when Save-to-Keychain is checked", async () => {
    await renderAndOpenProviderSheet();

    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "deepseek-v4-pro" } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-persist" } });
    fireEvent.click(screen.getByLabelText(/keychain/i));
    fireEvent.click(screen.getByRole("button", { name: /^add worker model$/i }));

    await waitFor(() => expect(setSecretMock).toHaveBeenCalledWith("deepseek", "sk-persist", true));
    expect(saveProviderConfigMock).toHaveBeenCalledWith({ id: "deepseek", kind: "deepseek", baseURL: undefined, model: "deepseek-v4-pro" });
  });

  it("requires a base URL for OpenAI-compatible and forwards it", async () => {
    await renderAndOpenProviderSheet();

    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "openai-compatible" } });
    fireEvent.change(screen.getByLabelText(/base url/i), { target: { value: "https://host/v1" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "qwen3-coder" } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-oai" } });
    fireEvent.click(screen.getByRole("button", { name: /^add worker model$/i }));

    await waitFor(() => expect(modelsConfigureMock).toHaveBeenCalledWith({ id: "openai-compatible", kind: "openai-compatible", apiKey: "sk-oai", baseURL: "https://host/v1" }));
  });

  it("hides the base URL field for DeepSeek", async () => {
    await renderAndOpenProviderSheet();
    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "deepseek" } });
    expect(screen.queryByLabelText(/base url/i)).toBeNull();
  });

  it("removes a configured provider (key + metadata)", async () => {
    const onSettingsChanged = vi.fn();
    modelsListMock.mockResolvedValue({ providers: [{ id: "deepseek", kind: "deepseek" }] });
    listProviderConfigsMock.mockResolvedValue([{ id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash" }]);
    render(<ModelProvidersPane onSettingsChanged={onSettingsChanged} />);
    await waitFor(() => expect(screen.getByText("deepseek")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    await waitFor(() => expect(modelsUnconfigureMock).toHaveBeenCalledWith("deepseek"));
    await waitFor(() => expect(deleteSecretMock).toHaveBeenCalledWith("deepseek"));
    expect(deleteProviderConfigMock).toHaveBeenCalledWith("deepseek");
    expect(onSettingsChanged).toHaveBeenCalledTimes(1);
    // Optimistic removal: the row disappears immediately and stays gone —
    // no reload happens on success (the live engine registry would still
    // return the "removed" provider since there's no models.unconfigure).
    await waitFor(() => expect(screen.queryByText("deepseek")).toBeNull());
  });

  it("keeps Add Worker Model disabled and does not call setSecret when the API key is empty", async () => {
    await renderAndOpenProviderSheet();

    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "deepseek-v4-flash" } });
    const addButton = screen.getByRole("button", { name: /^add worker model$/i }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    expect(setSecretMock).not.toHaveBeenCalled();
    expect(modelsConfigureMock).not.toHaveBeenCalled();
  });

  it("shows a connection error and saves nothing when the API check fails", async () => {
    modelsCheckConnectionMock.mockRejectedValue(new Error("Authentication failed. Check the API key and account access."));
    await renderAndOpenProviderSheet();

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "bad-key" } });
    fireEvent.click(screen.getByRole("button", { name: /^add worker model$/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/authentication failed/i);
    expect(setSecretMock).not.toHaveBeenCalled();
    expect(modelsConfigureMock).not.toHaveBeenCalled();
    expect(saveProviderConfigMock).not.toHaveBeenCalled();
  });

  it("shows a verified status after a successful connection check", async () => {
    modelsListMock
      .mockResolvedValueOnce({ providers: [] })
      .mockResolvedValue({ providers: [{ id: "deepseek", kind: "deepseek" }] });
    await renderAndOpenProviderSheet();

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "valid-key" } });
    fireEvent.click(screen.getByRole("button", { name: /^add worker model$/i }));

    expect((await screen.findByRole("status")).textContent).toMatch(/connection verified/i);
  });
});
