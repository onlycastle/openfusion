import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const { useProjectMock } = vi.hoisted(() => ({ useProjectMock: vi.fn() }));
vi.mock("../ProjectContext", () => ({ useProject: () => useProjectMock(), baseName: (d: string) => d.split("/").filter(Boolean).pop() ?? d }));

import { ProjectRail } from "./ProjectRail";

afterEach(cleanup);
const setSection = vi.fn();
beforeEach(() => {
  setSection.mockReset();
  useProjectMock.mockReturnValue({ activeProjectDir: "/r/alpha", section: "chat", setSection });
});

describe("ProjectRail", () => {
  it("shows the active project name and the three sections", () => {
    render(<ProjectRail />);
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chat" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Harness setting" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Health" })).toBeTruthy();
  });

  it("switches section on click", () => {
    render(<ProjectRail />);
    fireEvent.click(screen.getByRole("button", { name: "Harness setting" }));
    expect(setSection).toHaveBeenCalledWith("harness");
  });

  it("renders an empty state when no project is active", () => {
    useProjectMock.mockReturnValue({ activeProjectDir: null, section: "chat", setSection });
    render(<ProjectRail />);
    expect(screen.getByText(/no project selected/i)).toBeTruthy();
  });
});
