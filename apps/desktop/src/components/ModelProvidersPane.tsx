import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  deleteProviderConfig,
  deleteSecret,
  engineClient,
  listProviderConfigs,
  saveProviderConfig,
  setSecret,
  type ProviderKind,
  type ProviderMeta,
} from "../engineClient";
import { PROVIDER_PRESETS, presetFor } from "../providerCatalog";

function friendlyMessage(err: unknown): string {
  if (typeof err === "string" && err.trim().length > 0) return err;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return "Something went wrong. Please try again.";
}

interface ConfiguredRow {
  id: string;
  kind: string;
  model?: string;
  baseURL?: string;
}

/** The BYOK model-providers pane: a list of configured providers and a form
 * to add one. Saving both configures the engine provider (live) and stores
 * the key (Keychain iff persist); persisted providers also record non-secret
 * metadata so they re-register on the next launch. The key value is written
 * only into `setSecret`/`modelsConfigure` — never rendered. */
export function ModelProvidersPane() {
  const [rows, setRows] = useState<ConfiguredRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [kind, setKind] = useState<ProviderKind>("deepseek");
  const preset = useMemo(() => presetFor(kind), [kind]);
  const [model, setModel] = useState<string>(preset.models[0] ?? "");
  const [baseURL, setBaseURL] = useState<string>(preset.defaultBaseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [persist, setPersist] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setListError(null);
    Promise.all([engineClient.modelsList(), listProviderConfigs()])
      .then(([live, metas]) => {
        const metaById = new Map<string, ProviderMeta>(metas.map((m) => [m.id, m]));
        setRows(
          live.providers.map((p) => ({
            id: p.id,
            kind: p.kind,
            model: metaById.get(p.id)?.model,
            baseURL: p.baseURL,
          })),
        );
      })
      .catch((err: unknown) => {
        setRows([]);
        setListError(friendlyMessage(err));
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // When the provider kind changes, reset model + base URL to that preset's
  // defaults so the form never carries a stale value from the previous kind.
  const onKindChange = useCallback((next: ProviderKind) => {
    setKind(next);
    const p = presetFor(next);
    setModel(p.models[0] ?? "");
    setBaseURL(p.defaultBaseURL ?? "");
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!model.trim() || !apiKey) return;
      const effectiveBaseURL = preset.baseURLHidden ? undefined : baseURL.trim() || undefined;
      if (preset.baseURLRequired && !effectiveBaseURL) {
        setFormError("This provider needs a base URL.");
        return;
      }
      const id = kind; // one provider per kind in v1
      setSubmitting(true);
      setFormError(null);
      setSecret(id, apiKey, persist)
        .then(() => engineClient.modelsConfigure({ id, kind, apiKey, baseURL: effectiveBaseURL }))
        .then(() => (persist ? saveProviderConfig({ id, kind, baseURL: effectiveBaseURL, model }) : Promise.resolve()))
        .then(() => {
          setApiKey("");
          setPersist(false);
          reload();
        })
        .catch((err: unknown) => setFormError(friendlyMessage(err)))
        .finally(() => setSubmitting(false));
    },
    [apiKey, baseURL, kind, model, persist, preset, reload],
  );

  const handleRemove = useCallback(
    (id: string) => {
      Promise.all([deleteSecret(id), deleteProviderConfig(id)])
        .then(reload)
        .catch((err: unknown) => setListError(friendlyMessage(err)));
    },
    [reload],
  );

  return (
    <section className="settings-pane settings-pane-divided">
      <h2 className="settings-section-title">Model providers</h2>
      <p className="settings-lede">Your bring-your-own-key workers. Add one to route work to cheaper models.</p>

      {listError && (
        <p role="alert" className="error-text">
          {listError}
        </p>
      )}
      {rows === null && <p role="status">Loading…</p>}
      {rows !== null &&
        (rows.length === 0 ? (
          <p className="settings-empty">No model providers yet. Add one below.</p>
        ) : (
          <ul className="key-list">
            {rows.map((row) => (
              <li key={row.id}>
                <code className="key-id">{row.id}</code>
                <span className="key-status">{row.model ?? row.kind}</span>
                <button type="button" className="key-delete" onClick={() => handleRemove(row.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ))}

      <form className="key-form" onSubmit={handleSubmit}>
        <h3 className="settings-subsection-title">Add a provider</h3>

        <label htmlFor="provider-kind">Provider</label>
        <select id="provider-kind" value={kind} onChange={(e) => onKindChange(e.target.value as ProviderKind)}>
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.kind} value={p.kind}>
              {p.label}
            </option>
          ))}
        </select>

        <label htmlFor="provider-model">Model</label>
        {preset.models.length > 0 ? (
          <select id="provider-model" value={model} onChange={(e) => setModel(e.target.value)}>
            {preset.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              id="provider-model"
              list="provider-model-suggestions"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="model id"
            />
            <datalist id="provider-model-suggestions">
              {(preset.modelSuggestions ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </>
        )}

        {!preset.baseURLHidden && (
          <>
            <label htmlFor="provider-base-url">Base URL{preset.baseURLRequired ? "" : " (optional)"}</label>
            <input id="provider-base-url" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://…" />
          </>
        )}

        <label htmlFor="provider-key">API key</label>
        {/* Write-only: never pre-filled, cleared on success. */}
        <input id="provider-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />

        <label className="key-persist">
          <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
          Save this key in the macOS Keychain (off: memory-only for this session)
        </label>

        {formError && (
          <p role="alert" className="error-text">
            {formError}
          </p>
        )}
        <button type="submit" disabled={submitting}>
          Save
        </button>
      </form>
    </section>
  );
}
