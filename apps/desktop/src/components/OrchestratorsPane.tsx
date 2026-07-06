import { useCallback, useEffect, useState } from "react";
import { frontierLogin, frontierLoginStatus, frontierLogout, type FrontierAuthStatus, type FrontierEngineKind } from "../engineClient";

function friendlyMessage(err: unknown): string {
  if (typeof err === "string" && err.trim().length > 0) return err;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return "Something went wrong. Please try again.";
}

type RowState = { status: "checking" } | { status: "ready"; auth: FrontierAuthStatus } | { status: "error"; message: string };

interface OrchestratorRowProps {
  engine: FrontierEngineKind;
  label: string;
  installHint: string;
}

function OrchestratorRow({ engine, label, installHint }: OrchestratorRowProps) {
  const [state, setState] = useState<RowState>({ status: "checking" });
  const [busy, setBusy] = useState(false);

  const probe = useCallback(() => {
    setState({ status: "checking" });
    frontierLoginStatus(engine)
      .then((auth) => setState({ status: "ready", auth }))
      .catch((err: unknown) => setState({ status: "error", message: friendlyMessage(err) }));
  }, [engine]);

  useEffect(() => {
    probe();
  }, [probe]);

  const onConnect = useCallback(() => {
    setBusy(true);
    frontierLogin(engine)
      .then(probe)
      .catch((err: unknown) => setState({ status: "error", message: friendlyMessage(err) }))
      .finally(() => setBusy(false));
  }, [engine, probe]);

  const onSignOut = useCallback(() => {
    setBusy(true);
    frontierLogout(engine)
      .then(probe)
      .catch((err: unknown) => setState({ status: "error", message: friendlyMessage(err) }))
      .finally(() => setBusy(false));
  }, [engine, probe]);

  const connected = state.status === "ready" && state.auth.state === "connected";
  const notInstalled = state.status === "ready" && state.auth.state === "not-installed";

  return (
    <li className="orchestrator-row">
      <span className={`orchestrator-dot orchestrator-dot-${connected ? "on" : "off"}`} aria-hidden="true" />
      <span className="orchestrator-name">{label}</span>
      <span className="orchestrator-status">
        {state.status === "checking" && "Checking…"}
        {state.status === "error" && <span className="error-text">{state.message}</span>}
        {state.status === "ready" && connected && "Connected"}
        {state.status === "ready" && state.auth.state === "disconnected" && "Not connected"}
        {state.status === "ready" && notInstalled && `${label} isn't installed`}
      </span>
      <span className="orchestrator-action">
        {connected && (
          <button type="button" onClick={onSignOut} disabled={busy}>
            Sign out
          </button>
        )}
        {state.status === "ready" && state.auth.state === "disconnected" && (
          <button type="button" onClick={onConnect} disabled={busy}>
            Connect
          </button>
        )}
        {notInstalled && <span className="muted-text">{installHint}</span>}
      </span>
    </li>
  );
}

/** The frontier orchestrators pane. Project 1 renders the Claude Code row
 * only; the Codex row is added with its adapter (Project 2). */
export function OrchestratorsPane() {
  return (
    <section className="settings-pane">
      <h2 className="settings-section-title">Orchestrators</h2>
      <p className="settings-lede">Run the frontier tier on your own subscription. Connect signs in through the official CLI — your token never touches OpenFusion.</p>
      <ul className="orchestrator-list">
        <OrchestratorRow engine="claude-code" label="Claude Code" installHint="Install the Claude Code CLI to connect." />
      </ul>
    </section>
  );
}
