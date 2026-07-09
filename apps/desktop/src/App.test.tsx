import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

afterEach(cleanup);

const { invokeMock, FakeChannel } = vi.hoisted(() => {
  class FakeChannel<T> { onmessage: ((message: T) => void) | undefined; }
  return { invokeMock: vi.fn(), FakeChannel };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: FakeChannel,
}));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "engine_call") return Promise.resolve({ providers: [] });
    if (cmd === "list_projects") return Promise.resolve([]);
    if (cmd === "list_provider_configs") return Promise.resolve([]);
    if (cmd === "frontier_login_status") return Promise.resolve({ state: "disconnected" });
    return Promise.resolve(undefined);
  });
});

/** `engineClient` (imported by App.tsx) is a real module-level singleton with
 * a private `#subscribed` flag — on purpose, that's what makes "one
 * subscription for the whole app" hold in production. In tests that means it
 * stays subscribed across `it()` blocks in this file even though
 * `invokeMock.mockReset()` clears the mock's call history each time (only
 * the call history resets, not the client's internal flag), so a second
 * test's mount would find zero fresh `engine_events` calls even though the
 * invariant genuinely holds. `vi.resetModules()` plus a fresh dynamic import
 * gives each test its own `App` + `engineClient` instance, mirroring one real
 * app launch per test — see the original App.test.tsx / engineClient.test.ts
 * for the same pattern this mirrors. */
async function freshApp() {
  vi.resetModules();
  const mod = await import("./App");
  return mod.App;
}

describe("App shell", () => {
  it("renders the project section rail after a project is selected", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "engine_call") return Promise.resolve({ providers: [] });
      if (cmd === "list_projects") return Promise.resolve([{ path: "/r/alpha", name: "alpha" }]);
      if (cmd === "list_provider_configs") return Promise.resolve([]);
      if (cmd === "frontier_login_status") return Promise.resolve({ state: "disconnected" });
      return Promise.resolve(undefined);
    });
    const App = await freshApp();
    render(<App />);
    await waitFor(() => expect(screen.getByRole("navigation", { name: /projects/i })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("navigation", { name: /project sections/i })).toBeTruthy());
    expect(screen.getAllByText("alpha").length).toBeGreaterThan(0);
  });

  it("does not render the empty project section rail before a project exists", async () => {
    const App = await freshApp();
    render(<App />);
    await waitFor(() => expect(screen.getByRole("navigation", { name: /projects/i })).toBeTruthy());
    expect(screen.queryByRole("navigation", { name: /project sections/i })).toBeNull();
    expect(screen.getAllByRole("button", { name: /add project/i }).length).toBeGreaterThan(0);
  });

  it("subscribes to engine events exactly once", async () => {
    const App = await freshApp();
    render(<App />);
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "engine_events");
      expect(calls).toHaveLength(1);
    });
  });
});
