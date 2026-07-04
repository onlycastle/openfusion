import { useEffect, useState } from "react";
import { EngineError, engineClient, type ModelProviderSummary } from "../engineClient";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; providers: ModelProviderSummary[] };

/** Foundation placeholder for the Project screen — the real project
 * workspace (directory picker, wiki build/status, harness generation) is
 * Task 6. This exercises `engineClient.modelsList()` end to end (webview ->
 * `engine_call` -> sidecar -> back) with a real loading/error/ready state
 * machine, so the pattern is already proven before Task 6 builds on it. */
export function ProjectScreen() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    engineClient
      .modelsList()
      .then((result) => {
        if (!cancelled) setState({ status: "ready", providers: result.providers });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof EngineError ? `[${err.code}] ${err.message}` : String(err);
        setState({ status: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="screen">
      <h1>Project</h1>
      <p>Project workspace — the full cockpit (open a project, build the wiki, generate a harness) arrives in Task 6.</p>
      <h2>Configured model providers</h2>
      {state.status === "loading" && <p role="status">Loading…</p>}
      {state.status === "error" && (
        <p role="alert" className="error-text">
          Error: {state.message}
        </p>
      )}
      {state.status === "ready" &&
        (state.providers.length === 0 ? (
          <p>No providers configured yet.</p>
        ) : (
          <ul>
            {state.providers.map((provider) => (
              <li key={provider.id}>
                {provider.id} ({provider.kind})
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
