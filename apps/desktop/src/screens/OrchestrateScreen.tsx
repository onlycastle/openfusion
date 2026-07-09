import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useProject } from "../ProjectContext";
import {
  EngineError,
  RunCancelledError,
  engineClient,
  frontierLoginStatus,
  type CancellableRun,
  type FrontierAuthStatus,
  type GenerateHarnessResult,
  type HarnessProgressEvent,
  type HarnessStatus,
  type OrchestrateProgressEvent,
  type OrchestrateResult,
  type WikiBuildStats,
  type WikiStatus,
} from "../engineClient";

/** Renders a rejection as a short, user-facing sentence — never a stack
 * trace. Same posture as EvalsScreen/KeysScreen's own `friendlyMessage`: an
 * `EngineError` carries the engine's JSON-RPC `code` alongside its
 * `message`; anything else (a plain string/`Error`) is passed through
 * as-is. */
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

type SetupState =
  | { status: "checking" }
  | { status: "ready"; orchestrator: FrontierAuthStatus; modelProviderCount: number }
  | { status: "error"; message: string };

type HarnessState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "missing"; harness: HarnessStatus; wiki: WikiStatus }
  | { status: "stale"; harness: HarnessStatus; wiki: WikiStatus }
  | { status: "invalid"; harness: HarnessStatus; wiki: WikiStatus }
  | { status: "ready"; harness: HarnessStatus; wiki: WikiStatus; result?: GenerateHarnessResult }
  | { status: "building"; progress: ProgressEntry[] }
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

function classifyHarness(harness: HarnessStatus, wiki: WikiStatus): HarnessState {
  if (!harness.present) return { status: "missing", harness, wiki };
  if (harness.structural !== "pass") return { status: "invalid", harness, wiki };
  if (harness.headSha !== wiki.currentSha) return { status: "stale", harness, wiki };
  return { status: "ready", harness, wiki };
}

function setupWarnings(state: SetupState): string[] {
  if (state.status !== "ready") return [];
  const warnings: string[] = [];
  if (state.orchestrator.state !== "connected") {
    warnings.push("Connect an orchestrator before building a harness.");
  }
  if (state.modelProviderCount === 0) {
    warnings.push("Add at least one executing model provider for cheaper routed work.");
  }
  return warnings;
}

function harnessStatusText(state: HarnessState): string {
  if (state.status === "idle") return "Select a project to check its harness.";
  if (state.status === "checking") return "Checking project harness…";
  if (state.status === "building") return "Building harness…";
  if (state.status === "missing") return "No harness yet.";
  if (state.status === "stale") return "Harness needs rebuild for this project version.";
  if (state.status === "invalid") return "Harness needs rebuild.";
  if (state.status === "ready") return state.result ? `Harness ready: ${state.result.agents} agents.` : "Harness ready.";
  return state.message;
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

/** The Studio cockpit screen (the "Studio" nav destination; the component
 * keeps the name `OrchestrateScreen` because it drives the engine's
 * orchestrate loop — Studio is the room, orchestrate is the machinery).
 * The first phase is harness setup: choose a project, verify orchestrator
 * and worker-model setup, then generate or refresh the project's
 * `.openfusion` harness. Only after that does the task chat open. Runs
 * stream progress, the routed model, diff, review verdict, cost split, and
 * final outcome — with a distinct Cancelling/Cancelled state (not Failed)
 * and a working-tree (not committed) Apply action. */
interface OrchestrateScreenProps {
  onOpenSettings?: () => void;
}

export function OrchestrateScreen({ onOpenSettings }: OrchestrateScreenProps = {}) {
  const { activeProjectDir, addProjectByPath } = useProject();
  const projectDir = activeProjectDir;
  const [runProjectDir, setRunProjectDir] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  // The task text as it was when Run was pressed — shown as the "You" turn in
  // the transcript, so it reflects the run in progress, not live typing.
  const [runTask, setRunTask] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [result, setResult] = useState<OrchestrateResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [applyState, setApplyState] = useState<ApplyState>({ status: "idle" });
  const [wikiState, setWikiState] = useState<WikiState>({ status: "idle" });
  const [setupState, setSetupState] = useState<SetupState>({ status: "checking" });
  const [harnessState, setHarnessState] = useState<HarnessState>({ status: "idle" });

  const runRef = useRef<CancellableRun<OrchestrateResult> | null>(null);

  // The wiki calls below resolve against whichever project is CURRENT when
  // they settle, not whichever was current when they started — re-picking a
  // project mid-flight must not let the old directory's response land.
  const projectDirRef = useRef<string | null>(null);
  projectDirRef.current = projectDir;

  const harnessBuilding = harnessState.status === "building";
  const isBusy = phase === "running" || phase === "cancelling" || harnessBuilding;
  const setupWarningList = setupWarnings(setupState);
  const setupReady = setupState.status === "ready" && setupWarningList.length === 0;
  const harnessReady = harnessState.status === "ready";

  const loadSetupStatus = useCallback(() => {
    setSetupState({ status: "checking" });
    Promise.all([frontierLoginStatus("claude-code"), engineClient.modelsList()])
      .then(([orchestrator, models]) => {
        setSetupState({ status: "ready", orchestrator, modelProviderCount: models.providers.length });
      })
      .catch((err: unknown) => setSetupState({ status: "error", message: friendlyMessage(err) }));
  }, []);

  useEffect(() => {
    loadSetupStatus();
  }, [loadSetupStatus]);

  const resetRunState = useCallback(() => {
    setTask("");
    setRunTask("");
    setProgress([]);
    setResult(null);
    setRunError(null);
    setApplyState({ status: "idle" });
    setRunProjectDir(null);
    setPhase("idle");
  }, []);

  const refreshHarnessState = useCallback((dir: string) => {
    setWikiState({ status: "checking" });
    setHarnessState({ status: "checking" });
    engineClient
      .wikiStatus(dir)
      .then((wiki) => {
        if (projectDirRef.current !== dir) return;
        setWikiState({ status: "ready", wiki });
        return engineClient
          .harnessStatus(dir)
          .then((harness) => {
            if (projectDirRef.current !== dir) return;
            setHarnessState(classifyHarness(harness, wiki));
          })
          .catch((err: unknown) => {
            if (projectDirRef.current !== dir) return;
            setHarnessState({ status: "error", message: friendlyMessage(err) });
          });
      })
      .catch((err: unknown) => {
        if (projectDirRef.current !== dir) return;
        const message = friendlyMessage(err);
        setWikiState({ status: "error", message });
        setHarnessState({ status: "error", message });
      });
  }, []);

  // Reacts to the active project changing (picked in Rail 1, via
  // ProjectContext) — mirrors what the former in-screen picker did
  // inline on a successful pick: drop back out of the task chat, clear
  // the prior run's state, and re-check the new project's harness/wiki.
  useEffect(() => {
    if (projectDir === null) return;
    projectDirRef.current = projectDir;
    setChatOpen(false);
    resetRunState();
    refreshHarnessState(projectDir);
  }, [projectDir, refreshHarnessState, resetRunState]);

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

  const handleBuildHarness = useCallback(() => {
    const dir = projectDir;
    if (!dir || !setupReady || isBusy || harnessBuilding) return;

    setChatOpen(false);
    resetRunState();
    setHarnessState({ status: "building", progress: [] });
    setWikiState((prev) => (prev.status === "ready" ? prev : { status: "checking" }));

    engineClient
      .harnessGenerate(dir, (event: HarnessProgressEvent) => {
        progressKeySeq += 1;
        const entry: ProgressEntry = { key: progressKeySeq, stage: event.stage, detail: event.detail };
        setHarnessState((prev) =>
          prev.status === "building" ? { status: "building", progress: [...prev.progress, entry] } : prev,
        );
      })
      .then((buildResult) =>
        Promise.all([engineClient.wikiStatus(dir), engineClient.harnessStatus(dir)]).then(([wiki, harness]) => ({
          buildResult,
          wiki,
          harness,
        })),
      )
      .then(({ buildResult, wiki, harness }) => {
        if (projectDirRef.current !== dir) return;
        setWikiState({ status: "ready", wiki });
        const nextHarnessState = classifyHarness(harness, wiki);
        if (nextHarnessState.status === "ready") {
          setHarnessState({ ...nextHarnessState, result: buildResult });
          setChatOpen(true);
          return;
        }
        setHarnessState(nextHarnessState);
        setChatOpen(false);
      })
      .catch((err: unknown) => {
        if (projectDirRef.current !== dir) return;
        setHarnessState({ status: "error", message: friendlyMessage(err) });
      });
  }, [harnessBuilding, isBusy, projectDir, resetRunState, setupReady]);

  const handleOpenChat = useCallback(() => {
    if (!harnessReady || !setupReady) return;
    setChatOpen(true);
  }, [harnessReady, setupReady]);

  const handleAddProject = useCallback((): void => {
    open({ directory: true })
      .then((selected) => {
        if (typeof selected === "string") return addProjectByPath(selected);
      })
      .catch(() => {});
  }, [addProjectByPath]);

  const handleRun = useCallback(() => {
    if (!projectDir || !task.trim() || !chatOpen || !harnessReady || !setupReady || isBusy) return;

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
  }, [chatOpen, harnessReady, isBusy, projectDir, setupReady, task]);

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

  const canRun = Boolean(projectDir) && chatOpen && harnessReady && setupReady && task.trim().length > 0 && !isBusy;
  const canApply =
    result !== null &&
    (result.outcome === "worker-approved" || result.outcome === "escalated") &&
    result.diff.trim().length > 0;

  const hasTranscript = runTask.length > 0 || progress.length > 0 || result !== null;
  const canBuildHarness =
    Boolean(projectDir) &&
    setupReady &&
    !isBusy &&
    wikiState.status === "ready" &&
    (harnessState.status === "missing" ||
      harnessState.status === "stale" ||
      harnessState.status === "invalid" ||
      harnessState.status === "error");
  const canOpenChat = harnessReady && setupReady && !isBusy;

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
        placeholder={projectDir ? "Describe a task…" : "Select a project, then describe a task…"}
      />
      <div className="composer-bar">
        <span className="composer-chip composer-chip-static">
          <FolderGlyph />
          <span>{projectName ?? "No project selected"}</span>
        </span>
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

  const setupView = (
    <div className="harness-setup">
      <div className="harness-setup-inner">
        <p className="harness-kicker">Building harness</p>
        <h2>{projectName ? `Build the ${projectName} harness.` : "Add a project to begin."}</h2>

        {projectDir && setupState.status === "checking" && (
          <p role="status" className="harness-setup-status">
            Checking settings…
          </p>
        )}
        {projectDir && setupState.status === "error" && (
          <p role="alert" className="error-text harness-setup-status">
            {setupState.message}
          </p>
        )}
        {projectDir && setupState.status === "ready" && setupWarningList.length === 0 && (
          <p className="harness-setup-status">
            Claude Code connected · {setupState.modelProviderCount} model provider
            {setupState.modelProviderCount === 1 ? "" : "s"} ready
          </p>
        )}
        {projectDir && setupWarningList.length > 0 && (
          <div role="alert" className="setup-warning">
            <strong>Finish setup before building.</strong>
            <ul>
              {setupWarningList.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <div className="setup-warning-actions">
              {onOpenSettings && (
                <button type="button" onClick={onOpenSettings}>
                  Open Settings
                </button>
              )}
              <button type="button" onClick={loadSetupStatus}>
                Recheck
              </button>
            </div>
          </div>
        )}

        <div className={projectDir ? "harness-panel" : "harness-panel harness-panel-empty"}>
          <div className="harness-project-static">
            <FolderGlyph />
            <span>{projectName ?? "No project selected"}</span>
          </div>

          {projectDir && <code className="harness-project-path">{projectDir}</code>}

          {!projectDir && <p className="harness-empty-copy">Select a project to check its harness.</p>}

          {projectDir && (
            <div className={`harness-state harness-state-${harnessState.status}`}>
              <span>{harnessStatusText(harnessState)}</span>
              {wikiState.status === "ready" && (
                <span className="harness-state-detail">
                  {wikiState.wiki.files} files · {wikiState.wiki.symbols}
                </span>
              )}
            </div>
          )}

          {harnessState.status === "ready" && harnessState.harness.card === "draft" && (
            <p className="muted-text">Project Card drafted — review it in Harness setting.</p>
          )}

          {wikiState.status === "error" && (
            <p role="alert" className="error-text">
              {wikiState.message}
            </p>
          )}
          {harnessState.status === "error" &&
            !(wikiState.status === "error" && wikiState.message === harnessState.message) && (
              <p role="alert" className="error-text">
                {harnessState.message}
              </p>
            )}

          {harnessState.status === "building" && harnessState.progress.length > 0 && (
            <ol className="harness-progress-list" aria-label="Harness build progress">
              {harnessState.progress.map((entry) => (
                <li key={entry.key}>
                  <span>{entry.stage}</span>
                  {entry.detail}
                </li>
              ))}
            </ol>
          )}

          <div className="harness-actions">
            {!projectDir ? (
              <button type="button" className="primary-action" onClick={handleAddProject}>
                Add project
              </button>
            ) : harnessReady ? (
              <button type="button" className="primary-action" onClick={handleOpenChat} disabled={!canOpenChat}>
                Open task chat
              </button>
            ) : (
              <button type="button" className="primary-action" onClick={handleBuildHarness} disabled={!canBuildHarness}>
                {harnessBuilding ? "Building…" : "Build harness"}
              </button>
            )}
            {projectDir && !harnessBuilding && (
              <button type="button" onClick={() => refreshHarnessState(projectDir)} disabled={isBusy}>
                Recheck project
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <section className={chatOpen && hasTranscript ? "screen chat-screen chat-screen-active" : "screen chat-screen"}>
      {/* Slim top bar: the screen eyebrow plus the full project path (the
        * chip in the composer shows only the directory's name; the machine
        * truth — the absolute path — lives here) and the project's wiki
        * reading, absorbed from the former Project screen.
        *
        * data-tauri-drag-region (bare): with titleBarStyle Overlay the webview
        * covers the whole frame, so this top strip — the natural place to grab
        * the window over the content pane — must be granted window-dragging
        * back, mirroring the sidebar (Nav.tsx). Bare means only a mousedown
        * whose TARGET is the header itself drags (its empty space), so the
        * eyebrow, the selectable project path, and the wiki Build button all
        * keep their own pointer behavior. Requires core:window:allow-start-
        * dragging in the capability (drag.js's invoke is ACL-gated). */}
      <header className="chat-head" data-tauri-drag-region>
        <h1>Studio</h1>
        {projectDir && chatOpen && (
          <div className="chat-head-project">
            <code className="chat-project-path">{projectDir}</code>
            <WikiReadout state={wikiState} onBuild={handleBuildWiki} />
          </div>
        )}
      </header>
      {chatOpen && wikiState.status === "error" && (
        <p role="alert" className="error-text chat-head-alert">
          wiki: {wikiState.message}
        </p>
      )}

      {!chatOpen ? (
        setupView
      ) : !hasTranscript ? (
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
