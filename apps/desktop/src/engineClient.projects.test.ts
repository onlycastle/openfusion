import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {},
}));

import { listProjects, addProject, removeProject } from "./engineClient";

beforeEach(() => invokeMock.mockReset());
afterEach(() => vi.clearAllMocks());

describe("project registry wrappers", () => {
  it("listProjects invokes list_projects", async () => {
    invokeMock.mockResolvedValue([{ path: "/r/a", name: "a" }]);
    await expect(listProjects()).resolves.toEqual([{ path: "/r/a", name: "a" }]);
    expect(invokeMock).toHaveBeenCalledWith("list_projects");
  });

  it("addProject passes the project object", async () => {
    invokeMock.mockResolvedValue(undefined);
    await addProject({ path: "/r/a", name: "a" });
    expect(invokeMock).toHaveBeenCalledWith("add_project", { project: { path: "/r/a", name: "a" } });
  });

  it("removeProject passes the path", async () => {
    invokeMock.mockResolvedValue(undefined);
    await removeProject("/r/a");
    expect(invokeMock).toHaveBeenCalledWith("remove_project", { path: "/r/a" });
  });
});
