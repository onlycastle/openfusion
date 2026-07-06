import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Nav } from "./components/Nav";
import { SettingsDialog } from "./components/SettingsDialog";
import { engineClient, reconfigureProvidersOnLaunch, type EngineNotification } from "./engineClient";
import { useHashRoute } from "./router";
import { EvalsScreen } from "./screens/EvalsScreen";
import { OrchestrateScreen } from "./screens/OrchestrateScreen";

/** The app shell: this is the ONE place the app subscribes to engine
 * notifications (`engineClient.onEngineEvent`), so it's also the proof, at
 * the real app's top level, that the single-subscription client works —
 * every screen mounting/unmounting underneath never triggers a second
 * `engine_events` invoke, because they'd go through the same
 * `engineClient` singleton and this subscription already established it. */
export function App() {
  const [route, navigate] = useHashRoute();
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
    // Best-effort: re-register persisted BYOK providers with the fresh engine
    // registry. A failure here must never block the shell from rendering.
    void reconfigureProvidersOnLaunch().catch(() => {});
  }, []);

  return (
    <ErrorBoundary>
      <div className="shell">
        <Nav current={route} onNavigate={navigate} onOpenSettings={() => setSettingsOpen(true)} />
        <main className="content">
          {route === "orchestrate" && <OrchestrateScreen />}
          {route === "evals" && <EvalsScreen />}
        </main>
      </div>
      <footer className="status-bar">
        <span>Engine events received: {notificationCount}</span>
        {lastNotification && <span className="status-bar-detail">last: {lastNotification.method}</span>}
      </footer>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </ErrorBoundary>
  );
}
