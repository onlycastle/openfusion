//! Host-owned project registry (non-secret). Mirrors `providers.rs`: a JSON
//! array at `<app_config_dir>/projects.json`, MRU-ordered (front = most
//! recently opened). Stores ONLY `{ path, name }` — never a secret.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub path: String,
    pub name: String,
}

pub trait ProjectBackend: Send + Sync {
    fn read(&self) -> Result<Vec<ProjectMeta>, String>;
    fn write(&self, projects: &[ProjectMeta]) -> Result<(), String>;
}

pub struct FileProjectBackend {
    path: PathBuf,
}

impl FileProjectBackend {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl ProjectBackend for FileProjectBackend {
    fn read(&self) -> Result<Vec<ProjectMeta>, String> {
        match std::fs::read_to_string(&self.path) {
            Ok(json) => serde_json::from_str(&json).map_err(|err| err.to_string()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(err) => Err(err.to_string()),
        }
    }

    fn write(&self, projects: &[ProjectMeta]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let json = serde_json::to_string_pretty(projects).map_err(|err| err.to_string())?;
        std::fs::write(&self.path, json).map_err(|err| err.to_string())
    }
}

pub struct ProjectRegistryStore {
    backend: Arc<dyn ProjectBackend>,
}

impl ProjectRegistryStore {
    pub fn new(backend: Arc<dyn ProjectBackend>) -> Self {
        Self { backend }
    }

    pub fn list(&self) -> Result<Vec<ProjectMeta>, String> {
        self.backend.read()
    }

    /// Upsert-to-front by `path`: remove any existing entry with the same
    /// path, then insert at index 0 so the list stays MRU-ordered.
    pub fn add(&self, project: ProjectMeta) -> Result<(), String> {
        let mut projects = self.backend.read()?;
        projects.retain(|p| p.path != project.path);
        projects.insert(0, project);
        self.backend.write(&projects)
    }

    pub fn remove(&self, path: &str) -> Result<(), String> {
        let mut projects = self.backend.read()?;
        projects.retain(|p| p.path != path);
        self.backend.write(&projects)
    }
}

/// `invoke('list_projects')`.
#[tauri::command]
pub fn list_projects(state: State<'_, Arc<ProjectRegistryStore>>) -> Result<Vec<ProjectMeta>, String> {
    state.inner().list()
}

/// `invoke('add_project', { project })`.
#[tauri::command]
pub fn add_project(state: State<'_, Arc<ProjectRegistryStore>>, project: ProjectMeta) -> Result<(), String> {
    state.inner().add(project)
}

/// `invoke('remove_project', { path })`.
#[tauri::command]
pub fn remove_project(state: State<'_, Arc<ProjectRegistryStore>>, path: String) -> Result<(), String> {
    state.inner().remove(&path)
}

#[cfg(test)]
#[derive(Default)]
pub struct FakeProjectBackend {
    projects: std::sync::Mutex<Vec<ProjectMeta>>,
}

#[cfg(test)]
impl ProjectBackend for FakeProjectBackend {
    fn read(&self) -> Result<Vec<ProjectMeta>, String> {
        Ok(self.projects.lock().expect("fake project backend mutex poisoned").clone())
    }
    fn write(&self, projects: &[ProjectMeta]) -> Result<(), String> {
        *self.projects.lock().expect("fake project backend mutex poisoned") = projects.to_vec();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> ProjectRegistryStore {
        ProjectRegistryStore::new(Arc::new(FakeProjectBackend::default()))
    }

    fn proj(path: &str) -> ProjectMeta {
        ProjectMeta { path: path.into(), name: path.rsplit('/').next().unwrap_or(path).into() }
    }

    #[test]
    fn add_then_list_round_trips() {
        let s = store();
        s.add(proj("/repo/alpha")).unwrap();
        let all = s.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].path, "/repo/alpha");
        assert_eq!(all[0].name, "alpha");
    }

    #[test]
    fn add_moves_existing_to_front_without_duplicating() {
        let s = store();
        s.add(proj("/repo/alpha")).unwrap();
        s.add(proj("/repo/beta")).unwrap();
        s.add(proj("/repo/alpha")).unwrap(); // re-open alpha
        let all = s.list().unwrap();
        assert_eq!(all.len(), 2, "re-adding same path must not duplicate");
        assert_eq!(all[0].path, "/repo/alpha", "re-added project must move to front");
        assert_eq!(all[1].path, "/repo/beta");
    }

    #[test]
    fn remove_deletes_by_path() {
        let s = store();
        s.add(proj("/repo/alpha")).unwrap();
        s.add(proj("/repo/beta")).unwrap();
        s.remove("/repo/alpha").unwrap();
        let all = s.list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].path, "/repo/beta");
    }

    #[test]
    fn list_on_missing_file_is_empty_not_error() {
        assert_eq!(store().list().unwrap(), Vec::new());
    }

    #[test]
    fn serialized_project_never_contains_a_key_field() {
        let json = serde_json::to_string(&proj("/repo/alpha")).unwrap();
        assert!(!json.to_lowercase().contains("key"), "project meta must never serialize a key: {json}");
    }
}
