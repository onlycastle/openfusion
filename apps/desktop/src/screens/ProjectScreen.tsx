import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { EngineError, engineClient, type ModelProviderSummary, type WikiBuildStats, type WikiStatus } from "../engineClient";

type ProvidersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; providers: ModelProviderSummary[] };

type WikiStatusState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; wiki: WikiStatus }
  | { status: "error"; message: string };

type BuildState =
  | { status: "idle" }
  | { status: "building" }
  | { status: "done"; stats: WikiBuildStats }
  | { status: "error"; message: string };

/** Renders a rejection as a short, user-facing sentence — never a stack
 * trace. An `EngineError` (the shape `engine_call` rejects with — see
 * `engineClient.ts`) carries the engine's JSON-RPC error `code` alongside
 * its `message`; a plain string/`Error` (e.g. the Tauri dialog plugin's own
 * rejections) is passed through as-is. */
function friendlyMessage(err: unknown): string {
  if (err instanceof EngineError) return `[${err.code}] ${err.message}`;
  if (typeof err === "string" && err.trim().length > 0) return err;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return "Something went wrong. Please try again.";
}

// Monotonic key for progress list entries — a plain incrementing counter
// (not `Date.now()`/`crypto.randomUUID()`) is enough since entries are only
// ever appended, never reordered or deduplicated by content.
let progressKeySeq = 0;

/** The Project screen: shows configured model providers (unchanged from
 * Task 5), lets the user pick a project directory via the native Tauri
 * dialog, shows that project's wiki status (built/stale, or the engine's
 * friendly error for a non-git directory), and runs `engine.wiki.build`
 * with a live progress area fed by `engine_events` notifications. */
export function ProjectScreen() {
  const [providersState, setProvidersState] = useState<ProvidersState>({ status: "loading" });
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [wikiStatusState, setWikiStatusState] = useState<WikiStatusState>({ status: "idle" });
  const [buildState, setBuildState] = useState<BuildState>({ status: "idle" });
  const [progress, setProgress] = useState<Array<{ key: number; text: string }>>([]);

  // The `wiki.build.progress` subscription below is set up once, on mount,
  // and lives for the component's lifetime — but it needs to filter
  // notifications against whichever project directory is CURRENT at the
  // moment each notification arrives, not whichever was current when the
  // effect first ran. A ref (rather than re-subscribing every time
  // `projectDir` changes) keeps this to the one `onEngineEvent` call the
  // single-subscription `EngineClient` is designed around.
  const projectDirRef = useRef<string | null>(null);
  projectDirRef.current = projectDir;

  useEffect(() => {
    let cancelled = false;
    setProvidersState({ status: "loading" });
    engineClient
      .modelsList()
      .then((result) => {
        if (!cancelled) setProvidersState({ status: "ready", providers: result.providers });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setProvidersState({ status: "error", message: friendlyMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = engineClient.onEngineEvent((notification) => {
      if (notification.method !== "wiki.build.progress") return;
      const params = notification.params as { projectDir?: string; detail?: string } | null | undefined;
      if (!params || params.projectDir !== projectDirRef.current) return;
      const text = typeof params.detail === "string" && params.detail.length > 0 ? params.detail : "working…";
      progressKeySeq += 1;
      setProgress((prev) => [...prev, { key: progressKeySeq, text }]);
    });
    return unsubscribe;
  }, []);

  const handleChooseProject = useCallback(() => {
    setPickerError(null);
    open({ directory: true })
      .then((selected) => {
        if (typeof selected !== "string") return; // user cancelled the dialog
        setProjectDir(selected);
        setBuildState({ status: "idle" });
        setProgress([]);
        setWikiStatusState({ status: "loading" });
        engineClient
          .wikiStatus(selected)
          .then((wiki) => setWikiStatusState({ status: "ready", wiki }))
          .catch((err: unknown) => setWikiStatusState({ status: "error", message: friendlyMessage(err) }));
      })
      .catch((err: unknown) => setPickerError(friendlyMessage(err)));
  }, []);

  const handleBuildWiki = useCallback(() => {
    if (!projectDir) return;
    setProgress([]);
    setBuildState({ status: "building" });
    engineClient
      .wikiBuild(projectDir)
      .then((stats) => setBuildState({ status: "done", stats }))
      .catch((err: unknown) => setBuildState({ status: "error", message: friendlyMessage(err) }));
  }, [projectDir]);

  return (
    <section className="screen">
      <h1>Project</h1>
      <p>Open a project, check its wiki status, and build the wiki index. Harness generation arrives in a later milestone.</p>

      <h2>Configured model providers</h2>
      {providersState.status === "loading" && <p role="status">Loading…</p>}
      {providersState.status === "error" && (
        <p role="alert" className="error-text">
          {providersState.message}
        </p>
      )}
      {providersState.status === "ready" &&
        (providersState.providers.length === 0 ? (
          <p>No providers configured yet.</p>
        ) : (
          <ul>
            {providersState.providers.map((provider) => (
              <li key={provider.id}>
                {provider.id} ({provider.kind})
              </li>
            ))}
          </ul>
        ))}

      <h2>Workspace</h2>
      <button type="button" onClick={handleChooseProject}>
        Choose project…
      </button>
      {pickerError && (
        <p role="alert" className="error-text">
          {pickerError}
        </p>
      )}
      {projectDir && (
        <>
          <p>
            <code>{projectDir}</code>
          </p>
          {wikiStatusState.status === "loading" && <p role="status">Checking wiki status…</p>}
          {wikiStatusState.status === "error" && (
            <p role="alert" className="error-text">
              {wikiStatusState.message}
            </p>
          )}
          {wikiStatusState.status === "ready" && (
            <p className="muted-text">
              {!wikiStatusState.wiki.built
                ? "Wiki not built yet."
                : wikiStatusState.wiki.stale
                  ? "Wiki built, but stale — HEAD has moved since the last build."
                  : "Wiki built and up to date."}
            </p>
          )}

          <h2>Wiki</h2>
          <button type="button" onClick={handleBuildWiki} disabled={buildState.status === "building"}>
            Build wiki
          </button>

          {buildState.status === "building" && (
            <div role="status">
              <p>Building…</p>
              {progress.length > 0 && (
                <ul>
                  {progress.map((entry) => (
                    <li key={entry.key}>{entry.text}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {buildState.status === "done" && (
            <dl>
              <dt>Files indexed</dt>
              <dd>{buildState.stats.filesIndexed}</dd>
              <dt>Files skipped</dt>
              <dd>{buildState.stats.filesSkipped}</dd>
              <dt>Symbols</dt>
              <dd>{buildState.stats.symbols}</dd>
              <dt>References</dt>
              <dd>{buildState.stats.refs}</dd>
            </dl>
          )}

          {buildState.status === "error" && (
            <p role="alert" className="error-text">
              {buildState.message}
            </p>
          )}
        </>
      )}
    </section>
  );
}
