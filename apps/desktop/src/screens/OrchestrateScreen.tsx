import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useProject } from "../ProjectContext";
import { Dialog } from "../ui/Dialog";
import { Spinner } from "../ui/Spinner";
import {
  EngineError,
  engineClient,
  frontierLoginStatus,
  type FrontierAuthStatus,
  type FrontierEngineKind,
  type FrontierRoleSelections,
  type GenerateHarnessResult,
  type HarnessProgressEvent,
  type HarnessStatus,
  type OrchestrateProgressEvent,
  type OrchestrateResult,
  type RuntimeApproval,
  type RuntimeSession,
  type WikiBuildStats,
  type WikiStatus,
} from "../engineClient";
import { loadFrontierRoleSelections } from "../frontierPreferences";

/** Renders a rejection as a short, user-facing sentence — never a stack
 * trace. Same posture as HarnessHealthScreen/KeysScreen's own `friendlyMessage`: an
 * `EngineError` carries the engine's JSON-RPC `code` alongside its
 * `message`; anything else (a plain string/`Error`) is passed through
 * as-is. */
function friendlyMessage(err: unknown): string {
  if (err instanceof EngineError) return `[${err.code}] ${err.message}`;
  if (typeof err === "string" && err.trim().length > 0) return err;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return "Something went wrong. Please try again.";
}

function harnessStageLabel(stage: string): string {
  const raw = stage.startsWith("page:") ? stage.slice("page:".length) : stage;
  if (raw === "agents-routing") return "Agents and routing";
  return raw
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

function harnessIssueMessage(issue: unknown): string | null {
  if (typeof issue === "string" && issue.trim().length > 0) return issue;
  if (typeof issue !== "object" || issue === null) return null;
  const message = (issue as { message?: unknown }).message;
  if (typeof message !== "string" || message.trim().length === 0) return null;
  const path = (issue as { path?: unknown }).path;
  return Array.isArray(path) && path.length > 0 ? `${path.join(".")}: ${message}` : message;
}

function harnessGenerationMessage(err: unknown): string {
  if (!(err instanceof EngineError) || typeof err.data !== "object" || err.data === null) {
    return friendlyMessage(err);
  }
  const data = err.data as { stage?: unknown; attempts?: unknown; issues?: unknown };
  if (typeof data.stage !== "string" || typeof data.attempts !== "number") return friendlyMessage(err);
  const issues = Array.isArray(data.issues) ? data.issues : [];
  const finalIssue = issues.map(harnessIssueMessage).filter((issue): issue is string => issue !== null).at(-1);
  const suffix = finalIssue ?? err.message;
  return `${harnessStageLabel(data.stage)} failed after ${data.attempts} attempt${data.attempts === 1 ? "" : "s"}: ${suffix}`;
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
// Shared append-only progress-list posture used across Studio screens.
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
type Phase =
  | "idle"
  | "running"
  | "waiting-approval"
  | "interrupted"
  | "needs-recovery"
  | "cancelling"
  | "cancelled"
  | "done"
  | "error";

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
  | {
      status: "ready";
      orchestrators: Array<{ engine: FrontierEngineKind; auth: FrontierAuthStatus }>;
      modelProviderCount: number;
    }
  | { status: "error"; message: string };

type HarnessState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "missing"; harness: HarnessStatus; wiki: WikiStatus }
  | { status: "stale"; harness: HarnessStatus; wiki: WikiStatus }
  | { status: "invalid"; harness: HarnessStatus; wiki: WikiStatus }
  | { status: "ready"; harness: HarnessStatus; wiki: WikiStatus; result?: GenerateHarnessResult }
  | { status: "building"; progress: ProgressEntry[] }
  | { status: "error"; message: string; progress: ProgressEntry[] };

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
  for (const orchestrator of state.orchestrators) {
    if (orchestrator.auth.state !== "connected") {
      warnings.push(`Connect ${orchestrator.engine === "codex" ? "OpenAI Codex" : "Claude Code"} before using it for a lead model role.`);
    }
  }
  if (state.modelProviderCount === 0) {
    warnings.push("Add at least one worker model for routed implementation work.");
  }
  return warnings;
}

type ReadinessStepStatus = "complete" | "active" | "pending" | "needs-action" | "error";

interface ReadinessStep {
  id: string;
  title: string;
  detail: string;
  status: ReadinessStepStatus;
  logs?: ProgressEntry[];
}

function frontierName(engine: FrontierEngineKind): string {
  return engine === "codex" ? "OpenAI Codex" : "Claude Code";
}

/** Turns setup and harness machine state into the single, ordered story a
 * person needs during onboarding. Incomplete prerequisites remain in context
 * beside completed and upcoming work instead of appearing as a warning. */
function readinessSteps(
  projectDir: string | null,
  setup: SetupState,
  harness: HarnessState,
): ReadinessStep[] {
  const steps: ReadinessStep[] = [
    {
      id: "project",
      title: projectDir ? "Project selected" : "Select a project",
      detail: projectDir ?? "Open a local Git repository to begin.",
      status: projectDir ? "complete" : "needs-action",
    },
  ];

  if (setup.status === "checking") {
    steps.push(
      {
        id: "frontier",
        title: "Checking lead model connections",
        detail: "Looking for the runtimes selected for planning, review, and escalation.",
        status: "active",
      },
      {
        id: "providers",
        title: "Checking worker models",
        detail: "Looking for a model used for routed implementation work.",
        status: "active",
      },
    );
  } else if (setup.status === "error") {
    steps.push(
      {
        id: "frontier",
        title: "Could not check project settings",
        detail: setup.message,
        status: "error",
      },
      {
        id: "providers",
        title: "Worker model check pending",
        detail: "Recheck project settings to continue.",
        status: "pending",
      },
    );
  } else {
    const disconnected = setup.orchestrators
      .filter((entry) => entry.auth.state !== "connected")
      .map((entry) => frontierName(entry.engine));
    const connected = setup.orchestrators
      .filter((entry) => entry.auth.state === "connected")
      .map((entry) => frontierName(entry.engine));
    steps.push({
      id: "frontier",
      title: disconnected.length === 0 ? "Lead model connections ready" : "Connect lead model runtimes",
      detail:
        disconnected.length === 0
          ? `${connected.join(" + ")} connected for lead model roles.`
          : `${disconnected.join(" + ")} ${disconnected.length === 1 ? "is" : "are"} required by the selected lead model roles.`,
      status: disconnected.length === 0 ? "complete" : "needs-action",
    });
    steps.push({
      id: "providers",
      title: setup.modelProviderCount > 0 ? "Worker models ready" : "Add a worker model",
      detail:
        setup.modelProviderCount > 0
          ? `${setup.modelProviderCount} worker model${setup.modelProviderCount === 1 ? "" : "s"} available for routed implementation work.`
          : "At least one worker model is needed for routed implementation work.",
      status: setup.modelProviderCount > 0 ? "complete" : "needs-action",
    });
  }

  let harnessStep: ReadinessStep;
  if (!projectDir || setup.status !== "ready" || setupWarnings(setup).length > 0) {
    harnessStep = {
      id: "harness",
      title: "Prepare project harness",
      detail: "Complete the steps above before the repository can be prepared.",
      status: "pending",
    };
  } else if (harness.status === "checking") {
    harnessStep = {
      id: "harness",
      title: "Checking repository and harness",
      detail: "Comparing the wiki and harness with the current Git version.",
      status: "active",
    };
  } else if (harness.status === "building") {
    harnessStep = {
      id: "harness",
      title: "Building project harness",
      detail: harness.progress.length > 0 ? "Live repository and generation activity is shown below." : "Starting repository preparation.",
      status: "active",
      logs: harness.progress,
    };
  } else if (harness.status === "ready") {
    harnessStep = {
      id: "harness",
      title: "Project harness ready",
      detail: harness.result
        ? `${harness.result.pages} pages and ${harness.result.agents} specialist agents generated.`
        : "The harness matches the current project version.",
      status: "complete",
    };
  } else if (harness.status === "error") {
    harnessStep = {
      id: "harness",
      title: "Harness preparation stopped",
      detail: harness.message,
      status: "error",
      logs: harness.progress,
    };
  } else if (harness.status === "missing") {
    harnessStep = {
      id: "harness",
      title: "Build project harness",
      detail: "The repository is ready for its first harness build.",
      status: "needs-action",
    };
  } else if (harness.status === "stale") {
    harnessStep = {
      id: "harness",
      title: "Rebuild project harness",
      detail: "The project has changed since this harness was generated.",
      status: "needs-action",
    };
  } else if (harness.status === "invalid") {
    harnessStep = {
      id: "harness",
      title: "Repair project harness",
      detail: "Structural checks failed; rebuild the harness to continue.",
      status: "needs-action",
    };
  } else {
    harnessStep = {
      id: "harness",
      title: "Prepare project harness",
      detail: "Waiting for a project.",
      status: "pending",
    };
  }
  steps.push(harnessStep);
  return steps;
}

function ReadinessMarker({ status }: { status: ReadinessStepStatus }) {
  if (status === "complete") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="m4 8.25 2.45 2.4L12 5.35" />
      </svg>
    );
  }
  if (status === "error") return <span aria-hidden="true">!</span>;
  return <span aria-hidden="true" />;
}

function ReadinessProgress({ steps }: { steps: ReadinessStep[] }) {
  const statusLabels: Record<ReadinessStepStatus, string> = {
    complete: "Complete",
    active: "In progress",
    pending: "Pending",
    "needs-action": "Needs action",
    error: "Stopped",
  };
  return (
    <ol className="readiness-progress" aria-label="Project readiness progress">
      {steps.map((step) => (
        <li key={step.id} className={`readiness-step readiness-step-${step.status}`}>
          <div className="readiness-marker" role="img" aria-label={statusLabels[step.status]}>
            <ReadinessMarker status={step.status} />
          </div>
          <div className="readiness-copy">
            <strong>{step.title}</strong>
            <p>{step.detail}</p>
            {step.logs && step.logs.length > 0 && (
              <ol className="readiness-log" aria-label="Harness activity log" aria-live="polite" aria-relevant="additions">
                {step.logs.map((entry, index) => {
                  const isCurrent = step.status === "active" && index === step.logs!.length - 1;
                  return (
                    <li key={entry.key} className={isCurrent ? "readiness-log-current" : undefined}>
                      <span className="readiness-log-icon" aria-hidden="true" />
                      <span><strong>{entry.stage}</strong> {entry.detail}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </li>
      ))}
    </ol>
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
  setupRefreshToken?: number;
}

export function OrchestrateScreen({ onOpenSettings, setupRefreshToken = 0 }: OrchestrateScreenProps = {}) {
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
  const [frontierSelections, setFrontierSelections] = useState<FrontierRoleSelections>(() => loadFrontierRoleSelections());
  const [harnessState, setHarnessState] = useState<HarnessState>({ status: "idle" });
  const [rebuildDialogOpen, setRebuildDialogOpen] = useState(false);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [resultTab, setResultTab] = useState<"summary" | "changes" | "review" | "cost">("summary");

  const [activeSession, setActiveSession] = useState<RuntimeSession | null>(null);
  const [pendingApproval, setPendingApproval] = useState<RuntimeApproval | null>(null);
  const [childSessions, setChildSessions] = useState<Array<{
    session: RuntimeSession;
    summary?: string;
    diffStat?: string;
  }>>([]);

  // The wiki calls below resolve against whichever project is CURRENT when
  // they settle, not whichever was current when they started — re-picking a
  // project mid-flight must not let the old directory's response land.
  const projectDirRef = useRef<string | null>(null);
  projectDirRef.current = projectDir;

  const harnessBuilding = harnessState.status === "building";
  const isBusy =
    phase === "running" ||
    phase === "waiting-approval" ||
    phase === "interrupted" ||
    phase === "needs-recovery" ||
    phase === "cancelling" ||
    harnessBuilding;
  const setupWarningList = setupWarnings(setupState);
  const setupReady = setupState.status === "ready" && setupWarningList.length === 0;
  const harnessReady = harnessState.status === "ready";

  const loadSetupStatus = useCallback(() => {
    setSetupState({ status: "checking" });
    const selections = loadFrontierRoleSelections();
    setFrontierSelections(selections);
    const engines = [...new Set([selections.planning.engine, selections.review.engine, selections.escalation.engine])];
    Promise.all([Promise.all(engines.map(async (engine) => ({ engine, auth: await frontierLoginStatus(engine) }))), engineClient.modelsList()])
      .then(([orchestrators, models]) => {
        setSetupState({ status: "ready", orchestrators, modelProviderCount: models.providers.length });
      })
      .catch((err: unknown) => setSetupState({ status: "error", message: friendlyMessage(err) }));
  }, []);

  useEffect(() => {
    loadSetupStatus();
  }, [loadSetupStatus, setupRefreshToken]);

  const resetRunState = useCallback(() => {
    setTask("");
    setRunTask("");
    setProgress([]);
    setResult(null);
    setRunError(null);
    setApplyState({ status: "idle" });
    setRunProjectDir(null);
    setActiveSession(null);
    setPendingApproval(null);
    setChildSessions([]);
    setPhase("idle");
  }, []);

  const refreshRuntimeSession = useCallback(async (dir: string, sessionId: string) => {
    const details = await engineClient.sessionGet(dir, sessionId, {
      includeEvents: true,
      eventLimit: 5_000,
    });
    if (projectDirRef.current !== dir) return;
    setActiveSession(details.session);
    setPendingApproval(details.pendingApproval);
    setRunProjectDir(dir);
    const listedChildren = await engineClient.sessionsList(dir, {
      kind: "child",
      parentSessionId: sessionId,
      limit: 6,
    });
    const children = await Promise.all(listedChildren.sessions.map(async (session) => {
      const child = await engineClient.sessionGet(dir, session.id, { includeEvents: true, eventLimit: 5_000 });
      const resultEvent = [...(child.events ?? [])].reverse().find((event) => event.type === "child.result");
      const payload = resultEvent?.payload.state === "available"
        ? resultEvent.payload.value as { summary?: unknown }
        : undefined;
      return {
        session,
        ...(typeof payload?.summary === "string" ? { summary: payload.summary } : {}),
        ...(typeof resultEvent?.metadata.diffStat === "string" ? { diffStat: resultEvent.metadata.diffStat } : {}),
      };
    }));
    if (projectDirRef.current !== dir) return;
    setChildSessions(children);

    const created = details.events?.find((event) => event.type === "session.created");
    if (created?.payload.state === "available") {
      const value = created.payload.value as { params?: { task?: unknown } };
      if (typeof value.params?.task === "string") setRunTask(value.params.task);
    }

    if (details.pendingApproval !== null) {
      setPhase("waiting-approval");
      return;
    }
    switch (details.session.status) {
      case "created":
      case "running":
        setPhase("running");
        break;
      case "waiting-approval":
        setPhase("waiting-approval");
        break;
      case "interrupted":
        setPhase("interrupted");
        break;
      case "needs-recovery":
        setPhase("needs-recovery");
        break;
      case "cancelled":
        setPhase("cancelled");
        break;
      case "failed": {
        const failure = [...(details.events ?? [])]
          .reverse()
          .find((event) => event.type === "orchestrate.failed");
        const message = failure?.payload.state === "available"
          ? (failure.payload.value as { message?: unknown }).message
          : undefined;
        setRunError(typeof message === "string" ? message : `Session failed (${details.session.outcome ?? "runtime"}).`);
        setPhase("error");
        break;
      }
      case "completed": {
        const completed = [...(details.events ?? [])]
          .reverse()
          .find((event) => event.type === "orchestrate.completed");
        if (completed?.payload.state === "available") {
          setResult(completed.payload.value as OrchestrateResult);
          setPhase("done");
        } else {
          setRunError("The session completed, but its encrypted result is locked or expired.");
          setPhase("error");
        }
        break;
      }
    }
  }, []);

  const restoreRuntimeSession = useCallback(async (dir: string) => {
    const traceKey = await engineClient.ensureRuntimeKey(dir);
    await engineClient.runtimeConfigure(dir, { traceKey, traceEnabled: true });
    const { sessions } = await engineClient.sessionsList(dir, { kind: "orchestrate", limit: 50 });
    const unresolved = sessions.find((session) =>
      session.status !== "completed" && session.status !== "failed" && session.status !== "cancelled",
    );
    if (unresolved === undefined || projectDirRef.current !== dir) return;
    setChatOpen(true);
    await refreshRuntimeSession(dir, unresolved.id);
  }, [refreshRuntimeSession]);

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
            setHarnessState({ status: "error", message: friendlyMessage(err), progress: [] });
          });
      })
      .catch((err: unknown) => {
        if (projectDirRef.current !== dir) return;
        const message = friendlyMessage(err);
        setWikiState({ status: "error", message });
        setHarnessState({ status: "error", message, progress: [] });
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
    void restoreRuntimeSession(projectDir).catch(() => {
      // Readiness remains usable even if Keychain/runtime restoration fails;
      // starting a task will surface the actionable error inline.
    });
  }, [projectDir, refreshHarnessState, resetRunState, restoreRuntimeSession]);

  useEffect(() => {
    if (!runProjectDir || !activeSession) return;
    const sessionId = activeSession.id;
    const runId = activeSession.runId;
    const unsubscribe = engineClient.onEngineEvent((notification) => {
      if (notification.method === "orchestrate.progress") {
        const event = notification.params as Partial<OrchestrateProgressEvent> & { runId?: string };
        if (event.runId !== undefined && event.runId !== runId) return;
        if (typeof event.stage !== "string" || typeof event.detail !== "string") return;
        progressKeySeq += 1;
        setProgress((prev) => [
          ...prev,
          { key: progressKeySeq, stage: event.stage!, detail: event.detail! },
        ]);
        return;
      }
      if (notification.method !== "session.changed") return;
      const changed = notification.params as { projectDir?: unknown; sessionId?: unknown };
      if (changed.projectDir !== runProjectDir) return;
      void refreshRuntimeSession(runProjectDir, sessionId).catch((err: unknown) => {
        setRunError(friendlyMessage(err));
        setPhase("error");
      });
    });
    const poll = window.setInterval(() => {
      void refreshRuntimeSession(runProjectDir, sessionId).catch(() => {});
    }, 1_000);
    return () => {
      window.clearInterval(poll);
      unsubscribe();
    };
  }, [activeSession?.id, activeSession?.runId, refreshRuntimeSession, runProjectDir]);

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
      }, frontierSelections.planning)
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
        setHarnessState((prev) => ({
          status: "error",
          message: harnessGenerationMessage(err),
          progress: prev.status === "building" ? prev.progress : [],
        }));
      });
  }, [frontierSelections.planning, harnessBuilding, isBusy, projectDir, resetRunState, setupReady]);

  const handleBuildHarnessRequest = useCallback(() => {
    if (harnessState.status === "stale" || harnessState.status === "invalid") {
      setRebuildDialogOpen(true);
      return;
    }
    handleBuildHarness();
  }, [handleBuildHarness, harnessState.status]);

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
    setResultTab("summary");
    setPhase("running");
    setRunProjectDir(projectDir); // Capture the run's project directory
    setRunTask(task.trim()); // Capture the task text for the transcript's "You" turn

    const runId = crypto.randomUUID();
    engineClient.ensureRuntimeKey(projectDir)
      .then((traceKey) => engineClient.runtimeConfigure(projectDir, { traceKey, traceEnabled: true }))
      .then(() => engineClient.orchestrateStart({
        projectDir,
        task: task.trim(),
        runId,
        frontier: { review: frontierSelections.review, escalation: frontierSelections.escalation },
      }))
      .then((started) => refreshRuntimeSession(projectDir, started.sessionId))
      .catch((err: unknown) => {
        setRunError(friendlyMessage(err));
        setPhase("error");
      });
  }, [chatOpen, frontierSelections.escalation, frontierSelections.review, harnessReady, isBusy, projectDir, refreshRuntimeSession, setupReady, task]);

  // Guarded on `phase === "running"` (not just the button's `disabled`
  // attribute) so a second Cancel click — even one that somehow reaches
  // this handler — can never issue a second `cancel()` call while one is
  // already in flight (per Task 2's review: a stray retry loop must not
  // start twice).
  const handleCancel = useCallback(() => {
    if (!runProjectDir || !activeSession || phase === "cancelling") return;
    if (activeSession.status === "completed" || activeSession.status === "failed" || activeSession.status === "cancelled") return;
    setPhase("cancelling");
    void engineClient
      .sessionAction(runProjectDir, activeSession.id, activeSession.version, { type: "cancel" })
      .then(({ session }) => {
        setActiveSession(session);
        setPhase("cancelled");
      })
      .catch((err: unknown) => {
        setRunError(friendlyMessage(err));
        setPhase("error");
      });
  }, [activeSession, phase, runProjectDir]);

  const handleApproval = useCallback((approved: boolean) => {
    if (!runProjectDir || !activeSession || !pendingApproval) return;
    void engineClient
      .sessionGet(runProjectDir, pendingApproval.sessionId)
      .then(({ session }) => engineClient.sessionAction(
        runProjectDir,
        session.id,
        session.version,
        {
          type: "respond-approval",
          approvalId: pendingApproval.id,
          approved,
          response: { reason: approved ? "Approved in Studio" : "Denied in Studio" },
        },
      ))
      .then(() => refreshRuntimeSession(runProjectDir, activeSession.id))
      .catch((err: unknown) => {
        setRunError(friendlyMessage(err));
        setPhase("error");
      });
  }, [activeSession, pendingApproval, refreshRuntimeSession, runProjectDir]);

  const handleSessionAction = useCallback((type: "resume" | "recover-current-state" | "recover-checkpoint") => {
    if (!runProjectDir || !activeSession) return;
    setPhase("running");
    void engineClient
      .sessionAction(runProjectDir, activeSession.id, activeSession.version, { type })
      .then(() => refreshRuntimeSession(runProjectDir, activeSession.id))
      .catch((err: unknown) => {
        setRunError(friendlyMessage(err));
        setPhase("error");
      });
  }, [activeSession, refreshRuntimeSession, runProjectDir]);

  const handleChildAction = useCallback((
    type: "close-child" | "import-child-diff",
    childSessionId: string,
  ) => {
    if (!runProjectDir || !activeSession) return;
    void engineClient.sessionAction(
      runProjectDir,
      activeSession.id,
      activeSession.version,
      { type, childSessionId },
    ).then(() => refreshRuntimeSession(runProjectDir, activeSession.id))
      .catch((err: unknown) => setRunError(friendlyMessage(err)));
  }, [activeSession, refreshRuntimeSession, runProjectDir]);

  const handleApply = useCallback(() => {
    if (!runProjectDir || !result?.candidateRef || applyState.status === "applying") return;
    setApplyState({ status: "applying" });
    engineClient
      .candidatePrepareApply(result.candidateRef.candidateId, runProjectDir)
      .then(({ approvalGrant }) =>
        engineClient.candidateApply(
          result.candidateRef!.candidateId,
          approvalGrant,
          runProjectDir,
          activeSession?.runId,
        ),
      )
      .then(() => {
        setApplyState({ status: "applied" });
        setApplyDialogOpen(false);
      })
      .catch((err: unknown) => setApplyState({ status: "failed", message: friendlyMessage(err) }));
  }, [runProjectDir, result, applyState.status, activeSession?.runId]);

  const canRun = Boolean(projectDir) && chatOpen && harnessReady && setupReady && task.trim().length > 0 && !isBusy;
  const canApply =
    result !== null &&
    (result.outcome === "worker-approved" || result.outcome === "escalated") &&
    result.candidateRef?.lifecycle === "approved" &&
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
          <span className="composer-hint" title="Models are routed automatically: worker model first, lead model review after">
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
        <p className="harness-kicker">Project readiness</p>
        <span className="sr-only">Building harness</span>
        <h2>{projectName ? `Get ${projectName} ready.` : "Open a project to begin."}</h2>

        <div className={projectDir ? "harness-panel" : "harness-panel harness-panel-empty"}>
          <ReadinessProgress steps={readinessSteps(projectDir, setupState, harnessState)} />

          {projectDir && wikiState.status === "ready" && (
            <p className="readiness-summary">
              Repository scan · {wikiState.wiki.files} files · {wikiState.wiki.symbols} symbols
            </p>
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

          <div className="harness-actions">
            {!projectDir ? (
              <button type="button" className="primary-action" aria-label="Add project" onClick={handleAddProject}>
                Open Project…
              </button>
            ) : harnessReady ? (
              <button type="button" className="primary-action" aria-label="Open task chat" onClick={handleOpenChat} disabled={!canOpenChat}>
                Start a task
              </button>
            ) : (
              <button type="button" className="primary-action" onClick={handleBuildHarnessRequest} disabled={!canBuildHarness}>
                {harnessBuilding ? "Building…" : "Build harness"}
              </button>
            )}
            {projectDir && !harnessBuilding && (
              <button type="button" onClick={() => refreshHarnessState(projectDir)} disabled={isBusy}>
                Refresh status
              </button>
            )}
            {projectDir && setupWarningList.length > 0 && onOpenSettings && (
              <button type="button" onClick={onOpenSettings}>
                Open Settings
              </button>
            )}
            {projectDir && setupState.status === "error" && (
              <button type="button" onClick={loadSetupStatus}>
                Recheck settings
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
          <p className="hero-caption">Routed worker · independent review · you stay in control</p>
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

            {(phase === "running" || phase === "cancelling") && (
              <article className="turn turn-step" aria-hidden="true">
                <span className="turn-role turn-role-step turn-role-working">·</span>
                <div className="turn-body muted-text"><Spinner label="Task in progress" /> Working…</div>
              </article>
            )}

            {childSessions.length > 0 && (
              <article className="turn turn-step child-session-tree">
                <span className="turn-role">children</span>
                <div className="turn-body">
                  <ul>
                    {childSessions.map(({ session, summary, diffStat }) => (
                      <li key={session.id}>
                        <div>
                          <strong>{session.status}</strong>
                          <code>{session.id.slice(0, 8)}</code>
                          <span>{session.usedSteps}/{session.budgetSteps ?? "—"} steps · {session.inputTokens + session.outputTokens} tokens</span>
                        </div>
                        {summary && <p>{summary}</p>}
                        {diffStat && <pre>{diffStat}</pre>}
                        <div className="harness-actions">
                          {!(["completed", "failed", "cancelled"] as string[]).includes(session.status) && (
                            <button type="button" onClick={() => handleChildAction("close-child", session.id)}>Cancel child</button>
                          )}
                          {session.status === "completed" && (
                            <button type="button" onClick={() => handleChildAction("import-child-diff", session.id)}>Import diff</button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            )}

            {phase === "waiting-approval" && pendingApproval && (
              <article className="turn turn-step">
                <span className="turn-role">permission</span>
                <div className="turn-body">
                  <p><strong>OpenFusion is waiting for your approval.</strong></p>
                  <p className="muted-text">
                    {pendingApproval.request.state === "available"
                      ? JSON.stringify(pendingApproval.request.value)
                      : "The encrypted operation details are locked."}
                  </p>
                  <div className="harness-actions">
                    <button type="button" onClick={() => handleApproval(false)}>Deny</button>
                    <button type="button" className="primary-action" onClick={() => handleApproval(true)}>Allow once</button>
                  </div>
                </div>
              </article>
            )}

            {(phase === "interrupted" || phase === "needs-recovery") && activeSession && (
              <article className="turn turn-step">
                <span className="turn-role">recovery</span>
                <div className="turn-body">
                  <p><strong>{phase === "needs-recovery" ? "A tool was interrupted." : "The engine stopped during this session."}</strong></p>
                  <p className="muted-text">
                    {activeSession.resumeCapability === "exact"
                      ? "The encrypted trace is available for exact continuation."
                      : "Model history is unavailable; the isolated worktree is still preserved."}
                  </p>
                  <div className="harness-actions">
                    {activeSession.resumeCapability === "exact" && (
                      <button type="button" className="primary-action" onClick={() => handleSessionAction("resume")}>Resume exactly</button>
                    )}
                    <button type="button" onClick={() => handleSessionAction("recover-current-state")}>Continue from worktree</button>
                    {phase === "needs-recovery" && (
                      <button type="button" onClick={() => handleSessionAction("recover-checkpoint")}>Restore checkpoint</button>
                    )}
                  </div>
                </div>
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
                          ? "lead model"
                          : `${result.resolution.providerId}/${result.resolution.model}`}
                      </strong>{" "}
                      via agent <strong>{result.agent}</strong> · task class: {result.taskClass}
                    </span>
                  </p>
                  {result.taskSnapshot?.dirtyState.category !== undefined &&
                    result.taskSnapshot.dirtyState.category !== "clean" && (
                      <p className="ui-inline-warning" role="status">
                        This run used committed HEAD. Your {result.taskSnapshot.dirtyState.category} working-tree changes were excluded and will not be overwritten by Apply.
                      </p>
                    )}
                  <div className="result-tabs" role="tablist" aria-label="Result details">
                    {(["summary", "changes", "review", "cost"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={resultTab === tab}
                        className={resultTab === tab ? "result-tab result-tab-active" : "result-tab"}
                        onClick={() => setResultTab(tab)}
                      >
                        {tab === "changes" ? "Changes" : tab[0]?.toUpperCase() + tab.slice(1)}
                      </button>
                    ))}
                  </div>

                  <div className="result-summary-grid" hidden={resultTab !== "summary"}>
                      <div><span>Outcome</span><strong>Complete</strong></div>
                      <div><span>Agent</span><strong>{result.agent}</strong></div>
                      <div><span>Changes</span><strong>{result.diffStat || (result.diff.trim() ? "Diff ready" : "No changes")}</strong></div>
                      <div><span>Estimated cost</span><strong>{formatUsd(result.cost.totalUsd)}</strong></div>
                    </div>

                  <ul className="attempts-list" hidden={resultTab !== "review"}>
                      {result.attempts.map((attempt) => (
                        <li key={attempt.n}>
                          <strong>Attempt {attempt.n}</strong>{" "}
                          <span className="muted-text">· {attempt.kind === "frontier" ? "lead model" : "worker"}</span>
                          <p>{attempt.summary}{attempt.empty ? " — no changes produced" : ""}</p>
                          {attempt.verdict && (
                            <div className="verdict">
                              <span className={`verdict-decision verdict-${attempt.verdict.decision}`}>
                                {attempt.verdict.decision === "approve" ? "Approved" : "Changes requested"}
                              </span>
                              <span className="verdict-severity"> severity: {attempt.verdict.severity}</span>
                              {attempt.verdict.reasons.length > 0 && (
                                <ul>{attempt.verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>

                  <div className="result-changes" hidden={resultTab !== "changes"}>
                      {result.diff.trim().length === 0 ? <p className="muted-text">No changes were produced.</p> : <DiffView diff={result.diff} />}
                    </div>

                  <div hidden={resultTab !== "cost"}>
                      <dl className="cost-split">
                        <dt>Worker</dt><dd>{formatUsd(result.cost.workerUsd)}</dd>
                        <dt>Review</dt><dd>{formatUsd(result.cost.reviewUsd)}</dd>
                        <dt>Escalation</dt><dd>{formatUsd(result.cost.escalateUsd)}</dd>
                        <dt>Lead models</dt><dd>{formatUsd(result.cost.frontierUsd)}</dd>
                        <dt>Total</dt><dd>{formatUsd(result.cost.totalUsd)}</dd>
                      </dl>
                      <p className="muted-text">{result.cost.note} figures{result.cost.pricingConfidence ? ` — pricing confidence: ${result.cost.pricingConfidence}` : ""}.</p>
                    </div>
                  {canApply && (
                    <div className="result-apply">
                      <button type="button" className="primary-action" onClick={() => setApplyDialogOpen(true)} disabled={applyState.status === "applying"}>
                        Review and Apply…
                      </button>
                      {applyState.status === "applied" && <p role="status" className="inline-success">Applied to working tree.</p>}
                    </div>
                  )}
                </div>
              </article>
            )}
          </div>

          <div className="chat-dock">{composer}</div>
        </>
      )}

      <Dialog
        open={rebuildDialogOpen}
        title={`Rebuild ${projectName ?? "this"} harness?`}
        description="Generated harness files may change to match the current project version. Review any manual harness edits before continuing."
        onClose={() => setRebuildDialogOpen(false)}
        dismissOnBackdrop={false}
        size="small"
        footer={
          <>
            <button type="button" onClick={() => setRebuildDialogOpen(false)}>Cancel</button>
            <button type="button" className="ui-button-primary" onClick={() => { setRebuildDialogOpen(false); handleBuildHarness(); }}>Rebuild Harness</button>
          </>
        }
      >
        <p className="dialog-impact-copy">The project wiki and generated team will be refreshed. An approved Project Card may need review again.</p>
      </Dialog>

      <Dialog
        open={applyDialogOpen}
        title="Apply generated changes?"
        description="Review the target and change summary before modifying the working tree."
        onClose={() => setApplyDialogOpen(false)}
        dismissOnBackdrop={false}
        size="medium"
        footer={
          <>
            <button type="button" onClick={() => setApplyDialogOpen(false)} disabled={applyState.status === "applying"}>Cancel</button>
            <button type="button" className="ui-button-primary" onClick={handleApply} disabled={applyState.status === "applying"}>
              {applyState.status === "applying" ? "Applying…" : "Apply Changes"}
            </button>
          </>
        }
      >
        <dl className="apply-review-list">
          <dt>Project</dt><dd>{projectName}</dd>
          <dt>Location</dt><dd><code>{runProjectDir}</code></dd>
          <dt>Changes</dt><dd>{result?.diffStat || "Generated diff"}</dd>
        </dl>
        <p className="ui-inline-warning">This updates the working tree only. OpenFusion does not commit or merge the changes.</p>
        {applyState.status === "failed" && <p role="alert" className="error-text">{applyState.message}</p>}
      </Dialog>
    </section>
  );
}
