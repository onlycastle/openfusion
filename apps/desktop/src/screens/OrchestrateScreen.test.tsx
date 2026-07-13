import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// `test.globals` is `false` (see vite.config.ts) so RTL's auto-registered
// `afterEach(cleanup)` never fires — do it explicitly, same as
// HarnessHealthScreen.test.tsx/KeysScreen.test.tsx.
afterEach(cleanup);

// The active project now comes from `ProjectContext` (Rail 1 owns picking
// it, Task 6/8) rather than an in-screen folder dialog — mocked so tests
// can drive `activeProjectDir` directly, same pattern as
// HarnessSettingPanel.test.tsx.
const { addProjectByPathMock, openMock, useProjectMock } = vi.hoisted(() => ({
  addProjectByPathMock: vi.fn(),
  openMock: vi.fn(),
  useProjectMock: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
vi.mock("../ProjectContext", () => ({ useProject: () => useProjectMock() }));

// `engineClient` (the singleton) is what OrchestrateScreen calls through
// for `runOrchestrate`/`call`. `importOriginal` keeps `EngineError`/
// `RunCancelledError` real so `instanceof` checks inside the component work
// against the same classes these tests construct.
const {
  runOrchestrateMock,
  ensureRuntimeKeyMock,
  runtimeConfigureMock,
  orchestrateStartMock,
  sessionGetMock,
  sessionsListMock,
  sessionActionMock,
  onEngineEventMock,
  callMock,
  modelsListMock,
  wikiStatusMock,
  wikiBuildMock,
  harnessStatusMock,
  harnessGenerateMock,
  candidatePrepareApplyMock,
  candidateApplyMock,
  frontierLoginStatusMock,
} = vi.hoisted(() => ({
  runOrchestrateMock: vi.fn(),
  ensureRuntimeKeyMock: vi.fn(),
  runtimeConfigureMock: vi.fn(),
  orchestrateStartMock: vi.fn(),
  sessionGetMock: vi.fn(),
  sessionsListMock: vi.fn(),
  sessionActionMock: vi.fn(),
  onEngineEventMock: vi.fn(),
  callMock: vi.fn(),
  modelsListMock: vi.fn(),
  wikiStatusMock: vi.fn(),
  wikiBuildMock: vi.fn(),
  harnessStatusMock: vi.fn(),
  harnessGenerateMock: vi.fn(),
  candidatePrepareApplyMock: vi.fn(),
  candidateApplyMock: vi.fn(),
  frontierLoginStatusMock: vi.fn(),
}));

vi.mock("../engineClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engineClient")>();
  return {
    ...actual,
    frontierLoginStatus: frontierLoginStatusMock,
    engineClient: {
      runOrchestrate: runOrchestrateMock,
      ensureRuntimeKey: ensureRuntimeKeyMock,
      runtimeConfigure: runtimeConfigureMock,
      orchestrateStart: orchestrateStartMock,
      sessionGet: sessionGetMock,
      sessionsList: sessionsListMock,
      sessionAction: sessionActionMock,
      onEngineEvent: onEngineEventMock,
      call: callMock,
      modelsList: modelsListMock,
      // Choosing a project now checks its wiki index (absorbed from the
      // former Project screen), so the mocked client must answer these too.
      wikiStatus: wikiStatusMock,
      wikiBuild: wikiBuildMock,
      harnessStatus: harnessStatusMock,
      harnessGenerate: harnessGenerateMock,
      candidatePrepareApply: candidatePrepareApplyMock,
      candidateApply: candidateApplyMock,
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
  type EngineNotification,
  type RuntimeSession,
  type RuntimeSessionDetails,
  type WikiBuildStats,
  type WikiStatus,
} from "../engineClient";

function wikiStatusFixture(overrides: Partial<WikiStatus> = {}): WikiStatus {
  return { built: false, headSha: null, currentSha: "abc123", stale: false, files: 0, symbols: 0, refs: 0, ...overrides };
}

function harnessStatusFixture(overrides: Partial<HarnessStatus> = {}): HarnessStatus {
  return { present: true, structural: "pass", headSha: "abc123", card: null, ...overrides };
}

function generateHarnessFixture(overrides: Partial<GenerateHarnessResult> = {}): GenerateHarnessResult {
  return {
    files: [".openfusion/manifest.json"],
    reportCard: { structural: "pass", operational: "insufficient-evidence" },
    estimatedCostUsd: 0.05,
    pages: 4,
    agents: 3,
    note: "harness structure is verified; operational health accumulates from metadata-only production evidence",
    ...overrides,
  };
}

function orchestrateResultFixture(overrides: Partial<OrchestrateResult> = {}): OrchestrateResult {
  return {
    outcome: "worker-approved",
    agent: "generalist",
    taskClass: "default",
    resolution: { providerId: "deepseek", model: "deepseek-v4-flash" },
    candidateRef: {
      schemaVersion: 1,
      candidateId: "candidate-1",
      diffDigest: `sha256:${"a".repeat(64)}`,
      touchedPaths: ["x.ts"],
      lifecycle: "approved",
      createdAt: "2026-07-10T00:00:00.000Z",
      expiresAt: "2026-07-17T00:00:00.000Z",
    },
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
    costEstimate: {
      knownUsd: 0.03,
      completeness: "complete",
      unpricedCalls: 0,
      pricingVersion: "pricing-v1",
      confidence: "verified",
    },
    ...overrides,
  };
}

/** A controllable stand-in for `CancellableRun<OrchestrateResult>`: tests
 * drive `resolve`/`reject` directly instead of waiting on a real engine
 * call, and assert against the `cancel` spy. */
const engineEventHandlers = new Set<(notification: EngineNotification) => void>();
let currentRun: ReturnType<typeof makeControllableRun> | null = null;

function makeControllableRun() {
  let resolveFn!: (result: OrchestrateResult) => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<OrchestrateResult>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  void promise.catch(() => {});
  let status: RuntimeSession["status"] = "running";
  let projectDir = "/r/alpha";
  let result: OrchestrateResult | null = null;
  let error: unknown;
  const session = (): RuntimeSession => ({
    id: "test-session-1",
    runId: "test-run-1",
    kind: "orchestrate",
    status,
    version: status === "running" ? 2 : 3,
    resumeCapability: "exact",
    projectDir,
    usedSteps: 1,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: result?.cost.totalUsd ?? null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:01.000Z",
    ...(status === "failed" ? { outcome: "runtime" } : {}),
  });
  const emit = (notification: EngineNotification): void => {
    for (const handler of engineEventHandlers) handler(notification);
  };
  const changed = (): void => emit({
    method: "session.changed",
    params: { projectDir, sessionId: "test-session-1" },
  });
  const resolve = (value: OrchestrateResult): void => {
    result = value;
    status = "completed";
    resolveFn(value);
    changed();
  };
  const reject = (value: unknown): void => {
    error = value;
    status = value instanceof RunCancelledError ? "cancelled" : "failed";
    rejectFn(value);
    changed();
  };
  const cancel = vi.fn().mockImplementation(async () => {
    status = "cancelled";
    changed();
  });
  const progress = (event: { stage: string; detail: string }): void => emit({
    method: "orchestrate.progress",
    params: { ...event, runId: "test-run-1" },
  });
  const details = (): RuntimeSessionDetails => ({
    session: session(),
    pendingApproval: null,
    events: [
      {
        sessionId: "test-session-1",
        seq: 1,
        type: "session.created",
        at: "2026-07-10T00:00:00.000Z",
        metadata: {},
        payload: { state: "available", value: { params: { task: "fix the null check bug" } } },
      },
      ...(result === null
        ? []
        : [{
            sessionId: "test-session-1",
            seq: 2,
            type: "orchestrate.completed",
            at: "2026-07-10T00:00:01.000Z",
            metadata: {},
            payload: { state: "available" as const, value: result },
          }]),
      ...(status === "failed"
        ? [{
            sessionId: "test-session-1",
            seq: 2,
            type: "orchestrate.failed",
            at: "2026-07-10T00:00:01.000Z",
            metadata: {},
            payload: {
              state: "available" as const,
              value: { message: error instanceof Error ? error.message : String(error) },
            },
          }]
        : []),
    ],
  });
  return {
    runId: "test-run-1",
    promise,
    cancel,
    resolve,
    reject,
    progress,
    details,
    session,
    setProject: (value: string) => {
      projectDir = value;
    },
  };
}

beforeEach(() => {
  addProjectByPathMock.mockReset();
  openMock.mockReset();
  useProjectMock.mockReset();
  useProjectMock.mockReturnValue({ activeProjectDir: "/r/alpha", addProjectByPath: addProjectByPathMock });
  runOrchestrateMock.mockReset();
  ensureRuntimeKeyMock.mockReset();
  runtimeConfigureMock.mockReset();
  orchestrateStartMock.mockReset();
  sessionGetMock.mockReset();
  sessionsListMock.mockReset();
  sessionActionMock.mockReset();
  onEngineEventMock.mockReset();
  engineEventHandlers.clear();
  currentRun = null;
  callMock.mockReset();
  modelsListMock.mockReset();
  wikiStatusMock.mockReset();
  wikiBuildMock.mockReset();
  harnessStatusMock.mockReset();
  harnessGenerateMock.mockReset();
  candidatePrepareApplyMock.mockReset();
  candidateApplyMock.mockReset();
  frontierLoginStatusMock.mockReset();
  frontierLoginStatusMock.mockResolvedValue({ state: "connected" });
  modelsListMock.mockResolvedValue({ providers: [{ id: "deepseek", kind: "deepseek" }] });
  // A benign default so tests that only exercise the run loop aren't forced
  // to stub the wiki check that mounting with an active project fires.
  wikiStatusMock.mockResolvedValue(wikiStatusFixture());
  harnessStatusMock.mockResolvedValue(harnessStatusFixture());
  harnessGenerateMock.mockResolvedValue(generateHarnessFixture());
  candidatePrepareApplyMock.mockResolvedValue({
    approvalGrant: {
      schemaVersion: 1,
      grantId: "grant-1",
      token: "x".repeat(32),
      candidateId: "candidate-1",
      destinationProjectDigest: `sha256:${"b".repeat(64)}`,
      baseSha: "a".repeat(40),
      diffDigest: `sha256:${"a".repeat(64)}`,
      issuedAt: "2026-07-10T00:00:00.000Z",
      expiresAt: "2026-07-10T00:10:00.000Z",
    },
  });
  candidateApplyMock.mockResolvedValue({ applied: true, candidateId: "candidate-1" });
  ensureRuntimeKeyMock.mockResolvedValue(Buffer.alloc(32, 1).toString("base64"));
  runtimeConfigureMock.mockResolvedValue({ configured: true });
  sessionsListMock.mockResolvedValue({ sessions: [] });
  onEngineEventMock.mockImplementation((handler: (notification: EngineNotification) => void) => {
    engineEventHandlers.add(handler);
    return () => engineEventHandlers.delete(handler);
  });
  orchestrateStartMock.mockImplementation(async (params: { projectDir: string; runId?: string }) => {
    currentRun = runOrchestrateMock(params);
    currentRun!.setProject(params.projectDir);
    return {
      sessionId: "test-session-1",
      runId: params.runId ?? "test-run-1",
      status: "created",
      version: 1,
    };
  });
  sessionGetMock.mockImplementation(async () => currentRun?.details());
  sessionActionMock.mockImplementation(async (_projectDir, _sessionId, _version, action) => {
    if (action.type === "cancel") await currentRun?.cancel();
    return { session: currentRun!.session() };
  });
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
  it("shows missing lead and worker models as actionable readiness steps instead of a warning", async () => {
    frontierLoginStatusMock.mockResolvedValueOnce({ state: "disconnected" });
    modelsListMock.mockResolvedValueOnce({ providers: [] });
    render(<OrchestrateScreen />);

    expect(screen.getByText(/building harness/i)).toBeTruthy();
    // The active project (from context) renders as static text — no
    // in-screen picker button exists anymore.
    expect(screen.getByText(/get alpha ready/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /choose project|select project/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^run$/i })).toBeNull();

    await waitFor(() => expect(screen.getByText(/connect lead model runtimes/i)).toBeTruthy());
    expect(screen.getByText(/add a worker model/i)).toBeTruthy();
    expect(screen.getByRole("list", { name: /project readiness progress/i })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rechecks setup when settings change", async () => {
    const { rerender } = render(<OrchestrateScreen setupRefreshToken={0} />);

    await waitFor(() => expect(frontierLoginStatusMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(modelsListMock).toHaveBeenCalledTimes(1));

    rerender(<OrchestrateScreen setupRefreshToken={1} />);

    await waitFor(() => expect(frontierLoginStatusMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(modelsListMock).toHaveBeenCalledTimes(2));
  });

  it("starts the readiness timeline with project selection when there is no active project", async () => {
    useProjectMock.mockReturnValue({ activeProjectDir: null, addProjectByPath: addProjectByPathMock });
    render(<OrchestrateScreen />);

    expect(screen.getByText(/^select a project$/i)).toBeTruthy();
    expect(screen.getByText(/open a local git repository to begin/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    // No harness/wiki check should have fired without an active project.
    expect(wikiStatusMock).not.toHaveBeenCalled();
    expect(harnessStatusMock).not.toHaveBeenCalled();
  });

  it("adds a project from the empty Studio state", async () => {
    useProjectMock.mockReturnValue({ activeProjectDir: null, addProjectByPath: addProjectByPathMock });
    openMock.mockResolvedValueOnce("/r/gamma");
    render(<OrchestrateScreen />);

    fireEvent.click(screen.getByRole("button", { name: /add project/i }));

    await waitFor(() => expect(addProjectByPathMock).toHaveBeenCalledWith("/r/gamma"));
  });

  it("checks the active project's harness on mount, streams build progress, then opens the task chat", async () => {
    harnessStatusMock.mockReset();
    harnessStatusMock
      .mockResolvedValueOnce(harnessStatusFixture({ present: false, structural: null, headSha: null }))
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

    await waitFor(() => expect(screen.getByText(/build project harness/i)).toBeTruthy());
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /build harness/i }) as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: /build harness/i }));
    expect(harnessGenerateMock).toHaveBeenCalledWith(
      "/r/alpha",
      expect.any(Function),
      { engine: "claude-code", model: "default" },
    );

    act(() => onProgress({ projectDir: "/r/alpha", stage: "overview", detail: "exploring repository" }));
    await waitFor(() => expect(screen.getByText(/exploring repository/i)).toBeTruthy());
    expect(screen.getByRole("list", { name: /harness activity log/i })).toBeTruthy();

    act(() => resolveGenerate(generateHarnessFixture({ agents: 4 })));
    await waitFor(() => expect(screen.getByText(/what should we work on/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: /^run$/i })).toBeTruthy();
  });

  it("keeps received harness activity visible when generation stops", async () => {
    harnessStatusMock.mockResolvedValueOnce(
      harnessStatusFixture({ present: false, structural: null, headSha: null }),
    );

    let onProgress!: (event: { projectDir: string; stage: string; detail: string }) => void;
    let rejectGenerate!: (error: Error) => void;
    harnessGenerateMock.mockImplementationOnce(
      (_projectDir: string, progress: typeof onProgress) =>
        new Promise<GenerateHarnessResult>((_resolve, reject) => {
          onProgress = progress;
          rejectGenerate = reject;
        }),
    );

    render(<OrchestrateScreen />);
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /build harness/i }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: /build harness/i }));

    act(() => onProgress({ projectDir: "/r/alpha", stage: "overview", detail: "exploring repository structure" }));
    await waitFor(() => expect(screen.getByText(/exploring repository structure/i)).toBeTruthy());

    act(() => rejectGenerate(new Error("planning runtime stopped")));

    await waitFor(() => expect(screen.getByText(/harness preparation stopped/i)).toBeTruthy());
    expect(screen.getByText(/exploring repository structure/i)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/planning runtime stopped/i);
  });

  it("summarizes exhausted harness validation with stage, attempts, and final issue", async () => {
    harnessStatusMock.mockResolvedValueOnce(
      harnessStatusFixture({ present: false, structural: null, headSha: null }),
    );
    let onProgress!: (event: { projectDir: string; stage: string; detail: string }) => void;
    let rejectGenerate!: (error: Error) => void;
    harnessGenerateMock.mockImplementationOnce(
      (_projectDir: string, progress: typeof onProgress) =>
        new Promise<GenerateHarnessResult>((_resolve, reject) => {
          onProgress = progress;
          rejectGenerate = reject;
        }),
    );

    render(<OrchestrateScreen />);
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /build harness/i }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: /build harness/i }));
    act(() =>
      onProgress({
        projectDir: "/r/alpha",
        stage: "page:architecture",
        detail: "validation-failure: body: Invalid input: expected string",
      }),
    );
    act(() =>
      rejectGenerate(
        new EngineError(-32000, "promptForJson exhausted", {
          stage: "page:architecture",
          attempts: 2,
          issues: [{ path: ["body"], message: "Invalid input: expected string" }],
        }),
      ),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Architecture failed after 2 attempts: body: Invalid input: expected string",
      ),
    );
    expect(screen.getByText(/validation-failure: body: Invalid input: expected string/i)).toBeTruthy();
  });

  it("starts a durable session, streams progress, and renders the routed model", async () => {
    const { path, task } = await openChatAndFillTask();
    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);

    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

    await waitFor(() => expect(orchestrateStartMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDir: path,
        task,
        runId: expect.any(String),
        frontier: {
          review: { engine: "claude-code", model: "default" },
          escalation: { engine: "claude-code", model: "default" },
        },
      }),
    ));
    expect(ensureRuntimeKeyMock).toHaveBeenCalledWith(path);
    expect(runtimeConfigureMock).toHaveBeenCalledWith(path, expect.objectContaining({ traceEnabled: true }));

    act(() => controllable.progress({ stage: "load", detail: "loading project" }));
    await waitFor(() => expect(screen.getByText(/loading project/)).toBeTruthy());

    act(() => controllable.progress({ stage: "route", detail: "routed to deepseek-v4-flash via worker agent generalist" }));
    await waitFor(() => expect(screen.getAllByText(/deepseek-v4-flash/).length).toBeGreaterThan(0));

    act(() => controllable.progress({ stage: "worker:1", detail: "worker attempt 1 running" }));
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
    expect(screen.getAllByText("$0.0300").length).toBeGreaterThan(0);
    expect(screen.getByText(/estimate-class/i)).toBeTruthy();
    expect(screen.getByText(/provider-reported/i)).toBeTruthy();
  });

  it("cancels the durable session once and shows Cancelled — not Failed", async () => {
    await openChatAndFillTask();
    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

    const cancelButton = await screen.findByRole("button", { name: /^cancel$/i });
    fireEvent.click(cancelButton);
    await waitFor(() => expect(controllable.cancel).toHaveBeenCalledTimes(1));
    expect(sessionActionMock).toHaveBeenCalledWith(
      "/r/alpha",
      "test-session-1",
      2,
      { type: "cancel" },
    );

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

  it("Apply links metadata to the originating run, disables while applying, and shows Applied", async () => {
    const { path } = await openChatAndFillTask();
    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
    const fixture = orchestrateResultFixture();
    act(() => controllable.resolve(fixture));
    await waitFor(() => expect(screen.getByRole("button", { name: /review and apply/i })).toBeTruthy());

    let resolveApply!: () => void;
    candidateApplyMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveApply = resolve;
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /review and apply/i }));
    fireEvent.click(screen.getByRole("button", { name: /^apply changes$/i }));
    expect(candidatePrepareApplyMock).toHaveBeenCalledWith("candidate-1", path);
    await waitFor(() => expect(candidateApplyMock).toHaveBeenCalledWith(
      "candidate-1",
      expect.objectContaining({ grantId: "grant-1", candidateId: "candidate-1" }),
      path,
      controllable.runId,
    ));
    expect((screen.getByRole("button", { name: /applying/i }) as HTMLButtonElement).disabled).toBe(true);

    act(() => resolveApply());
    await waitFor(() => expect(screen.getByText(/applied to working tree/i)).toBeTruthy());
  });

  it("shows a friendly Apply-failed state on rejection", async () => {
    await openChatAndFillTask();
    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));
    act(() => controllable.resolve(orchestrateResultFixture()));
    await waitFor(() => expect(screen.getByRole("button", { name: /review and apply/i })).toBeTruthy());

    candidateApplyMock.mockRejectedValueOnce(new EngineError(-32000, "candidate apply failed: conflict", undefined));
    fireEvent.click(screen.getByRole("button", { name: /review and apply/i }));
    fireEvent.click(screen.getByRole("button", { name: /^apply changes$/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/candidate apply failed/i);
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
    expect(screen.queryByRole("button", { name: /review and apply/i })).toBeNull();
  });

  it("never calls console.* while running/streaming/resolving/applying (content-logging invariant)", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await openChatAndFillTask("a very specific secret-looking task string");
      const controllable = makeControllableRun();
      runOrchestrateMock.mockReturnValueOnce(controllable);
      fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

      act(() => controllable.progress({ stage: "route", detail: "routed to deepseek-v4-flash" }));
      act(() => controllable.resolve(orchestrateResultFixture()));
      await waitFor(() => expect(screen.getByText(/worker approved/i)).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: /review and apply/i }));
      fireEvent.click(screen.getByRole("button", { name: /^apply changes$/i }));
      await waitFor(() => expect(screen.getByText(/applied to working tree/i)).toBeTruthy());

      expect(consoleSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it("changing the active project (Rail 1) after a result returns to setup and removes the old Apply action", async () => {
    useProjectMock.mockReturnValue({ activeProjectDir: "/proj/A", addProjectByPath: addProjectByPathMock });
    const { rerender } = render(<OrchestrateScreen />);
    await waitFor(() => expect(screen.getByRole("button", { name: /open task chat/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /open task chat/i }));
    fireEvent.change(screen.getByLabelText(/task/i), { target: { value: "fix something" } });

    const controllable = makeControllableRun();
    runOrchestrateMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /^run$/i }));

    const fixture = orchestrateResultFixture();
    act(() => controllable.resolve(fixture));
    await waitFor(() => expect(screen.getByRole("button", { name: /review and apply/i })).toBeTruthy());

    // The active project changes — as Rail 1 (ProjectContext) would drive it,
    // not an in-screen picker.
    useProjectMock.mockReturnValue({ activeProjectDir: "/proj/B", addProjectByPath: addProjectByPathMock });
    rerender(<OrchestrateScreen />);

    await waitFor(() => {
      const code = screen.getAllByText(/^\/proj\//)[0];
      expect(code?.textContent).toBe("/proj/B");
    });

    expect(screen.queryByRole("button", { name: /review and apply/i })).toBeNull();
    expect(candidatePrepareApplyMock).not.toHaveBeenCalledWith("candidate-1", "/proj/B");
    expect(candidateApplyMock).not.toHaveBeenCalled();
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
        sourceFingerprint: `sha256:${"a".repeat(64)}`,
        coverage: {
          supportedTracked: 3,
          currentEntries: 3,
          unchanged: 0,
          oversized: 0,
          unreadable: 0,
          parseFailed: 0,
          removed: 0,
        },
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
});
