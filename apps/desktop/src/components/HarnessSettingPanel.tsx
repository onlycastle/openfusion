import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  engineClient,
  listProviderConfigs,
  type AgentModel,
  type HarnessAgentView,
  type HarnessTeam,
  type RoutingCandidate,
} from "../engineClient";
import { useProject } from "../ProjectContext";
import { Dialog } from "../ui/Dialog";
import { Spinner } from "../ui/Spinner";

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
  // Set only by a failed Approve (spec: stays draft, shows the error inline,
  // does NOT reload) — every other card action (Save draft, a successful
  // Approve, or a fresh `load`) clears it, so a stale banner can never
  // survive past the action that produced it.
  const [cardError, setCardError] = useState<string | null>(null);

  // The status/configs/read calls below resolve against whichever project is
  // CURRENT when they settle, not whichever was current when they started —
  // re-picking a project mid-flight must not let a slower, stale response
  // (e.g. A's harnessRead landing after B's, once activeProjectDir has moved
  // on to B) overwrite the panel with the wrong project's team. Mirrors
  // OrchestrateScreen's projectDirRef guard.
  const activeProjectDirRef = useRef<string | null>(null);
  activeProjectDirRef.current = activeProjectDir;

  const load = useCallback((dir: string) => {
    setState({ status: "loading" });
    setCardError(null);
    Promise.all([engineClient.harnessStatus(dir), listProviderConfigs()])
      .then(([status, configs]) => {
        if (activeProjectDirRef.current !== dir) return;
        setOptions([
          { value: "frontier", label: "Lead model", model: "frontier" },
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
        return engineClient.harnessRead(dir).then((team) => {
          if (activeProjectDirRef.current !== dir) return;
          setState({ status: "ready", team });
        });
      })
      .catch((err: unknown) => {
        if (activeProjectDirRef.current !== dir) return;
        setState({ status: "error", message: friendlyMessage(err) });
      });
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
      const dir = activeProjectDir;
      const option = options.find((o) => o.value === value);
      if (option === undefined) return;
      // Optimistic: reflect immediately, reconcile (reload) on failure.
      setState((prev) =>
        prev.status === "ready"
          ? { status: "ready", team: { ...prev.team, agents: prev.team.agents.map((a) => (a.name === agentName ? { ...a, model: option.model } : a)) } }
          : prev,
      );
      engineClient.harnessUpdateAgentModel(dir, agentName, option.model).catch(() => {
        // Stale-guard: don't let a slow failure's reload stomp whatever
        // project the user has since switched to (see `load`'s own guard —
        // this is the settle-time call site, not the async continuation).
        if (activeProjectDirRef.current !== dir) return;
        load(dir);
      });
    },
    [activeProjectDir, options, load],
  );

  const onEscalationChange = useCallback(
    (value: string) => {
      if (activeProjectDir === null) return;
      const dir = activeProjectDir;
      const n = Number(value);
      setState((prev) => (prev.status === "ready" ? { status: "ready", team: { ...prev.team, escalation: n } } : prev));
      engineClient.harnessUpdateEscalation(dir, n).catch(() => {
        // Stale-guard: same as onModelChange above.
        if (activeProjectDirRef.current !== dir) return;
        load(dir);
      });
    },
    [activeProjectDir, load],
  );

  const onCardSave = useCallback(
    (digest: string) => {
      if (activeProjectDir === null) return;
      const dir = activeProjectDir;
      // Reconcile-by-reload, both branches — house pattern (see onModelChange
      // above): a save can also flip an already-approved card back to draft
      // server-side, so even the success path needs a fresh `load`, not just
      // a local patch.
      engineClient.harnessCardUpdate(dir, digest).then(
        () => {
          // Stale-guard: a slower response landing after the user has
          // switched projects must not flip the NEW project's rendered
          // panel back to "Loading harness…" via a reload for this OLD dir.
          if (activeProjectDirRef.current !== dir) return;
          load(dir);
        },
        () => {
          if (activeProjectDirRef.current !== dir) return;
          load(dir);
        },
      );
    },
    [activeProjectDir, load],
  );

  const onCardApprove = useCallback(() => {
    if (activeProjectDir === null) return;
    const dir = activeProjectDir;
    engineClient.harnessCardApprove(dir).then(
      () => {
        // Stale-guard: same reasoning as onCardSave's success branch above.
        if (activeProjectDirRef.current !== dir) return;
        load(dir);
      },
      (err: unknown) => {
        // Stale-guard: a slower response landing after the user has already
        // moved to a different project must not paint an error banner over
        // that OTHER project's (unrelated) card section.
        if (activeProjectDirRef.current !== dir) return;
        setCardError(friendlyMessage(err));
      },
    );
  }, [activeProjectDir, load]);

  if (state.status === "loading") return <div className="harness-panel-screen"><p role="status" className="screen-loading"><Spinner label="Loading harness" size="medium" /> Loading harness…</p></div>;
  if (state.status === "error") return <div className="harness-panel-screen"><p role="alert" className="error-text">{state.message}</p></div>;
  if (state.status === "missing") {
    return (
      <div className="harness-panel-screen">
        <div className="screen-empty-state">
          <span className="screen-empty-icon" aria-hidden="true">◇</span>
          <h2>No harness yet</h2>
          <p>Build the project harness in Studio, then return here to review the Project Card and route the team.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="harness-panel-screen">
      <header className="screen-title-block">
        <p className="screen-eyebrow">Project configuration</p>
        <h1 className="harness-tree-title">Harness</h1>
        <p>Review the project knowledge OpenFusion trusts and choose how each specialist routes work.</p>
      </header>
      {state.team.card !== null && (
        <ProjectCardSection card={state.team.card} error={cardError} onSave={onCardSave} onApprove={onCardApprove} />
      )}
      <div className="harness-tree-root"><span>Lead models</span><span className="muted-text">Planning · review · escalation</span></div>
      <ul className="harness-tree">
        {state.team.agents.map((agent) => (
          <AgentRow key={agent.name} agent={agent} options={options} onChange={onModelChange} />
        ))}
      </ul>
      <label className="harness-escalation">
        Escalate to a lead model after{" "}
        <select aria-label="Escalate to a lead model after N failed attempts" value={state.team.escalation} onChange={(e) => onEscalationChange(e.target.value)}>
          <option value={1}>1</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
        </select>{" "}
        failed attempts
      </label>
      <RoutingPolicySection projectDir={activeProjectDir!} />
      {options.length === 1 && (
        <p className="muted-text harness-tree-caption">Only lead models are available — add a worker model in Settings to route suitable implementation work.</p>
      )}
    </div>
  );
}

function percentage(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "Unavailable";
}

function RoutingPolicySection({ projectDir }: { projectDir: string }) {
  const [candidates, setCandidates] = useState<RoutingCandidate[]>([]);
  const [active, setActive] = useState<RoutingCandidate | null>(null);
  const [harnessDigest, setHarnessDigest] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmCandidate, setConfirmCandidate] = useState<RoutingCandidate | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      engineClient.routingProposals(projectDir),
      engineClient.routingStatus(projectDir),
    ]).then(([proposals, status]) => {
      setCandidates(proposals.candidates);
      setActive(status.active);
      setHarnessDigest(status.currentHarnessDigest);
    }).catch((reason: unknown) => {
      setError(friendlyMessage(reason));
    }).finally(() => setLoading(false));
  }, [projectDir]);

  useEffect(() => refresh(), [refresh]);

  const act = (operation: Promise<unknown>): void => {
    setLoading(true);
    setError(null);
    operation.then(refresh, (reason: unknown) => {
      setError(friendlyMessage(reason));
      setLoading(false);
    });
  };

  return (
    <section className="harness-card routing-policy-section">
      <div className="harness-card-header">
        <div>
          <h3 className="harness-card-title">Evidence-backed routing</h3>
          <p className="muted-text">Deterministic routing-v3 proposals require protected evidence, a shadow check, and your approval.</p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => act(engineClient.routingCreateProposal(projectDir))}
        >
          Compile proposal
        </button>
      </div>
      {active !== null && (
        <div className="routing-active-policy">
          <strong>Active policy</strong>
          <span>{active.id}</span>
          <button type="button" disabled={loading} onClick={() => act(engineClient.routingRollback(projectDir, active.id))}>
            Roll back
          </button>
        </div>
      )}
      {loading && candidates.length === 0 && <p role="status"><Spinner label="Loading routing evidence" /> Loading routing evidence…</p>}
      {error !== null && <p role="alert" className="error-text">{error}</p>}
      {candidates.length === 0 && !loading && error === null && (
        <p className="muted-text">No routing proposal has been compiled for this harness.</p>
      )}
      <ul className="harness-tree routing-candidate-list">
        {candidates.map((candidate) => (
          <li key={candidate.id} className="harness-tree-row routing-candidate-row">
            <span>
              <strong>{candidate.id}</strong>
              <small>{candidate.status} · {candidate.gate.cleanMatchedTasks} matched tasks</small>
            </span>
            <span className="muted-text">
              quality lower {percentage(candidate.gate.qualityDelta.lower95)} · savings lower {percentage(candidate.gate.pairedSavings.lower95)}
            </span>
            <span>
              {candidate.status === "proposed" && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => act(engineClient.routingCompleteShadow(projectDir, candidate))}
                >
                  Run shadow check
                </button>
              )}
              {candidate.status === "shadowed" && candidate.gate.eligible && (
                <button type="button" className="primary-action" disabled={loading} onClick={() => setConfirmCandidate(candidate)}>
                  Review promotion…
                </button>
              )}
            </span>
            {!candidate.gate.eligible && (
              <small className="error-text">Blocked: {candidate.gate.reasons.join(", ")}</small>
            )}
          </li>
        ))}
      </ul>
      <Dialog
        open={confirmCandidate !== null}
        title="Promote this routing policy?"
        description="This changes deterministic routing for new sessions that exactly match the current harness and project fingerprints. Sparse or stale evidence still falls back to configured routing."
        onClose={() => setConfirmCandidate(null)}
        dismissOnBackdrop={false}
        size="medium"
        footer={
          <>
            <button type="button" onClick={() => setConfirmCandidate(null)}>Cancel</button>
            <button
              type="button"
              className="ui-button-primary"
              onClick={() => {
                const candidate = confirmCandidate;
                setConfirmCandidate(null);
                if (candidate !== null) {
                  act(engineClient.routingPromote(projectDir, candidate.id, harnessDigest));
                }
              }}
            >
              Promote policy
            </button>
          </>
        }
      >
        <p>Promotion is reversible and does not mutate the harness. It activates only the compiled override table tied to the current harness digest.</p>
      </Dialog>
    </section>
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

/** Renders ABOVE the agent tree (spec §3.4) whenever `team.card !== null` —
 * absent entirely otherwise. Owns only the textarea's local edit-in-progress
 * state; the actual `harnessCardUpdate`/`harnessCardApprove` calls, the
 * reconcile-by-reload on save, and the stale-project guard on a failed
 * approve all live in the parent (mirrors AgentRow/onModelChange: rows are
 * presentational, the panel owns the RPCs). */
function ProjectCardSection({
  card,
  error,
  onSave,
  onApprove,
}: {
  card: NonNullable<HarnessTeam["card"]>;
  error: string | null;
  onSave: (digest: string) => void;
  onApprove: () => void;
}) {
  const [digestDraft, setDigestDraft] = useState(card.digest);
  const [approveOpen, setApproveOpen] = useState(false);

  // Reseed whenever a reload hands us a NEW `card` (a fresh RPC response
  // object) — covers both the happy path (post-save/-approve reload) and the
  // "failed save" reconcile-by-reload, which must discard the rejected edit
  // and fall back to whatever digest is actually on disk. A failed APPROVE
  // deliberately does not reload (spec: "stay draft"), so `card` keeps the
  // same reference and this effect correctly does nothing.
  useEffect(() => {
    setDigestDraft(card.digest);
  }, [card]);

  const isDraft = card.state === "draft";
  const isDirty = digestDraft !== card.digest;

  return (
    <section className="harness-card">
      <div className="harness-card-header">
        <h3 className="harness-card-title">Project card</h3>
        <span className={`harness-card-badge harness-card-badge-${card.state}`}>{isDraft ? "Draft" : "Approved"}</span>
      </div>
      <textarea
        className="harness-card-textarea"
        aria-label="Project card digest"
        value={digestDraft}
        disabled={!isDraft}
        onChange={(e) => setDigestDraft(e.target.value)}
      />
      <details className="harness-card-details">
        <summary>Full card</summary>
        <pre>{card.body}</pre>
      </details>
      {error !== null && <p role="alert" className="error-text">{error}</p>}
      <div className="harness-card-actions">
        <button type="button" disabled={!isDraft || !isDirty} onClick={() => onSave(digestDraft)}>
          Save draft
        </button>
        {isDraft && (
          <button type="button" className="primary-action" aria-label="Approve" disabled={isDirty} onClick={() => setApproveOpen(true)}>
            Review and Approve…
          </button>
        )}
      </div>

      <Dialog
        open={approveOpen}
        title="Approve this Project Card?"
        description="Approved project knowledge is included in future model work. Confirm that the summary is accurate and contains no sensitive information you do not want sent to configured models."
        onClose={() => setApproveOpen(false)}
        dismissOnBackdrop={false}
        size="medium"
        footer={
          <>
            <button type="button" onClick={() => setApproveOpen(false)}>Cancel</button>
            <button type="button" className="ui-button-primary" onClick={() => { setApproveOpen(false); onApprove(); }}>Approve Card</button>
          </>
        }
      >
        <div className="project-card-review">
          <span>Summary being approved</span>
          <p>{digestDraft}</p>
        </div>
      </Dialog>
    </section>
  );
}
