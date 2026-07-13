import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { addProject, listProjects, removeProject, type ProjectMeta } from "./engineClient";

export type Section = "chat" | "harness" | "health";

/** Last path segment, or the raw string when it has none (e.g. "/"). */
export function baseName(dir: string): string {
  const segments = dir.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? dir;
}

interface ProjectContextValue {
  projects: ProjectMeta[];
  activeProjectDir: string | null;
  section: Section;
  selectProject: (path: string) => void;
  addProjectByPath: (path: string) => Promise<void>;
  removeProjectByPath: (path: string) => Promise<void>;
  setSection: (section: Section) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (ctx === null) throw new Error("useProject must be used within <ProjectProvider>");
  return ctx;
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [activeProjectDir, setActiveProjectDir] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("chat");

  useEffect(() => {
    listProjects()
      .then((list) => {
        setProjects(list);
        setActiveProjectDir((current) => current ?? list[0]?.path ?? null);
      })
      .catch(() => {});
  }, []);

  const selectProject = useCallback((path: string) => {
    setActiveProjectDir(path);
    setSection("chat");
    // Bump to front (MRU) then resync the list order. Best-effort.
    void addProject({ path, name: baseName(path) })
      .then(() => listProjects())
      .then(setProjects)
      .catch(() => {});
  }, []);

  const addProjectByPath = useCallback(async (path: string) => {
    await addProject({ path, name: baseName(path) });
    setProjects(await listProjects());
    setActiveProjectDir(path);
    setSection("chat");
  }, []);

  const removeProjectByPath = useCallback(async (path: string) => {
    await removeProject(path);
    const list = await listProjects();
    setProjects(list);
    setActiveProjectDir((current) => (current === path ? list[0]?.path ?? null : current));
  }, []);

  return (
    <ProjectContext.Provider
      value={{ projects, activeProjectDir, section, selectProject, addProjectByPath, removeProjectByPath, setSection }}
    >
      {children}
    </ProjectContext.Provider>
  );
}
