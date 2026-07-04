import { useCallback, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  EngineError,
  RunCancelledError,
  engineClient,
  type CancellableRun,
  type OrchestrateProgressEvent,
  type OrchestrateResult,
} from "../engineClient";

/** Renders a rejection as a short, user-facing sentence — never a stack
 * trace. Same posture as ProjectScreen's own `friendlyMessage`: an
 * `EngineError` carries the engine's JSON-RPC `code` alongside its
 * `message`; anything else (a plain string/`Error`, e.g. the Tauri dialog
 * plugin's own rejections) is passed through as-is. */
function friendlyMessage(err: unknown): string {
  if (err instanceof EngineError) return `[${err.code}] ${err.message}`;
  if (typeof err === "string" && err.trim().length > 0) return err;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return "Something went wrong. Please try again.";
}

function formatUsd(value: number | null): string {
  if (value === null) return "n/a";
  return `$${value.toFixed(4)}`;
}

// Monotonic key for progress list entries — same rationale as
// ProjectScreen's own `progressKeySeq` (append-only list, no reordering).
let progressKeySeq = 0;

interface ProgressEntry {
  key: number;
  stage: string;
  detail: string;
}

/** The run's overall lifecycle. `"cancelling"` is deliberately distinct from
 * `"cancelled"` — the former is the window between the Cancel click and the
 * run's promise actually settling; the latter is the final, displayed state
 * once `RunCancelledError` is caught. Both are distinct from `"error"`,
 * which is a genuine failure (a plain `EngineError`, not a cancellation). */
type Phase = "idle" | "running" | "cancelling" | "cancelled" | "done" | "error";

type ApplyState =
  | { status: "idle" }
  | { status: "applying" }
  | { status: "applied" }
  | { status: "failed"; message: string };

function OutcomeBadge({ outcome }: { outcome: OrchestrateResult["outcome"] }) {
  const label =
    outcome === "worker-approved" ? "Worker approved" : outcome === "escalated" ? "Escalated" : "Failed";
  const cls =
    outcome === "worker-approved" ? "outcome-success" : outcome === "escalated" ? "outcome-warning" : "outcome-failure";
  return <span className={`outcome-badge ${cls}`}>{label}</span>;
}

/** A deliberately simple diff renderer: one `<pre>` block, one `<div>` per
 * line, colored by leading character. Not a real diff library (the brief is
 * explicit: don't over-build this) — just enough to make a worker's diff
 * readable at a glance during an operator smoke. */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="diff-view">
      {lines.map((line, index) => {
        let cls = "diff-line";
        if (line.startsWith("+++") || line.startsWith("---")) cls += " diff-line-meta";
        else if (line.startsWith("@@")) cls += " diff-line-hunk";
        else if (line.startsWith("+")) cls += " diff-line-add";
        else if (line.startsWith("-")) cls += " diff-line-remove";
        return (
          <div key={index} className={cls}>
            {line.length > 0 ? line : " "}
          </div>
        );
      })}
    </pre>
  );
}

/** The Orchestrate cockpit screen: the marquee "route → cheap worker diff →
 * frontier review → escalate → apply" loop, live. Picks a project
 * directory (a minimal, self-contained picker — Task 3's brief allows
 * either reusing shared project state or adding a local one, and the app
 * has no shared project context today; ProjectScreen's own `projectDir` is
 * component-local too), takes a task description, runs
 * `engineClient.runOrchestrate` as a `CancellableRun`, and renders its
 * streamed progress, routed model, diff, review verdict, cost split, and
 * final outcome — with a distinct Cancelling/Cancelled state (not Failed)
 * and a working-tree (not committed) Apply action. */
export function OrchestrateScreen() {
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [runProjectDir, setRunProjectDir] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [result, setResult] = useState<OrchestrateResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [applyState, setApplyState] = useState<ApplyState>({ status: "idle" });

  const runRef = useRef<CancellableRun<OrchestrateResult> | null>(null);

  const isBusy = phase === "running" || phase === "cancelling";

  const handleChooseProject = useCallback(() => {
    setPickerError(null);
    open({ directory: true })
      .then((selected) => {
        if (typeof selected !== "string") return; // user cancelled the dialog
        setProjectDir(selected);
      })
      .catch((err: unknown) => setPickerError(friendlyMessage(err)));
  }, []);

  const handleRun = useCallback(() => {
    if (!projectDir || !task.trim() || isBusy) return;

    setProgress([]);
    setResult(null);
    setRunError(null);
    setApplyState({ status: "idle" });
    setPhase("running");
    setRunProjectDir(projectDir); // Capture the run's project directory

    const run = engineClient.runOrchestrate({ projectDir, task }, (event: OrchestrateProgressEvent) => {
      progressKeySeq += 1;
      const entry: ProgressEntry = { key: progressKeySeq, stage: event.stage, detail: event.detail };
      setProgress((prev) => [...prev, entry]);
    });
    runRef.current = run;

    run.promise
      .then((res) => {
        setResult(res);
        setPhase("done");
      })
      .catch((err: unknown) => {
        if (err instanceof RunCancelledError) {
          setPhase("cancelled");
          return;
        }
        setRunError(friendlyMessage(err));
        setPhase("error");
      });
  }, [projectDir, task, isBusy]);

  // Guarded on `phase === "running"` (not just the button's `disabled`
  // attribute) so a second Cancel click — even one that somehow reaches
  // this handler — can never issue a second `cancel()` call while one is
  // already in flight (per Task 2's review: a stray retry loop must not
  // start twice).
  const handleCancel = useCallback(() => {
    if (phase !== "running") return;
    setPhase("cancelling");
    void runRef.current?.cancel();
  }, [phase]);

  const handleApply = useCallback(() => {
    if (!runProjectDir || !result || applyState.status === "applying") return;
    setApplyState({ status: "applying" });
    engineClient
      .call<unknown>("engine.orchestrate.apply", { projectDir: runProjectDir, diff: result.diff })
      .then(() => setApplyState({ status: "applied" }))
      .catch((err: unknown) => setApplyState({ status: "failed", message: friendlyMessage(err) }));
  }, [runProjectDir, result, applyState.status]);

  const routeEntry = progress.find((entry) => entry.stage === "route");
  const canRun = Boolean(projectDir) && task.trim().length > 0 && !isBusy;
  const canApply =
    result !== null &&
    (result.outcome === "worker-approved" || result.outcome === "escalated") &&
    result.diff.trim().length > 0;

  return (
    <section className="screen">
      <h1>Orchestrate</h1>
      <p>
        Route a task to a cheap worker model, get its diff reviewed by the frontier model, escalate if needed, and
        apply the result — the harness-fusion loop, live.
      </p>

      <h2>Project</h2>
      <button type="button" onClick={handleChooseProject}>
        Choose project…
      </button>
      {pickerError && (
        <p role="alert" className="error-text">
          {pickerError}
        </p>
      )}
      {projectDir && (
        <p>
          <code>{projectDir}</code>
        </p>
      )}

      <h2>Task</h2>
      <label>
        Describe the task
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={4}
          disabled={isBusy}
          placeholder="e.g. fix the off-by-one in the pagination helper"
        />
      </label>

      <div className="actions">
        <button type="button" onClick={handleRun} disabled={!canRun}>
          Run
        </button>
        {isBusy && (
          <button type="button" onClick={handleCancel} disabled={phase === "cancelling"}>
            {phase === "cancelling" ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>

      {phase === "cancelled" && (
        <p role="status" className="outcome-badge outcome-cancelled">
          Cancelled
        </p>
      )}
      {phase === "error" && runError && (
        <p role="alert" className="error-text">
          {runError}
        </p>
      )}

      {progress.length > 0 && (
        <>
          <h2>Progress</h2>
          {routeEntry && <p className="routed-callout">Routed: {routeEntry.detail}</p>}
          <ul className="progress-list">
            {progress.map((entry) => (
              <li key={entry.key}>
                <strong>{entry.stage}</strong>: {entry.detail}
              </li>
            ))}
          </ul>
        </>
      )}

      {phase === "done" && result && (
        <>
          <h2>Outcome</h2>
          <p>
            <OutcomeBadge outcome={result.outcome} />
          </p>
          <p>
            Routed to{" "}
            <strong>
              {result.resolution === "frontier" ? "frontier" : `${result.resolution.providerId}/${result.resolution.model}`}
            </strong>{" "}
            via agent <strong>{result.agent}</strong> (task class: {result.taskClass})
          </p>

          <h2>Attempts</h2>
          <ul className="attempts-list">
            {result.attempts.map((attempt) => (
              <li key={attempt.n}>
                <strong>
                  #{attempt.n} ({attempt.kind})
                </strong>
                : {attempt.summary}
                {attempt.empty && <span className="muted-text"> — no changes produced</span>}
                {attempt.verdict && (
                  <div className="verdict">
                    <span className={`verdict-decision verdict-${attempt.verdict.decision}`}>
                      {attempt.verdict.decision === "approve" ? "Approved" : "Changes requested"}
                    </span>{" "}
                    <span className="verdict-severity">severity: {attempt.verdict.severity}</span>
                    {attempt.verdict.reasons.length > 0 && (
                      <ul>
                        {attempt.verdict.reasons.map((reason, index) => (
                          <li key={index}>{reason}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>

          <h2>Diff</h2>
          {result.diff.trim().length === 0 ? (
            <p className="muted-text">No diff produced.</p>
          ) : (
            <>
              {result.diffStat && <p className="muted-text">{result.diffStat}</p>}
              <DiffView diff={result.diff} />
            </>
          )}

          <h2>Cost</h2>
          <dl className="cost-split">
            <dt>Worker</dt>
            <dd>{formatUsd(result.cost.workerUsd)}</dd>
            <dt>Review</dt>
            <dd>{formatUsd(result.cost.reviewUsd)}</dd>
            <dt>Escalate</dt>
            <dd>{formatUsd(result.cost.escalateUsd)}</dd>
            <dt>Frontier</dt>
            <dd>{formatUsd(result.cost.frontierUsd)}</dd>
            <dt>Total</dt>
            <dd>{formatUsd(result.cost.totalUsd)}</dd>
          </dl>
          <p className="muted-text">
            {result.cost.note} figures
            {result.cost.pricingConfidence ? ` — pricing confidence: ${result.cost.pricingConfidence}` : ""}.
          </p>

          {canApply && (
            <>
              <h2>Apply</h2>
              <p className="muted-text">
                Applies the diff to the working tree at <code>{runProjectDir}</code> — this does NOT commit it.
              </p>
              <button type="button" onClick={handleApply} disabled={applyState.status === "applying"}>
                {applyState.status === "applying" ? "Applying…" : "Apply diff"}
              </button>
              {applyState.status === "applied" && <p role="status">Applied.</p>}
              {applyState.status === "failed" && (
                <p role="alert" className="error-text">
                  {applyState.message}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
