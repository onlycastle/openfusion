import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

afterEach(cleanup);

const { modelsConfigureMock, modelsListMock, setSecretMock, deleteSecretMock, saveProviderConfigMock, deleteProviderConfigMock, listProviderConfigsMock } = vi.hoisted(() => ({
  modelsConfigureMock: vi.fn(),
  modelsListMock: vi.fn(),
  setSecretMock: vi.fn(),
  deleteSecretMock: vi.fn(),
  saveProviderConfigMock: vi.fn(),
  deleteProviderConfigMock: vi.fn(),
  listProviderConfigsMock: vi.fn(),
}));

vi.mock("../engineClient", () => ({
  engineClient: { modelsConfigure: modelsConfigureMock, modelsList: modelsListMock },
  setSecret: setSecretMock,
  deleteSecret: deleteSecretMock,
  saveProviderConfig: saveProviderConfigMock,
  deleteProviderConfig: deleteProviderConfigMock,
  listProviderConfigs: listProviderConfigsMock,
}));

import { ModelProvidersPane } from "./ModelProvidersPane";

beforeEach(() => {
  for (const m of [modelsConfigureMock, modelsListMock, setSecretMock, deleteSecretMock, saveProviderConfigMock, deleteProviderConfigMock, listProviderConfigsMock]) m.mockReset();
  modelsListMock.mockResolvedValue({ providers: [] });
  listProviderConfigsMock.mockResolvedValue([]);
  modelsConfigureMock.mockResolvedValue({ configured: true });
  setSecretMock.mockResolvedValue(undefined);
  deleteSecretMock.mockResolvedValue(undefined);
  saveProviderConfigMock.mockResolvedValue(undefined);
  deleteProviderConfigMock.mockResolvedValue(undefined);
});

describe("ModelProvidersPane", () => {
  it("configures a DeepSeek provider and stores the key on Save (persist off by default)", async () => {
    render(<ModelProvidersPane />);
    await waitFor(() => expect(modelsListMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "deepseek-v4-flash" } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-deepseek" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(setSecretMock).toHaveBeenCalledWith("deepseek", "sk-deepseek", false));
    expect(modelsConfigureMock).toHaveBeenCalledWith({ id: "deepseek", kind: "deepseek", apiKey: "sk-deepseek", baseURL: undefined });
    // persist off => no metadata write
    expect(saveProviderConfigMock).not.toHaveBeenCalled();
  });

  it("persists metadata (with the key) when Save-to-Keychain is checked", async () => {
    render(<ModelProvidersPane />);
    await waitFor(() => expect(modelsListMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "deepseek-v4-pro" } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-persist" } });
    fireEvent.click(screen.getByLabelText(/keychain/i));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(setSecretMock).toHaveBeenCalledWith("deepseek", "sk-persist", true));
    expect(saveProviderConfigMock).toHaveBeenCalledWith({ id: "deepseek", kind: "deepseek", baseURL: undefined, model: "deepseek-v4-pro" });
  });

  it("requires a base URL for OpenAI-compatible and forwards it", async () => {
    render(<ModelProvidersPane />);
    await waitFor(() => expect(modelsListMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "openai-compatible" } });
    fireEvent.change(screen.getByLabelText(/base url/i), { target: { value: "https://host/v1" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "qwen3-coder" } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-oai" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(modelsConfigureMock).toHaveBeenCalledWith({ id: "openai-compatible", kind: "openai-compatible", apiKey: "sk-oai", baseURL: "https://host/v1" }));
  });

  it("hides the base URL field for DeepSeek", async () => {
    render(<ModelProvidersPane />);
    await waitFor(() => expect(modelsListMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "deepseek" } });
    expect(screen.queryByLabelText(/base url/i)).toBeNull();
  });

  it("removes a configured provider (key + metadata)", async () => {
    modelsListMock.mockResolvedValue({ providers: [{ id: "deepseek", kind: "deepseek" }] });
    listProviderConfigsMock.mockResolvedValue([{ id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash" }]);
    render(<ModelProvidersPane />);
    await waitFor(() => expect(screen.getByText("deepseek")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    await waitFor(() => expect(deleteSecretMock).toHaveBeenCalledWith("deepseek"));
    expect(deleteProviderConfigMock).toHaveBeenCalledWith("deepseek");
  });
});
