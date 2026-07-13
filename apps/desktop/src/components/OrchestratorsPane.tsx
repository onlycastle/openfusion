import { useCallback, useEffect, useState } from "react";
import { frontierLogin, frontierLoginStatus, frontierLogout, type FrontierAuthStatus, type FrontierEngineKind } from "../engineClient";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Spinner } from "../ui/Spinner";

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
  connectLabel?: string;
  onSettingsChanged?: () => void;
}

function OrchestratorRow({ engine, label, installHint, connectLabel = "Connect", onSettingsChanged }: OrchestratorRowProps) {
  const [state, setState] = useState<RowState>({ status: "checking" });
  const [busy, setBusy] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);

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
      .then(() => {
        onSettingsChanged?.();
        probe();
      })
      .catch((err: unknown) => setState({ status: "error", message: friendlyMessage(err) }))
      .finally(() => setBusy(false));
  }, [engine, onSettingsChanged, probe]);

  const onSignOut = useCallback(() => {
    setBusy(true);
    setSignOutOpen(false);
    frontierLogout(engine)
      .then(() => {
        onSettingsChanged?.();
        probe();
      })
      .catch((err: unknown) => setState({ status: "error", message: friendlyMessage(err) }))
      .finally(() => setBusy(false));
  }, [engine, onSettingsChanged, probe]);

  const connected = state.status === "ready" && state.auth.state === "connected";
  const notInstalled = state.status === "ready" && state.auth.state === "not-installed";

  return (
    <li className="orchestrator-row">
      <span className={`orchestrator-dot orchestrator-dot-${connected ? "on" : "off"}`} aria-hidden="true" />
      <span className="orchestrator-name">{label}</span>
      <span className="orchestrator-status">
        {state.status === "checking" && <><Spinner label={`Checking ${label}`} /> Checking…</>}
        {state.status === "error" && <span className="error-text">{state.message}</span>}
        {state.status === "ready" && connected && "Connected"}
        {state.status === "ready" && state.auth.state === "disconnected" && "Not connected"}
        {state.status === "ready" && notInstalled && `${label} isn't installed`}
      </span>
      <span className="orchestrator-action">
        {connected && (
          <button type="button" onClick={() => setSignOutOpen(true)} disabled={busy}>
            {busy ? "Signing out…" : "Sign Out…"}
          </button>
        )}
        {state.status === "ready" && state.auth.state === "disconnected" && (
          <button type="button" onClick={onConnect} disabled={busy}>
            {busy ? "Connecting…" : connectLabel}
          </button>
        )}
        {notInstalled && <span className="muted-text">{installHint}</span>}
      </span>
      <ConfirmDialog
        open={signOutOpen}
        title={`Sign out of ${label}?`}
        description="Lead model planning and review will be unavailable until you reconnect."
        confirmLabel="Sign Out"
        destructive
        busy={busy}
        onCancel={() => setSignOutOpen(false)}
        onConfirm={onSignOut}
      />
    </li>
  );
}

/** Frontier CLI authentication stays inside each official tool. Codex's
 * default `codex login` flow opens ChatGPT OAuth in the browser. */
export function OrchestratorsPane({ onSettingsChanged }: { onSettingsChanged?: () => void } = {}) {
  return (
    <section className="settings-pane">
      <h2 className="settings-section-title">Connections</h2>
      <p className="settings-lede">Connect the official Claude and Codex runtimes used by lead models. Subscription tokens remain inside the official tools.</p>
      <ul className="orchestrator-list">
        <OrchestratorRow
          engine="claude-code"
          label="Claude Code"
          installHint="Install the Claude Code CLI to connect."
          onSettingsChanged={onSettingsChanged}
        />
        <OrchestratorRow
          engine="codex"
          label="OpenAI Codex"
          connectLabel="Sign in with ChatGPT"
          installHint="Install the Codex CLI to sign in with ChatGPT."
          onSettingsChanged={onSettingsChanged}
        />
      </ul>
    </section>
  );
}
