import { useProject, type Section } from "../ProjectContext";
import { Icon, type IconName } from "../ui/Icon";
import { FusionMark } from "./Logo";

interface WorkspaceSidebarProps {
  collapsed: boolean;
  onOpenSettings: () => void;
}

const SECTIONS: Array<{ id: Section; label: string; icon: IconName }> = [
  { id: "chat", label: "Studio", icon: "studio" },
  { id: "harness", label: "Harness", icon: "harness" },
  { id: "health", label: "Health", icon: "evaluations" },
];

export function WorkspaceSidebar({ collapsed, onOpenSettings }: WorkspaceSidebarProps) {
  const { activeProjectDir, section, setSection } = useProject();

  return (
    <aside className={collapsed ? "workspace-sidebar workspace-sidebar-collapsed" : "workspace-sidebar"} data-tauri-drag-region>
      <div className="workspace-brand" data-tauri-drag-region>
        <FusionMark size={19} />
        <span>OpenFusion</span>
      </div>

      <nav className="workspace-nav" aria-label="Workspace sections">
        {SECTIONS.map((item) => {
          const unavailable = activeProjectDir === null && item.id !== "chat";
          return (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? "workspace-nav-item workspace-nav-item-active" : "workspace-nav-item"}
              aria-current={section === item.id ? "page" : undefined}
              disabled={unavailable}
              onClick={() => setSection(item.id)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <button type="button" className="workspace-settings" onClick={onOpenSettings}>
        <Icon name="settings" />
        <span>Settings</span>
        <kbd>⌘,</kbd>
      </button>
    </aside>
  );
}
