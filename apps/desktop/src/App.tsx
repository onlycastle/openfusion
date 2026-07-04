import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Nav } from "./components/Nav";
import { engineClient, type EngineNotification } from "./engineClient";
import { useHashRoute } from "./router";
import { KeysScreen } from "./screens/KeysScreen";
import { OrchestrateScreen } from "./screens/OrchestrateScreen";
import { ProjectScreen } from "./screens/ProjectScreen";
import { StubScreen } from "./screens/StubScreen";

/** The app shell: this is the ONE place the app subscribes to engine
 * notifications (`engineClient.onEngineEvent`), so it's also the proof, at
 * the real app's top level, that the single-subscription client works —
 * every screen mounting/unmounting underneath never triggers a second
 * `engine_events` invoke, because they'd go through the same
 * `engineClient` singleton and this subscription already established it. */
export function App() {
  const [route, navigate] = useHashRoute();
  const [lastNotification, setLastNotification] = useState<EngineNotification | null>(null);
  const [notificationCount, setNotificationCount] = useState(0);

  useEffect(() => {
    const unsubscribe = engineClient.onEngineEvent((notification) => {
      setLastNotification(notification);
      setNotificationCount((count) => count + 1);
    });
    return unsubscribe;
  }, []);

  return (
    <ErrorBoundary>
      <div className="shell">
        <Nav current={route} onNavigate={navigate} />
        <main className="content">
          {route === "project" && <ProjectScreen />}
          {route === "keys" && <KeysScreen />}
          {route === "orchestrate" && <OrchestrateScreen />}
          {route === "evals" && <StubScreen title="Evals" />}
        </main>
      </div>
      <footer className="status-bar">
        <span>Engine events received: {notificationCount}</span>
        {lastNotification && <span className="status-bar-detail">last: {lastNotification.method}</span>}
      </footer>
    </ErrorBoundary>
  );
}
