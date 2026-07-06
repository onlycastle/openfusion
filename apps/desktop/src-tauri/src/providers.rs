//! Non-secret provider metadata store.
//!
//! The Keychain (`secrets.rs`) persists a provider's API KEY value; this
//! module persists the NON-secret metadata that must be paired with it on the
//! next launch to re-register the provider in the engine: its kind, base URL,
//! and model. It NEVER stores an API key — that is the hard invariant the
//! `serialized_meta_never_contains_an_api_key_field` test guards.
//!
//! Storage goes through the [`MetaBackend`] trait (real: a JSON file in the
//! app config dir; test: an in-memory fake), mirroring `secrets.rs`'s
//! `KeyringBackend` seam so the store's logic is `cargo test`-able with no
//! filesystem access.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

/// Non-secret provider metadata. `base_url` serializes as `baseURL` to match
/// the engine's `ProviderConfigSchema` and the webview types. There is
/// deliberately NO `api_key` field here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderMeta {
    pub id: String,
    pub kind: String,
    #[serde(rename = "baseURL", skip_serializing_if = "Option::is_none", default)]
    pub base_url: Option<String>,
    pub model: String,
}

/// Read/write the full metadata list. Real impl is file-backed; the test fake
/// is in-memory.
pub trait MetaBackend: Send + Sync {
    fn read(&self) -> Result<Vec<ProviderMeta>, String>;
    fn write(&self, metas: &[ProviderMeta]) -> Result<(), String>;
}

/// File-backed backend: a JSON array at `path` (e.g.
/// `<app_config_dir>/providers.json`). A missing file reads as an empty list.
pub struct FileMetaBackend {
    path: PathBuf,
}

impl FileMetaBackend {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl MetaBackend for FileMetaBackend {
    fn read(&self) -> Result<Vec<ProviderMeta>, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(json) => serde_json::from_str(&json).map_err(|err| err.to_string()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(err) => Err(err.to_string()),
        }
    }

    fn write(&self, metas: &[ProviderMeta]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let json = serde_json::to_string_pretty(metas).map_err(|err| err.to_string())?;
        std::fs::write(&self.path, json).map_err(|err| err.to_string())
    }
}

/// Held in Tauri managed state as `Arc<ProviderConfigStore>`.
pub struct ProviderConfigStore {
    backend: Arc<dyn MetaBackend>,
}

impl ProviderConfigStore {
    pub fn new(backend: Arc<dyn MetaBackend>) -> Self {
        Self { backend }
    }

    pub fn list(&self) -> Result<Vec<ProviderMeta>, String> {
        self.backend.read()
    }

    /// Upsert by `id` (one provider per kind == per id in v1), keeping the
    /// list id-sorted for a stable UI.
    pub fn save(&self, meta: ProviderMeta) -> Result<(), String> {
        let mut metas = self.backend.read()?;
        metas.retain(|m| m.id != meta.id);
        metas.push(meta);
        metas.sort_by(|a, b| a.id.cmp(&b.id));
        self.backend.write(&metas)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut metas = self.backend.read()?;
        metas.retain(|m| m.id != id);
        self.backend.write(&metas)
    }
}

/// `invoke('list_provider_configs')` → the non-secret metadata list.
#[tauri::command]
pub fn list_provider_configs(state: State<'_, Arc<ProviderConfigStore>>) -> Result<Vec<ProviderMeta>, String> {
    state.inner().list()
}

/// `invoke('save_provider_config', { meta })`.
#[tauri::command]
pub fn save_provider_config(state: State<'_, Arc<ProviderConfigStore>>, meta: ProviderMeta) -> Result<(), String> {
    state.inner().save(meta)
}

/// `invoke('delete_provider_config', { id })`.
#[tauri::command]
pub fn delete_provider_config(state: State<'_, Arc<ProviderConfigStore>>, id: String) -> Result<(), String> {
    state.inner().delete(&id)
}

#[cfg(test)]
#[derive(Default)]
pub struct FakeMetaBackend {
    metas: std::sync::Mutex<Vec<ProviderMeta>>,
}

#[cfg(test)]
impl FakeMetaBackend {
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
impl MetaBackend for FakeMetaBackend {
    fn read(&self) -> Result<Vec<ProviderMeta>, String> {
        Ok(self.metas.lock().expect("fake meta backend mutex poisoned").clone())
    }
    fn write(&self, metas: &[ProviderMeta]) -> Result<(), String> {
        *self.metas.lock().expect("fake meta backend mutex poisoned") = metas.to_vec();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn fake_store() -> (Arc<FakeMetaBackend>, ProviderConfigStore) {
        let backend = Arc::new(FakeMetaBackend::new());
        let store = ProviderConfigStore::new(backend.clone());
        (backend, store)
    }

    fn meta(id: &str, model: &str) -> ProviderMeta {
        ProviderMeta { id: id.into(), kind: id.into(), base_url: None, model: model.into() }
    }

    #[test]
    fn save_then_list_round_trips() {
        let (_b, store) = fake_store();
        store.save(meta("deepseek", "deepseek-v4-flash")).unwrap();
        let all = store.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "deepseek");
        assert_eq!(all[0].model, "deepseek-v4-flash");
    }

    #[test]
    fn save_upserts_by_id() {
        let (_b, store) = fake_store();
        store.save(meta("deepseek", "deepseek-v4-flash")).unwrap();
        store.save(meta("deepseek", "deepseek-v4-pro")).unwrap();
        let all = store.list().unwrap();
        assert_eq!(all.len(), 1, "same id must overwrite, not duplicate");
        assert_eq!(all[0].model, "deepseek-v4-pro");
    }

    #[test]
    fn delete_removes_by_id() {
        let (_b, store) = fake_store();
        store.save(meta("deepseek", "deepseek-v4-flash")).unwrap();
        store.save(meta("moonshot", "kimi-k2.6")).unwrap();
        store.delete("deepseek").unwrap();
        let all = store.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "moonshot");
    }

    #[test]
    fn serialized_meta_never_contains_an_api_key_field() {
        let m = ProviderMeta { id: "openai-compatible".into(), kind: "openai-compatible".into(), base_url: Some("https://x/v1".into()), model: "qwen3-coder".into() };
        let json = serde_json::to_string(&m).unwrap();
        assert!(!json.to_lowercase().contains("apikey"), "metadata must never serialize an apiKey: {json}");
        assert!(!json.to_lowercase().contains("\"key\""), "metadata must never serialize a key field: {json}");
        assert!(json.contains("\"baseURL\""), "base_url must serialize as baseURL, got {json}");
    }

    #[test]
    fn list_on_missing_file_is_empty_not_error() {
        let (_b, store) = fake_store();
        assert_eq!(store.list().unwrap(), Vec::new());
    }
}
