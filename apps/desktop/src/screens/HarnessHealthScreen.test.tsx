import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessHealthReport } from "../engineClient";

afterEach(cleanup);

const { useProjectMock, harnessHealthMock } = vi.hoisted(() => ({
  useProjectMock: vi.fn(),
  harnessHealthMock: vi.fn(),
}));

vi.mock("../ProjectContext", () => ({ useProject: () => useProjectMock() }));
vi.mock("../engineClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../engineClient")>();
  return { ...actual, engineClient: { harnessHealth: harnessHealthMock } };
});

import { HarnessHealthScreen } from "./HarnessHealthScreen";

function healthFixture(overrides: Partial<HarnessHealthReport> = {}): HarnessHealthReport {
  return {
    checkedAt: "2026-07-10T00:00:00.000Z",
    overall: "healthy",
    harness: { present: true, structural: "passed", freshness: "current", card: "approved" },
    wiki: { operational: "passed", index: "passed", retrieval: "passed", delivery: "passed" },
    operational: {
      status: "healthy",
      sampleSize: 8,
      successfulRuns: 7,
      failedRuns: 1,
      errorRuns: 0,
      cancelledRuns: 1,
      escalatedRuns: 2,
      reviewRequestChanges: 3,
      toolErrors: 0,
      applySucceeded: 5,
      applyFailed: 0,
      lastRunAt: "2026-07-10T00:00:00.000Z",
    },
    issues: [],
    ...overrides,
  };
}

beforeEach(() => {
  useProjectMock.mockReset();
  harnessHealthMock.mockReset();
  useProjectMock.mockReturnValue({ activeProjectDir: "/r/alpha" });
  harnessHealthMock.mockResolvedValue(healthFixture());
});

describe("Harness health screen", () => {
  it("does not run a check without an active project", () => {
    useProjectMock.mockReturnValue({ activeProjectDir: null });
    render(<HarnessHealthScreen />);

    expect(screen.getByText(/no project selected/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /refresh/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(harnessHealthMock).not.toHaveBeenCalled();
  });

  it("loads deterministic verification and production evidence without an eval form", async () => {
    render(<HarnessHealthScreen />);

    await waitFor(() => expect(harnessHealthMock).toHaveBeenCalledWith("/r/alpha"));
    await waitFor(() => expect(screen.getByText(/supported by recent production evidence/i)).toBeTruthy());
    expect(screen.getByText("Harness structure")).toBeTruthy();
    expect(screen.getByText("Wiki delivery")).toBeTruthy();
    expect(screen.getByText("Observed runs")).toBeTruthy();
    expect(screen.getByText(/reliability, not answer correctness/i)).toBeTruthy();
    expect(screen.queryByLabelText(/golden commit/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /run eval/i })).toBeNull();
  });

  it("renders safe issue categories for degraded health", async () => {
    harnessHealthMock.mockResolvedValue(
      healthFixture({
        overall: "degraded",
        operational: {
          ...healthFixture().operational,
          status: "degraded",
          errorRuns: 1,
          applyFailed: 1,
        },
        issues: [
          { code: "runtime-errors-observed", severity: "error" },
          { code: "apply-failures-observed", severity: "error" },
        ],
      }),
    );
    render(<HarnessHealthScreen />);

    await waitFor(() => expect(screen.getByText(/harness needs attention/i)).toBeTruthy());
    expect(screen.getByText(/engine-level errors/i)).toBeTruthy();
    expect(screen.getByText(/failed to apply/i)).toBeTruthy();
    expect(screen.getByText(/prompts, diffs, model output/i)).toBeTruthy();
  });

  it("refreshes the current project on demand", async () => {
    render(<HarnessHealthScreen />);
    await waitFor(() => expect(harnessHealthMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(harnessHealthMock).toHaveBeenCalledTimes(2));
  });
});
