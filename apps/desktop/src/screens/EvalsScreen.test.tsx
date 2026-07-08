import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// `test.globals` is `false` (see vite.config.ts) so RTL's auto-registered
// `afterEach(cleanup)` never fires — do it explicitly, same as
// OrchestrateScreen.test.tsx/KeysScreen.test.tsx.
afterEach(cleanup);

// The active project now comes from `ProjectContext` (Rail 1 owns picking
// it) rather than an in-screen folder dialog — mocked so tests can drive
// `activeProjectDir` directly, same pattern as OrchestrateScreen.test.tsx.
const { useProjectMock } = vi.hoisted(() => ({ useProjectMock: vi.fn() }));
vi.mock("../ProjectContext", () => ({ useProject: () => useProjectMock() }));

// `engineClient` (the singleton) is what EvalsScreen calls through for
// `runEvals`. `importOriginal` keeps `EngineError`/`RunCancelledError` real
// so `instanceof` checks inside the component work against the same classes
// these tests construct.
const { runEvalsMock, runsListMock } = vi.hoisted(() => ({
  runEvalsMock: vi.fn(),
  runsListMock: vi.fn(),
}));

vi.mock("../engineClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engineClient")>();
  return {
    ...actual,
    engineClient: {
      runEvals: runEvalsMock,
      runsList: runsListMock,
    },
  };
});

import { EvalsScreen } from "./EvalsScreen";
import { EngineError, RunCancelledError, type EvalsReportCard, type EvalsRunRecord } from "../engineClient";

function reportFixture(overrides: Partial<EvalsReportCard> = {}): EvalsReportCard {
  return {
    taskCount: 8,
    baseline: { passed: 5, costUsd: 0.5 },
    harness: { passed: 6, costUsd: 0.2, escalations: 1 },
    savingsPct: 0.6,
    qualityHeld: true,
    verdict: "pass",
    pricingConfidence: "verified",
    perTask: [
      {
        id: "golden-abc1234",
        baselinePassed: true,
        baselineOutcome: "completed",
        harnessPassed: true,
        harnessOutcome: "worker-approved",
        baselineUsd: 0.1,
        harnessUsd: 0.02,
      },
      {
        id: "golden-def5678",
        baselinePassed: false,
        baselineOutcome: "completed",
        harnessPassed: true,
        harnessOutcome: "escalated",
        baselineUsd: 0.1,
        harnessUsd: 0.05,
      },
    ],
    note: "Sample size: 8 task(s) (a credible claim wants 20-50 paired tasks; treat this as directional).",
    cleanTaskCount: 8,
    cleanBaselinePassed: 5,
    cleanHarnessPassed: 6,
    cleanSavingsPct: 0.6,
    measurementFailureCount: 0,
    ...overrides,
  };
}

/** One `"evals"`-kind run-ledger record, as `engineClient.runsList` resolves
 * it (Task 5). Mirrors the engine's `RunRecordSchema` "evals" branch
 * (packages/engine/src/runs/ledger.ts) — kept minimal here since the History
 * strip only reads `at`/`verdict`/`savingsPct`/`taskCount`. */
function evalsRecordFixture(overrides: Partial<EvalsRunRecord> = {}): EvalsRunRecord {
  return {
    v: 1,
    kind: "evals",
    at: "2026-07-02T09:00:00.000Z",
    taskCount: 8,
    verdict: "pass",
    savingsPct: 0.42,
    cleanSavingsPct: 0.42,
    qualityHeld: true,
    qualityGapWithinNoise: false,
    pricingConfidence: "verified",
    measurementFailureCount: 0,
    perTask: [],
    note: "",
    durationMs: 1000,
    ...overrides,
  };
}

/** A controllable stand-in for `CancellableRun<EvalsReportCard>`: tests drive
 * `resolve`/`reject` directly instead of waiting on a real engine call, and
 * assert against the `cancel` spy. */
function makeControllableRun() {
  let resolveFn!: (result: EvalsReportCard) => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<EvalsReportCard>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const cancel = vi.fn().mockResolvedValue(undefined);
  return { runId: "test-run-1", promise, cancel, resolve: resolveFn, reject: rejectFn };
}

beforeEach(() => {
  useProjectMock.mockReset();
  useProjectMock.mockReturnValue({ activeProjectDir: "/r/alpha" });
  runEvalsMock.mockReset();
  // The screen now fetches history on mount (Task 5) — every pre-existing
  // test that doesn't care about history needs a default empty-resolving
  // mock so it doesn't have to know about `runsList` at all.
  runsListMock.mockReset();
  runsListMock.mockResolvedValue({ records: [], skipped: 0 });
});

/** The active project is already set via `ProjectContext` (mocked to
 * `/r/alpha` in `beforeEach`, or a custom `path` here) by the time the
 * screen mounts — unlike the old in-screen folder dialog, there is nothing
 * to click to "choose" it. */
async function setUpRunnableForm(
  path = "/r/alpha",
  commitShas = "abc1234\ndef5678",
  testCommand = "npm test",
): Promise<{ path: string; rerender: ReturnType<typeof render>["rerender"] }> {
  useProjectMock.mockReturnValue({ activeProjectDir: path });
  const { rerender } = render(<EvalsScreen />);
  expect(screen.getByText(path)).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/golden commit shas/i), { target: { value: commitShas } });
  fireEvent.change(screen.getByLabelText(/test command/i), { target: { value: testCommand } });
  return { path, rerender };
}

describe("EvalsScreen", () => {
  it("renders 'No project selected' when there is no active project in context", () => {
    useProjectMock.mockReturnValue({ activeProjectDir: null });
    render(<EvalsScreen />);

    expect(screen.getByText(/no project selected/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /choose project|select project/i })).toBeNull();
  });

  it("Run evals calls runEvals with {projectDir, tasks} built from the commit-sha/test-command form, and streams progress", async () => {
    const { path } = await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);

    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    expect(runEvalsMock).toHaveBeenCalledWith(
      {
        projectDir: path,
        tasks: [
          { commitSha: "abc1234", testCommand: ["npm", "test"] },
          { commitSha: "def5678", testCommand: ["npm", "test"] },
        ],
      },
      expect.any(Function),
    );
    const onProgress = runEvalsMock.mock.calls[0]![1] as (event: unknown) => void;

    act(() => onProgress({ stage: "start" }));
    await waitFor(() => expect(screen.getByText(/^start$/)).toBeTruthy());

    act(() => onProgress({ stage: "baseline", taskId: "golden-abc1234" }));
    await waitFor(() => expect(screen.getByText(/golden-abc1234/)).toBeTruthy());

    act(() => onProgress({ stage: "harness", taskId: "golden-abc1234" }));
    await waitFor(() => expect(screen.getAllByText(/golden-abc1234/).length).toBeGreaterThan(1));
  });

  it("renders the PASS verdict prominently, without any ETH-hazard wording", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(() => controllable.resolve(reportFixture({ verdict: "pass" })));

    await waitFor(() => expect(screen.getByText(/^PASS —/)).toBeTruthy());
    expect(screen.getByText(/harness holds quality at lower cost/i)).toBeTruthy();
    expect(screen.queryByText(/eth-hazard/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the FAIL verdict as a clear ETH-HAZARD warning — quality-degraded, never a savings win", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(
      () =>
        controllable.resolve(
          reportFixture({
            verdict: "fail",
            qualityHeld: false,
            cleanHarnessPassed: 2,
            cleanBaselinePassed: 6,
            harness: { passed: 2, costUsd: 0.1, escalations: 0 },
          }),
        ),
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alertText = screen.getByRole("alert").textContent ?? "";
    expect(alertText).toMatch(/eth-hazard/i);
    expect(alertText).toMatch(/worse quality/i);
    expect(alertText).toMatch(/flagged/i);
    expect(alertText).toMatch(/not a savings win/i);
    // Never a success framing for a quality-degrading harness.
    expect(screen.queryByText(/harness holds quality at lower cost/i)).toBeNull();
    expect(screen.queryByText(/^PASS —/)).toBeNull();
  });

  it("qualifies the savings line on a FAIL verdict so it can never skim-read as a win", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(
      () =>
        controllable.resolve(
          reportFixture({
            verdict: "fail",
            qualityHeld: false,
            cleanHarnessPassed: 2,
            cleanBaselinePassed: 6,
            harness: { passed: 2, costUsd: 0.1, escalations: 0 },
          }),
        ),
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const savingsLine = screen.getByText(/^Savings:/);
    expect(savingsLine.textContent).toMatch(/disregarded/i);
  });

  it("does NOT qualify the savings line on a PASS verdict", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(() => controllable.resolve(reportFixture({ verdict: "pass" })));

    await waitFor(() => expect(screen.getByText(/^PASS —/)).toBeTruthy());
    const savingsLine = screen.getByText(/^Savings:/);
    expect(savingsLine.textContent).not.toMatch(/disregarded/i);
  });

  it("qualifies the Clean savings line on a FAIL verdict so it can never skim-read as a win", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(
      () =>
        controllable.resolve(
          reportFixture({
            verdict: "fail",
            qualityHeld: false,
            cleanHarnessPassed: 2,
            cleanBaselinePassed: 6,
            // Positive despite the fail verdict -- fail is decided by quality
            // regardless of cost, so this is the exact skim-reads-as-win gap
            // SavingsDisplay's own qualifier already closes for the main
            // savings line.
            cleanSavingsPct: 0.3,
            harness: { passed: 2, costUsd: 0.1, escalations: 0 },
          }),
        ),
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const cleanSavingsDt = screen.getByText(/^clean savings$/i);
    const cleanSavingsDd = cleanSavingsDt.nextElementSibling as HTMLElement;
    expect(cleanSavingsDd.textContent).toMatch(/disregarded/i);
  });

  it("does NOT qualify the Clean savings line on a PASS verdict", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(() => controllable.resolve(reportFixture({ verdict: "pass" })));

    await waitFor(() => expect(screen.getByText(/^PASS —/)).toBeTruthy());
    const cleanSavingsDt = screen.getByText(/^clean savings$/i);
    const cleanSavingsDd = cleanSavingsDt.nextElementSibling as HTMLElement;
    expect(cleanSavingsDd.textContent).not.toMatch(/disregarded/i);
  });

  it("renders an INCONCLUSIVE verdict using the engine's own report.note as the reason (material measurement-failure gate)", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    // A note shaped like evals/run.ts's own buildNote() output for this gate
    // (see that module's extraNotes push for the material-measurement-
    // failure case) — driving the mocked report with a KNOWN note lets this
    // test assert the note text is shown verbatim, never re-derived from a
    // copied MATERIAL_MEASUREMENT_FAILURE_FRACTION threshold.
    const engineNote =
      "3 of 8 task(s) hit a measurement failure rather than a genuine, oracle-scoreable quality result " +
      "(harness: 2 apply-failed, 1 error; baseline: 0 error) -- see the verdict note below for exactly how " +
      "this run's pass/fail/inconclusive determination accounts for them. 3 of 8 task(s) (>= the 20% " +
      'materiality threshold) hit a measurement failure -- this run is too corrupted to ground a "pass" or a ' +
      '"fail" verdict in either direction; reported as inconclusive rather than trusting the raw pass counts.';
    act(
      () =>
        controllable.resolve(
          reportFixture({
            verdict: "inconclusive",
            taskCount: 8,
            measurementFailureCount: 3,
            note: engineNote,
          }),
        ),
    );

    // Scoped to the verdict banner (role="status") rather than a page-wide
    // text query — report.note is ALSO rendered verbatim further down the
    // report card (the existing muted-text paragraph), and this note's own
    // prose contains the word "inconclusive" too, so an unscoped query would
    // ambiguously match both.
    const banner = await screen.findByRole("status");
    expect(banner.textContent).toMatch(/inconclusive/i);
    expect(banner.textContent).toMatch(/too corrupted to ground a "pass" or a "fail" verdict/i);
  });

  it("renders an INCONCLUSIVE verdict using the engine's own report.note as the reason (too-few-tasks gate, a demo not a claim)", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    // Shaped like buildNote()'s own always-present sample-size sentence for
    // taskCount below the engine's private minimum — again driven by a KNOWN
    // note, not a re-derived MIN_TASK_COUNT_FOR_VERDICT comparison.
    const engineNote =
      "Sample size 3 task(s) is below the 5-task minimum for a credible savings claim (Anthropic eval guidance " +
      "— see docs/research/2026-07-04-m6-pricing-eval-verification.md) -- this is a demo, not a claim.";
    act(
      () =>
        controllable.resolve(
          reportFixture({
            verdict: "inconclusive",
            taskCount: 3,
            measurementFailureCount: 0,
            cleanBaselinePassed: 2,
            cleanSavingsPct: 0.1,
            perTask: [],
            note: engineNote,
          }),
        ),
    );

    const banner = await screen.findByRole("status");
    expect(banner.textContent).toMatch(/inconclusive/i);
    expect(banner.textContent).toMatch(/below the 5-task minimum/i);
    expect(banner.textContent).toMatch(/demo, not a claim/i);
  });

  it("prefers report.note verbatim even for the gate the engine's note doesn't name explicitly (quality held, no savings measured)", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    // evals/run.ts's buildNote() never adds an extraNotes entry for THIS
    // gate (quality held on the clean subset, but cleanSavingsPct <= 0) —
    // unlike the other three inconclusive gates. The reason shown must still
    // come from report.note (never a hand-derived "quality held, no
    // savings" sentence re-deriving the engine's own gate order).
    const engineNote =
      "Sample size: 8 task(s) (a credible claim wants 20-50 paired tasks; treat this as directional). " +
      "Cost figures are estimate-class (see engine.orchestrate's own cost.note) -- directional, not exact. " +
      "Pricing confidence: verified (the worst confidence across every cost record this run produced).";
    act(
      () =>
        controllable.resolve(
          reportFixture({
            verdict: "inconclusive",
            taskCount: 8,
            measurementFailureCount: 0,
            cleanBaselinePassed: 5,
            cleanSavingsPct: -0.05,
            note: engineNote,
          }),
        ),
    );

    const banner = await screen.findByRole("status");
    expect(banner.textContent).toMatch(/inconclusive/i);
    expect(banner.textContent).toMatch(/credible claim wants 20-50 paired tasks/i);
  });

  it("shows a pricingConfidence caveat badge whenever confidence is not 'verified'", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(() => controllable.resolve(reportFixture({ pricingConfidence: "provider-reported" })));

    await waitFor(() => expect(screen.getByText(/savings estimate/i)).toBeTruthy());
    expect(screen.getByText(/pricing confidence: provider-reported/i)).toBeTruthy();
  });

  it("shows NO caveat badge when pricingConfidence is 'verified'", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(() => controllable.resolve(reportFixture({ pricingConfidence: "verified" })));

    await waitFor(() => expect(screen.getByText(/harness holds quality/i)).toBeTruthy());
    expect(screen.queryByText(/savings estimate/i)).toBeNull();
  });

  it("renders a generic 'savings not computable' — NOT a fake number — when savingsPct is null (null occurs for more than just unpriced models)", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(
      () =>
        controllable.resolve(
          reportFixture({
            verdict: "inconclusive",
            savingsPct: null,
            pricingConfidence: "unpriced",
            cleanSavingsPct: null,
          }),
        ),
    );

    await waitFor(() => expect(screen.getByText(/savings: not computable/i)).toBeTruthy());
    expect(screen.queryByText(/unpriced models/i)).toBeNull();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("renders the per-task table (id, baseline/harness pass-fail, outcome, cost) from the result", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(() => controllable.resolve(reportFixture()));

    await waitFor(() => expect(screen.getByText("golden-abc1234")).toBeTruthy());
    expect(screen.getByText("golden-def5678")).toBeTruthy();
    // golden-abc1234: baseline pass, harness pass, worker-approved
    const row1 = screen.getByText("golden-abc1234").closest("tr");
    expect(row1?.textContent).toMatch(/pass.*pass.*worker-approved.*\$0\.1000.*\$0\.0200/is);
    // golden-def5678: baseline fail, harness pass, escalated
    const row2 = screen.getByText("golden-def5678").closest("tr");
    expect(row2?.textContent).toMatch(/fail.*pass.*escalated/is);
  });

  it("renders the clean-subset numbers (cleanTaskCount/cleanBaseline/cleanHarness/cleanSavings/measurementFailureCount)", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(
      () =>
        controllable.resolve(
          reportFixture({
            cleanTaskCount: 7,
            cleanBaselinePassed: 4,
            cleanHarnessPassed: 5,
            cleanSavingsPct: 0.42,
            measurementFailureCount: 1,
          }),
        ),
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: /clean subset/i })).toBeTruthy());
    const cleanSection = screen.getByText(/clean tasks/i).closest("dl");
    expect(cleanSection?.textContent).toMatch(/7/);
    expect(cleanSection?.textContent).toMatch(/4/);
    expect(cleanSection?.textContent).toMatch(/5/);
    expect(cleanSection?.textContent).toMatch(/42\.0%/);
    expect(cleanSection?.textContent).toMatch(/1/);
  });

  it("Report card heading shows the RUN's project directory, not the live active project (wrong-project safety test)", async () => {
    const { rerender } = await setUpRunnableForm("/proj/A");
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(() => controllable.resolve(reportFixture()));
    await waitFor(() => expect(screen.getByRole("heading", { name: /report card/i })).toBeTruthy());
    expect(screen.getByRole("heading", { name: /report card/i }).textContent).toMatch(/\/proj\/A/);

    // The active project changes AFTER the run resolves — as Rail 1
    // (ProjectContext) would drive it, not an in-screen picker.
    useProjectMock.mockReturnValue({ activeProjectDir: "/proj/B" });
    rerender(<EvalsScreen />);
    await waitFor(() => {
      const code = screen.getAllByText(/^\/proj\//)[0];
      expect(code?.textContent).toBe("/proj/B");
    });

    // CORRECTNESS: the report card must still show the RUN's project
    // (/proj/A), not the live active project (/proj/B) — the same
    // wrong-project safety property OrchestrateScreen's own analogous test
    // guards.
    expect(screen.getByRole("heading", { name: /report card/i }).textContent).toMatch(/\/proj\/A/);
    expect(screen.getByRole("heading", { name: /report card/i }).textContent).not.toMatch(/\/proj\/B/);
  });

  it("Cancel calls the run's cancel(), disables the button while cancelling (no second cancel call), then shows Cancelled — not Failed — on RunCancelledError", async () => {
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

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
    await setUpRunnableForm();
    const controllable = makeControllableRun();
    runEvalsMock.mockReturnValueOnce(controllable);
    fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

    act(() => controllable.reject(new EngineError(-32000, "no harness; run engine.harness.generate first", undefined)));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alertText = screen.getByRole("alert").textContent ?? "";
    expect(alertText).toMatch(/no harness/i);
    expect(alertText).not.toMatch(/at Object|\.tsx:\d+|\bstack\b/i);
    expect(screen.queryByText(/^cancelled$/i)).toBeNull();
  });

  it("never calls console.* while running/streaming/resolving (content-logging invariant)", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await setUpRunnableForm("/Users/test/project", "abc1234-secret-looking-sha", "npm test");
      const controllable = makeControllableRun();
      runEvalsMock.mockReturnValueOnce(controllable);
      fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

      const onProgress = runEvalsMock.mock.calls[0]![1] as (event: unknown) => void;
      act(() => onProgress({ stage: "baseline", taskId: "golden-abc1234-secret-looking-sha" }));
      act(() => controllable.resolve(reportFixture()));
      await waitFor(() => expect(screen.getByText(/harness holds quality/i)).toBeTruthy());

      expect(consoleSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it("disables Run evals until a project, at least one commit sha, and a test command are all present", async () => {
    useProjectMock.mockReturnValue({ activeProjectDir: null });
    const { rerender } = render(<EvalsScreen />);
    const runButton = () => screen.getByRole("button", { name: /run evals/i }) as HTMLButtonElement;
    expect(runButton().disabled).toBe(true);
    expect(screen.getByText(/no project selected/i)).toBeTruthy();

    // The active project becomes available — as Rail 1 (ProjectContext)
    // would drive it, not an in-screen picker.
    useProjectMock.mockReturnValue({ activeProjectDir: "/Users/test/project" });
    rerender(<EvalsScreen />);
    await waitFor(() => expect(screen.getByText("/Users/test/project")).toBeTruthy());
    expect(runButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/golden commit shas/i), { target: { value: "abc1234" } });
    expect(runButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/test command/i), { target: { value: "npm test" } });
    expect(runButton().disabled).toBe(false);
  });

  describe("evals history strip (Task 5)", () => {
    it("renders a History section with rows in the RPC's own (newest-first) order, verdict badges, and formatted savings", async () => {
      const records: EvalsRunRecord[] = [
        evalsRecordFixture({ at: "2026-07-02T09:00:00.000Z", verdict: "pass", savingsPct: 0.567, taskCount: 5 }),
        evalsRecordFixture({ at: "2026-07-01T09:00:00.000Z", verdict: "fail", savingsPct: null, taskCount: 3 }),
      ];
      runsListMock.mockResolvedValue({ records, skipped: 0 });

      await setUpRunnableForm();

      await screen.findByRole("heading", { name: /^history$/i });
      const rows = document.querySelectorAll(".evals-history-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toMatch(/pass/i);
      expect(rows[0]?.textContent).toMatch(/56\.7%/);
      expect(rows[0]?.textContent).toMatch(/5 tasks/);
      expect(rows[1]?.textContent).toMatch(/fail/i);
      expect(rows[1]?.textContent).toMatch(/—/);
      expect(rows[1]?.textContent).toMatch(/3 tasks/);

      expect(runsListMock).toHaveBeenCalledWith("/r/alpha", "evals", 10);
    });

    it("shows no History heading when runsList resolves with empty records", async () => {
      runsListMock.mockResolvedValue({ records: [], skipped: 0 });

      await setUpRunnableForm();
      await waitFor(() => expect(runsListMock).toHaveBeenCalled());

      expect(screen.queryByRole("heading", { name: /^history$/i })).toBeNull();
    });

    it("renders normally (no crash, no History, no error) when runsList rejects — best-effort chrome, never an error state", async () => {
      runsListMock.mockRejectedValue(new Error("boom"));

      await setUpRunnableForm();
      await waitFor(() => expect(runsListMock).toHaveBeenCalled());

      expect(screen.queryByRole("heading", { name: /^history$/i })).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      // The rest of the screen still renders fine.
      expect(screen.getByText("/r/alpha")).toBeTruthy();
    });

    it("refetches history after a run completes", async () => {
      await setUpRunnableForm();
      await waitFor(() => expect(runsListMock).toHaveBeenCalledTimes(1));

      const controllable = makeControllableRun();
      runEvalsMock.mockReturnValueOnce(controllable);
      fireEvent.click(screen.getByRole("button", { name: /run evals/i }));

      act(() => controllable.resolve(reportFixture()));
      await waitFor(() => expect(screen.getByText(/harness holds quality/i)).toBeTruthy());

      await waitFor(() => expect(runsListMock.mock.calls.length).toBeGreaterThanOrEqual(2));
      const lastCall = runsListMock.mock.calls[runsListMock.mock.calls.length - 1];
      expect(lastCall?.[0]).toBe("/r/alpha");
      expect(lastCall?.[1]).toBe("evals");
    });

    it("stale-guards the history fetch: a slow response for a project no longer active must not overwrite the new project's history", async () => {
      let resolveA!: (value: { records: EvalsRunRecord[]; skipped: number }) => void;
      const pendingA = new Promise<{ records: EvalsRunRecord[]; skipped: number }>((resolve) => {
        resolveA = resolve;
      });
      runsListMock.mockReturnValueOnce(pendingA);
      useProjectMock.mockReturnValue({ activeProjectDir: "/proj/A" });
      const { rerender } = render(<EvalsScreen />);
      await waitFor(() => expect(runsListMock).toHaveBeenCalledTimes(1));

      // Switch to project B before A's fetch resolves — B's own fetch
      // resolves immediately with empty history.
      runsListMock.mockResolvedValueOnce({ records: [], skipped: 0 });
      useProjectMock.mockReturnValue({ activeProjectDir: "/proj/B" });
      rerender(<EvalsScreen />);
      await waitFor(() => expect(runsListMock).toHaveBeenCalledTimes(2));

      // NOW resolve A's slow response with a non-empty record — must be
      // dropped, not painted under project B's now-active screen.
      await act(async () => {
        resolveA({ records: [evalsRecordFixture()], skipped: 0 });
        await Promise.resolve();
      });

      expect(screen.queryByRole("heading", { name: /^history$/i })).toBeNull();
    });
  });
});
