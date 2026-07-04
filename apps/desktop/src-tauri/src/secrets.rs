//! macOS Keychain BYOK (bring-your-own-key) secret store.
//!
//! ## The flow (why this module exists, and where it sits in the pipeline)
//!
//! Open-model provider API keys (OpenAI, Anthropic-via-API, etc. — the
//! "BYOK" keys, as opposed to the external `claude`/`codex` CLIs which
//! handle their own auth) are entered by the user in the cockpit UI. They
//! land here, in the Rust-owned [`SecretStore`], **memory-only by default**.
//! The UI reads them back out via the `get_secret` command to forward into
//! an engine call (a future `models.configure`-shaped JSON-RPC call — see
//! `commands.rs`'s `engine_call`); this module never talks to the engine
//! itself. The engine (`packages/engine`) receives whatever key the UI
//! forwards it *per call*, over JSON-RPC, and keeps it memory-only on its
//! own side too — that contract is unchanged by this task. This task is
//! purely the **shell**'s (Rust host's) secret storage: memory-default,
//! with an explicit per-secret opt-in to Keychain persistence so the key
//! survives an app restart without the user re-typing it.
//!
//! ```text
//! cockpit UI --invoke(set_secret)--> SecretStore (memory always;
//!                                     Keychain iff persist=true)
//! cockpit UI --invoke(get_secret)--> SecretStore --> engine_call(models.configure, {apiKey})
//!                                                     (engine: memory-only, per-call, unchanged)
//! ```
//!
//! ## Backend abstraction: `KeyringBackend`
//!
//! All Keychain I/O goes through the [`KeyringBackend`] trait rather than
//! calling the `keyring` crate directly from [`SecretStore`]. This is the
//! seam that makes every persistence-logic path (write-through, the
//! opted-in index, restart-reload) `cargo test`-able with zero real
//! Keychain access: [`FakeKeyringBackend`] (`#[cfg(test)]`) is a
//! `Mutex<HashMap>` standing in for the platform Keychain, and every test
//! below drives [`SecretStore`] against it. [`KeyringImpl`] is the real
//! backend (thin wrapper over the `keyring` crate's classic `Entry` API,
//! `apple-native` feature, which wraps the macOS Security framework
//! directly); it is exercised only by the `#[ignore]`d operator-smoke test
//! at the bottom of this file (see that test's doc comment) and in the
//! packaged app itself — never in the default `cargo test` run, since CI
//! has no login keychain to unlock.
//!
//! **Crate version note**: this pins `keyring = "3.6.3"` rather than the
//! newer `4.1.3` line. `4.1.3`'s classic-API compat shim (its `v1` feature,
//! the same `Entry::new`/`set_password`/`get_password`/`delete_credential`
//! surface used here) has a verified, reproducible bug: `v1.rs`'s
//! lazy-init guard is `if SET_CREDENTIAL_STORE.compare_exchange(false,
//! true, ..) == Ok(true)` — but a *successful* first-call swap returns
//! `Ok(false)` (the previous value), and a failing (already-initialized)
//! swap returns `Err(true)`; `Ok(true)` is therefore unreachable, so the
//! backing platform store is never installed and every `Entry::new` fails
//! at first use with "No default store has been set". This was confirmed
//! directly against the installed `4.1.3` crate (including via its own
//! `examples/v1/main.rs`, which hits the identical failure) before falling
//! back to the last `3.x` release, whose `Entry` talks to the platform
//! credential store directly with no such indirection and was verified
//! working end-to-end against the real Keychain (see the operator-smoke
//! test). The `KeyringBackend` trait fully insulates the rest of this
//! module from this choice — swapping the pinned version back to `4.x` if
//! upstream fixes it later only touches [`KeyringImpl`].
//!
//! ## The opted-in-persisted-ids index (surviving a restart)
//!
//! `get_secret`/`load_persisted_secrets` need to know, after a fresh
//! process start (empty memory map), *which* ids were previously persisted
//! — otherwise there's no way to know which Keychain entries (if any) to
//! read back without guessing ids or scanning the whole Keychain (which
//! `keyring`/the Security framework does not offer a portable way to do —
//! entries are looked up by exact service+account, not enumerated). This
//! module solves that with an **index entry**: a reserved id
//! ([`PERSISTED_INDEX_ID`], `__persisted_ids__`) stored in the *same*
//! backend, holding a JSON array of the real opted-in ids. `set(..., persist:
//! true)` write-throughs the secret itself AND rewrites this index (adding
//! the id); `delete` removes the id from both the secret entry and the
//! index. `load_persisted_secrets` reads the index first, then reads each
//! listed id's entry and populates the memory map. This is the portable
//! mechanism the brief calls for — it doesn't depend on any
//! backend-specific enumeration API, so it works identically against the
//! fake in tests and the real Keychain in production.
//!
//! **The `persist` flag is authoritative per `set` call, not additive**:
//! `set(id, value, persist: false)` for an id CURRENTLY in this index
//! actively removes it (deletes the backend entry, drops it from the
//! index) rather than merely leaving the old persisted value stranded
//! behind a fresher in-memory one. This matters concretely for key
//! rotation — see [`SecretStore::set`]'s own doc comment for the failure
//! this closes.
//!
//! ## No-value-logging invariant
//!
//! Every diagnostic line in this module (`eprintln!`) carries ids or error
//! *descriptions* only — never a secret's plaintext value. `list_secret_ids`
//! returns ids only (never a value, in a list or a log). This is checked
//! mechanically by `no_value_logging_in_module_source` below, which greps
//! this file's own source for the interpolation patterns that would leak a
//! `value`/`password` local into a log line.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tauri::State;

/// Keychain (or other backend) service name every entry is stored under.
/// Matches the app's own identifier (`tauri.conf.json`'s `identifier`) so
/// Keychain Access shows entries grouped under a recognizable, stable name.
pub const SERVICE_NAME: &str = "net.originlayer.openfusion";

/// Reserved id for the JSON-array index of opted-in-persisted secret ids
/// (see module doc's "opted-in-persisted-ids index" section). Chosen to be
/// syntactically distinguishable from any real provider/secret id a caller
/// would pass to `set_secret` (leading/trailing dunder), so it can never
/// collide with a legitimate id.
const PERSISTED_INDEX_ID: &str = "__persisted_ids__";

/// Abstraction over a Keychain-shaped key/value secret backend: set, get,
/// delete, by id. [`KeyringImpl`] is the real macOS Keychain (via the
/// `keyring` crate); [`FakeKeyringBackend`] (test-only) is an in-memory
/// stand-in. [`SecretStore`] is written entirely against this trait, so its
/// persistence logic is exercised by `cargo test` with the fake — no real
/// Keychain access needed to cover it.
pub trait KeyringBackend: Send + Sync {
    /// Write `value` under `id`, creating or overwriting the entry.
    fn set(&self, id: &str, value: &str) -> Result<(), String>;
    /// Read the value stored under `id`, or `Ok(None)` if no such entry
    /// exists. Never panics on a missing entry.
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    /// Remove the entry stored under `id`. A missing entry is not an error
    /// (deleting something already gone is a no-op success).
    fn delete(&self, id: &str) -> Result<(), String>;
}

/// The real backend: macOS Keychain via the `keyring` crate's `v1` (`Entry`)
/// API, which itself dispatches to `apple-native-keyring-store` (Security
/// framework) on macOS. Every entry lives under ([`SERVICE_NAME`], `id`).
///
/// Constructing an `Entry` does not itself touch the Keychain (it's a
/// lazy handle) — the actual Security-framework calls happen inside
/// `set_password`/`get_password`/`delete_credential`, which is why this
/// type is safe to construct freely (e.g. once per call) without a
/// perf or side-effect concern.
#[derive(Debug, Default, Clone, Copy)]
pub struct KeyringImpl;

impl KeyringImpl {
    pub fn new() -> Self {
        Self
    }

    fn entry(&self, id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE_NAME, id).map_err(|err| err.to_string())
    }
}

impl KeyringBackend for KeyringImpl {
    fn set(&self, id: &str, value: &str) -> Result<(), String> {
        self.entry(id)?.set_password(value).map_err(|err| err.to_string())
    }

    fn get(&self, id: &str) -> Result<Option<String>, String> {
        match self.entry(id)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.to_string()),
        }
    }
}

/// Session-plus-Keychain-backed secret store, held in Tauri managed state
/// as `Arc<SecretStore>`.
///
/// - `memory`: the session store. Every `set_secret` call lands here,
///   regardless of `persist`. This is the DEFAULT and, for a `persist:
///   false` secret, the *only* place the value ever lives — process exit
///   loses it, by design.
/// - `persisted_ids`: the in-memory mirror of the Keychain index (see
///   module doc). Tracks which ids are opted into persistence, so `get`
///   knows whether a memory-miss is worth a Keychain read, and so
///   `list_secret_ids` can report an id even before it's been loaded back
///   into memory this session.
/// - `backend`: the [`KeyringBackend`] (real or fake) all Keychain I/O goes
///   through.
pub struct SecretStore {
    memory: Mutex<HashMap<String, String>>,
    persisted_ids: Mutex<HashSet<String>>,
    backend: Arc<dyn KeyringBackend>,
}

impl SecretStore {
    /// `backend` is `Arc<dyn KeyringBackend>` (not `Box`) specifically so
    /// tests can hold their own clone of the *same* fake backend instance
    /// alongside the store, both to assert on its recorded calls and to
    /// construct a second `SecretStore` against it (simulating an app
    /// restart against the same Keychain).
    pub fn new(backend: Arc<dyn KeyringBackend>) -> Self {
        Self { memory: Mutex::new(HashMap::new()), persisted_ids: Mutex::new(HashSet::new()), backend }
    }

    fn memory_lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.memory.lock().expect("secret store memory mutex poisoned")
    }

    fn persisted_ids_lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.persisted_ids.lock().expect("secret store persisted-ids mutex poisoned")
    }

    /// Store `value` under `id` in the session memory map (always). The
    /// `persist` flag is AUTHORITATIVE for this call, not merely additive:
    ///
    /// - `persist: true` — ALSO write-through to the Keychain backend and
    ///   record `id` in the opted-in-persisted-ids index (so a future
    ///   `load_persisted_secrets` — e.g. after an app restart — knows to
    ///   reload it).
    /// - `persist: false` — if `id` was never previously persisted,
    ///   `backend` is untouched (unchanged from before). If `id` WAS
    ///   previously persisted (present in the opted-in index), this call
    ///   actively DE-PERSISTS it: the stale Keychain entry is deleted and
    ///   `id` is removed from the index. Without this, a memory-only
    ///   re-set of a previously-persisted id (e.g. rotating a key with the
    ///   persist toggle left at its default OFF) would silently leave the
    ///   OLD value sitting in the Keychain, which `load_persisted_secrets`
    ///   would then restore on the next app launch — feeding a rotated-out
    ///   key back into engine calls with no visible indication to the user.
    ///   See `set_persist_false_after_previous_persist_deletes_stale_backend_value_and_deindexes`
    ///   below.
    ///
    /// **Rejects the reserved sentinel id** (`PERSISTED_INDEX_ID`) to prevent
    /// caller-inflicted corruption of the backend's opted-in index.
    pub fn set(&self, id: &str, value: &str, persist: bool) -> Result<(), String> {
        if id == PERSISTED_INDEX_ID {
            return Err(format!("rejected reserved secret id {id:?}"));
        }
        self.memory_lock().insert(id.to_string(), value.to_string());
        if persist {
            self.backend.set(id, value)?;
            self.add_to_persisted_index(id)?;
        } else {
            // Authoritative de-persist: only when `id` was ALREADY opted
            // into persistence does a persist=false re-set touch the
            // backend at all -- a never-persisted id must still see zero
            // backend calls (see
            // set_persist_false_never_touches_backend_for_never_persisted_id).
            let was_persisted = self.persisted_ids_lock().contains(id);
            if was_persisted {
                self.backend.delete(id)?;
                self.remove_from_persisted_index(id)?;
            }
        }
        Ok(())
    }

    /// Memory first; if absent AND `id` was previously opted into
    /// persistence, fall back to the Keychain backend (populating memory
    /// on a hit, so subsequent calls are memory-fast). Returns `None` for
    /// an unknown id — never panics/throws.
    ///
    /// **Rejects the reserved sentinel id** (`PERSISTED_INDEX_ID`) to prevent
    /// caller access to the backend's opted-in index.
    pub fn get(&self, id: &str) -> Option<String> {
        if id == PERSISTED_INDEX_ID {
            return None;
        }
        if let Some(value) = self.memory_lock().get(id).cloned() {
            return Some(value);
        }
        if !self.persisted_ids_lock().contains(id) {
            return None;
        }
        match self.backend.get(id) {
            Ok(Some(value)) => {
                self.memory_lock().insert(id.to_string(), value.clone());
                Some(value)
            }
            Ok(None) => None,
            Err(err) => {
                // Metadata only: the id and the backend's error description,
                // never the secret value (we never got one back on this path).
                eprintln!("[secrets] backend get failed for id {id:?}: {err}");
                None
            }
        }
    }

    /// Remove `id` from the session memory map, the Keychain backend, and
    /// the opted-in-persisted-ids index. Safe to call for an id that was
    /// never persisted (the backend treats deleting a non-existent entry
    /// as a no-op success — see [`KeyringImpl::delete`]/
    /// [`FakeKeyringBackend`]).
    ///
    /// **Rejects the reserved sentinel id** (`PERSISTED_INDEX_ID`) to prevent
    /// caller deletion of the backend's opted-in index.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        if id == PERSISTED_INDEX_ID {
            return Err(format!("rejected reserved secret id {id:?}"));
        }
        self.memory_lock().remove(id);
        self.backend.delete(id)?;
        self.remove_from_persisted_index(id)?;
        Ok(())
    }

    /// All known secret ids — currently-loaded memory entries union
    /// opted-in-but-not-yet-reloaded persisted ids — sorted for a stable
    /// UI listing. **Ids only, never values**: nothing in this function
    /// (or anywhere else in this module) ever puts a secret's value into
    /// the returned `Vec`.
    pub fn list_ids(&self) -> Vec<String> {
        let mut ids: HashSet<String> = self.memory_lock().keys().cloned().collect();
        ids.extend(self.persisted_ids_lock().iter().cloned());
        let mut ids: Vec<String> = ids.into_iter().collect();
        ids.sort();
        ids
    }

    /// On startup (or whenever invoked): read the opted-in-persisted-ids
    /// index from the backend, then read each listed id's entry and
    /// populate the memory map. Best-effort — a missing index, a missing
    /// individual entry, or a backend error is logged (id/metadata only)
    /// and skipped rather than propagated, since a partial restore is
    /// strictly better than failing the whole app launch over one bad
    /// Keychain entry.
    pub fn load_persisted(&self) {
        let index = match self.backend.get(PERSISTED_INDEX_ID) {
            Ok(Some(json)) => match serde_json::from_str::<Vec<String>>(&json) {
                Ok(ids) => ids,
                Err(_) => {
                    eprintln!("[secrets] persisted-ids index was malformed; resetting to empty");
                    Vec::new()
                }
            },
            Ok(None) => Vec::new(),
            Err(err) => {
                eprintln!("[secrets] failed to load persisted-ids index: {err}");
                Vec::new()
            }
        };

        *self.persisted_ids_lock() = index.iter().cloned().collect();

        for id in &index {
            match self.backend.get(id) {
                Ok(Some(value)) => {
                    self.memory_lock().insert(id.clone(), value);
                }
                Ok(None) => {
                    eprintln!("[secrets] persisted id {id:?} missing from backend at load; skipping");
                }
                Err(err) => {
                    eprintln!("[secrets] failed to load persisted id {id:?}: {err}");
                }
            }
        }
    }

    fn add_to_persisted_index(&self, id: &str) -> Result<(), String> {
        let mut ids = self.persisted_ids_lock();
        ids.insert(id.to_string());
        self.write_persisted_index(&ids)
    }

    fn remove_from_persisted_index(&self, id: &str) -> Result<(), String> {
        let mut ids = self.persisted_ids_lock();
        if ids.remove(id) {
            self.write_persisted_index(&ids)
        } else {
            Ok(())
        }
    }

    fn write_persisted_index(&self, ids: &HashSet<String>) -> Result<(), String> {
        let mut sorted: Vec<&String> = ids.iter().collect();
        sorted.sort();
        let json = serde_json::to_string(&sorted).map_err(|err| err.to_string())?;
        self.backend.set(PERSISTED_INDEX_ID, &json)
    }
}

/// `invoke('set_secret', { id, value, persist })`. See [`SecretStore::set`].
#[tauri::command]
pub fn set_secret(state: State<'_, Arc<SecretStore>>, id: String, value: String, persist: bool) -> Result<(), String> {
    state.inner().set(&id, &value, persist)
}

/// `invoke('get_secret', { id })`. See [`SecretStore::get`]. This is what
/// the cockpit UI calls to pull a key back out before forwarding it into
/// an `engine_call` (e.g. a future `models.configure`).
#[tauri::command]
pub fn get_secret(state: State<'_, Arc<SecretStore>>, id: String) -> Option<String> {
    state.inner().get(&id)
}

/// `invoke('delete_secret', { id })`. See [`SecretStore::delete`].
#[tauri::command]
pub fn delete_secret(state: State<'_, Arc<SecretStore>>, id: String) -> Result<(), String> {
    state.inner().delete(&id)
}

/// `invoke('list_secret_ids')`. See [`SecretStore::list_ids`]. Returns ids
/// only — never values — for populating a "your saved keys" UI list.
#[tauri::command]
pub fn list_secret_ids(state: State<'_, Arc<SecretStore>>) -> Vec<String> {
    state.inner().list_ids()
}

/// `invoke('load_persisted_secrets')`. See [`SecretStore::load_persisted`].
/// Also called once, directly (not through `invoke`), from `lib.rs`'s
/// `.setup()` so persisted keys are already in memory before the webview
/// ever asks — exposed as a command too so the frontend can force a
/// reload (e.g. after an external Keychain change) without relaunching.
#[tauri::command]
pub fn load_persisted_secrets(state: State<'_, Arc<SecretStore>>) {
    state.inner().load_persisted();
}

#[cfg(test)]
/// In-memory stand-in for the platform Keychain: a `Mutex<HashMap>` behind
/// the same [`KeyringBackend`] trait `SecretStore` uses. `set_call_ids`
/// records every id `set` was called with, and `delete_call_ids` records
/// every id `delete` was called with (ids only — even in test spy state,
/// values are never retained anywhere they don't need to be) so tests can
/// assert on *whether* the backend was written to or deleted from without
/// depending on internal storage layout.
#[derive(Default)]
pub struct FakeKeyringBackend {
    store: Mutex<HashMap<String, String>>,
    pub set_call_ids: Mutex<Vec<String>>,
    pub delete_call_ids: Mutex<Vec<String>>,
}

#[cfg(test)]
impl FakeKeyringBackend {
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
impl KeyringBackend for FakeKeyringBackend {
    fn set(&self, id: &str, value: &str) -> Result<(), String> {
        self.set_call_ids.lock().expect("fake backend set_call_ids mutex poisoned").push(id.to_string());
        self.store.lock().expect("fake backend store mutex poisoned").insert(id.to_string(), value.to_string());
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<String>, String> {
        Ok(self.store.lock().expect("fake backend store mutex poisoned").get(id).cloned())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        self.delete_call_ids.lock().expect("fake backend delete_call_ids mutex poisoned").push(id.to_string());
        self.store.lock().expect("fake backend store mutex poisoned").remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_store() -> (Arc<FakeKeyringBackend>, SecretStore) {
        let backend = Arc::new(FakeKeyringBackend::new());
        let store = SecretStore::new(backend.clone());
        (backend, store)
    }

    #[test]
    fn memory_round_trip_persist_false_never_touches_backend() {
        let (backend, store) = fake_store();

        store.set("openai", "sk-test-memory-only", false).expect("set should succeed");
        assert_eq!(store.get("openai"), Some("sk-test-memory-only".to_string()));

        store.delete("openai").expect("delete should succeed");
        assert_eq!(store.get("openai"), None);

        assert!(
            backend.set_call_ids.lock().expect("mutex").is_empty(),
            "persist=false must never call backend.set"
        );
    }

    #[test]
    fn persist_true_writes_backend_and_updates_index() {
        let (backend, store) = fake_store();

        store.set("anthropic", "sk-ant-persisted", true).expect("set should succeed");

        assert_eq!(
            backend.get("anthropic").expect("backend get should not error"),
            Some("sk-ant-persisted".to_string()),
            "persist=true must write-through to the backend"
        );
        assert!(backend.set_call_ids.lock().expect("mutex").contains(&"anthropic".to_string()));
        assert!(
            backend.set_call_ids.lock().expect("mutex").contains(&PERSISTED_INDEX_ID.to_string()),
            "persist=true must also update the opted-in-persisted-ids index"
        );

        let index_json = backend.get(PERSISTED_INDEX_ID).expect("index get should not error").expect("index should exist");
        let index: Vec<String> = serde_json::from_str(&index_json).expect("index should be a JSON string array");
        assert_eq!(index, vec!["anthropic".to_string()]);
    }

    #[test]
    fn set_persist_false_after_previous_persist_deletes_stale_backend_value_and_deindexes() {
        // The BYOK rotation footgun this test guards against: a user
        // persists `openai` = A, then later rotates the key and re-adds
        // `openai` = B with the persist toggle at its DEFAULT (OFF). This
        // session must use B (memory), but the fix under test here is that
        // the STALE A must not be left sitting in the backend/index, where
        // a future `load_persisted` would silently resurrect it.
        let (backend, store) = fake_store();

        store.set("openai", "sk-A-original", true).expect("initial persisted set should succeed");
        assert_eq!(
            backend.get("openai").expect("backend get should not error"),
            Some("sk-A-original".to_string()),
            "sanity: A must be persisted to the backend before rotation"
        );
        assert!(store.list_ids().contains(&"openai".to_string()), "sanity: openai must be in the opted-in index before rotation");

        // Rotate: re-set with persist=false (the toggle's default).
        store.set("openai", "sk-B-rotated", false).expect("rotation set should succeed");

        // This session must use B.
        assert_eq!(store.get("openai"), Some("sk-B-rotated".to_string()), "memory must hold the newly-rotated value B");

        // The stale A must be GONE from the backend, not merely shadowed by
        // the in-memory map.
        assert_eq!(
            backend.get("openai").expect("backend get should not error"),
            None,
            "de-persisting on rotation must delete the stale backend value, not leave A sitting in the Keychain"
        );

        // `openai` must no longer be in the opted-in-persisted index.
        let index_ids: Vec<String> = match backend.get(PERSISTED_INDEX_ID).expect("index get should not error") {
            Some(json) => serde_json::from_str(&json).expect("index should be valid JSON"),
            None => Vec::new(),
        };
        assert!(
            !index_ids.contains(&"openai".to_string()),
            "openai must be removed from the opted-in-persisted index after de-persisting, got {index_ids:?}"
        );

        // Simulated restart: a brand-new SecretStore against the SAME
        // backend must NOT resurrect A -- openai is no longer in the index,
        // so load_persisted has nothing to reload for it.
        let restarted = SecretStore::new(backend.clone());
        restarted.load_persisted();
        assert_eq!(
            restarted.get("openai"),
            None,
            "a restart must not resurrect the rotated-out stale value A -- the id was de-persisted, so nothing reloads for it"
        );
    }

    #[test]
    fn set_persist_false_never_touches_backend_for_never_persisted_id() {
        // Companion to the rotation test above: the de-persist delete path
        // must fire ONLY when the id was previously in the persisted index.
        // A plain memory-only set for an id that was never persisted must
        // still leave the backend completely untouched -- zero sets AND
        // zero deletes for that id.
        let (backend, store) = fake_store();

        store.set("never-persisted", "sk-memory-only", false).expect("set should succeed");
        assert_eq!(store.get("never-persisted"), Some("sk-memory-only".to_string()));

        assert!(
            !backend.set_call_ids.lock().expect("mutex").contains(&"never-persisted".to_string()),
            "persist=false on a never-persisted id must never call backend.set"
        );
        assert!(
            !backend.delete_call_ids.lock().expect("mutex").contains(&"never-persisted".to_string()),
            "persist=false on a never-persisted id must never call backend.delete either -- the de-persist \
             delete only fires when the id WAS previously in the opted-in index"
        );
    }

    #[test]
    fn get_secret_restores_persisted_value_after_simulated_restart() {
        let (backend, store) = fake_store();
        store.set("anthropic", "sk-ant-survives-restart", true).expect("set should succeed");

        // Simulate an app restart: a brand-new `SecretStore` (fresh, empty
        // memory map) against the SAME backend instance.
        let restarted = SecretStore::new(backend.clone());
        assert_eq!(restarted.get("anthropic"), None, "a fresh store has nothing in memory before loading");

        restarted.load_persisted();
        assert_eq!(restarted.get("anthropic"), Some("sk-ant-survives-restart".to_string()));
    }

    #[test]
    fn list_ids_returns_ids_only_never_values() {
        let (_backend, store) = fake_store();
        store.set("openai", "sk-openai-should-not-appear-in-list", false).expect("set should succeed");
        store.set("anthropic", "sk-anthropic-should-not-appear-in-list", true).expect("set should succeed");

        let ids = store.list_ids();
        assert_eq!(ids, vec!["anthropic".to_string(), "openai".to_string()]);
        for id in &ids {
            assert!(!id.starts_with("sk-"), "list_ids must never return a value, got {id:?}");
        }
    }

    #[test]
    fn delete_removes_from_both_memory_and_backend() {
        let (backend, store) = fake_store();
        store.set("openai", "sk-to-be-deleted", true).expect("set should succeed");
        assert!(backend.get("openai").expect("get should not error").is_some());

        store.delete("openai").expect("delete should succeed");

        assert_eq!(store.get("openai"), None, "must be gone from memory");
        assert_eq!(backend.get("openai").expect("get should not error"), None, "must be gone from the backend");
        assert!(!store.list_ids().contains(&"openai".to_string()), "must be gone from the opted-in index");
    }

    #[test]
    fn get_secret_for_unknown_id_returns_none_without_panicking() {
        let (_backend, store) = fake_store();
        assert_eq!(store.get("never-set"), None);
    }

    #[test]
    fn reserved_id_sentinel_attack_rejected() {
        let (backend, store) = fake_store();

        // Persist a legitimate secret first
        store.set("openai", "sk-openai-key", true).expect("set openai should succeed");
        let initial_index = backend.get(PERSISTED_INDEX_ID).expect("index get should not error").expect("index should exist");
        let initial_ids: Vec<String> = serde_json::from_str(&initial_index).expect("index should be valid JSON");
        assert_eq!(initial_ids, vec!["openai"], "initial index should contain only openai");

        // Attempt to set the reserved id with persist=true: must be rejected or no-op
        let set_result = store.set(PERSISTED_INDEX_ID, "malicious-value", true);
        assert!(
            set_result.is_err(),
            "set with reserved id must be rejected (return Err), not silently accepted"
        );

        // Verify the reserved id is NOT in the memory map
        assert_eq!(
            store.get(PERSISTED_INDEX_ID),
            None,
            "reserved id must not be readable from memory"
        );

        // Verify the persisted index was NOT overwritten: openai should still be there
        let after_attack_index = backend.get(PERSISTED_INDEX_ID).expect("index get should not error").expect("index should exist after attack");
        let after_attack_ids: Vec<String> = serde_json::from_str(&after_attack_index).expect("index should be valid JSON after attack");
        assert_eq!(
            after_attack_ids, initial_ids,
            "persisted index must not be corrupted by reserved-id attack"
        );

        // Simulate restart: verify openai still loads correctly
        let restarted = SecretStore::new(backend.clone());
        restarted.load_persisted();
        assert_eq!(
            restarted.get("openai"),
            Some("sk-openai-key".to_string()),
            "legitimate persisted secret must still survive after sentinel-attack attempt"
        );
    }

    #[test]
    fn reserved_id_get_rejected() {
        let (_backend, store) = fake_store();

        // get with reserved id must return None (the sentinel is not a real secret)
        let result = store.get(PERSISTED_INDEX_ID);
        assert_eq!(result, None, "get with reserved id must return None");
    }

    #[test]
    fn reserved_id_delete_rejected() {
        let (backend, store) = fake_store();

        // Persist a legitimate secret first
        store.set("openai", "sk-openai-key", true).expect("set openai should succeed");

        // Attempt to delete the reserved id: must be rejected or no-op
        let delete_result = store.delete(PERSISTED_INDEX_ID);
        assert!(
            delete_result.is_err(),
            "delete with reserved id must be rejected (return Err)"
        );

        // Verify the legitimate secret's index entry is still there
        let index = backend.get(PERSISTED_INDEX_ID).expect("index get should not error").expect("index should exist");
        let ids: Vec<String> = serde_json::from_str(&index).expect("index should be valid JSON");
        assert_eq!(ids, vec!["openai"], "index must not be corrupted by reserved-id delete");
    }

    #[test]
    fn load_persisted_malformed_index_logs_and_resets() {
        let (backend, _store) = fake_store();

        // Corrupt the persisted index: store non-JSON in the __persisted_ids__ entry
        backend.set(PERSISTED_INDEX_ID, "{invalid json [").expect("backend set should succeed");

        // Create a new store and load persisted: must not crash, must reset to empty
        let new_store = SecretStore::new(backend.clone());
        new_store.load_persisted();

        // Verify it didn't crash and reset to empty index
        let ids = new_store.list_ids();
        assert!(
            ids.is_empty(),
            "corrupted index should reset to empty on load, got {ids:?}"
        );

        // Verify the persisted_ids set is empty
        assert_eq!(
            new_store.persisted_ids_lock().len(),
            0,
            "persisted_ids should be empty after loading corrupted index"
        );
    }

    #[test]
    fn no_value_logging_in_module_source() {
        // Mechanical proxy for the module's "never log a secret value"
        // invariant: scans this file's own source for any `eprintln!` line
        // that interpolates a `value`/`password` local (the only locals in
        // this module that ever hold plaintext secret content) as a format
        // argument. `include_str!` re-reads this same file at compile
        // time, so this test fails loudly if a future edit ever adds such
        // a line, without relying on a human re-auditing every diff.
        let source = include_str!("secrets.rs");
        for (line_no, line) in source.lines().enumerate() {
            if !line.contains("eprintln!") {
                continue;
            }
            let forbidden = ["{value", ", value", "(value", "{password", ", password", "(password"];
            for pattern in forbidden {
                assert!(
                    !line.contains(pattern),
                    "secrets.rs:{}: eprintln! appears to log a secret value/password ({line:?})",
                    line_no + 1
                );
            }
        }
    }

    /// **Operator smoke, not CI coverage.** Everything above exercises
    /// `SecretStore`'s full persistence logic against [`FakeKeyringBackend`]
    /// — no real Keychain needed. This test is the one place [`KeyringImpl`]
    /// (the real macOS Keychain backend) is exercised, and it is
    /// intentionally `#[ignore]`d: CI sandboxes typically have no unlocked
    /// login keychain, so a real Security-framework call would be flaky or
    /// outright fail there, not because the code is wrong.
    ///
    /// Run manually on a real macOS workstation with `cargo test -- --ignored
    /// real_keychain_round_trip_operator_smoke` to prove the real backend
    /// works end to end (it self-cleans via `delete` regardless of
    /// assertion outcome... well, best-effort — see the note below).
    ///
    /// The FULL operator smoke for the feature (not just this backend) is:
    /// launch the app, `set_secret` with `persist: true` for a real
    /// provider key, quit the app, relaunch it, and confirm `get_secret`
    /// (or the UI reading it) returns the same value — proving
    /// `load_persisted_secrets` in `lib.rs`'s `.setup()` actually restored
    /// it from the Keychain across a real process restart.
    #[test]
    #[ignore = "touches the real macOS Keychain; run manually on a workstation with an unlocked login keychain"]
    fn real_keychain_round_trip_operator_smoke() {
        let backend = KeyringImpl::new();
        let id = "openfusion-secrets-rs-operator-smoke-test";

        backend.set(id, "operator-smoke-test-value").expect("real Keychain set should succeed");
        assert_eq!(
            backend.get(id).expect("real Keychain get should succeed"),
            Some("operator-smoke-test-value".to_string())
        );
        backend.delete(id).expect("real Keychain delete should succeed");
        assert_eq!(backend.get(id).expect("real Keychain get after delete should succeed"), None);
    }
}
