import { open } from "@tauri-apps/plugin-dialog";
import { useProject } from "../ProjectContext";
import { FusionMark } from "./Logo";

export function AppRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { projects, activeProjectDir, selectProject, addProjectByPath, removeProjectByPath } = useProject();

  const onAdd = (): void => {
    open({ directory: true })
      .then((selected) => {
        if (typeof selected === "string") return addProjectByPath(selected);
      })
      .catch(() => {});
  };

  return (
    <nav className="app-rail" aria-label="Projects" data-tauri-drag-region>
      <div className="app-rail-head" data-tauri-drag-region>
        <FusionMark />
        <span className="app-rail-word">OpenFusion</span>
      </div>
      <div className="app-rail-label" aria-hidden="true">Projects</div>
      <ul className="project-list" aria-label="Projects">
        {projects.map((project) => (
          <li key={project.path} className="project-list-item">
            <button
              type="button"
              className={project.path === activeProjectDir ? "project-item project-item-active" : "project-item"}
              aria-current={project.path === activeProjectDir ? "true" : undefined}
              onClick={() => selectProject(project.path)}
            >
              {project.name}
            </button>
            <button
              type="button"
              className="project-remove"
              aria-label={`Remove ${project.name}`}
              onClick={() => void removeProjectByPath(project.path).catch(() => {})}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {projects.length === 0 && <p className="project-list-empty">No projects yet</p>}
      <button type="button" className="project-add" onClick={onAdd}>
        <span aria-hidden="true">+</span>
        <span>Add project</span>
      </button>
      <div className="app-rail-foot">
        <button type="button" className="nav-link" onClick={onOpenSettings}>Settings</button>
      </div>
    </nav>
  );
}
