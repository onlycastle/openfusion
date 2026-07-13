import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { Spinner } from "../ui/Spinner";
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

interface ModelProvidersPaneProps {
  onSettingsChanged?: () => void;
}

/** The BYOK model-providers pane: a list of configured providers and a form
 * to add one. Saving both configures the engine provider (live) and stores
 * the key (Keychain iff persist); persisted providers also record non-secret
 * metadata so they re-register on the next launch. The key value crosses
 * only the connection-check, secret-store, and configure calls — it is never
 * rendered or logged. */
export function ModelProvidersPane({ onSettingsChanged }: ModelProvidersPaneProps = {}) {
  const [rows, setRows] = useState<ConfiguredRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [kind, setKind] = useState<ProviderKind>("deepseek");
  const preset = useMemo(() => presetFor(kind), [kind]);
  const [model, setModel] = useState<string>(preset.models[0] ?? "");
  const [baseURL, setBaseURL] = useState<string>(preset.defaultBaseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [persist, setPersist] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissionStage, setSubmissionStage] = useState<"idle" | "checking" | "saving">("idle");
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

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
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!model.trim()) return;
      if (!apiKey) {
        setFormError("Enter an API key.");
        return;
      }
      const effectiveBaseURL = preset.baseURLHidden ? undefined : baseURL.trim() || undefined;
      if (preset.baseURLRequired && !effectiveBaseURL) {
        setFormError("This provider needs a base URL.");
        return;
      }
      const id = kind; // one provider per kind in v1
      setSubmitting(true);
      setSubmissionStage("checking");
      setFormError(null);
      setSuccessMessage(null);

      try {
        // This is a real, minimal model request against a scratch provider.
        // Nothing is saved or registered for routing until it succeeds.
        await engineClient.modelsCheckConnection(
          { id, kind, apiKey, baseURL: effectiveBaseURL, model },
          { timeoutMs: 20_000 },
        );
        setSubmissionStage("saving");
        await setSecret(id, apiKey, persist);
        await engineClient.modelsConfigure({ id, kind, apiKey, baseURL: effectiveBaseURL });
        if (persist) {
          await saveProviderConfig({ id, kind, baseURL: effectiveBaseURL, model });
        }

        setApiKey("");
        setPersist(false);
        setFormError(null);
        setSuccessMessage(`${preset.label} connection verified. ${model} is ready as a worker model.`);
        setAddOpen(false);
        onSettingsChanged?.();
        reload();
      } catch (err) {
        setFormError(friendlyMessage(err));
      } finally {
        setSubmitting(false);
        setSubmissionStage("idle");
      }
    },
    [apiKey, baseURL, kind, model, onSettingsChanged, persist, preset, reload],
  );

  const handleRemove = useCallback(
    (id: string) => {
      // Optimistically drop the row while all three stores are cleared: the
      // live engine registry, session/Keychain secret, and persisted metadata.
      setRemoving(true);
      setRows((prev) => (prev === null ? prev : prev.filter((r) => r.id !== id)));
      Promise.all([engineClient.modelsUnconfigure(id), deleteSecret(id), deleteProviderConfig(id)])
        .then(() => {
          setRemoveId(null);
          onSettingsChanged?.();
        })
        .catch((err: unknown) => {
          setRemoveId(null);
          reload();
          setListError(friendlyMessage(err));
        })
        .finally(() => setRemoving(false));
    },
    [onSettingsChanged, reload],
  );

  const resetForm = useCallback(() => {
    const nextPreset = presetFor("deepseek");
    setKind("deepseek");
    setModel(nextPreset.models[0] ?? "");
    setBaseURL(nextPreset.defaultBaseURL ?? "");
    setApiKey("");
    setPersist(false);
    setFormError(null);
  }, []);

  const formDirty = apiKey.length > 0 || persist || kind !== "deepseek" || model !== (presetFor("deepseek").models[0] ?? "");

  const requestCloseAdd = useCallback(() => {
    if (submitting) return;
    if (formDirty) {
      setDiscardOpen(true);
      return;
    }
    setAddOpen(false);
    resetForm();
  }, [formDirty, resetForm, submitting]);

  return (
    <section className="settings-pane settings-pane-divided">
      <h2 className="settings-section-title">Worker models</h2>
      <p className="settings-lede">Add bring-your-own-key models that implement and test routed tasks. Keys stay write-only and can be stored in macOS Keychain.</p>

      {listError && (
        <p role="alert" className="error-text">
          {listError}
        </p>
      )}
      {successMessage && (
        <p role="status" className="settings-success">
          <span className="settings-success-dot" aria-hidden="true" />
          {successMessage}
        </p>
      )}
      {rows === null && <p role="status" className="settings-loading"><Spinner label="Loading worker models" /> Loading worker models…</p>}
      {rows !== null &&
        (rows.length === 0 ? (
          <div className="settings-empty">
            <p>No worker models yet</p>
            <span>Add a worker model to implement suitable tasks before lead model review.</span>
          </div>
        ) : (
          <ul className="key-list">
            {rows.map((row) => (
              <li key={row.id}>
                <code className="key-id">{row.id}</code>
                <span className="key-status">{row.model ?? row.kind}</span>
                <button type="button" className="key-delete" aria-label={`Remove ${row.id}`} title={`Remove ${row.id}`} onClick={() => setRemoveId(row.id)}>
                  <Icon name="trash" size={16} />
                </button>
              </li>
            ))}
          </ul>
        ))}

      <button type="button" className="settings-add-button" onClick={() => { setSuccessMessage(null); setAddOpen(true); }}>
        <Icon name="add" /> Add Worker Model…
      </button>

      <Dialog
        open={addOpen && !discardOpen}
        title="Add Worker Model"
        description="Connect a model for routed implementation work. OpenFusion never displays a saved API key again."
        onClose={requestCloseAdd}
        dismissOnBackdrop={false}
        size="medium"
        footer={
          <>
            <button type="button" onClick={requestCloseAdd} disabled={submitting}>Cancel</button>
            <button type="submit" form="provider-form" className="ui-button-primary" disabled={submitting || !apiKey || !model.trim()}>
              {submissionStage === "checking" ? "Checking…" : submissionStage === "saving" ? "Adding…" : "Add Worker Model"}
            </button>
          </>
        }
      >
      <form id="provider-form" className="key-form provider-sheet-form" onSubmit={handleSubmit} aria-busy={submitting}>

        <label htmlFor="provider-kind">Provider</label>
        <select id="provider-kind" autoFocus value={kind} disabled={submitting} onChange={(e) => onKindChange(e.target.value as ProviderKind)}>
          {PROVIDER_PRESETS.map((p) => (
            <option key={p.kind} value={p.kind}>
              {p.label}
            </option>
          ))}
        </select>

        <label htmlFor="provider-model">Model</label>
        {preset.models.length > 0 ? (
          <select id="provider-model" value={model} disabled={submitting} onChange={(e) => setModel(e.target.value)}>
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
              disabled={submitting}
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

        <label htmlFor="provider-key">API key</label>
        {/* Write-only: never pre-filled, cleared on success. */}
        <input id="provider-key" type="password" value={apiKey} disabled={submitting} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />

        <label className="key-persist">
          <input type="checkbox" checked={persist} disabled={submitting} onChange={(e) => setPersist(e.target.checked)} />
          <span><strong>Save to macOS Keychain</strong><small>When off, the key is available for this session only.</small></span>
        </label>

        {!preset.baseURLHidden && (
          <details className="provider-advanced" open={preset.baseURLRequired}>
            <summary>Advanced</summary>
            <label htmlFor="provider-base-url">Base URL{preset.baseURLRequired ? "" : " (optional)"}</label>
            <input id="provider-base-url" value={baseURL} disabled={submitting} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://…" />
          </details>
        )}

        {formError && (
          <p role="alert" className="error-text">
            {formError}
          </p>
        )}
        {submissionStage === "checking" && (
          <p role="status" className="provider-checking">
            <Spinner label="Checking provider connection" />
            Checking the API key, endpoint, and model with a small request…
          </p>
        )}
      </form>
      </Dialog>

      <ConfirmDialog
        open={discardOpen}
        title="Discard this provider?"
        description="The API key and other unsaved details will be cleared."
        confirmLabel="Discard"
        cancelLabel="Keep Editing"
        destructive
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          setDiscardOpen(false);
          setAddOpen(false);
          resetForm();
        }}
      />

      <ConfirmDialog
        open={removeId !== null}
        title={`Remove ${removeId ?? "provider"}?`}
        description="The saved key will be deleted. Project agents routed to this provider may stop working until you choose another model."
        confirmLabel="Remove"
        destructive
        busy={removing}
        onCancel={() => setRemoveId(null)}
        onConfirm={() => { if (removeId) handleRemove(removeId); }}
      />
    </section>
  );
}
