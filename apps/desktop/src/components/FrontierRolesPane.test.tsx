import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

const { frontierModelsMock } = vi.hoisted(() => ({ frontierModelsMock: vi.fn() }));

vi.mock("../engineClient", () => ({
  engineClient: { frontierModels: frontierModelsMock },
}));

import { FrontierRolesPane } from "./FrontierRolesPane";

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  window.localStorage.clear();
  frontierModelsMock.mockReset();
  frontierModelsMock.mockResolvedValue({
    models: [
      { engine: "claude-code", id: "opus[1m]", displayName: "Opus", description: "Claude Opus", isDefault: true },
      { engine: "codex", id: "gpt-5.5", displayName: "GPT-5.5", description: "OpenAI GPT-5.5", isDefault: false },
    ],
    unavailable: [],
  });
});

describe("FrontierRolesPane", () => {
  it("discovers both runtimes and persists independent role selections", async () => {
    const changed = vi.fn();
    render(<FrontierRolesPane onSettingsChanged={changed} />);

    expect(screen.getByRole("heading", { name: /lead models/i })).toBeTruthy();
    const review = await screen.findByRole("combobox", { name: /worker review/i });
    await waitFor(() => expect(screen.getAllByRole("option", { name: /gpt-5\.5/i }).length).toBeGreaterThan(0));
    fireEvent.change(review, { target: { value: "codex:gpt-5.5" } });

    expect(changed).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem("openfusion.frontier-role-selections.v1") ?? "{}").review).toEqual({
      engine: "codex",
      model: "gpt-5.5",
    });
  });
});
