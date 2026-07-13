import { useCallback, useEffect, useMemo, useState } from "react";
import {
  engineClient,
  type FrontierModelEntry,
  type FrontierRoleSelections,
  type FrontierSelection,
} from "../engineClient";
import {
  frontierSelectionValue,
  loadFrontierRoleSelections,
  parseFrontierSelectionValue,
  saveFrontierRoleSelections,
} from "../frontierPreferences";
import { Spinner } from "../ui/Spinner";

const ROLES: Array<{ key: keyof FrontierRoleSelections; label: string; description: string }> = [
  { key: "planning", label: "Harness planning", description: "Builds project knowledge and the specialist routing plan." },
  { key: "review", label: "Worker review", description: "Approves or rejects changes from routed worker models." },
  { key: "escalation", label: "Escalation", description: "Completes difficult tasks after worker attempts are exhausted." },
  { key: "baseline", label: "Evaluation baseline", description: "Provides the direct lead model comparison in evaluation runs." },
];

function engineLabel(engine: FrontierSelection["engine"]): string {
  return engine === "codex" ? "OpenAI Codex" : "Claude Code";
}

export function FrontierRolesPane({ onSettingsChanged }: { onSettingsChanged?: () => void } = {}) {
  const [selections, setSelections] = useState<FrontierRoleSelections>(() => loadFrontierRoleSelections());
  const [models, setModels] = useState<FrontierModelEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadModels = useCallback(() => {
    setModels(null);
    setError(null);
    engineClient.frontierModels().then(
      (result) => {
        setModels(result.models);
        if (result.models.length === 0 && result.unavailable.length > 0) {
          setError(result.unavailable.map((entry) => `${engineLabel(entry.engine)}: ${entry.message}`).join(" · "));
        }
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  useEffect(() => loadModels(), [loadModels]);

  const options = useMemo(() => {
    const discovered = models ?? [];
    const discoveredValue = (model: FrontierModelEntry): string =>
      frontierSelectionValue({ engine: model.engine, model: model.id });
    const preserved = [...new Map(
      Object.values(selections)
        .filter((selection) => !discovered.some((model) => discoveredValue(model) === frontierSelectionValue(selection)))
        .map((selection) => [frontierSelectionValue(selection), selection]),
    ).values()];
    return [
      ...discovered.map((model) => ({
        value: discoveredValue(model),
        label: `${engineLabel(model.engine)} · ${model.displayName}${model.isDefault ? " (default)" : ""}`,
        description: model.description,
      })),
      ...preserved.map((selection) => ({
        value: frontierSelectionValue(selection),
        label: `${engineLabel(selection.engine)} · ${selection.model ?? "Default"} (currently unavailable)`,
        description: "This saved model was not returned by the current authenticated runtime.",
      })),
    ];
  }, [models, selections]);

  const onChange = useCallback(
    (role: keyof FrontierRoleSelections, value: string) => {
      const selection = parseFrontierSelectionValue(value);
      if (selection === null) return;
      setSelections((current) => {
        const next = { ...current, [role]: selection };
        saveFrontierRoleSelections(next);
        return next;
      });
      onSettingsChanged?.();
    },
    [onSettingsChanged],
  );

  return (
    <section className="settings-pane settings-pane-divided">
      <h2 className="settings-section-title">Lead models</h2>
      <p className="settings-lede">Choose the runtime and model that plans, reviews, handles escalations, and provides the evaluation baseline.</p>
      {models === null && error === null && <p role="status"><Spinner label="Discovering lead models" /> Discovering models from Claude and Codex…</p>}
      {error !== null && <p role="alert" className="error-text">{error}</p>}
      <div className="frontier-role-list">
        {ROLES.map((role) => {
          const current = selections[role.key];
          const selected = options.find((option) => option.value === frontierSelectionValue(current));
          return (
            <label className="frontier-role-row" key={role.key}>
              <span><strong>{role.label}</strong><small>{role.description}</small></span>
              <select
                aria-label={role.label}
                value={frontierSelectionValue(current)}
                disabled={options.length === 0}
                title={selected?.description}
                onChange={(event) => onChange(role.key, event.target.value)}
              >
                {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          );
        })}
      </div>
      <button type="button" onClick={loadModels}>Refresh model catalog</button>
    </section>
  );
}
