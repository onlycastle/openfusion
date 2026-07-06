import { useEffect, useRef } from "react";
import { ModelProvidersPane } from "./ModelProvidersPane";
import { OrchestratorsPane } from "./OrchestratorsPane";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

/** The Settings overlay: the frontier Orchestrators group (Connect to your
 * subscription via the official CLI) and the BYOK Model providers group.
 * Both panes mount fresh on every open, re-fetching their state for free. */
export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
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
          <OrchestratorsPane />
          <ModelProvidersPane />
        </div>
      </div>
    </div>
  );
}
