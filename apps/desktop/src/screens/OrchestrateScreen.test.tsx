import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// `test.globals` is `false` (see vite.config.ts) so RTL's auto-registered
// `afterEach(cleanup)` never fires — do it explicitly, same as
// EvalsScreen.test.tsx/KeysScreen.test.tsx.
afterEach(cleanup);

// The Tauri dialog plugin's `open()` — mocked so tests drive the project
// directory picker without a real native dialog (same pattern as
// EvalsScreen.test.tsx).
const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));

// `engineClient` (the singleton) is what OrchestrateScreen calls through
// for `runOrchestrate`/`call`. `importOriginal` keeps `EngineError`/
// `RunCancelledError` real so `instanceof` checks inside the component work
// against the same classes these tests construct.
const {
  runOrchestrateMock,
  callMock,
  modelsListMock,
  wikiStatusMock,
  wikiBuildMock,
  harnessStatusMock,
  harnessGenerateMock,
  frontierLoginStatusMock,
} = vi.hoisted(() => ({
  runOrchestrateMock: vi.fn(),
  callMock: vi.fn(),
  modelsListMock: vi.fn(),
  wikiStatusMock: vi.fn(),
  wikiBuildMock: vi.fn(),
  harnessStatusMock: vi.fn(),
  harnessGenerateMock: vi.fn(),
  frontierLoginStatusMock: vi.fn(),
}));

vi.mock("../engineClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engineClient")>();
  return {
    ...actual,
    frontierLoginStatus: frontierLoginStatusMock,
    engineClient: {
      runOrchestrate: runOrchestrateMock,
      call: callMock,
      modelsList: modelsListMock,
      // Choosing a project now checks its wiki index (absorbed from the
      // former Project screen), so the mocked client must answer these too.
      wikiStatus: wikiStatusMock,
      wikiBuild: wikiBuildMock,
      harnessStatus: harnessStatusMock,
      harnessGenerate: harnessGenerateMock,
    },
  };
});

import { OrchestrateScreen } from "./OrchestrateScreen";
import {
  EngineError,
  RunCancelledError,
  type GenerateHarnessResult,
  type HarnessStatus,
  type OrchestrateResult,
  type WikiBuildStats,
  type WikiStatus,
} from "../engineClient";

function wikiStatusFixture(overrides: Partial<WikiStatus> = {}): WikiStatus {
  return { built: false, headSha: null, currentSha: "abc123", stale: false, files: 0, symbols: 0, refs: 0, ...overrides };
}

function harnessStatusFixture(overrides: Partial<HarnessStatus> = {}): HarnessStatus {
  return { present: true, structural: "pass", evals: "pending", headSha: "abc123", ...overrides };
}

function generateHarnessFixture(overrides: Partial<GenerateHarnessResult> = {}): GenerateHarnessResult {
  return {
    files: [".openfusion/manifest.json"],
    reportCard: { structural: "pass", evals: "pending" },
    estimatedCostUsd: 0.05,
    pages: 4,
    agents: 3,
    note: "harness is UNVERIFIED until evals run (M6)",
    ...overrides,
  };
}

function orchestrateResultFixture(overrides: Partial<OrchestrateResult> = {}): OrchestrateResult {
  return {
    outcome: "worker-approved",
    agent: "generalist",
    taskClass: "default",
    resolution: { providerId: "deepseek", model: "deepseek-v4-flash" },
    attempts: [
      {
        n: 1,
        kind: "worker",
        summary: "fixed the null check",
        verdict: { decision: "approve", reasons: ["looks correct"], severity: "none" },
      },
    ],
    diff: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n-old line\n+new line\n+another new line\n",
    diffStat: "1 file changed, 2 insertions(+), 1 deletion(-)",
    worktree: { path: "/tmp/wt", branch: "of-worker-1" },
    cost: {
      workerUsd: 0.01,
      reviewUsd: 0.02,
      escalateUsd: null,
      frontierUsd: null,
      totalUsd: 0.03,
      note: "estimate-class",
      pricingConfidence: "provider-reported",
    },
    ...overrides,
  };
}

/** A controllable stand-in for `CancellableRun<OrchestrateResult>`: tests
 * drive `resolve`/`reject` directly instead of waiting on a real engine
 * call, and assert against the `cancel` spy. */
function makeControllableRun() {
  let resolveFn!: (result: OrchestrateResult) => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<OrchestrateResult>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const cancel = vi.fn().mockResolvedValue(undefined);
  return { runId: "test-run-1", promise, cancel, resolve: resolveFn, reject: rejectFn };
}

beforeEach(() => {
  openMock.mockReset();
  runOrchestrateMock.mockReset();
  callMock.mockReset();
  modelsListMock.mockReset();
  wikiStatusMock.mockReset();
  wikiBuildMock.mockReset();
  harnessStatusMock.mockReset();
  harnessGenerateMock.mockReset();
  frontierLoginStatusMock.mockReset();
  frontierLoginStatusMock.mockResolvedValue({ state: "connected" });
  modelsListMock.mockResolvedValue({ providers: [{ id: "deepseek", kind: "deepseek" }] });
  // A benign default so tests that only exercise the run loop aren't forced
  // to stub the wiki check that choosing a project fires.
  wikiStatusMock.mockResolvedValue(wikiStatusFixture());
  harnessStatusMock.mockResolvedValue(harnessStatusFixture());
  harnessGenerateMock.mockResolvedValue(generateHarnessFixture());
});

async function chooseProjectAndFillTask(
  task = "fix the null check bug",
  path = "/Users/test/project",
): Promise<{ path: string; task: string }> {
  openMock.mockResolvedValueOnce(path);
  render(<OrchestrateScreen />);
  fireEvent.click(screen.getByRole("button", { name: /select project/i }));
  await waitFor(() => expect(screen.getByText(path)).toBeTruthy());
  await waitFor(() => expect(screen.getByRole("button", { name: /open task chat/i })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /open task chat/i }));
  fireEvent.change(screen.getByLabelText(/task/i), { target: { value: task } });
  return { path, task };
}

describe("OrchestrateScreen", () => {
  it("starts in harness setup and warns when orchestrator or executing models are missing", async () => {
    frontierLoginStatusMock.mockResolvedValueOnce({ state: "disconnected" });
    modelsListMock.mockResolvedValueOnce({ providers: [] });
    render(<OrchestrateScreen />);

    expect(screen.getByText(/building harness/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /select project/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^run$/i })).toBeNull();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/connect an orchestrator/i)).toBeTruthy();
    expect(screen.getByText(/executing model provider/i)).toBeTruthy();
  });

  it("builds the harness for a selected project, streams build progress, then opens the task chat", async () => {
    harnessStatusMock.mockReset();
    harnessStatusMock
      .mockResolvedValueOnce(harnessStatusFixture({ present: false, structural: null, evals: null, headSha: null }))
      .mockResolvedValueOnce(harnessStatusFixture());

    let onProgress!: (event: { projectDir: string; stage: string; detail: string }) => void;
    let resolveGenerate!: (result: GenerateHarnessResult) => void;
    harnessGenerateMock.mockImplementationOnce(
      (_projectDir: string, progress: typeof onProgress) =>
        new Promise<GenerateHarnessResult>((resolve) => {
          onProgress = progress;
          resolveGenerate = resolve;
        }),
    );

    openMock.mockResolvedValueOnce("/Users/test/project");
    render(<OrchestrateScreen />);

    fireEvent.click(screen.getByRole("button", { name: /select project/i }));
    await waitFor(() => expect(screen.getByText(/no harness yet/i)).toBeTruthy());
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /build harness/i }) as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: /build harness/i }));
    expect(harnessGenerateMock).toHaveBeenCalledWith("/Users/test/project", expect.any(Function));

    act(() => onProgress({ projectDir: "/Users/test/project", stage: "overview", detail: "exploring repository" }));
    await waitFor(() => expect(screen.getByText(/exploring repository/i)).toBeTruthy());

    act(() => resolveGenerate(generateHarnessFixture({ agents: 4 })));
    await waitFor(() => expect(screen.getByText(/what should we work on/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: /^run$/i })).toBeTruthy();
  });

  it("Run calls runOrchestrate with {projectDir, task}, streams progress, and renders the routed model", async () => {
    const { path, task } = await chooseProjectAndFillTask();
    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);

    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

    expect(runOrchestrateMock).toHaveBeenCalledWith({ projectDir: path, task }, expect.any(Function));
    const onProgress = runOrchestrateMock.mock.calls[0]![1] as (event: unknown) => void;

    act(() => onProgress({ stage: "load", detail: "loading project" }));
    await waitFor(() => expect(screen.getByText(/loading project/)).toBeTruthy());

    act(() => onProgress({ stage: "route", detail: "routed to deepseek-v4-flash via worker agent generalist" }));
    await waitFor(() => expect(screen.getAllByText(/deepseek-v4-flash/).length).toBeGreaterThan(0));

    act(() => onProgress({ stage: "worker:1", detail: "worker attempt 1 running" }));
    await waitFor(() => expect(screen.getByText(/worker attempt 1 running/)).toBeTruthy());
  });

  it("renders the diff, verdict (decision+reasons+severity), outcome, and cost split on resolve", async () => {
    await chooseProjectAndFillTask();
    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

    act(() => controllable.resolve(orchestrateResultFixture()));

    await waitFor(() => expect(screen.getByText(/worker approved/i)).toBeTruthy());
    expect(screen.getByText(/^approved$/i)).toBeTruthy();
    expect(screen.getByText(/looks correct/)).toBeTruthy();
    expect(screen.getByText(/severity: none/i)).toBeTruthy();
    expect(screen.getByText("-old line")).toBeTruthy();
    expect(screen.getByText("+new line")).toBeTruthy();
    expect(screen.getByText("$0.0100")).toBeTruthy();
    expect(screen.getByText("$0.0200")).toBeTruthy();
    expect(screen.getByText("$0.0300")).toBeTruthy();
    expect(screen.getByText(/estimate-class/i)).toBeTruthy();
    expect(screen.getByText(/provider-reported/i)).toBeTruthy();
  });

  it("Cancel calls the run's cancel(), disables the button while cancelling (no second cancel call), then shows Cancelled — not Failed — on RunCancelledError", async () => {
    await chooseProjectAndFillTask();
    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

    const cancelButton = await screen.findByRole("button", { name: /^cancel$/i });
    fireEvent.click(cancelButton);
    expect(controllable.cancel).toHaveBeenCalledTimes(1);

    const cancellingButton = screen.getByRole("button", { name: /cancelling/i }) as HTMLButtonElement;
    expect(cancellingButton.disabled).toBe(true);
    fireEvent.click(cancellingButton); // second click must NOT start a second cancel
    expect(controllable.cancel).toHaveBeenCalledTimes(1);

    act(() => controllable.reject(new RunCancelledError(controllable.runId, undefined)));

    await waitFor(() => expect(screen.getByText(/^cancelled$/i)).toBeTruthy());
    expect(screen.queryByText(/^failed$/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a friendly message (not a crash) for a genuine EngineError, distinct from Cancelled", async () => {
    await chooseProjectAndFillTask();
    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

    act(() => controllable.reject(new EngineError(-32000, "no harness found for this project", undefined)));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alertText = screen.getByRole("alert").textContent ?? "";
    expect(alertText).toMatch(/no harness found/i);
    expect(alertText).not.toMatch(/at Object|\.tsx:\d+|\bstack\b/i);
    expect(screen.queryByText(/^cancelled$/i)).toBeNull();
  });

  it("Apply calls engine.orchestrate.apply with {projectDir, diff}, disables while applying, and shows Applied", async () => {
    const { path } = await chooseProjectAndFillTask();
    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
    const fixture = orchestrateResultFixture();
    act(() => controllable.resolve(fixture));
    await waitFor(() => expect(screen.getByRole("button", { name: /apply diff/i })).toBeTruthy());

    let resolveApply!: () => void;
    callMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveApply = resolve;
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /apply diff/i }));
    expect(callMock).toHaveBeenCalledWith("engine.orchestrate.apply", { projectDir: path, diff: fixture.diff });
    expect((screen.getByRole("button", { name: /applying/i }) as HTMLButtonElement).disabled).toBe(true);

    act(() => resolveApply());
    await waitFor(() => expect(screen.getByText(/^applied\.?$/i)).toBeTruthy());
  });

  it("shows a friendly Apply-failed state on rejection", async () => {
    await chooseProjectAndFillTask();
    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
    act(() => controllable.resolve(orchestrateResultFixture()));
    await waitFor(() => expect(screen.getByRole("button", { name: /apply diff/i })).toBeTruthy());

    callMock.mockRejectedValueOnce(new EngineError(-32000, "git apply failed: conflict", undefined));
    fireEvent.click(screen.getByRole("button", { name: /apply diff/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/git apply failed/i);
  });

  it("does not show an Apply button for a failed outcome with an empty diff", async () => {
    await chooseProjectAndFillTask();
    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

    act(() =>
      controllable.resolve(
        orchestrateResultFixture({
          outcome: "failed",
          diff: "",
          diffStat: "",
          attempts: [{ n: 1, kind: "worker", summary: "gave up", empty: true }],
          cost: {
            workerUsd: 0.01,
            reviewUsd: null,
            escalateUsd: null,
            frontierUsd: null,
            totalUsd: 0.01,
            note: "estimate-class",
          },
        }),
      ),
    );

    await waitFor(() => expect(screen.getByText(/^failed$/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /apply diff/i })).toBeNull();
  });

  it("never calls console.* while running/streaming/resolving/applying (content-logging invariant)", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await chooseProjectAndFillTask("a very specific secret-looking task string");
      const controllable = makeControllableRun();
      runOrchestrateMock.mockReturnValueOnce(controllable);
      fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

      const onProgress = runOrchestrateMock.mock.calls[0]![1] as (event: unknown) => void;
      act(() => onProgress({ stage: "route", detail: "routed to deepseek-v4-flash" }));
      act(() => controllable.resolve(orchestrateResultFixture()));
      await waitFor(() => expect(screen.getByText(/worker approved/i)).toBeTruthy());

      callMock.mockResolvedValueOnce(undefined);
      fireEvent.click(screen.getByRole("button", { name: /apply diff/i }));
      await waitFor(() => expect(screen.getByText(/^applied\.?$/i)).toBeTruthy());

      expect(consoleSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it("changing projects after a result returns to setup and removes the old Apply action", async () => {
    await chooseProjectAndFillTask("fix something", "/proj/A");

    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

    const fixture = orchestrateResultFixture();
    act(() => controllable.resolve(fixture));
    await waitFor(() => expect(screen.getByRole("button", { name: /apply diff/i })).toBeTruthy());

    // User re-picks a different directory AFTER the run resolves
    openMock.mockResolvedValueOnce("/proj/B");
    fireEvent.click(screen.getByRole("button", { name: /choose project/i }));
    // Give the picker time to update the displayed path
    await waitFor(() => {
      const code = screen.getAllByText(/^\/proj\//)[0];
      expect(code?.textContent).toBe("/proj/B");
    });

    expect(screen.queryByRole("button", { name: /apply diff/i })).toBeNull();
    expect(callMock).not.toHaveBeenCalledWith("engine.orchestrate.apply", { projectDir: "/proj/B", diff: fixture.diff });
  });

  it("shows the chosen project's wiki reading in the head and builds it on demand (absorbed from the former Project screen)", async () => {
    wikiStatusMock.mockReset(); // drop the beforeEach default so the ordered Once values below apply
    // First status (on choose): not built. Second (after a build): up to date.
    wikiStatusMock.mockResolvedValueOnce(wikiStatusFixture({ built: false }));
    openMock.mockResolvedValueOnce("/Users/test/project");
    render(<OrchestrateScreen />);

    fireEvent.click(screen.getByRole("button", { name: /select project/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /open task chat/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /open task chat/i }));
    await waitFor(() => expect(screen.getByText(/wiki: not built/i)).toBeTruthy());

    let resolveBuild!: (stats: WikiBuildStats) => void;
    wikiBuildMock.mockReturnValueOnce(
      new Promise<WikiBuildStats>((resolve) => {
        resolveBuild = resolve;
      }),
    );
    wikiStatusMock.mockResolvedValueOnce(wikiStatusFixture({ built: true, headSha: "abc123", symbols: 12, refs: 4, files: 3 }));

    fireEvent.click(screen.getByRole("button", { name: /^build$/i }));
    await waitFor(() => expect(screen.getByText(/wiki: building/i)).toBeTruthy());
    expect(wikiBuildMock).toHaveBeenCalledWith("/Users/test/project");

    act(() =>
      resolveBuild({
        filesSeen: 3,
        filesIndexed: 3,
        filesSkipped: 0,
        filesFailed: 0,
        filesRemoved: 0,
        symbols: 12,
        refs: 4,
        headSha: "abc123",
      }),
    );
    await waitFor(() => expect(screen.getByText(/wiki: up to date/i)).toBeTruthy());
  });

  it("surfaces a friendly wiki error in the head (not a crash) when the wiki check rejects", async () => {
    wikiStatusMock.mockReset();
    wikiStatusMock.mockRejectedValueOnce(new EngineError(-32001, "not a git repository", undefined));
    openMock.mockResolvedValueOnce("/Users/test/not-a-repo");
    render(<OrchestrateScreen />);

    fireEvent.click(screen.getByRole("button", { name: /select project/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/not a git repository/i);
    // A wiki failure must not read as a run failure.
    expect(screen.queryByText(/^failed$/i)).toBeNull();
  });

  it("renders the routed model from result.resolution in the final outcome view (structural routed-model test)", async () => {
    await chooseProjectAndFillTask();
    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

    // Resolve with a known structured resolution
    const fixture = orchestrateResultFixture({
      resolution: { providerId: "deepseek", model: "deepseek-v4-flash" },
    });
    act(() => controllable.resolve(fixture));

    // Assert the structural routed model appears in the DOM (not just progress text)
    await waitFor(() => expect(screen.getByText(/deepseek\/deepseek-v4-flash/)).toBeTruthy());
  });
});
