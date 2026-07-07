import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { listProjectsMock, addProjectMock, removeProjectMock } = vi.hoisted(() => ({
  listProjectsMock: vi.fn(), addProjectMock: vi.fn(), removeProjectMock: vi.fn(),
}));
vi.mock("./engineClient", () => ({
  listProjects: listProjectsMock, addProject: addProjectMock, removeProject: removeProjectMock,
}));

import { ProjectProvider, useProject, baseName } from "./ProjectContext";

afterEach(cleanup);
beforeEach(() => {
  listProjectsMock.mockReset(); addProjectMock.mockReset(); removeProjectMock.mockReset();
  addProjectMock.mockResolvedValue(undefined); removeProjectMock.mockResolvedValue(undefined);
});

function Probe() {
  const { projects, activeProjectDir, section, addProjectByPath, setSection } = useProject();
  return (
    <div>
      <span data-testid="active">{activeProjectDir ?? "none"}</span>
      <span data-testid="section">{section}</span>
      <span data-testid="count">{projects.length}</span>
      <button onClick={() => void addProjectByPath("/r/beta")}>add</button>
      <button onClick={() => setSection("harness")}>harness</button>
    </div>
  );
}

describe("ProjectContext", () => {
  it("baseName returns the last path segment", () => {
    expect(baseName("/a/b/openfusion")).toBe("openfusion");
    expect(baseName("/")).toBe("/");
  });

  it("hydrates from listProjects and selects the most recent", async () => {
    listProjectsMock.mockResolvedValue([{ path: "/r/alpha", name: "alpha" }]);
    render(<ProjectProvider><Probe /></ProjectProvider>);
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("/r/alpha"));
    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  it("addProjectByPath adds, re-lists, and activates", async () => {
    listProjectsMock.mockResolvedValueOnce([]); // initial hydrate
    listProjectsMock.mockResolvedValueOnce([{ path: "/r/beta", name: "beta" }]); // after add
    render(<ProjectProvider><Probe /></ProjectProvider>);
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("none"));
    fireEvent.click(screen.getByText("add"));
    await waitFor(() => expect(addProjectMock).toHaveBeenCalledWith({ path: "/r/beta", name: "beta" }));
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("/r/beta"));
  });

  it("setSection switches the active section", async () => {
    listProjectsMock.mockResolvedValue([]);
    render(<ProjectProvider><Probe /></ProjectProvider>);
    fireEvent.click(screen.getByText("harness"));
    expect(screen.getByTestId("section").textContent).toBe("harness");
  });
});
