import { useState, type KeyboardEvent } from "react";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { ModelProvidersPane } from "./ModelProvidersPane";
import { OrchestratorsPane } from "./OrchestratorsPane";
import { FrontierRolesPane } from "./FrontierRolesPane";
import { RuntimeSettingsPane } from "./RuntimeSettingsPane";

type SettingsPane = "connections" | "orchestration" | "providers" | "runtime";
const SETTINGS_PANES: SettingsPane[] = ["connections", "orchestration", "providers", "runtime"];

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onSettingsChanged?: () => void;
  projectDir?: string | null;
}

/** The Settings overlay: official runtime connections, lead-model role
 * selection, and BYOK worker models.
 * Both panes mount fresh on every open, re-fetching their state for free. */
export function SettingsDialog({ open, onClose, onSettingsChanged, projectDir }: SettingsDialogProps) {
  const [pane, setPane] = useState<SettingsPane>("connections");

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const currentIndex = SETTINGS_PANES.indexOf(pane);
    const nextPane = SETTINGS_PANES[(currentIndex + direction + SETTINGS_PANES.length) % SETTINGS_PANES.length]!;
    setPane(nextPane);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`#settings-tab-${nextPane}`)
      ?.focus();
  };

  return (
    <Dialog
      open={open}
      title="OpenFusion Settings"
      description="Manage the connections OpenFusion uses to build, route, and review work."
      onClose={onClose}
      dismissOnBackdrop
      size="large"
      footer={<button type="button" onClick={onClose}>Done</button>}
    >
      <div className="settings-layout">
        <div className="settings-tabs" role="tablist" aria-label="Settings panes">
          <button
            type="button"
            id="settings-tab-connections"
            role="tab"
            aria-selected={pane === "connections"}
            aria-controls="settings-panel"
            tabIndex={pane === "connections" ? 0 : -1}
            className={pane === "connections" ? "settings-tab settings-tab-active" : "settings-tab"}
            onClick={() => setPane("connections")}
            onKeyDown={handleTabKeyDown}
          >
            <Icon name="studio" />
            <span>Connections</span>
          </button>
          <button
            type="button"
            id="settings-tab-runtime"
            role="tab"
            aria-selected={pane === "runtime"}
            aria-controls="settings-panel"
            tabIndex={pane === "runtime" ? 0 : -1}
            className={pane === "runtime" ? "settings-tab settings-tab-active" : "settings-tab"}
            onClick={() => setPane("runtime")}
            onKeyDown={handleTabKeyDown}
          >
            <Icon name="settings" />
            <span>Runtime</span>
          </button>
          <button
            type="button"
            id="settings-tab-orchestration"
            role="tab"
            aria-selected={pane === "orchestration"}
            aria-controls="settings-panel"
            tabIndex={pane === "orchestration" ? 0 : -1}
            className={pane === "orchestration" ? "settings-tab settings-tab-active" : "settings-tab"}
            onClick={() => setPane("orchestration")}
            onKeyDown={handleTabKeyDown}
          >
            <Icon name="evaluations" />
            <span>Lead models</span>
          </button>
          <button
            type="button"
            id="settings-tab-providers"
            role="tab"
            aria-selected={pane === "providers"}
            aria-controls="settings-panel"
            tabIndex={pane === "providers" ? 0 : -1}
            className={pane === "providers" ? "settings-tab settings-tab-active" : "settings-tab"}
            onClick={() => setPane("providers")}
            onKeyDown={handleTabKeyDown}
          >
            <Icon name="harness" />
            <span>Worker models</span>
          </button>
        </div>
        <div
          id="settings-panel"
          className="settings-content"
          role="tabpanel"
          aria-labelledby={`settings-tab-${pane}`}
        >
          {pane === "connections" ? (
            <OrchestratorsPane onSettingsChanged={onSettingsChanged} />
          ) : pane === "orchestration" ? (
            <FrontierRolesPane onSettingsChanged={onSettingsChanged} />
          ) : pane === "providers" ? (
            <ModelProvidersPane onSettingsChanged={onSettingsChanged} />
          ) : (
            <RuntimeSettingsPane projectDir={projectDir} />
          )}
        </div>
      </div>
    </Dialog>
  );
}
