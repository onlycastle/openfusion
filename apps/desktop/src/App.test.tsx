import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// `vitest.config`'s `test.globals` is `false` (every test file imports its
// own vitest globals explicitly — see vite.config.ts), so
// @testing-library/react's usual auto-registered `afterEach(cleanup)` can't
// detect a global test framework and never runs; do it explicitly instead,
// or the second test in this file finds two mounted trees (the previous
// test's + this one's) and every `getByRole` query throws "found multiple
// elements".
afterEach(cleanup);

// Same mocking approach as engineClient.test.ts: see that file's comment on
// why `vi.hoisted` is needed for a factory that needs to reference outer-
// scope values (a plain `class`/`const` declared below the hoisted
// `vi.mock` call would still be in its temporal dead zone when the factory
// runs).
const { invokeMock, FakeChannel } = vi.hoisted(() => {
  class FakeChannel<T> {
    onmessage: ((message: T) => void) | undefined;
  }
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
    if (cmd === "list_secret_ids") return Promise.resolve([]);
    if (cmd === "frontier_login_status") return Promise.resolve({ state: "disconnected" });
    if (cmd === "list_provider_configs") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
  // Reset route state between tests — jsdom's `window` persists across
  // `it` blocks within this file.
  window.location.hash = "";
});

/** `engineClient` (imported by App.tsx) is a real module-level singleton —
 * on purpose, that's what makes "one subscription for the whole app" hold
 * in production. In tests that means it'd otherwise stay subscribed across
 * `it()` blocks in this file (only the mock's call history resets, not the
 * client's internal `#subscribed` flag). `vi.resetModules()` plus a fresh
 * dynamic import gives each test its own `App` + `engineClient` instance,
 * mirroring one real app launch per test. */
async function freshApp() {
  vi.resetModules();
  const mod = await import("./App");
  return mod.App;
}

describe("App shell", () => {
  it("renders the nav and the default Studio route, using the mocked engine client", async () => {
    const App = await freshApp();
    render(<App />);

    expect(screen.getByRole("navigation")).toBeTruthy();
    // Studio is the default route. The first screen is the harness setup
    // phase, so the task composer/run control are not visible yet.
    expect(screen.getByRole("heading", { level: 1, name: "Studio" })).toBeTruthy();
    expect(screen.getByText(/building harness/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /select project/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^run$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Project" })).toBeNull();
  });

  it("switches routes on nav click: Evals is a real cockpit screen; Studio is the default", async () => {
    const App = await freshApp();
    render(<App />);

    // Default is Studio.
    expect(screen.getByRole("heading", { level: 1, name: "Studio" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Evals" }));
    expect(screen.getByRole("heading", { level: 1, name: "Evals" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /run evals/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Studio" }));
    expect(screen.getByRole("heading", { level: 1, name: "Studio" })).toBeTruthy();
  });

  it("opens the Orchestrators + Model providers (BYOK) groups in the Settings dialog — neither is a nav route — and closes it again", async () => {
    const App = await freshApp();
    render(<App />);

    // Neither Keys nor Project is navigation anymore.
    expect(screen.queryByRole("button", { name: "Keys" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Project" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/No model providers yet/)).toBeTruthy());
    // The Orchestrators group (frontier connect) sits alongside the merged
    // BYOK model-providers pane — both render inside Settings, not as routes.
    expect(screen.getByRole("heading", { name: /orchestrators/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /close settings/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The route underneath never changed — Studio is still on screen.
    expect(screen.getByRole("heading", { level: 1, name: "Studio" })).toBeTruthy();
  });

  it("closes the Settings dialog on Escape", async () => {
    const App = await freshApp();
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    // Let the dialog's own async panes settle before dismissing, so no
    // state update lands after unmount.
    await waitFor(() => expect(screen.getByText(/No model providers yet/)).toBeTruthy());

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("establishes exactly one engine_events subscription for the whole app on mount", async () => {
    const App = await freshApp();
    render(<App />);

    await waitFor(() => {
      const engineEventsCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === "engine_events");
      expect(engineEventsCalls).toHaveLength(1);
    });
  });
});
