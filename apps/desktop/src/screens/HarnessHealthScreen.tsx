import { useCallback, useEffect, useRef, useState } from "react";
import { useProject } from "../ProjectContext";
import {
  EngineError,
  engineClient,
  type HarnessHealthIssue,
  type HarnessHealthReport,
} from "../engineClient";
import { Icon } from "../ui/Icon";
import { Spinner } from "../ui/Spinner";

function friendlyMessage(err: unknown): string {
  if (err instanceof EngineError) return `[${err.code}] ${err.message}`;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return "Harness health could not be checked.";
}

function label(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function overallCopy(report: HarnessHealthReport): string {
  if (report.overall === "healthy") return "The harness is current, operational, and supported by recent production evidence.";
  if (report.overall === "degraded") return "The harness needs attention. Deterministic checks or recent operations found problems.";
  if (report.overall === "failed") return "The harness is missing or structurally invalid.";
  return "Deterministic checks ran, but more real task evidence is needed before assigning operational health.";
}

const ISSUE_COPY: Record<string, string> = {
  "harness-missing": "No generated harness is present.",
  "harness-structural-invalid": "Harness artifacts failed structural validation.",
  "harness-stale": "The harness was generated for an older Git HEAD.",
  "wiki-index-failed": "The project wiki index is missing, stale, or corrupt.",
  "wiki-retrieval-unavailable": "Deterministic wiki retrieval checks did not pass.",
  "wiki-delivery-unavailable": "The wiki MCP delivery round-trip did not pass.",
  "wiki-verification-error": "Wiki verification could not complete.",
  "runtime-errors-observed": "Recent orchestration runs include engine-level errors.",
  "apply-failures-observed": "A recent approved diff failed to apply.",
  "high-task-failure-rate": "The recent task-failure rate crossed the operational warning threshold.",
  "tool-errors-observed": "Recent runs contain tool errors; successful retries remain counted separately.",
  "insufficient-production-evidence": "Fewer than five non-cancelled production runs are available.",
};

function IssueList({ issues }: { issues: HarnessHealthIssue[] }) {
  if (issues.length === 0) return <p className="muted-text">No current health issues.</p>;
  return (
    <ul className="health-issue-list">
      {issues.map((issue) => (
        <li key={issue.code} className={`health-issue health-issue-${issue.severity}`}>
          <strong>{label(issue.severity)}</strong>
          <span>{ISSUE_COPY[issue.code] ?? label(issue.code)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Project harness verification and production-health view. System benchmark
 * experiments intentionally live outside this project-local workspace. */
export function HarnessHealthScreen() {
  const { activeProjectDir: projectDir } = useProject();
  const [report, setReport] = useState<HarnessHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const refresh = useCallback(() => {
    if (!projectDir) return;
    requestSequence.current += 1;
    const request = requestSequence.current;
    setLoading(true);
    setError(null);
    engineClient
      .harnessHealth(projectDir)
      .then((next) => {
        if (request !== requestSequence.current) return;
        setReport(next);
      })
      .catch((err: unknown) => {
        if (request !== requestSequence.current) return;
        setReport(null);
        setError(friendlyMessage(err));
      })
      .finally(() => {
        if (request === requestSequence.current) setLoading(false);
      });
  }, [projectDir]);

  useEffect(() => {
    setReport(null);
    setError(null);
    if (projectDir) refresh();
    return () => {
      requestSequence.current += 1;
    };
  }, [projectDir, refresh]);

  return (
    <section className="screen evaluations-screen harness-health-screen">
      <header className="screen-title-block">
        <p className="screen-eyebrow">Verification and operations</p>
        <h1>Harness health</h1>
        <p>Check this project’s generated harness and recent runtime evidence without running model comparisons.</p>
      </header>

      <div className="eval-project-context">
        <span className="eval-project-icon"><Icon name="folder" /></span>
        <span className="eval-project-copy">
          <small>Current project</small>
          <strong>{projectDir ? projectDir.split("/").filter(Boolean).pop() : "No project selected"}</strong>
        </span>
        {projectDir && <span className="sr-only">{projectDir}</span>}
        <button type="button" onClick={refresh} disabled={!projectDir || loading}>
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {loading && report === null && (
        <p role="status"><Spinner label="Checking harness health" /> Checking harness and wiki delivery…</p>
      )}
      {error && <p role="alert" className="error-text">{error}</p>}

      {report && (
        <>
          <div className={`health-banner health-banner-${report.overall}`} role={report.overall === "failed" ? "alert" : "status"}>
            <strong>{label(report.overall)}</strong>
            <span>{overallCopy(report)}</span>
          </div>

          <section className="health-section">
            <h2>Deterministic verification</h2>
            <dl className="health-grid">
              <div><dt>Harness structure</dt><dd>{label(report.harness.structural)}</dd></div>
              <div><dt>Harness freshness</dt><dd>{label(report.harness.freshness)}</dd></div>
              <div><dt>Project card</dt><dd>{label(report.harness.card)}</dd></div>
              <div><dt>Wiki index</dt><dd>{label(report.wiki.index)}</dd></div>
              <div><dt>Wiki retrieval</dt><dd>{label(report.wiki.retrieval)}</dd></div>
              <div><dt>Wiki delivery</dt><dd>{label(report.wiki.delivery)}</dd></div>
            </dl>
          </section>

          <section className="health-section">
            <h2>Production evidence</h2>
            <p className="muted-text">
              Metadata-only observations from the latest 50 orchestration and apply records. They indicate reliability, not answer correctness.
            </p>
            <dl className="health-grid">
              <div><dt>Operational status</dt><dd>{label(report.operational.status)}</dd></div>
              <div><dt>Observed runs</dt><dd>{report.operational.sampleSize}</dd></div>
              <div><dt>Completed</dt><dd>{report.operational.successfulRuns}</dd></div>
              <div><dt>Task failures</dt><dd>{report.operational.failedRuns}</dd></div>
              <div><dt>Runtime errors</dt><dd>{report.operational.errorRuns}</dd></div>
              <div><dt>Escalations</dt><dd>{report.operational.escalatedRuns}</dd></div>
              <div><dt>Review retries</dt><dd>{report.operational.reviewRequestChanges}</dd></div>
              <div><dt>Tool errors</dt><dd>{report.operational.toolErrors}</dd></div>
              <div><dt>Applied</dt><dd>{report.operational.applySucceeded}</dd></div>
              <div><dt>Apply failures</dt><dd>{report.operational.applyFailed}</dd></div>
              <div><dt>Cancelled</dt><dd>{report.operational.cancelledRuns}</dd></div>
            </dl>
          </section>

          <section className="health-section">
            <h2>Attention</h2>
            <IssueList issues={report.issues} />
          </section>

          <p className="muted-text health-checked-at">
            Checked {new Date(report.checkedAt).toLocaleString()}. Prompts, diffs, model output, command output, RPC payloads, and secrets are not stored in this health evidence.
          </p>
        </>
      )}
    </section>
  );
}
