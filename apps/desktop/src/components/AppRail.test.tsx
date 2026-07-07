import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { openMock, useProjectMock } = vi.hoisted(() => ({ openMock: vi.fn(), useProjectMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
vi.mock("../ProjectContext", () => ({ useProject: () => useProjectMock() }));
vi.mock("./Logo", () => ({ FusionMark: () => <svg data-testid="mark" /> }));

import { AppRail } from "./AppRail";

afterEach(cleanup);
const selectProject = vi.fn();
const addProjectByPath = vi.fn();
const removeProjectByPath = vi.fn();
beforeEach(() => {
  openMock.mockReset(); selectProject.mockReset(); addProjectByPath.mockReset(); removeProjectByPath.mockReset();
  useProjectMock.mockReturnValue({
    projects: [{ path: "/r/alpha", name: "alpha" }, { path: "/r/beta", name: "beta" }],
    activeProjectDir: "/r/alpha", selectProject, addProjectByPath, removeProjectByPath,
  });
});

describe("AppRail", () => {
  it("lists projects and marks the active one", () => {
    render(<AppRail onOpenSettings={vi.fn()} />);
    const alpha = screen.getByRole("button", { name: "alpha" });
    expect(alpha.getAttribute("aria-current")).toBe("true");
  });

  it("selects a project on click", () => {
    render(<AppRail onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "beta" }));
    expect(selectProject).toHaveBeenCalledWith("/r/beta");
  });

  it("opens the folder dialog and adds the chosen path", async () => {
    openMock.mockResolvedValue("/r/gamma");
    render(<AppRail onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    await waitFor(() => expect(addProjectByPath).toHaveBeenCalledWith("/r/gamma"));
  });

  it("fires onOpenSettings", () => {
    const onOpenSettings = vi.fn();
    render(<AppRail onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
