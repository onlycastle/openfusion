import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { HarnessSettingPanel } from "./components/HarnessSettingPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WorkspaceToolbar } from "./components/WorkspaceToolbar";
import { engineClient, reconfigureProvidersOnLaunch } from "./engineClient";
import { ProjectProvider, useProject } from "./ProjectContext";
import { HarnessHealthScreen } from "./screens/HarnessHealthScreen";
import { OrchestrateScreen } from "./screens/OrchestrateScreen";

/** MAIN pane: renders the active Rail 2 section for the active project. */
function MainPane({ onOpenSettings, setupRefreshToken }: { onOpenSettings: () => void; setupRefreshToken: number }) {
  const { section } = useProject();
  if (section === "harness") return <HarnessSettingPanel />;
  if (section === "health") return <HarnessHealthScreen />;
  return <OrchestrateScreen onOpenSettings={onOpenSettings} setupRefreshToken={setupRefreshToken} />;
}

function WorkspaceShell({ onOpenSettings, setupRefreshToken }: { onOpenSettings: () => void; setupRefreshToken: number }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <div className={sidebarCollapsed ? "workspace-shell workspace-shell-sidebar-collapsed" : "workspace-shell"}>
      <WorkspaceSidebar collapsed={sidebarCollapsed} onOpenSettings={onOpenSettings} />
      <div className="workspace-main">
        <WorkspaceToolbar
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
        />
        <main className="content">
          <MainPane onOpenSettings={onOpenSettings} setupRefreshToken={setupRefreshToken} />
        </main>
      </div>
    </div>
  );
}

function ProjectSettingsDialog(props: {
  open: boolean;
  onClose: () => void;
  onSettingsChanged: () => void;
}) {
  const { activeProjectDir } = useProject();
  return <SettingsDialog {...props} projectDir={activeProjectDir} />;
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [setupRefreshToken, setSetupRefreshToken] = useState(0);

  useEffect(() => {
    const unsubscribe = engineClient.onEngineEvent(() => {});
    return unsubscribe;
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey && event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    void reconfigureProvidersOnLaunch().catch(() => {});
  }, []);

  return (
    <ErrorBoundary>
      <ProjectProvider>
        <WorkspaceShell onOpenSettings={() => setSettingsOpen(true)} setupRefreshToken={setupRefreshToken} />
        <ProjectSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSettingsChanged={() => setSetupRefreshToken((token) => token + 1)}
        />
      </ProjectProvider>
    </ErrorBoundary>
  );
}
