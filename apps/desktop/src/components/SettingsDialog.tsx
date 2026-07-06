import { useEffect, useRef, useState } from "react";
import { EngineError, engineClient, type ModelProviderSummary } from "../engineClient";
import { KeysScreen } from "../screens/KeysScreen";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Renders a rejection as a short, user-facing sentence — never a stack
 * trace. Same posture as the cockpit screens' own `friendlyMessage`. */
function friendlyMessage(err: unknown): string {
  if (err instanceof EngineError) return `[${err.code}] ${err.message}`;
  if (typeof err === "string" && err.trim().length > 0) return err;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return "Something went wrong. Please try again.";
}

type ProvidersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; providers: ModelProviderSummary[] };

/** The configured model providers, as a read-only readout — absorbed from
 * the former Project screen. It answers the same question the keys pane
 * above it does ("what is this app configured with?"), which is why it
 * lives here and not in navigation. */
function ProvidersPane() {
  const [state, setState] = useState<ProvidersState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    engineClient
      .modelsList()
      .then((result) => {
        if (!cancelled) setState({ status: "ready", providers: result.providers });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", message: friendlyMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="settings-pane settings-pane-divided">
      <h2 className="settings-section-title">Model providers</h2>
      <p className="settings-lede">What the engine routes work across. Configured engine-side; read-only here.</p>
      {state.status === "loading" && <p role="status">Loading…</p>}
      {state.status === "error" && (
        <p role="alert" className="error-text">
          {state.message}
        </p>
      )}
      {state.status === "ready" &&
        (state.providers.length === 0 ? (
          <p className="settings-empty">No providers configured yet.</p>
        ) : (
          <ul className="key-list">
            {state.providers.map((provider) => (
              <li key={provider.id}>
                <code className="key-id">{provider.id}</code>
                <span className="key-status">{provider.kind}</span>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

/** The Settings overlay. Hosts the API-keys (BYOK) pane and the model-
 * providers readout — settings are an interruption you dismiss, not a place
 * you navigate to, so this is plain component state in App rather than a
 * route. Both panes mount fresh on every open, which re-fetches their lists
 * for free — no staleness handling needed anywhere. */
export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    // Move focus into the dialog so Esc / tabbing starts from it.
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    // The backdrop click-to-close is a convenience on top of the labelled
    // Close button and Esc, not the only path — hence no key handler here.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="dialog"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h1 id="settings-title">Settings</h1>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close settings">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="dialog-body">
          <KeysScreen />
          <ProvidersPane />
        </div>
      </div>
    </div>
  );
}
