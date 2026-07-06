import { useCallback, useEffect, useMemo, useState } from "react";
import { engineClient, listProviderConfigs, type AgentModel, type HarnessAgentView, type HarnessTeam } from "../engineClient";
import { useProject } from "../ProjectContext";

function friendlyMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  if (typeof err === "string" && err.trim().length > 0) return err;
  return "Something went wrong. Please try again.";
}

interface ModelOption {
  /** `<select>` value: "frontier" or the provider id. */
  value: string;
  label: string;
  model: AgentModel;
}

/** Serialize an AgentModel to a `<select>` value for comparison. */
function modelToValue(model: AgentModel): string {
  return model === "frontier" ? "frontier" : model.providerId ?? model.kind;
}

type PanelState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; team: HarnessTeam };

export function HarnessSettingPanel() {
  const { activeProjectDir } = useProject();
  const [state, setState] = useState<PanelState>({ status: "loading" });
  const [options, setOptions] = useState<ModelOption[]>([]);

  const load = useCallback((dir: string) => {
    setState({ status: "loading" });
    Promise.all([engineClient.harnessStatus(dir), listProviderConfigs()])
      .then(([status, configs]) => {
        setOptions([
          { value: "frontier", label: "frontier", model: "frontier" },
          ...configs.map((c) => ({
            value: c.id,
            label: `${c.kind} · ${c.model}`,
            model: { kind: c.kind, model: c.model, providerId: c.id } as AgentModel,
          })),
        ]);
        if (!status.present) {
          setState({ status: "missing" });
          return;
        }
        return engineClient.harnessRead(dir).then((team) => setState({ status: "ready", team }));
      })
      .catch((err: unknown) => setState({ status: "error", message: friendlyMessage(err) }));
  }, []);

  useEffect(() => {
    if (activeProjectDir === null) {
      setState({ status: "error", message: "Select a project first." });
      return;
    }
    load(activeProjectDir);
  }, [activeProjectDir, load]);

  const onModelChange = useCallback(
    (agentName: string, value: string) => {
      if (activeProjectDir === null) return;
      const option = options.find((o) => o.value === value);
      if (option === undefined) return;
      // Optimistic: reflect immediately, reconcile (reload) on failure.
      setState((prev) =>
        prev.status === "ready"
          ? { status: "ready", team: { ...prev.team, agents: prev.team.agents.map((a) => (a.name === agentName ? { ...a, model: option.model } : a)) } }
          : prev,
      );
      engineClient.harnessUpdateAgentModel(activeProjectDir, agentName, option.model).catch(() => load(activeProjectDir));
    },
    [activeProjectDir, options, load],
  );

  const onEscalationChange = useCallback(
    (value: string) => {
      if (activeProjectDir === null) return;
      const n = Number(value);
      setState((prev) => (prev.status === "ready" ? { status: "ready", team: { ...prev.team, escalation: n } } : prev));
      engineClient.harnessUpdateEscalation(activeProjectDir, n).catch(() => load(activeProjectDir));
    },
    [activeProjectDir, load],
  );

  if (state.status === "loading") return <div className="harness-panel-screen"><p role="status">Loading harness…</p></div>;
  if (state.status === "error") return <div className="harness-panel-screen"><p role="alert" className="error-text">{state.message}</p></div>;
  if (state.status === "missing") {
    return (
      <div className="harness-panel-screen">
        <p>No harness yet. Generate one from the Chat tab, then return here to tune models.</p>
      </div>
    );
  }

  return (
    <div className="harness-panel-screen">
      <h2 className="harness-tree-title">Harness setting</h2>
      <div className="harness-tree-root">Claude Code <span className="muted-text">orchestrator · frontier</span></div>
      <ul className="harness-tree">
        {state.team.agents.map((agent) => (
          <AgentRow key={agent.name} agent={agent} options={options} onChange={onModelChange} />
        ))}
      </ul>
      <label className="harness-escalation">
        Escalate to frontier after{" "}
        <select aria-label="Escalate to frontier after N failed attempts" value={state.team.escalation} onChange={(e) => onEscalationChange(e.target.value)}>
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
        </select>{" "}
        failed attempts
      </label>
      {options.length === 1 && (
        <p className="muted-text harness-tree-caption">Only frontier is available — add a model provider in Settings to route work to cheaper models.</p>
      )}
    </div>
  );
}

function AgentRow({ agent, options, onChange }: { agent: HarnessAgentView; options: ModelOption[]; onChange: (name: string, value: string) => void }) {
  const current = useMemo(() => modelToValue(agent.model), [agent.model]);
  const selectId = `model-${agent.name}`;
  return (
    <li className="harness-tree-row">
      <span className="harness-agent-name">{agent.name}</span>
      <span className="harness-agent-classes">
        {agent.taskClasses.map((tc) => (
          <span key={tc} className="harness-class-chip">{tc}</span>
        ))}
      </span>
      <label className="sr-only" htmlFor={selectId}>{`Model for ${agent.name}`}</label>
      <select id={selectId} value={current} onChange={(e) => onChange(agent.name, e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </li>
  );
}
