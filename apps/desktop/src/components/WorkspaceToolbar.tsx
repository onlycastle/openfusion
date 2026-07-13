import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { baseName, useProject } from "../ProjectContext";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Icon } from "../ui/Icon";

interface WorkspaceToolbarProps {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

export function WorkspaceToolbar({ sidebarCollapsed, onToggleSidebar }: WorkspaceToolbarProps) {
  const { projects, activeProjectDir, selectProject, addProjectByPath, removeProjectByPath } = useProject();
  const [menuOpen, setMenuOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointer = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", handlePointer);
    return () => window.removeEventListener("mousedown", handlePointer);
  }, [menuOpen]);

  useEffect(() => {
    if (feedback === null) return;
    const id = window.setTimeout(() => setFeedback(null), 4000);
    return () => window.clearTimeout(id);
  }, [feedback]);

  const handleOpenProject = (): void => {
    setMenuOpen(false);
    open({ directory: true })
      .then((selected) => {
        if (typeof selected === "string") return addProjectByPath(selected);
      })
      .catch(() => setFeedback("The project picker could not be opened."));
  };

  const handleRemove = (): void => {
    if (!activeProjectDir || removing) return;
    const name = baseName(activeProjectDir);
    setRemoving(true);
    void removeProjectByPath(activeProjectDir)
      .then(() => {
        setRemoveOpen(false);
        setFeedback(`${name} was removed from OpenFusion. The repository was not changed.`);
      })
      .catch(() => setFeedback(`Couldn't remove ${name}. Try again.`))
      .finally(() => setRemoving(false));
  };

  const activeName = activeProjectDir ? baseName(activeProjectDir) : "No project";

  return (
    <>
      <header className="workspace-toolbar" data-tauri-drag-region>
        <button
          type="button"
          className="ui-icon-button toolbar-sidebar-toggle"
          onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          <Icon name="menu" />
        </button>

        <div className="project-switcher" ref={menuRef}>
          <button
            type="button"
            className="project-switcher-button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <span className="project-switcher-icon"><Icon name="folder" /></span>
            <span className="project-switcher-copy">
              <strong>{activeName}</strong>
              <small>{activeProjectDir ? "Current project" : "Open a project to begin"}</small>
            </span>
            <Icon name="chevronDown" size={14} />
          </button>

          {menuOpen && (
            <div className="project-menu" role="menu" aria-label="Projects">
              {projects.length > 0 && <p className="project-menu-label">Recent projects</p>}
              {projects.map((project) => (
                <button
                  key={project.path}
                  type="button"
                  role="menuitemradio"
                  aria-checked={project.path === activeProjectDir}
                  onClick={() => {
                    selectProject(project.path);
                    setMenuOpen(false);
                  }}
                >
                  <Icon name="folder" />
                  <span><strong>{project.name}</strong><small>{project.path}</small></span>
                  {project.path === activeProjectDir && <span className="project-menu-check">✓</span>}
                </button>
              ))}
              <div className="project-menu-divider" />
              <button type="button" role="menuitem" onClick={handleOpenProject}>
                <Icon name="add" />
                <span>Open Project…</span>
              </button>
              {activeProjectDir && (
                <button
                  type="button"
                  role="menuitem"
                  className="project-menu-destructive"
                  onClick={() => {
                    setMenuOpen(false);
                    setRemoveOpen(true);
                  }}
                >
                  <Icon name="trash" />
                  <span>Remove from OpenFusion…</span>
                </button>
              )}
            </div>
          )}
        </div>

        <div className="workspace-toolbar-status" aria-live="polite">
          {activeProjectDir ? <><span className="status-dot status-dot-ready" /> Project selected</> : "Choose a project"}
        </div>
      </header>

      {feedback && <div className="ui-toast" role="status">{feedback}</div>}

      <ConfirmDialog
        open={removeOpen}
        title={`Remove ${activeName}?`}
        description="This removes the project from OpenFusion only. Files in the repository, including .openfusion, will not be changed."
        confirmLabel="Remove"
        destructive
        busy={removing}
        onCancel={() => setRemoveOpen(false)}
        onConfirm={handleRemove}
      />
    </>
  );
}
