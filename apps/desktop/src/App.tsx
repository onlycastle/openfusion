import { useEffect, useState } from "react";
import { AppRail } from "./components/AppRail";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { HarnessSettingPanel } from "./components/HarnessSettingPanel";
import { ProjectRail } from "./components/ProjectRail";
import { SettingsDialog } from "./components/SettingsDialog";
import { engineClient, reconfigureProvidersOnLaunch, type EngineNotification } from "./engineClient";
import { ProjectProvider, useProject } from "./ProjectContext";
import { EvalsScreen } from "./screens/EvalsScreen";
import { OrchestrateScreen } from "./screens/OrchestrateScreen";

/** MAIN pane: renders the active Rail 2 section for the active project. */
function MainPane({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { section } = useProject();
  if (section === "harness") return <HarnessSettingPanel />;
  if (section === "evals") return <EvalsScreen />;
  return <OrchestrateScreen onOpenSettings={onOpenSettings} />;
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lastNotification, setLastNotification] = useState<EngineNotification | null>(null);
  const [notificationCount, setNotificationCount] = useState(0);

  useEffect(() => {
    const unsubscribe = engineClient.onEngineEvent((notification) => {
      setLastNotification(notification);
      setNotificationCount((count) => count + 1);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    void reconfigureProvidersOnLaunch().catch(() => {});
  }, []);

  return (
    <ErrorBoundary>
      <ProjectProvider>
        <div className="shell shell-three-pane">
          <AppRail onOpenSettings={() => setSettingsOpen(true)} />
          <ProjectRail />
          <main className="content">
            <MainPane onOpenSettings={() => setSettingsOpen(true)} />
          </main>
        </div>
        <footer className="status-bar">
          <span>Engine events received: {notificationCount}</span>
          {lastNotification && <span className="status-bar-detail">last: {lastNotification.method}</span>}
        </footer>
        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </ProjectProvider>
    </ErrorBoundary>
  );
}
