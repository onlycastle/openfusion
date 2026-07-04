import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

afterEach(cleanup);

// The Tauri dialog plugin's `open()` — mocked so tests drive the directory
// picker without a real native dialog.
const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));

// `engineClient` (the singleton) is what ProjectScreen calls through for
// modelsList/wikiBuild/wikiStatus/onEngineEvent. `importOriginal` keeps
// `EngineError` (and everything else) real — only the singleton's methods
// are replaced with spies, same pattern as mocking a class instance's
// methods without losing `instanceof EngineError` checks in the component.
const { modelsListMock, wikiBuildMock, wikiStatusMock, onEngineEventMock, unsubscribeMock } = vi.hoisted(() => ({
  modelsListMock: vi.fn(),
  wikiBuildMock: vi.fn(),
  wikiStatusMock: vi.fn(),
  onEngineEventMock: vi.fn(),
  unsubscribeMock: vi.fn(),
}));

vi.mock("../engineClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engineClient")>();
  return {
    ...actual,
    engineClient: {
      modelsList: modelsListMock,
      wikiBuild: wikiBuildMock,
      wikiStatus: wikiStatusMock,
      onEngineEvent: onEngineEventMock,
    },
  };
});

import { ProjectScreen } from "./ProjectScreen";
import { EngineError } from "../engineClient";

beforeEach(() => {
  openMock.mockReset();
  modelsListMock.mockReset();
  wikiBuildMock.mockReset();
  wikiStatusMock.mockReset();
  onEngineEventMock.mockReset();
  unsubscribeMock.mockReset();

  modelsListMock.mockResolvedValue({ providers: [] });
  wikiStatusMock.mockResolvedValue({
    built: false,
    headSha: null,
    currentSha: "abc123",
    stale: false,
    files: 0,
    symbols: 0,
    refs: 0,
  });
  onEngineEventMock.mockReturnValue(unsubscribeMock);
});

async function chooseProject(path = "/Users/test/project"): Promise<string> {
  openMock.mockResolvedValueOnce(path);
  render(<ProjectScreen />);
  await waitFor(() => expect(screen.getByText(/no providers configured/i)).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /choose project/i }));
  await waitFor(() => expect(screen.getByText(path)).toBeTruthy());
  return path;
}

describe("ProjectScreen", () => {
  it("invokes wikiBuild with the chosen project directory when 'Build wiki' is clicked", async () => {
    const path = await chooseProject();
    wikiBuildMock.mockReturnValueOnce(new Promise(() => {})); // never resolves in this test

    fireEvent.click(screen.getByRole("button", { name: /build wiki/i }));

    expect(wikiBuildMock).toHaveBeenCalledWith(path);
  });

  it("renders streamed wiki.build.progress notifications as they arrive", async () => {
    const path = await chooseProject();
    wikiBuildMock.mockReturnValueOnce(new Promise(() => {}));

    fireEvent.click(screen.getByRole("button", { name: /build wiki/i }));

    expect(onEngineEventMock).toHaveBeenCalled();
    const handler = onEngineEventMock.mock.calls[0][0] as (n: unknown) => void;

    act(() => {
      handler({ method: "wiki.build.progress", params: { projectDir: path, detail: "indexing src/foo.ts" } });
    });
    await waitFor(() => expect(screen.getByText(/indexing src\/foo\.ts/)).toBeTruthy());

    act(() => {
      handler({ method: "wiki.build.progress", params: { projectDir: path, detail: "indexing src/bar.ts" } });
    });
    await waitFor(() => expect(screen.getByText(/indexing src\/bar\.ts/)).toBeTruthy());

    // A notification for a different project (or a different method
    // entirely) must not render.
    act(() => {
      handler({ method: "wiki.build.progress", params: { projectDir: "/some/other/project", detail: "should not show" } });
      handler({ method: "orchestrate.progress", params: { stage: "irrelevant" } });
    });
    expect(screen.queryByText(/should not show/)).toBeNull();
  });

  it("renders the result (files indexed, symbols, refs) on completion", async () => {
    await chooseProject();
    wikiBuildMock.mockResolvedValueOnce({
      filesSeen: 42,
      filesIndexed: 40,
      filesSkipped: 2,
      filesFailed: 0,
      filesRemoved: 0,
      symbols: 300,
      refs: 900,
      headSha: "deadbeef",
    });

    fireEvent.click(screen.getByRole("button", { name: /build wiki/i }));

    await waitFor(() => expect(screen.getByText("40")).toBeTruthy());
    expect(screen.getByText("300")).toBeTruthy();
    expect(screen.getByText("900")).toBeTruthy();
  });

  it("renders a friendly message (not a stack trace) when wikiBuild rejects with an EngineError", async () => {
    await chooseProject();
    wikiBuildMock.mockRejectedValueOnce(new EngineError(-32000, "not a git repository: /Users/test/project", undefined));

    fireEvent.click(screen.getByRole("button", { name: /build wiki/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alertText = screen.getByRole("alert").textContent ?? "";
    expect(alertText).toMatch(/not a git repository/i);
    expect(alertText).not.toMatch(/at Object|\.tsx:\d+|\bstack\b/i);
  });

  it("renders a friendly message when the chosen directory's wiki status call fails (non-git dir SERVER_ERROR)", async () => {
    openMock.mockResolvedValueOnce("/tmp/not-a-repo");
    wikiStatusMock.mockRejectedValueOnce(new EngineError(-32000, "not a git repository: /tmp/not-a-repo", undefined));

    render(<ProjectScreen />);
    await waitFor(() => expect(screen.getByText(/no providers configured/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /choose project/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/not a git repository/i);
  });

  it("unsubscribes from engine events on unmount", async () => {
    const { unmount } = render(<ProjectScreen />);
    await waitFor(() => expect(onEngineEventMock).toHaveBeenCalled());

    unmount();

    expect(unsubscribeMock).toHaveBeenCalled();
  });
});
