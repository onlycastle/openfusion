import { useCallback, useEffect, useRef, useState } from "react";
import { useProject } from "../ProjectContext";
import {
  EngineError,
  RunCancelledError,
  engineClient,
  type CancellableRun,
  type EvalsProgressEvent,
  type EvalsReportCard,
  type EvalsRunRecord,
  type EvalsTaskDescriptor,
  type OrchestrateRunRecord,
} from "../engineClient";

/** Renders a rejection as a short, user-facing sentence — never a stack
 * trace. Same posture as Orchestrate/Keys screens' own
 * `friendlyMessage`. */
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

/** `null` shows up for more than one reason — an unpriced model (the most
 * common case), but also an empty clean subset, a zero clean-baseline cost
 * total, or subscription-auth calls that meter zero cost — so the message
 * stays a generic "not computable" rather than naming "(unpriced models)"
 * specifically and misattributing the other cases. Never a fake number
 * (a `0` or `NaN` here would silently misread as "no savings" or crash the
 * format call). */
function formatPct(value: number | null): string {
  if (value === null) return "not computable";
  return `${(value * 100).toFixed(1)}%`;
}

/** Narrows one `engine.runs.list` record to the `"evals"` kind — the RPC's
 * `records` field is a loose union (`EvalsRunRecord | OrchestrateRunRecord |
 * Record<string, unknown>`, see engineClient.ts's own drift caveat) even
 * though this screen always passes `kind: "evals"` in its request; filtering
 * again here is a defensive belt-and-suspenders against a future engine
 * change that ever widened what an "evals"-filtered response could contain. */
function isEvalsRunRecord(
  record: EvalsRunRecord | OrchestrateRunRecord | Record<string, unknown>,
): record is EvalsRunRecord {
  return (record as { kind?: unknown }).kind === "evals";
}

/** The History strip's own savings format: an em dash for `null` (never a
 * fake number), otherwise a percentage to one decimal — deliberately
 * distinct from `formatPct`'s longer "not computable" prose, which reads
 * fine inline in the full report card but would be too wide for a compact
 * history row. */
function formatHistorySavings(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

// Monotonic key for progress list entries — same rationale as
// OrchestrateScreen's own `progressKeySeq` (append-only list, no reordering).
let progressKeySeq = 0;

interface ProgressEntry {
  key: number;
  stage: string;
  taskId?: string;
}

/** The run's overall lifecycle — mirrors OrchestrateScreen's `Phase` exactly,
 * including the deliberate `"cancelling"` vs `"cancelled"` vs `"error"`
 * three-way split (see that screen's own doc comment for the rationale). */
type Phase = "idle" | "running" | "cancelling" | "cancelled" | "done" | "error";

/** Parses the two plain-text form fields into the `EvalsTaskDescriptor[]`
 * shape `engine.evals.run` actually accepts (evals/methods.ts's
 * `TaskDescriptorSchema`: `{commitSha, testCommand}`, `testCommand` a
 * non-empty argv array). v1 keeps this minimal: one shared test command,
 * applied to every commit sha the user lists (one per line) — matching the
 * task brief's "a textarea/form for commit shas + a test command". Blank
 * lines are dropped; a blank/whitespace-only test command yields an empty
 * `testCommand` for every task, which the Run button's own `canRun` guard
 * below refuses to submit. */
function parseTasks(commitShasText: string, testCommandText: string): EvalsTaskDescriptor[] {
  const shas = commitShasText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const testCommand = testCommandText.trim().length > 0 ? testCommandText.trim().split(/\s+/) : [];
  return shas.map((commitSha) => ({ commitSha, testCommand }));
}

/** Picks the reason text shown next to an "inconclusive" verdict. PREFERS
 * evals/run.ts's own `report.note` — the structural, authoritative prose the
 * engine itself built while computing this exact verdict (see that module's
 * `buildNote`) — over re-deriving a reason from copied gate logic.
 *
 * An earlier version of this function hand-duplicated evals/run.ts's own
 * `MIN_TASK_COUNT_FOR_VERDICT`/`MATERIAL_MEASUREMENT_FAILURE_FRACTION`
 * constants to pick which sentence to show. That was a silent-drift hazard:
 * the VERDICT itself always stays correct (it comes straight from
 * `report.verdict`, computed by the engine), but the hand-copied constants
 * used only to choose the REASON TEXT could quietly go stale if the engine's
 * own thresholds ever changed, and silently name the wrong gate.
 * `report.note` can't drift this way — it's the engine's own text, not a
 * copy of its logic.
 *
 * `report.note` (`buildNote` in evals/run.ts) names three of the engine's
 * four inconclusive gates explicitly: material measurement-failure
 * fraction, a zero-clean-baseline run, and unpriced calls each get their own
 * sentence appended via `buildNote`'s `extraNotes`. The too-few-tasks gate
 * is also named, via `buildNote`'s own always-present sample-size sentence
 * ("below the N-task minimum ... a demo, not a claim" when under that
 * count). The one gate `buildNote` never calls out by name is "quality held
 * on the clean subset, but no cost savings were measured" — for that gate
 * `report.note` still reads as true, honest, structural context (sample
 * size, cost-estimate caveat, pricing confidence), even though it doesn't
 * spell out that specific gate by name. Showing it there anyway is still
 * strictly safer than a hand-derived, drift-prone guess at the reason.
 *
 * The structural fallback below (no thresholds, just the STRUCTURAL counts
 * the report card already carries) only fires if the engine ever ships an
 * inconclusive report with a genuinely empty note — not expected today
 * (`buildNote` always returns non-empty text) but kept as a floor rather
 * than an empty reason. */
function inconclusiveReason(report: EvalsReportCard): string {
  const note = report.note.trim();
  if (note.length > 0) return `inconclusive: ${note}`;
  return (
    `inconclusive: verdict computed from ${report.cleanTaskCount} of ${report.taskCount} clean task(s) ` +
    `(${report.measurementFailureCount} measurement failure(s)) — see the report details below for why.`
  );
}

/** The verdict callout — the honesty gate this whole screen exists for (spec
 * §12.1, the ETH hazard). `"pass"` and `"inconclusive"` are informational
 * (`role="status"`); `"fail"` is deliberately `role="alert"` and worded as an
 * unambiguous warning — a quality-degrading harness must never be mistaken
 * for a savings win, regardless of how good its cost numbers look. */
function VerdictBanner({ report }: { report: EvalsReportCard }) {
  if (report.verdict === "pass") {
    return (
      <p role="status" className="verdict-banner verdict-banner-pass">
        PASS — the harness holds quality at lower cost.
      </p>
    );
  }
  if (report.verdict === "fail") {
    return (
      <p role="alert" className="verdict-banner verdict-banner-fail">
        ⚠ ETH-HAZARD: the harness produced WORSE quality than the frontier baseline — FLAGGED, not a savings win.
      </p>
    );
  }
  return (
    <p role="status" className="verdict-banner verdict-banner-inconclusive">
      {inconclusiveReason(report)}
    </p>
  );
}

/** The savings figure: a real percentage only when `savingsPct` is priced;
 * otherwise an honest "not computable" sentence, never a fabricated number
 * (a `0` or `NaN` would silently misread as "no savings" or crash the
 * format call). A non-`"verified"` `pricingConfidence` always shows a
 * caveat badge alongside the figure — the savings claim is an ESTIMATE, and
 * this is the one place in the screen that says so out loud.
 *
 * On a `"fail"` verdict (the ETH hazard — see `VerdictBanner`), a bare
 * "Savings: X%" line reads, to a skim-reader, as a positive number without
 * any acknowledgment that the fail banner above already supersedes it — a
 * quality-degrading harness must never register as a savings win. So on
 * `"fail"` ONLY, this line gets an inline qualifier saying so; `"pass"` and
 * `"inconclusive"` rendering is unchanged. */
function SavingsDisplay({ report }: { report: EvalsReportCard }) {
  const isFail = report.verdict === "fail";
  return (
    <div className="savings-display">
      <p className={isFail ? "savings-figure savings-figure-disregarded" : "savings-figure"}>
        Savings: {formatPct(report.savingsPct)}
        {isFail && <span className="disregarded-note"> — disregarded; see verdict above</span>}
      </p>
      {report.pricingConfidence !== "verified" && (
        <p className="caveat-badge">savings estimate — pricing confidence: {report.pricingConfidence}</p>
      )}
    </div>
  );
}

/** The Evals cockpit screen: the M6 baseline-vs-harness report card, live.
 * Reads the active project from `ProjectContext` (Rail 1's concern now —
 * this screen no longer owns a picker), takes a list of golden-commit SHAs
 * plus one shared test command, runs `engineClient.runEvals` as a
 * `CancellableRun`, and renders its streamed `evals.progress` stages, then
 * the full report card: the verdict (with the ETH-hazard fail treatment),
 * the savings figure (with its pricing-confidence caveat), baseline-vs-
 * harness passed counts and cost, the per-task table, and the clean-subset
 * numbers the verdict was actually computed from — with a distinct
 * Cancelling/Cancelled state (not Failed), matching OrchestrateScreen's own
 * cancel semantics exactly. */
export function EvalsScreen() {
  const { activeProjectDir: projectDir } = useProject();
  const [runProjectDir, setRunProjectDir] = useState<string | null>(null);
  const [commitShasText, setCommitShasText] = useState("");
  const [testCommandText, setTestCommandText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [report, setReport] = useState<EvalsReportCard | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [evalsHistory, setEvalsHistory] = useState<EvalsRunRecord[]>([]);

  const runRef = useRef<CancellableRun<EvalsReportCard> | null>(null);

  // The history fetch below resolves against whichever project is CURRENT
  // when it settles, not whichever was current when it started — re-picking
  // a project mid-flight must not let a slower, stale response (e.g. A's
  // runsList landing after B's, once projectDir has moved on to B) overwrite
  // the screen with the wrong project's history. Mirrors OrchestrateScreen's
  // projectDirRef guard / HarnessSettingPanel's activeProjectDirRef guard —
  // the house stale-guard pattern (see this file's own Task 5 history-strip
  // code below for where it's actually checked).
  const projectDirRef = useRef<string | null>(null);
  projectDirRef.current = projectDir;

  /** Fetches the last 10 `"evals"`-kind ledger records for `dir` and, if
   * `dir` is still the active project once the call settles, replaces the
   * History strip's contents. History is best-effort chrome (Task 5 brief):
   * a rejection renders nothing — never a screen-level error state — so the
   * `.catch` below deliberately does not touch any state at all (there is
   * nothing to reconcile; the stale-guard above is what protects the ONE
   * branch that does write state). */
  const loadHistory = useCallback((dir: string) => {
    engineClient
      .runsList(dir, "evals", 10)
      .then((res) => {
        if (projectDirRef.current !== dir) return;
        setEvalsHistory(res.records.filter(isEvalsRunRecord));
      })
      .catch(() => {
        // best-effort chrome — see this function's own doc comment above.
      });
  }, []);

  // Fetch on load AND whenever the active project changes — clears the prior
  // project's rows immediately so a project switch never briefly shows a
  // foreign project's history while the new fetch is in flight.
  useEffect(() => {
    setEvalsHistory([]);
    if (projectDir) loadHistory(projectDir);
  }, [projectDir, loadHistory]);

  const isBusy = phase === "running" || phase === "cancelling";
  const tasks = parseTasks(commitShasText, testCommandText);
  const canRun =
    Boolean(projectDir) && tasks.length > 0 && tasks.every((t) => t.testCommand.length > 0) && !isBusy;

  const handleRun = useCallback(() => {
    if (!projectDir || isBusy) return;
    const parsedTasks = parseTasks(commitShasText, testCommandText);
    if (parsedTasks.length === 0 || !parsedTasks.every((t) => t.testCommand.length > 0)) return;

    setProgress([]);
    setReport(null);
    setRunError(null);
    setPhase("running");
    setRunProjectDir(projectDir); // Capture the run's project directory — bind the report card to it.

    const run = engineClient.runEvals({ projectDir, tasks: parsedTasks }, (event: EvalsProgressEvent) => {
      progressKeySeq += 1;
      const entry: ProgressEntry = { key: progressKeySeq, stage: event.stage, taskId: event.taskId };
      setProgress((prev) => [...prev, entry]);
    });
    runRef.current = run;

    run.promise
      .then((res) => {
        setReport(res);
        setPhase("done");
        // The engine's evals write point (evals/methods.ts) records a ledger
        // entry ONLY on success (never on a thrown/cancelled run — see that
        // module's own comment on why there's no error-path record) — so a
        // refetch belongs here, not in the catch branch below. `loadHistory`
        // re-checks `projectDirRef` itself before writing any state, so this
        // is safe even if the active project has since moved on.
        loadHistory(projectDir);
      })
      .catch((err: unknown) => {
        if (err instanceof RunCancelledError) {
          setPhase("cancelled");
          return;
        }
        setRunError(friendlyMessage(err));
        setPhase("error");
      });
  }, [projectDir, commitShasText, testCommandText, isBusy, loadHistory]);

  // Guarded on `phase === "running"` (not just the button's `disabled`
  // attribute) so a second Cancel click can never issue a second `cancel()`
  // call while one is already in flight — mirrors OrchestrateScreen's
  // identical guard (per Task 2's review).
  const handleCancel = useCallback(() => {
    if (phase !== "running") return;
    setPhase("cancelling");
    void runRef.current?.cancel();
  }, [phase]);

  return (
    <section className="screen">
      <h1>Evals</h1>
      <p>
        Run the baseline-vs-harness report card against golden commits and get an honest verdict — never a
        marketing summary — on how the harness actually did.
      </p>

      <h2>Project</h2>
      {projectDir ? (
        <p>
          <code>{projectDir}</code>
        </p>
      ) : (
        <p className="muted-text">No project selected</p>
      )}

      <h2>Eval tasks</h2>
      <label>
        Golden commit SHAs (one per line)
        <textarea
          value={commitShasText}
          onChange={(e) => setCommitShasText(e.target.value)}
          rows={4}
          disabled={isBusy}
          placeholder={"abc1234\ndef5678"}
        />
      </label>
      <label>
        Test command (applied to every task above, space-separated)
        <input
          type="text"
          value={testCommandText}
          onChange={(e) => setTestCommandText(e.target.value)}
          disabled={isBusy}
          placeholder="npm test"
        />
      </label>

      <div className="actions">
        <button type="button" onClick={handleRun} disabled={!canRun}>
          Run evals
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
          <ul className="progress-list">
            {progress.map((entry) => (
              <li key={entry.key}>
                <strong>{entry.stage}</strong>
                {entry.taskId ? `: ${entry.taskId}` : ""}
              </li>
            ))}
          </ul>
        </>
      )}

      {phase === "done" && report && (
        <>
          <h2>Report card{runProjectDir ? <span className="muted-text"> — {runProjectDir}</span> : null}</h2>
          <VerdictBanner report={report} />
          <SavingsDisplay report={report} />

          <h2>Baseline vs harness</h2>
          <dl className="cost-split">
            <dt>Baseline passed</dt>
            <dd>
              {report.baseline.passed}/{report.taskCount}
            </dd>
            <dt>Harness passed</dt>
            <dd>
              {report.harness.passed}/{report.taskCount}
            </dd>
            <dt>Harness escalations</dt>
            <dd>{report.harness.escalations}</dd>
            <dt>Baseline cost</dt>
            <dd>{formatUsd(report.baseline.costUsd)}</dd>
            <dt>Harness cost</dt>
            <dd>{formatUsd(report.harness.costUsd)}</dd>
          </dl>

          <h2>Per-task breakdown</h2>
          <table className="eval-per-task-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Baseline</th>
                <th>Harness</th>
                <th>Harness outcome</th>
                <th>Baseline cost</th>
                <th>Harness cost</th>
              </tr>
            </thead>
            <tbody>
              {report.perTask.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td>{t.baselinePassed ? "Pass" : "Fail"}</td>
                  <td>{t.harnessPassed ? "Pass" : "Fail"}</td>
                  <td>{t.harnessOutcome}</td>
                  <td>{formatUsd(t.baselineUsd)}</td>
                  <td>{formatUsd(t.harnessUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Clean subset — what the verdict was computed from</h2>
          <dl className="clean-subset">
            <dt>Clean tasks</dt>
            <dd>{report.cleanTaskCount}</dd>
            <dt>Clean baseline passed</dt>
            <dd>{report.cleanBaselinePassed}</dd>
            <dt>Clean harness passed</dt>
            <dd>{report.cleanHarnessPassed}</dd>
            {/* Same skim-reads-as-win gap SavingsDisplay's own qualifier closes for the
                main savings line, above: fail is decided by quality on the clean subset
                regardless of cost (evals/run.ts's `!qualityHeldClean` branch, checked
                before any cost comparison), so cleanSavingsPct can still read positive on
                a fail verdict. Qualify it here too rather than leaving it bare. */}
            <dt>Clean savings</dt>
            <dd className={report.verdict === "fail" ? "savings-figure-disregarded" : undefined}>
              {formatPct(report.cleanSavingsPct)}
              {report.verdict === "fail" && (
                <span className="disregarded-note"> — disregarded; see verdict above</span>
              )}
            </dd>
            <dt>Measurement failures</dt>
            <dd>{report.measurementFailureCount}</dd>
          </dl>
          <p className="muted-text">
            The verdict above is computed from this clean subset — tasks where neither side hit a measurement
            failure — not the raw all-task figures shown further up.
          </p>

          <p className="muted-text">{report.note}</p>
        </>
      )}

      {evalsHistory.length > 0 && (
        <section className="evals-history">
          <h2>History</h2>
          <ul className="evals-history-list">
            {evalsHistory.map((record, index) => (
              <li key={`${record.runId ?? record.at}-${index}`} className="evals-history-row">
                <span className="evals-history-date">{new Date(record.at).toLocaleString()}</span>
                <span className={`outcome-badge evals-history-verdict-${record.verdict}`}>{record.verdict}</span>
                <span className="evals-history-savings">{formatHistorySavings(record.savingsPct)}</span>
                <span className="evals-history-tasks">{record.taskCount} tasks</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
