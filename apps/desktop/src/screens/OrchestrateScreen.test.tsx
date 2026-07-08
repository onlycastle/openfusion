import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// `test.globals` is `false` (see vite.config.ts) so RTL's auto-registered
// `afterEach(cleanup)` never fires — do it explicitly, same as
// EvalsScreen.test.tsx/KeysScreen.test.tsx.
afterEach(cleanup);

// The active project now comes from `ProjectContext` (Rail 1 owns picking
// it, Task 6/8) rather than an in-screen folder dialog — mocked so tests
// can drive `activeProjectDir` directly, same pattern as
// HarnessSettingPanel.test.tsx.
const { useProjectMock } = vi.hoisted(() => ({ useProjectMock: vi.fn() }));
vi.mock("../ProjectContext", () => ({ useProject: () => useProjectMock() }));

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
  runsListMock,
} = vi.hoisted(() => ({
  runOrchestrateMock: vi.fn(),
  callMock: vi.fn(),
  modelsListMock: vi.fn(),
  wikiStatusMock: vi.fn(),
  wikiBuildMock: vi.fn(),
  harnessStatusMock: vi.fn(),
  harnessGenerateMock: vi.fn(),
  frontierLoginStatusMock: vi.fn(),
  runsListMock: vi.fn(),
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
      // The screen now fetches recent-outcomes history on mount (Task 6) —
      // every pre-existing test that doesn't care about it needs a default
      // empty-resolving mock so it doesn't have to know about `runsList`.
      runsList: runsListMock,
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
  type OrchestrateRunRecord,
  type WikiBuildStats,
  type WikiStatus,
} from "../engineClient";

function wikiStatusFixture(overrides: Partial<WikiStatus> = {}): WikiStatus {
  return { built: false, headSha: null, currentSha: "abc123", stale: false, files: 0, symbols: 0, refs: 0, ...overrides };
}

function harnessStatusFixture(overrides: Partial<HarnessStatus> = {}): HarnessStatus {
  return { present: true, structural: "pass", evals: "pending", headSha: "abc123", card: null, ...overrides };
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

/** One `"orchestrate"`-kind run-ledger record, as `engineClient.runsList`
 * resolves it (Task 6). Mirrors the engine's `RunRecordSchema` "orchestrate"
 * branch (packages/engine/src/runs/ledger.ts) — kept minimal here since the
 * recent-outcomes row only reads `at`/`taskClass`/`outcome`/`runId`. */
function orchestrateRecordFixture(overrides: Partial<OrchestrateRunRecord> = {}): OrchestrateRunRecord {
  return {
    v: 1,
    kind: "orchestrate",
    at: "2026-07-02T09:00:00.000Z",
    taskClass: "tests",
    agent: "generalist",
    workerModel: "deepseek-v4-flash",
    attempts: 1,
    outcome: "worker-approved",
    escalated: false,
    reviews: [{ decision: "approve", reasons: [] }],
    contextBranch: "approved-card",
    cost: { workerUsd: 0.01, reviewUsd: 0.02, escalateUsd: null, totalUsd: 0.03 },
    durationMs: 4000,
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
  useProjectMock.mockReset();
  useProjectMock.mockReturnValue({ activeProjectDir: "/r/alpha" });
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
  // to stub the wiki check that mounting with an active project fires.
  wikiStatusMock.mockResolvedValue(wikiStatusFixture());
  harnessStatusMock.mockResolvedValue(harnessStatusFixture());
  harnessGenerateMock.mockResolvedValue(generateHarnessFixture());
  runsListMock.mockReset();
  runsListMock.mockResolvedValue({ records: [], skipped: 0 });
});

/** The active project is already set via `ProjectContext` (mocked to
 * `/r/alpha` in `beforeEach`) by the time the screen mounts, so — unlike the
 * old in-screen folder dialog — there is nothing to click to "choose" it.
 * This just waits for the harness check that fires on mount to resolve
 * (default fixtures classify it "ready"), opens the task chat, and fills
 * in the task text. */
async function openChatAndFillTask(task = "fix the null check bug"): Promise<{ path: string; task: string }> {
  const path = "/r/alpha";
  render(<OrchestrateScreen />);
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
    // The active project (from context) renders as static text — no
    // in-screen picker button exists anymore.
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /choose project|select project/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^run$/i })).toBeNull();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/connect an orchestrator/i)).toBeTruthy();
    expect(screen.getByText(/executing model provider/i)).toBeTruthy();
  });

  it("renders 'No project selected' when there is no active project in context", async () => {
    useProjectMock.mockReturnValue({ activeProjectDir: null });
    render(<OrchestrateScreen />);

    expect(screen.getByText(/no project selected/i)).toBeTruthy();
    expect(screen.getByText(/select a project to check its harness/i)).toBeTruthy();
    // No harness/wiki check should have fired without an active project.
    expect(wikiStatusMock).not.toHaveBeenCalled();
    expect(harnessStatusMock).not.toHaveBeenCalled();
  });

  it("checks the active project's harness on mount, streams build progress, then opens the task chat", async () => {
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

    render(<OrchestrateScreen />);

    await waitFor(() => expect(screen.getByText(/no harness yet/i)).toBeTruthy());
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /build harness/i }) as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: /build harness/i }));
    expect(harnessGenerateMock).toHaveBeenCalledWith("/r/alpha", expect.any(Function));

    act(() => onProgress({ projectDir: "/r/alpha", stage: "overview", detail: "exploring repository" }));
    await waitFor(() => expect(screen.getByText(/exploring repository/i)).toBeTruthy());

    act(() => resolveGenerate(generateHarnessFixture({ agents: 4 })));
    await waitFor(() => expect(screen.getByText(/what should we work on/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: /^run$/i })).toBeTruthy();
  });

  it("Run calls runOrchestrate with {projectDir, task}, streams progress, and renders the routed model", async () => {
    const { path, task } = await openChatAndFillTask();
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
    await openChatAndFillTask();
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
    await openChatAndFillTask();
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
    await openChatAndFillTask();
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
    const { path } = await openChatAndFillTask();
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
    await openChatAndFillTask();
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
    await openChatAndFillTask();
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
      await openChatAndFillTask("a very specific secret-looking task string");
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

  it("changing the active project (Rail 1) after a result returns to setup and removes the old Apply action", async () => {
    useProjectMock.mockReturnValue({ activeProjectDir: "/proj/A" });
    const { rerender } = render(<OrchestrateScreen />);
    await waitFor(() => expect(screen.getByRole("button", { name: /open task chat/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /open task chat/i }));
    fireEvent.change(screen.getByLabelText(/task/i), { target: { value: "fix something" } });

    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

    const fixture = orchestrateResultFixture();
    act(() => controllable.resolve(fixture));
    await waitFor(() => expect(screen.getByRole("button", { name: /apply diff/i })).toBeTruthy());

    // The active project changes — as Rail 1 (ProjectContext) would drive it,
    // not an in-screen picker.
    useProjectMock.mockReturnValue({ activeProjectDir: "/proj/B" });
    rerender(<OrchestrateScreen />);

    await waitFor(() => {
      const code = screen.getAllByText(/^\/proj\//)[0];
      expect(code?.textContent).toBe("/proj/B");
    });

    expect(screen.queryByRole("button", { name: /apply diff/i })).toBeNull();
    expect(callMock).not.toHaveBeenCalledWith("engine.orchestrate.apply", { projectDir: "/proj/B", diff: fixture.diff });
  });

  it("shows the active project's wiki reading in the head and builds it on demand (absorbed from the former Project screen)", async () => {
    wikiStatusMock.mockReset(); // drop the beforeEach default so the ordered Once values below apply
    // First status (on mount): not built. Second (after a build): up to date.
    wikiStatusMock.mockResolvedValueOnce(wikiStatusFixture({ built: false }));
    render(<OrchestrateScreen />);

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
    expect(wikiBuildMock).toHaveBeenCalledWith("/r/alpha");

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
    render(<OrchestrateScreen />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/not a git repository/i);
    // A wiki failure must not read as a run failure.
    expect(screen.queryByText(/^failed$/i)).toBeNull();
  });

  it("shows the draft-card nudge when the harness is ready with a draft card, and Run enablement is unaffected", async () => {
    harnessStatusMock.mockReset();
    harnessStatusMock.mockResolvedValue(harnessStatusFixture({ card: "draft" }));
    render(<OrchestrateScreen />);

    await waitFor(() => expect(screen.getByRole("button", { name: /open task chat/i })).toBeTruthy());
    expect(screen.getByText(/project card drafted — review it in harness setting\./i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /open task chat/i }));
    fireEvent.change(screen.getByLabelText(/task/i), { target: { value: "fix the null check bug" } });
    // The nudge is never a gate — Run still enables normally with a draft card.
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /^run$/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("hides the draft-card nudge when the harness is ready with an approved card", async () => {
    harnessStatusMock.mockReset();
    harnessStatusMock.mockResolvedValue(harnessStatusFixture({ card: "approved" }));
    render(<OrchestrateScreen />);

    await waitFor(() => expect(screen.getByRole("button", { name: /open task chat/i })).toBeTruthy());
    expect(screen.queryByText(/project card drafted/i)).toBeNull();
  });

  it("hides the draft-card nudge when the harness is ready with no card (legacy harness)", async () => {
    harnessStatusMock.mockReset();
    harnessStatusMock.mockResolvedValue(harnessStatusFixture({ card: null }));
    render(<OrchestrateScreen />);

    await waitFor(() => expect(screen.getByRole("button", { name: /open task chat/i })).toBeTruthy());
    expect(screen.queryByText(/project card drafted/i)).toBeNull();
  });

  it("renders the routed model from result.resolution in the final outcome view (structural routed-model test)", async () => {
    await openChatAndFillTask();
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

  describe("recent-outcomes row (Task 6)", () => {
    it("renders one chip per record in the RPC's own (newest-first) order, with outcome labels and taskClass/local-time tooltips", async () => {
      const records: OrchestrateRunRecord[] = [
        orchestrateRecordFixture({ at: "2026-07-02T09:00:00.000Z", taskClass: "tests", outcome: "worker-approved" }),
        orchestrateRecordFixture({ at: "2026-07-01T09:00:00.000Z", taskClass: "docs", outcome: "escalated" }),
        orchestrateRecordFixture({ at: "2026-06-30T09:00:00.000Z", taskClass: "refactor", outcome: "failed" }),
        orchestrateRecordFixture({
          at: "2026-06-29T09:00:00.000Z",
          taskClass: "infra",
          outcome: "error",
          errorCategory: "cancelled",
        }),
      ];
      runsListMock.mockResolvedValue({ records, skipped: 0 });

      await openChatAndFillTask();
      await waitFor(() => expect(runsListMock).toHaveBeenCalledWith("/r/alpha", "orchestrate", 5));

      const row = await waitFor(() => {
        const el = document.querySelector(".recent-runs");
        expect(el).toBeTruthy();
        return el as Element;
      });
      const chips = row.querySelectorAll(".recent-run-chip");
      expect(chips).toHaveLength(4);
      expect(chips[0]?.textContent).toMatch(/worker approved/i);
      expect(chips[1]?.textContent).toMatch(/escalated/i);
      expect(chips[2]?.textContent).toMatch(/^failed$/i);
      expect(chips[3]?.textContent).toMatch(/^error$/i);

      expect(chips[0]?.getAttribute("title")).toBe(`tests · ${new Date(records[0]!.at).toLocaleString()}`);
      expect(chips[3]?.getAttribute("title")).toBe(`infra · ${new Date(records[3]!.at).toLocaleString()}`);
    });

    it("shows no .recent-runs row when runsList resolves with empty records", async () => {
      runsListMock.mockResolvedValue({ records: [], skipped: 0 });

      await openChatAndFillTask();
      await waitFor(() => expect(runsListMock).toHaveBeenCalled());

      expect(document.querySelector(".recent-runs")).toBeNull();
    });

    it("renders normally (no crash, no error state) when runsList rejects — best-effort chrome, never an error state", async () => {
      runsListMock.mockRejectedValue(new Error("boom"));

      await openChatAndFillTask();
      await waitFor(() => expect(runsListMock).toHaveBeenCalled());

      expect(document.querySelector(".recent-runs")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      // The rest of the screen still renders fine.
      expect(screen.getByLabelText(/task/i)).toBeTruthy();
    });

    it("Run-button enablement is unaffected by recent-outcomes history presence", async () => {
      runsListMock.mockResolvedValue({ records: [orchestrateRecordFixture()], skipped: 0 });

      await openChatAndFillTask();
      await waitFor(() => expect(document.querySelector(".recent-runs")).toBeTruthy());
      await waitFor(() => {
        expect((screen.getByRole("button", { name: /^run$/i }) as HTMLButtonElement).disabled).toBe(false);
      });
    });

    it("refetches recent outcomes after a run completes (success)", async () => {
      await openChatAndFillTask();
      await waitFor(() => expect(runsListMock).toHaveBeenCalledTimes(1));

      const controllable = makeControllableRun();
      runOrchestrateMock.mockReturnValueOnce(controllable);
      fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

      runsListMock.mockResolvedValueOnce({ records: [orchestrateRecordFixture()], skipped: 0 });
      act(() => controllable.resolve(orchestrateResultFixture()));
      await waitFor(() => expect(screen.getByText(/worker approved/i)).toBeTruthy());

      await waitFor(() => expect(runsListMock.mock.calls.length).toBeGreaterThanOrEqual(2));
      const lastCall = runsListMock.mock.calls[runsListMock.mock.calls.length - 1];
      expect(lastCall?.[0]).toBe("/r/alpha");
      expect(lastCall?.[1]).toBe("orchestrate");
    });

    it("refetches recent outcomes after a run is cancelled (the engine still writes a ledger record for it)", async () => {
      await openChatAndFillTask();
      await waitFor(() => expect(runsListMock).toHaveBeenCalledTimes(1));

      const controllable = makeControllableRun();
      runOrchestrateMock.mockReturnValueOnce(controllable);
      fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

      act(() => controllable.reject(new RunCancelledError(controllable.runId, undefined)));
      await waitFor(() => expect(screen.getByText(/^cancelled$/i)).toBeTruthy());

      await waitFor(() => expect(runsListMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    });

    it("stale-guards the recent-outcomes fetch: a slow response for a project no longer active must not overwrite the new project's row", async () => {
      let resolveA!: (value: { records: OrchestrateRunRecord[]; skipped: number }) => void;
      const pendingA = new Promise<{ records: OrchestrateRunRecord[]; skipped: number }>((resolve) => {
        resolveA = resolve;
      });
      runsListMock.mockReturnValueOnce(pendingA);
      useProjectMock.mockReturnValue({ activeProjectDir: "/proj/A" });
      const { rerender } = render(<OrchestrateScreen />);
      await waitFor(() => expect(runsListMock).toHaveBeenCalledTimes(1));

      // Switch to project B before A's fetch resolves — B's own fetch
      // resolves immediately with empty history.
      runsListMock.mockResolvedValueOnce({ records: [], skipped: 0 });
      useProjectMock.mockReturnValue({ activeProjectDir: "/proj/B" });
      rerender(<OrchestrateScreen />);
      await waitFor(() => expect(runsListMock).toHaveBeenCalledTimes(2));

      // Open the chat for B so the row (if wrongly populated) would be visible.
      await waitFor(() => expect(screen.getByRole("button", { name: /open task chat/i })).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: /open task chat/i }));

      // NOW resolve A's slow response with a non-empty record — must be
      // dropped, not painted under project B's now-active screen.
      await act(async () => {
        resolveA({ records: [orchestrateRecordFixture()], skipped: 0 });
        await Promise.resolve();
      });

      expect(document.querySelector(".recent-runs")).toBeNull();
    });
  });
});
