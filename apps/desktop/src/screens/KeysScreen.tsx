import { useCallback, useEffect, useState, type FormEvent } from "react";
import { deleteSecret, listSecretIds, setSecret } from "../engineClient";

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; ids: string[] };

// Suggestions only (a `<datalist>`, not a constrained `<select>`) — the
// secret `id` a caller passes to `set_secret`/`get_secret` is an arbitrary
// BYOK provider key, not a model id, so there is no "correct" fixed set to
// enforce here. These are provider KINDS (matching
// `packages/engine/src/models/providers.ts`'s `ProviderConfigSchema.kind`
// enum, plus "anthropic" for the external CLI's own key), never specific
// model ids — so the "use deepseek-v4-flash/-pro, not the retiring
// deepseek-chat/-reasoner aliases" concern doesn't apply to this field at
// all (that's a MODEL id distinction; nothing in this screen ever
// hardcodes a model id, retiring or otherwise).
const SUGGESTED_PROVIDER_IDS = ["anthropic", "openai", "deepseek", "moonshot", "zai"];

/** Renders an unknown rejection (a plain string from a Rust `Result<(),
 * String>` command, or occasionally an `Error`/other value) as a short,
 * user-facing sentence — never a stack trace. */
function friendlyMessage(err: unknown): string {
  if (typeof err === "string" && err.trim().length > 0) return err;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return "Something went wrong. Please try again.";
}

/** The Keys (BYOK) screen: list configured provider secret ids (ids only,
 * NEVER a value — this component never calls `getSecret` at all, so there
 * is no value to accidentally render), add/edit a key via a write-only
 * value field, and delete a key.
 *
 * The persist toggle DEFAULTS TO OFF (memory-only for this process's
 * lifetime) on every render of the add form, including right after a
 * successful submit — a user must actively opt in to Keychain persistence
 * on every key they add, not just the first one. */
export function KeysScreen() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [newId, setNewId] = useState("");
  const [newValue, setNewValue] = useState("");
  const [persist, setPersist] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    listSecretIds()
      .then((ids) => setState({ status: "ready", ids }))
      .catch((err: unknown) => setState({ status: "error", message: friendlyMessage(err) }));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleAdd = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!newId.trim() || !newValue) return;
      setSubmitting(true);
      setFormError(null);
      setSecret(newId.trim(), newValue, persist)
        .then(() => {
          setNewId("");
          setNewValue("");
          setPersist(false);
          reload();
        })
        .catch((err: unknown) => setFormError(friendlyMessage(err)))
        .finally(() => setSubmitting(false));
    },
    [newId, newValue, persist, reload],
  );

  const handleDelete = useCallback(
    (id: string) => {
      setRowError(null);
      deleteSecret(id)
        .then(reload)
        .catch((err: unknown) => setRowError(friendlyMessage(err)));
    },
    [reload],
  );

  return (
    <section className="screen">
      <h1>Keys</h1>
      <p>Bring-your-own-key provider credentials, held in memory by default (opt in to save them to the OS Keychain).</p>

      <h2>Saved keys</h2>
      {state.status === "loading" && <p role="status">Loading…</p>}
      {state.status === "error" && (
        <p role="alert" className="error-text">
          {state.message}
        </p>
      )}
      {rowError && (
        <p role="alert" className="error-text">
          {rowError}
        </p>
      )}
      {state.status === "ready" &&
        (state.ids.length === 0 ? (
          <p>No keys set yet.</p>
        ) : (
          <ul>
            {state.ids.map((id) => (
              <li key={id}>
                <strong>{id}</strong> <span className="muted-text">configured</span>{" "}
                <button type="button" onClick={() => handleDelete(id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        ))}

      <h2>Add a key</h2>
      <form onSubmit={handleAdd}>
        <label>
          Provider id
          <input
            list="keys-provider-suggestions"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="anthropic"
          />
        </label>
        <datalist id="keys-provider-suggestions">
          {SUGGESTED_PROVIDER_IDS.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <label>
          Value
          {/* Write-only: a password field that is NEVER pre-filled from a
           * stored secret (this component never fetches one), and is
           * cleared immediately on every successful submit below. */}
          <input type="password" value={newValue} onChange={(e) => setNewValue(e.target.value)} autoComplete="off" />
        </label>
        <label>
          <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
          Remember this key in the macOS Keychain (off = memory-only for this session)
        </label>
        {formError && (
          <p role="alert" className="error-text">
            {formError}
          </p>
        )}
        <button type="submit" disabled={submitting}>
          Add
        </button>
      </form>
    </section>
  );
}
