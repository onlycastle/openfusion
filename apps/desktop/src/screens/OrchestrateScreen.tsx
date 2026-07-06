import { useCallback, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  EngineError,
  RunCancelledError,
  engineClient,
  type CancellableRun,
  type OrchestrateProgressEvent,
  type OrchestrateResult,
  type WikiBuildStats,
  type WikiStatus,
} from "../engineClient";

/** Renders a rejection as a short, user-facing sentence — never a stack
 * trace. Same posture as EvalsScreen/KeysScreen's own `friendlyMessage`: an
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

/** The directory's display name — the last path segment, or the raw string
 * when it has none (e.g. a bare "/"). */
function baseName(dir: string): string {
  const segments = dir.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? dir;
}

// Monotonic key for progress list entries — same rationale as
// EvalsScreen's own `progressKeySeq` (append-only list, no reordering).
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

/** The chosen project's wiki index, as a head-bar reading. `"idle"` means no
 * project is chosen yet; `"error"` renders through the head's alert row (the
 * engine's friendly "not a git repository" explanation matters more than a
 * truncated chip), so `WikiReadout` itself renders nothing for it. */
type WikiState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; wiki: WikiStatus; lastBuild?: WikiBuildStats }
  | { status: "building" }
  | { status: "error"; message: string };

/** The wiki reading in the chat head: machine truth in the measurement voice
 * (mono, lowercase), with the one action that changes it. Absorbed from the
 * former Project screen — the project is chosen here now, so its per-project
 * tooling lives here too. */
function WikiReadout({ state, onBuild }: { state: WikiState; onBuild: () => void }) {
  if (state.status === "idle" || state.status === "error") return null;
  if (state.status === "checking") return <span className="wiki-reading">wiki: checking…</span>;
  if (state.status === "building") {
    return (
      <span role="status" className="wiki-reading">
        wiki: building…
      </span>
    );
  }
  const { wiki, lastBuild } = state;
  const reading = !wiki.built ? "not built" : wiki.stale ? "stale" : "up to date";
  return (
    <span className="wiki-readout">
      <span
        className="wiki-reading"
        title={lastBuild ? `${lastBuild.filesIndexed} files · ${lastBuild.symbols} symbols indexed` : undefined}
      >
        wiki: {reading}
      </span>
      <button type="button" className="wiki-action" onClick={onBuild}>
        {wiki.built ? "Rebuild" : "Build"}
      </button>
    </span>
  );
}

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
            {line.length > 0 ? line : " "}
          </div>
        );
      })}
    </pre>
  );
}

function FolderGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.9c.4 0 .78.16 1.06.44l.86.86h4.68c.83 0 1.5.67 1.5 1.5v5.7c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5v-7Z" />
    </svg>
  );
}

/** The Orchestrate cockpit screen: the marquee "route → cheap worker diff →
 * frontier review → escalate → apply" loop, live. An empty session opens on
 * a centered prompt + composer (the composer card is the screen's one
 * raised, signature object); once a run starts, the transcript takes over
 * and the same composer docks at the bottom. The project is chosen from a
 * chip inside the composer (a minimal, self-contained picker — the app has
 * no shared project context today; EvalsScreen's own `projectDir` is
 * component-local too), and the chosen project's wiki status/build tooling
 * lives in the head bar. Runs stream progress, the routed model, diff,
 * review verdict, cost split, and final outcome — with a distinct
 * Cancelling/Cancelled state (not Failed) and a working-tree (not
 * committed) Apply action. */
export function OrchestrateScreen() {
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [runProjectDir, setRunProjectDir] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [task, setTask] = useState("");
  // The task text as it was when Run was pressed — shown as the "You" turn in
  // the transcript, so it reflects the run in progress, not live typing.
  const [runTask, setRunTask] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [result, setResult] = useState<OrchestrateResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [applyState, setApplyState] = useState<ApplyState>({ status: "idle" });
  const [wikiState, setWikiState] = useState<WikiState>({ status: "idle" });

  const runRef = useRef<CancellableRun<OrchestrateResult> | null>(null);

  // The wiki calls below resolve against whichever project is CURRENT when
  // they settle, not whichever was current when they started — re-picking a
  // project mid-flight must not let the old directory's response land.
  const projectDirRef = useRef<string | null>(null);
  projectDirRef.current = projectDir;

  const isBusy = phase === "running" || phase === "cancelling";

  const handleChooseProject = useCallback(() => {
    setPickerError(null);
    open({ directory: true })
      .then((selected) => {
        if (typeof selected !== "string") return; // user cancelled the dialog
        setProjectDir(selected);
        setWikiState({ status: "checking" });
        engineClient
          .wikiStatus(selected)
          .then((wiki) => {
            if (projectDirRef.current !== selected) return;
            setWikiState({ status: "ready", wiki });
          })
          .catch((err: unknown) => {
            if (projectDirRef.current !== selected) return;
            setWikiState({ status: "error", message: friendlyMessage(err) });
          });
      })
      .catch((err: unknown) => setPickerError(friendlyMessage(err)));
  }, []);

  const handleBuildWiki = useCallback(() => {
    const dir = projectDir;
    if (!dir || wikiState.status === "building" || wikiState.status === "checking") return;
    setWikiState({ status: "building" });
    engineClient
      .wikiBuild(dir)
      // Re-fetch the status rather than fabricating one from the build stats
      // — `WikiStatus` carries fields (currentSha, …) only the engine knows.
      .then((stats) =>
        engineClient.wikiStatus(dir).then((wiki) => {
          if (projectDirRef.current !== dir) return;
          setWikiState({ status: "ready", wiki, lastBuild: stats });
        }),
      )
      .catch((err: unknown) => {
        if (projectDirRef.current !== dir) return;
        setWikiState({ status: "error", message: friendlyMessage(err) });
      });
  }, [projectDir, wikiState.status]);

  const handleRun = useCallback(() => {
    if (!projectDir || !task.trim() || isBusy) return;

    setProgress([]);
    setResult(null);
    setRunError(null);
    setApplyState({ status: "idle" });
    setPhase("running");
    setRunProjectDir(projectDir); // Capture the run's project directory
    setRunTask(task.trim()); // Capture the task text for the transcript's "You" turn

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

  const canRun = Boolean(projectDir) && task.trim().length > 0 && !isBusy;
  const canApply =
    result !== null &&
    (result.outcome === "worker-approved" || result.outcome === "escalated") &&
    result.diff.trim().length > 0;

  const hasTranscript = runTask.length > 0 || progress.length > 0 || result !== null;

  const projectName = projectDir ? baseName(projectDir) : null;

  /* The composer card — one raised object holding the task input and its
   * controls: the project chip on the left, the run circle (or, while a run
   * is in flight, the stop square) on the right. Rendered centered under the
   * hero prompt while the session is empty, docked at the bottom once a
   * transcript exists. */
  const composer = (
    <div className="composer-card">
      <label className="sr-only" htmlFor="orchestrate-task">
        Describe the task
      </label>
      <textarea
        id="orchestrate-task"
        className="composer-input"
        value={task}
        onChange={(e) => setTask(e.target.value)}
        rows={2}
        disabled={isBusy}
        placeholder={projectDir ? "Describe a task…" : "Choose a project, then describe a task…"}
      />
      <div className="composer-bar">
        <button
          type="button"
          className="composer-chip"
          onClick={handleChooseProject}
          disabled={isBusy}
          aria-label={projectName ? `Choose project — current: ${projectName}` : "Choose project"}
        >
          <FolderGlyph />
          <span>{projectName ?? "Choose a project"}</span>
        </button>
        <div className="composer-bar-right">
          <span className="composer-hint" title="Models are routed automatically: cheap worker first, frontier review after">
            auto-route
          </span>
          {isBusy ? (
            <button
              type="button"
              className="run-button run-button-stop"
              onClick={handleCancel}
              disabled={phase === "cancelling"}
              aria-label={phase === "cancelling" ? "Cancelling…" : "Cancel"}
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
                <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button type="button" className="run-button" onClick={handleRun} disabled={!canRun} aria-label="Run">
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="M8 12.5v-9M4.25 7.25 8 3.5l3.75 3.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <section className={hasTranscript ? "screen chat-screen chat-screen-active" : "screen chat-screen"}>
      {/* Slim top bar: the screen eyebrow plus the full project path (the
        * chip in the composer shows only the directory's name; the machine
        * truth — the absolute path — lives here) and the project's wiki
        * reading, absorbed from the former Project screen. */}
      <header className="chat-head">
        <h1>Orchestrate</h1>
        {projectDir && (
          <div className="chat-head-project">
            <code className="chat-project-path">{projectDir}</code>
            <WikiReadout state={wikiState} onBuild={handleBuildWiki} />
          </div>
        )}
      </header>
      {pickerError && (
        <p role="alert" className="error-text chat-head-alert">
          {pickerError}
        </p>
      )}
      {wikiState.status === "error" && (
        <p role="alert" className="error-text chat-head-alert">
          wiki: {wikiState.message}
        </p>
      )}

      {!hasTranscript ? (
        <div className="chat-hero">
          <p className="hero-title">
            What should we work on{projectName ? <span className="hero-project"> in {projectName}</span> : null}?
          </p>
          {composer}
          <p className="hero-caption">cheap worker · frontier review · you approve</p>
        </div>
      ) : (
        <>
          <div className="chat-transcript">
            {runTask.length > 0 && (
              <article className="turn turn-you">
                <span className="turn-role">You</span>
                <div className="turn-body">{runTask}</div>
              </article>
            )}

            {progress.map((entry) => (
              <article className="turn turn-step" key={entry.key}>
                <span className="turn-role turn-role-step">{entry.stage}</span>
                <div className="turn-body">
                  {entry.stage === "route" ? <span className="routed-callout">{entry.detail}</span> : entry.detail}
                </div>
              </article>
            ))}

            {isBusy && (
              <article className="turn turn-step" aria-hidden="true">
                <span className="turn-role turn-role-step turn-role-working">·</span>
                <div className="turn-body muted-text">working…</div>
              </article>
            )}

            {phase === "cancelled" && (
              <article className="turn turn-step">
                <span className="turn-role">—</span>
                <div className="turn-body">
                  <span role="status" className="outcome-badge outcome-cancelled">
                    Cancelled
                  </span>
                </div>
              </article>
            )}

            {phase === "error" && runError && (
              <article className="turn turn-step">
                <span className="turn-role turn-role-error">error</span>
                <div className="turn-body">
                  <p role="alert" className="error-text">
                    {runError}
                  </p>
                </div>
              </article>
            )}

            {phase === "done" && result && (
              <article className="turn turn-result">
                <span className="turn-role">Result</span>
                <div className="turn-body">
                  <p className="result-headline">
                    <OutcomeBadge outcome={result.outcome} />
                    <span className="muted-text">
                      {" "}
                      routed to{" "}
                      <strong>
                        {result.resolution === "frontier"
                          ? "frontier"
                          : `${result.resolution.providerId}/${result.resolution.model}`}
                      </strong>{" "}
                      via agent <strong>{result.agent}</strong> · task class: {result.taskClass}
                    </span>
                  </p>

                  <h3>Review</h3>
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

                  <h3>Diff</h3>
                  {result.diff.trim().length === 0 ? (
                    <p className="muted-text">No diff produced.</p>
                  ) : (
                    <>
                      {result.diffStat && <p className="muted-text">{result.diffStat}</p>}
                      <DiffView diff={result.diff} />
                    </>
                  )}

                  <h3>Cost</h3>
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
                    <div className="result-apply">
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
                    </div>
                  )}
                </div>
              </article>
            )}
          </div>

          <div className="chat-dock">{composer}</div>
        </>
      )}
    </section>
  );
}
