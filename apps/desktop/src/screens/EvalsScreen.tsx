import { useCallback, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  EngineError,
  RunCancelledError,
  engineClient,
  type CancellableRun,
  type EvalsProgressEvent,
  type EvalsReportCard,
  type EvalsTaskDescriptor,
} from "../engineClient";

/** Renders a rejection as a short, user-facing sentence — never a stack
 * trace. Same posture as Orchestrate/Project/Keys screens' own
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

function formatPct(value: number | null): string {
  if (value === null) return "not computable (unpriced models)";
  return `${(value * 100).toFixed(1)}%`;
}

// Monotonic key for progress list entries — same rationale as Orchestrate/
// Project screens' own `progressKeySeq` (append-only list, no reordering).
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

// Mirrors evals/run.ts's own MIN_TASK_COUNT_FOR_VERDICT / own
// MATERIAL_MEASUREMENT_FAILURE_FRACTION constants — used here ONLY to pick
// a human-readable REASON string for an "inconclusive" verdict (the engine
// itself already applied these thresholds; this screen never re-derives the
// verdict, only explains it from the structured fields the report card
// already carries).
const MIN_TASK_COUNT_FOR_VERDICT = 5;
const MATERIAL_MEASUREMENT_FAILURE_FRACTION = 0.2;

/** Picks the most relevant honest reason for an "inconclusive" verdict,
 * checked in the SAME priority order evals/run.ts's own verdict computation
 * uses (material measurement-failure fraction, then a zero-clean-baseline
 * run, then unpriced calls, then too-few-tasks) — so the reason shown here
 * always names the actual gate that produced this run's "inconclusive"
 * result, never a guess. */
function inconclusiveReason(report: EvalsReportCard): string {
  if (report.taskCount > 0 && report.measurementFailureCount / report.taskCount >= MATERIAL_MEASUREMENT_FAILURE_FRACTION) {
    return (
      `inconclusive: ${report.measurementFailureCount} of ${report.taskCount} tasks had measurement failures — ` +
      "this run is too corrupted to trust either a pass or fail verdict."
    );
  }
  if (report.cleanBaselinePassed === 0) {
    return "inconclusive: the baseline solved 0 of the clean (non-measurement-failed) tasks — there is nothing to measure quality against.";
  }
  if (report.pricingConfidence === "unpriced" || report.cleanSavingsPct === null) {
    return "inconclusive: unpriced — no savings number can be computed for this run.";
  }
  if (report.taskCount < MIN_TASK_COUNT_FOR_VERDICT) {
    return "inconclusive: too few tasks — a demo, not a claim.";
  }
  return "inconclusive: quality held, but no cost savings were measured on the clean subset.";
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
 * this is the one place in the screen that says so out loud. */
function SavingsDisplay({ report }: { report: EvalsReportCard }) {
  return (
    <div className="savings-display">
      <p className="savings-figure">Savings: {formatPct(report.savingsPct)}</p>
      {report.pricingConfidence !== "verified" && (
        <p className="caveat-badge">savings estimate — pricing confidence: {report.pricingConfidence}</p>
      )}
    </div>
  );
}

/** The Evals cockpit screen: the M6 baseline-vs-harness report card, live.
 * Picks a project directory (a minimal, self-contained picker — same
 * posture as OrchestrateScreen's own), takes a list of golden-commit SHAs
 * plus one shared test command, runs `engineClient.runEvals` as a
 * `CancellableRun`, and renders its streamed `evals.progress` stages, then
 * the full report card: the verdict (with the ETH-hazard fail treatment),
 * the savings figure (with its pricing-confidence caveat), baseline-vs-
 * harness passed counts and cost, the per-task table, and the clean-subset
 * numbers the verdict was actually computed from — with a distinct
 * Cancelling/Cancelled state (not Failed), matching OrchestrateScreen's own
 * cancel semantics exactly. */
export function EvalsScreen() {
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [runProjectDir, setRunProjectDir] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [commitShasText, setCommitShasText] = useState("");
  const [testCommandText, setTestCommandText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [report, setReport] = useState<EvalsReportCard | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const runRef = useRef<CancellableRun<EvalsReportCard> | null>(null);

  const isBusy = phase === "running" || phase === "cancelling";
  const tasks = parseTasks(commitShasText, testCommandText);
  const canRun =
    Boolean(projectDir) && tasks.length > 0 && tasks.every((t) => t.testCommand.length > 0) && !isBusy;

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
      })
      .catch((err: unknown) => {
        if (err instanceof RunCancelledError) {
          setPhase("cancelled");
          return;
        }
        setRunError(friendlyMessage(err));
        setPhase("error");
      });
  }, [projectDir, commitShasText, testCommandText, isBusy]);

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
            <dt>Clean savings</dt>
            <dd>{formatPct(report.cleanSavingsPct)}</dd>
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
    </section>
  );
}
