import { useCallback, useEffect, useState, type FormEvent } from "react";
import { deleteSecret, listSecretIds, setSecret } from "../engineClient";

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; ids: string[] };

/** Foundation placeholder for the Keys (BYOK) screen — the full key
 * management UI (per-provider setup flows, validation) is Task 6. This
 * wires the real secret commands end to end: list ids, add one, delete one.
 * The secret VALUE typed into the form is sent to `setSecret` and never
 * retained or displayed anywhere in this component afterward — only ids
 * are ever rendered. */
export function KeysScreen() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [newId, setNewId] = useState("");
  const [newValue, setNewValue] = useState("");
  const [persist, setPersist] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(() => {
    setState({ status: "loading" });
    listSecretIds()
      .then((ids) => setState({ status: "ready", ids }))
      .catch((err: unknown) => setState({ status: "error", message: String(err) }));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleAdd = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!newId.trim() || !newValue) return;
      setSubmitting(true);
      setSecret(newId.trim(), newValue, persist)
        .then(() => {
          setNewId("");
          setNewValue("");
          setPersist(false);
          reload();
        })
        .catch((err: unknown) => setState({ status: "error", message: String(err) }))
        .finally(() => setSubmitting(false));
    },
    [newId, newValue, persist, reload],
  );

  const handleDelete = useCallback(
    (id: string) => {
      deleteSecret(id)
        .then(reload)
        .catch((err: unknown) => setState({ status: "error", message: String(err) }));
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
          Error: {state.message}
        </p>
      )}
      {state.status === "ready" &&
        (state.ids.length === 0 ? (
          <p>No keys set yet.</p>
        ) : (
          <ul>
            {state.ids.map((id) => (
              <li key={id}>
                {id}{" "}
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
          <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="anthropic" />
        </label>
        <label>
          Value
          <input type="password" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
        </label>
        <label>
          <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
          Save to Keychain
        </label>
        <button type="submit" disabled={submitting}>
          Add
        </button>
      </form>
    </section>
  );
}
