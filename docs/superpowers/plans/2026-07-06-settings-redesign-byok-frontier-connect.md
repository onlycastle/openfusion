# Settings redesign: working BYOK + frontier Connect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Settings dialog into a working control panel — pick a BYOK provider + model + key and it becomes a usable, restart-durable engine provider; connect Claude Code to its subscription via the official CLI, with live status.

**Architecture:** Three layers along the existing boundaries — webview React panes drive engine RPC (`engine.models.configure`) and Tauri host commands; a new host-owned non-secret metadata store (`providers.rs`) pairs with the existing Keychain (`secrets.rs`) so providers survive restart; a new host module (`frontier.rs`) detects/launches the official CLI login without ever touching a token.

**Tech Stack:** React 18 + TypeScript (Vite), Tauri 2 (Rust), Vitest + Testing Library, `cargo test --features test-mocks`. Engine is a Node/TS JSON-RPC sidecar (unchanged by this plan except calls into existing `engine.models.configure`).

Spec: `docs/superpowers/specs/2026-07-06-settings-redesign-byok-frontier-connect-design.md`.

## Global Constraints

- **No token handling for frontier auth.** `frontier_*` commands invoke the official CLI and observe status/exit only — never read, store, prompt for, or route a subscription token. Copied from spec §6.
- **Provider metadata store holds NO secrets.** `providers.json` / `ProviderMeta` contains only `{id, kind, baseURL?, model}`. The API key lives only in the Keychain (if persisted) or process memory. Spec §6.
- **Key values are never rendered or logged.** Only Save and startup-reconfigure read a key value; both pass it straight to `engine.models.configure` and never place it in the DOM or a log. The `noConsoleLogging.test.ts` grep (no `console.*` under `src/`) and `secrets.rs`'s `no_value_logging_in_module_source` test must keep passing. Spec §6.
- **One provider per kind in v1:** the provider `id` equals its `kind` (routing resolves a bare model `kind` to the single configured provider of that kind). Spec §2.
- **Provider kinds are exactly** `moonshot | zai | deepseek | openai-compatible`. No `anthropic`/`openai` provider kinds (those are the frontier tier). Spec §5.2.
- **DeepSeek retiring aliases** `deepseek-chat` and `deepseek-reasoner` (hard-retire 2026-07-24) are omitted from the model dropdown. Spec §5.3.
- **Rust tests run as** `cargo test --manifest-path src-tauri/Cargo.toml --features test-mocks` (via `pnpm --filter @openfusion/desktop test:rust`). Frontend tests: `pnpm --filter @openfusion/desktop test` (vitest). `test.globals` is false — every test file imports vitest globals explicitly and calls `afterEach(cleanup)`.
- **Commit style:** conventional commits, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Strict TS:** NodeNext `.js`-less relative imports in the webview (Vite), `noUncheckedIndexedAccess` on. Never introduce `console.*` under `apps/desktop/src/`.

## File Structure

- `apps/desktop/src/engineClient.ts` — MODIFY: add `ProviderKind`, `ProviderConfigInput`, `engineClient.modelsConfigure()`; add host-command wrappers (`ProviderMeta`, `listProviderConfigs`/`saveProviderConfig`/`deleteProviderConfig`; `FrontierEngineKind`, `FrontierAuthStatus`, `frontierLoginStatus`/`frontierLogin`/`frontierLogout`); add `reconfigureProvidersOnLaunch()`.
- `apps/desktop/src/providerCatalog.ts` — CREATE: provider presets (label, default/required/hidden base URL, model catalog).
- `apps/desktop/src/components/ModelProvidersPane.tsx` — CREATE: BYOK list + add-provider form (replaces `KeysScreen`).
- `apps/desktop/src/components/OrchestratorsPane.tsx` — CREATE: frontier Connect rows.
- `apps/desktop/src/components/SettingsDialog.tsx` — MODIFY: host the two new panes; drop `KeysScreen`/`ProvidersPane`.
- `apps/desktop/src/App.tsx` — MODIFY: call `reconfigureProvidersOnLaunch()` once on mount.
- `apps/desktop/src/screens/KeysScreen.tsx` + `KeysScreen.test.tsx` — DELETE (folded into `ModelProvidersPane`).
- `apps/desktop/src/styles.css` — MODIFY: Orchestrators + provider-form styling.
- `apps/desktop/src-tauri/src/providers.rs` — CREATE: non-secret metadata store + 3 commands.
- `apps/desktop/src-tauri/src/frontier.rs` — CREATE: CLI-auth status/login/logout + commands.
- `apps/desktop/src-tauri/src/lib.rs` — MODIFY: `pub mod providers; pub mod frontier;`, manage `ProviderConfigStore`, register 6 new commands.
- Test files created alongside each new module.

---

### Task 1: Engine client `modelsConfigure` wrapper + provider types

**Files:**
- Modify: `apps/desktop/src/engineClient.ts`
- Test: `apps/desktop/src/engineClient.test.ts`

**Interfaces:**
- Consumes: existing `EngineClient.call<T>()`, existing `ModelProviderSummary`.
- Produces: `export type ProviderKind = "moonshot" | "zai" | "deepseek" | "openai-compatible"`; `export interface ProviderConfigInput { id: string; kind: ProviderKind; apiKey: string; baseURL?: string }`; `engineClient.modelsConfigure(config: ProviderConfigInput, opts?: CallOptions): Promise<{ configured: boolean }>`.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/engineClient.test.ts` (follow the file's existing `vi.mock("@tauri-apps/api/core")` + `invokeMock` setup):

```ts
it("modelsConfigure calls engine.models.configure with the provider config", async () => {
  invokeMock.mockResolvedValueOnce({ configured: true });
  const client = new EngineClient();
  const result = await client.modelsConfigure({
    id: "deepseek",
    kind: "deepseek",
    apiKey: "sk-test",
    baseURL: undefined,
  });
  expect(result).toEqual({ configured: true });
  expect(invokeMock).toHaveBeenCalledWith("engine_call", {
    method: "engine.models.configure",
    params: { id: "deepseek", kind: "deepseek", apiKey: "sk-test", baseURL: undefined },
    timeoutMs: undefined,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/engineClient.test.ts -t "modelsConfigure"`
Expected: FAIL — `client.modelsConfigure is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `engineClient.ts`, add the exported type above `ModelProviderSummary` and reuse it there:

```ts
export type ProviderKind = "moonshot" | "zai" | "deepseek" | "openai-compatible";

export interface ProviderConfigInput {
  id: string;
  kind: ProviderKind;
  apiKey: string;
  baseURL?: string;
}
```

Change `ModelProviderSummary.kind` to reference it:

```ts
export interface ModelProviderSummary {
  id: string;
  kind: ProviderKind;
  baseURL?: string;
}
```

Add the method to the `EngineClient` class, next to `modelsList`:

```ts
/** `engine.models.configure` — registers (or overwrites) a provider in the
 * engine's in-memory registry so routing can resolve to it. The engine keeps
 * the apiKey memory-only per its own contract; this call carries it once. */
modelsConfigure(config: ProviderConfigInput, opts?: CallOptions): Promise<{ configured: boolean }> {
  return this.call<{ configured: boolean }>("engine.models.configure", config, opts);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/engineClient.test.ts`
Expected: PASS (all existing engineClient tests still green).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @openfusion/desktop exec tsc --noEmit` → Expected: exit 0.

```bash
git add apps/desktop/src/engineClient.ts apps/desktop/src/engineClient.test.ts
git commit -m "feat(desktop): add engineClient.modelsConfigure + ProviderKind types

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Rust non-secret provider-metadata store (`providers.rs`)

**Files:**
- Create: `apps/desktop/src-tauri/src/providers.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Produces (Rust): `ProviderMeta { id: String, kind: String, base_url: Option<String> (serde "baseURL"), model: String }` — NO apiKey field; `ProviderConfigStore::{new,list,save,delete}`; commands `list_provider_configs`, `save_provider_config`, `delete_provider_config`.
- Produces (for Task 4): invoke names `list_provider_configs` → `Vec<ProviderMeta>`; `save_provider_config` `{ meta }` → `()`; `delete_provider_config` `{ id }` → `()`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src-tauri/src/providers.rs` with the test module first (compile will fail until impl exists — that's the failing state):

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/desktop test:rust 2>&1 | head -20`
Expected: FAIL to compile — `cannot find type ProviderMeta`, `ProviderConfigStore`, `FakeMetaBackend`.

- [ ] **Step 3: Write minimal implementation**

Prepend to `apps/desktop/src-tauri/src/providers.rs` (above the test module):

```rust
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
```

- [ ] **Step 4: Wire into `lib.rs`**

In `apps/desktop/src-tauri/src/lib.rs`: add `pub mod providers;` next to `pub mod secrets;`. Add the import:

```rust
use providers::{FileMetaBackend, ProviderConfigStore};
```

Inside `.setup(|app| { ... })`, after the `secret_store` block, before `Ok(())`:

```rust
// Non-secret provider metadata store (see `providers.rs`). Pairs with the
// Keychain on startup-reconfigure (webview-driven) to re-register providers.
let providers_path = app
    .path()
    .app_config_dir()
    .map_err(|err| std::io::Error::other(format!("no app config dir: {err}")))?
    .join("providers.json");
app.manage(Arc::new(ProviderConfigStore::new(Arc::new(FileMetaBackend::new(providers_path)))));
```

Add to `tauri::generate_handler![ ... ]` after the secrets commands:

```rust
            providers::list_provider_configs,
            providers::save_provider_config,
            providers::delete_provider_config,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @openfusion/desktop test:rust 2>&1 | tail -15`
Expected: PASS — the 5 `providers::tests::*` plus all existing tests. `cargo build` succeeds (lib.rs compiles with the new module + commands).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/providers.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): host-owned non-secret provider metadata store

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Rust frontier CLI-auth commands (`frontier.rs`)

**Files:**
- Create: `apps/desktop/src-tauri/src/frontier.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Produces (Rust): `FrontierAuthStatus { state: String, detail: Option<String> }` (serde camelCase); pure `compute_status(runner: &dyn CliRunner, engine: &str) -> FrontierAuthStatus`; commands `frontier_login_status`, `frontier_login`, `frontier_logout`.
- Produces (for Task 4): invoke `frontier_login_status` `{ engine }` → `FrontierAuthStatus`; `frontier_login` `{ engine }` → `()`; `frontier_logout` `{ engine }` → `()`. `state` ∈ `"connected" | "disconnected" | "not-installed"`.

> **Implementation-verification (spec §9):** the exact CLI subcommands for
> status/login/logout are captured as the `*_ARGS` constants below and MUST be
> confirmed against the installed `claude`/`codex` CLIs during this task
> (run them by hand once). The status *mapping* (spawn-fail → not-installed,
> exit 0 → connected, else → disconnected) is what the tests pin; the exact
> argv is data, verified manually, not asserted by a unit test.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src-tauri/src/frontier.rs` with the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    struct FakeCli {
        // None => spawn fails (program not installed)
        result: Option<CliOutput>,
    }
    impl CliRunner for FakeCli {
        fn run(&self, _program: &str, _args: &[&str]) -> Result<CliOutput, CliSpawnError> {
            match &self.result {
                Some(o) => Ok(CliOutput { code: o.code, stdout: o.stdout.clone(), stderr: o.stderr.clone() }),
                None => Err(CliSpawnError),
            }
        }
    }

    #[test]
    fn unknown_engine_reports_not_installed() {
        let runner = FakeCli { result: Some(CliOutput { code: 0, stdout: String::new(), stderr: String::new() }) };
        let status = compute_status(&runner, "nonesuch");
        assert_eq!(status.state, "not-installed");
    }

    #[test]
    fn spawn_failure_maps_to_not_installed() {
        let runner = FakeCli { result: None };
        let status = compute_status(&runner, "claude-code");
        assert_eq!(status.state, "not-installed");
    }

    #[test]
    fn exit_zero_maps_to_connected() {
        let runner = FakeCli { result: Some(CliOutput { code: 0, stdout: "logged in".into(), stderr: String::new() }) };
        let status = compute_status(&runner, "claude-code");
        assert_eq!(status.state, "connected");
    }

    #[test]
    fn nonzero_exit_maps_to_disconnected() {
        let runner = FakeCli { result: Some(CliOutput { code: 1, stdout: String::new(), stderr: "not authenticated".into() }) };
        let status = compute_status(&runner, "codex");
        assert_eq!(status.state, "disconnected");
    }

    #[test]
    fn status_serializes_state_camelcase_without_detail_when_none() {
        let status = FrontierAuthStatus { state: "connected".into(), detail: None };
        let json = serde_json::to_string(&status).unwrap();
        assert_eq!(json, r#"{"state":"connected"}"#);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/desktop test:rust 2>&1 | head -20`
Expected: FAIL to compile — `cannot find CliRunner`, `compute_status`, `FrontierAuthStatus`, etc.

- [ ] **Step 3: Write minimal implementation**

Prepend to `frontier.rs` (above the tests):

```rust
//! Frontier engine (Claude Code / Codex) auth via delegation to the official
//! CLI. This module NEVER handles a subscription token — it invokes the
//! operator's own installed CLI and observes its exit/status only, keeping
//! the engine's auth-agnostic invariant intact (spec §3, §6). The CLI holds
//! the login; the engine already runs on it by spawning the CLI.

use serde::Serialize;

/// The outcome of running a CLI once. `code` is the process exit code.
pub struct CliOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// The CLI could not be spawned at all (binary not found / not executable).
pub struct CliSpawnError;

/// Seam over "run a CLI once", so `compute_status` is unit-testable without
/// the real binaries. Real impl: [`SystemCli`].
pub trait CliRunner: Send + Sync {
    fn run(&self, program: &str, args: &[&str]) -> Result<CliOutput, CliSpawnError>;
}

/// Real runner over `std::process::Command`.
pub struct SystemCli;

impl CliRunner for SystemCli {
    fn run(&self, program: &str, args: &[&str]) -> Result<CliOutput, CliSpawnError> {
        match std::process::Command::new(program).args(args).output() {
            Ok(out) => Ok(CliOutput {
                code: out.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            }),
            Err(_) => Err(CliSpawnError),
        }
    }
}

/// Connection status for one frontier engine.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontierAuthStatus {
    /// "connected" | "disconnected" | "not-installed"
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

// IMPLEMENTATION-VERIFICATION (spec §9): confirm these argv against the real
// CLIs before shipping. The mapping below (spawn-fail => not-installed,
// exit 0 => connected, else => disconnected) is the tested contract.
const CLAUDE_PROGRAM: &str = "claude";
const CODEX_PROGRAM: &str = "codex";
const STATUS_ARGS_CLAUDE: &[&str] = &["auth", "status"];
const STATUS_ARGS_CODEX: &[&str] = &["login", "status"];
const LOGIN_ARGS_CLAUDE: &[&str] = &["auth", "login"];
const LOGIN_ARGS_CODEX: &[&str] = &["login"];
const LOGOUT_ARGS_CLAUDE: &[&str] = &["auth", "logout"];
const LOGOUT_ARGS_CODEX: &[&str] = &["logout"];

fn program_and_status_args(engine: &str) -> Option<(&'static str, &'static [&'static str])> {
    match engine {
        "claude-code" => Some((CLAUDE_PROGRAM, STATUS_ARGS_CLAUDE)),
        "codex" => Some((CODEX_PROGRAM, STATUS_ARGS_CODEX)),
        _ => None,
    }
}

fn program_and_login_args(engine: &str) -> Option<(&'static str, &'static [&'static str])> {
    match engine {
        "claude-code" => Some((CLAUDE_PROGRAM, LOGIN_ARGS_CLAUDE)),
        "codex" => Some((CODEX_PROGRAM, LOGIN_ARGS_CODEX)),
        _ => None,
    }
}

fn program_and_logout_args(engine: &str) -> Option<(&'static str, &'static [&'static str])> {
    match engine {
        "claude-code" => Some((CLAUDE_PROGRAM, LOGOUT_ARGS_CLAUDE)),
        "codex" => Some((CODEX_PROGRAM, LOGOUT_ARGS_CODEX)),
        _ => None,
    }
}

/// Pure status mapping (testable): unknown engine or un-spawnable binary =>
/// not-installed; exit 0 => connected; any other exit => disconnected.
pub fn compute_status(runner: &dyn CliRunner, engine: &str) -> FrontierAuthStatus {
    let Some((program, args)) = program_and_status_args(engine) else {
        return FrontierAuthStatus { state: "not-installed".into(), detail: Some(format!("unknown engine {engine}")) };
    };
    match runner.run(program, args) {
        Err(CliSpawnError) => FrontierAuthStatus { state: "not-installed".into(), detail: None },
        Ok(out) if out.code == 0 => FrontierAuthStatus { state: "connected".into(), detail: None },
        Ok(_) => FrontierAuthStatus { state: "disconnected".into(), detail: None },
    }
}

/// `invoke('frontier_login_status', { engine })`.
#[tauri::command]
pub fn frontier_login_status(engine: String) -> FrontierAuthStatus {
    compute_status(&SystemCli, &engine)
}

/// `invoke('frontier_login', { engine })`. Launches the official CLI's own
/// login (its OAuth completes in the user's browser). Returns once the
/// process is initiated; the pane re-probes status afterward. No token
/// crosses this boundary.
#[tauri::command]
pub fn frontier_login(engine: String) -> Result<(), String> {
    let Some((program, args)) = program_and_login_args(&engine) else {
        return Err(format!("unknown frontier engine: {engine}"));
    };
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map(|_child| ())
        .map_err(|err| format!("could not launch {program} login: {err}"))
}

/// `invoke('frontier_logout', { engine })`.
#[tauri::command]
pub fn frontier_logout(engine: String) -> Result<(), String> {
    let Some((program, args)) = program_and_logout_args(&engine) else {
        return Err(format!("unknown frontier engine: {engine}"));
    };
    std::process::Command::new(program)
        .args(args)
        .output()
        .map(|_| ())
        .map_err(|err| format!("could not run {program} logout: {err}"))
}
```

- [ ] **Step 4: Wire into `lib.rs`**

Add `pub mod frontier;` next to `pub mod providers;`. Add to `generate_handler![ ... ]`:

```rust
            frontier::frontier_login_status,
            frontier::frontier_login,
            frontier::frontier_logout,
```

(No managed state — these commands are stateless wrappers over `SystemCli`.)

- [ ] **Step 5: Run tests + verify argv manually**

Run: `pnpm --filter @openfusion/desktop test:rust 2>&1 | tail -15` → Expected: PASS (5 `frontier::tests::*` + existing).

Manual verification (do once, record result in a code comment if argv differs): run `claude auth status; echo $?` and `codex login status; echo $?` on a machine with the CLIs; confirm exit 0 when logged in, non-zero when not. Adjust the `*_ARGS` constants if the real subcommands differ, and re-run the tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/frontier.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): frontier CLI-auth commands (detect/launch official login)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend host-command wrappers

**Files:**
- Modify: `apps/desktop/src/engineClient.ts`
- Test: `apps/desktop/src/engineClient.test.ts`

**Interfaces:**
- Consumes: Task 1's `ProviderKind`; the invoke names from Tasks 2 & 3.
- Produces: `ProviderMeta`, `listProviderConfigs()`, `saveProviderConfig(meta)`, `deleteProviderConfig(id)`; `FrontierEngineKind`, `FrontierAuthStatus`, `frontierLoginStatus(engine)`, `frontierLogin(engine)`, `frontierLogout(engine)`.

- [ ] **Step 1: Write the failing test**

Add to `engineClient.test.ts`:

```ts
it("host-command wrappers call the right Tauri commands", async () => {
  invokeMock.mockResolvedValue(undefined);
  await saveProviderConfig({ id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash" });
  expect(invokeMock).toHaveBeenCalledWith("save_provider_config", {
    meta: { id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash" },
  });
  await deleteProviderConfig("deepseek");
  expect(invokeMock).toHaveBeenCalledWith("delete_provider_config", { id: "deepseek" });
  await frontierLoginStatus("claude-code");
  expect(invokeMock).toHaveBeenCalledWith("frontier_login_status", { engine: "claude-code" });
  await frontierLogin("claude-code");
  expect(invokeMock).toHaveBeenCalledWith("frontier_login", { engine: "claude-code" });
  await frontierLogout("claude-code");
  expect(invokeMock).toHaveBeenCalledWith("frontier_logout", { engine: "claude-code" });
});
```

Add the imports at the top of the test file to the existing `import { ... } from "./engineClient"` line: `saveProviderConfig, deleteProviderConfig, listProviderConfigs, frontierLoginStatus, frontierLogin, frontierLogout`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/engineClient.test.ts -t "host-command"`
Expected: FAIL — `saveProviderConfig is not a function` (or import error).

- [ ] **Step 3: Write minimal implementation**

Append to `engineClient.ts` (after the secret command exports):

```ts
// ---------------------------------------------------------------------------
// Provider metadata commands (non-secret) — Rust host, NOT engine RPC.
// ---------------------------------------------------------------------------

/** Non-secret provider metadata (never an API key). Mirrors `providers.rs`'s
 * `ProviderMeta`. */
export interface ProviderMeta {
  id: string;
  kind: ProviderKind;
  baseURL?: string;
  model: string;
}

/** `invoke('list_provider_configs')`. */
export function listProviderConfigs(): Promise<ProviderMeta[]> {
  return invoke<ProviderMeta[]>("list_provider_configs");
}

/** `invoke('save_provider_config', { meta })`. */
export function saveProviderConfig(meta: ProviderMeta): Promise<void> {
  return invoke("save_provider_config", { meta });
}

/** `invoke('delete_provider_config', { id })`. */
export function deleteProviderConfig(id: string): Promise<void> {
  return invoke("delete_provider_config", { id });
}

// ---------------------------------------------------------------------------
// Frontier CLI-auth commands — Rust host. No token ever crosses this surface.
// ---------------------------------------------------------------------------

export type FrontierEngineKind = "claude-code" | "codex";

/** Mirrors `frontier.rs`'s `FrontierAuthStatus`. */
export interface FrontierAuthStatus {
  state: "connected" | "disconnected" | "not-installed";
  detail?: string;
}

/** `invoke('frontier_login_status', { engine })`. */
export function frontierLoginStatus(engine: FrontierEngineKind): Promise<FrontierAuthStatus> {
  return invoke<FrontierAuthStatus>("frontier_login_status", { engine });
}

/** `invoke('frontier_login', { engine })` — launches the official CLI login. */
export function frontierLogin(engine: FrontierEngineKind): Promise<void> {
  return invoke("frontier_login", { engine });
}

/** `invoke('frontier_logout', { engine })`. */
export function frontierLogout(engine: FrontierEngineKind): Promise<void> {
  return invoke("frontier_logout", { engine });
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/engineClient.test.ts` → Expected: PASS.
Run: `pnpm --filter @openfusion/desktop exec tsc --noEmit` → Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/engineClient.ts apps/desktop/src/engineClient.test.ts
git commit -m "feat(desktop): frontend wrappers for provider-config + frontier-auth commands

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Provider catalog module

**Files:**
- Create: `apps/desktop/src/providerCatalog.ts`
- Test: `apps/desktop/src/providerCatalog.test.ts`

**Interfaces:**
- Consumes: Task 1's `ProviderKind`.
- Produces: `ProviderPreset`; `PROVIDER_PRESETS: ProviderPreset[]`; `presetFor(kind): ProviderPreset`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/providerCatalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, presetFor } from "./providerCatalog";

describe("providerCatalog", () => {
  it("exposes exactly the four engine provider kinds", () => {
    expect(PROVIDER_PRESETS.map((p) => p.kind).sort()).toEqual(
      ["deepseek", "moonshot", "openai-compatible", "zai"],
    );
  });

  it("omits DeepSeek's retiring aliases from the model list", () => {
    const models = presetFor("deepseek").models;
    expect(models).toContain("deepseek-v4-flash");
    expect(models).toContain("deepseek-v4-pro");
    expect(models).not.toContain("deepseek-chat");
    expect(models).not.toContain("deepseek-reasoner");
  });

  it("marks base URL required for openai-compatible and hidden for deepseek", () => {
    expect(presetFor("openai-compatible").baseURLRequired).toBe(true);
    expect(presetFor("deepseek").baseURLHidden).toBe(true);
  });

  it("prefills default base URLs for moonshot and zai", () => {
    expect(presetFor("moonshot").defaultBaseURL).toBe("https://api.moonshot.ai/v1");
    expect(presetFor("zai").defaultBaseURL).toBe("https://api.z.ai/api/paas/v4");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/providerCatalog.test.ts`
Expected: FAIL — cannot find module `./providerCatalog`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/providerCatalog.ts`:

```ts
import type { ProviderKind } from "./engineClient";

/** UI-side provider preset. The engine exposes no model-enumeration RPC, so
 * `models` is sourced from the engine pricing table
 * (`packages/engine/src/models/pricing.ts`) and must be kept in sync with it.
 * DeepSeek's retiring aliases (deepseek-chat / deepseek-reasoner, hard-retire
 * 2026-07-24) are deliberately omitted. */
export interface ProviderPreset {
  kind: ProviderKind;
  label: string;
  /** Prefilled + editable (Moonshot/Z.ai). Undefined when hidden or required. */
  defaultBaseURL?: string;
  /** Required field (OpenAI-compatible has no default endpoint). */
  baseURLRequired: boolean;
  /** Hidden field — the SDK supplies the endpoint (DeepSeek). */
  baseURLHidden: boolean;
  /** Fixed catalog for a `<select>`. Empty => free-text model input. */
  models: string[];
  /** `<datalist>` suggestions when `models` is empty (OpenAI-compatible). */
  modelSuggestions?: string[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    kind: "moonshot",
    label: "Moonshot",
    defaultBaseURL: "https://api.moonshot.ai/v1",
    baseURLRequired: false,
    baseURLHidden: false,
    models: ["kimi-k2.6", "kimi-k2.7-code"],
  },
  {
    kind: "zai",
    label: "Z.ai",
    defaultBaseURL: "https://api.z.ai/api/paas/v4",
    baseURLRequired: false,
    baseURLHidden: false,
    models: ["glm-5.2"],
  },
  {
    kind: "deepseek",
    label: "DeepSeek",
    baseURLRequired: false,
    baseURLHidden: true,
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    kind: "openai-compatible",
    label: "OpenAI-compatible",
    baseURLRequired: true,
    baseURLHidden: false,
    models: [],
    modelSuggestions: ["qwen3-coder-next", "qwen3-coder", "minimax-m2.5"],
  },
];

export function presetFor(kind: ProviderKind): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((p) => p.kind === kind);
  if (preset === undefined) {
    throw new Error(`no provider preset for kind ${kind}`);
  }
  return preset;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/providerCatalog.test.ts` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/providerCatalog.ts apps/desktop/src/providerCatalog.test.ts
git commit -m "feat(desktop): provider catalog (kinds, base-URL rules, model lists)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: ModelProvidersPane component

**Files:**
- Create: `apps/desktop/src/components/ModelProvidersPane.tsx`
- Test: `apps/desktop/src/components/ModelProvidersPane.test.tsx`
- Delete: `apps/desktop/src/screens/KeysScreen.tsx`, `apps/desktop/src/screens/KeysScreen.test.tsx`

**Interfaces:**
- Consumes: `engineClient` (`.modelsConfigure`, `.modelsList`), `setSecret`, `deleteSecret`, `listProviderConfigs`, `saveProviderConfig`, `deleteProviderConfig`, `type ProviderMeta`, `type ProviderKind` (engineClient); `PROVIDER_PRESETS`, `presetFor` (providerCatalog).
- Produces: `export function ModelProvidersPane(): JSX.Element`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/ModelProvidersPane.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

afterEach(cleanup);

const { modelsConfigureMock, modelsListMock, setSecretMock, deleteSecretMock, saveProviderConfigMock, deleteProviderConfigMock, listProviderConfigsMock } = vi.hoisted(() => ({
  modelsConfigureMock: vi.fn(),
  modelsListMock: vi.fn(),
  setSecretMock: vi.fn(),
  deleteSecretMock: vi.fn(),
  saveProviderConfigMock: vi.fn(),
  deleteProviderConfigMock: vi.fn(),
  listProviderConfigsMock: vi.fn(),
}));

vi.mock("../engineClient", () => ({
  engineClient: { modelsConfigure: modelsConfigureMock, modelsList: modelsListMock },
  setSecret: setSecretMock,
  deleteSecret: deleteSecretMock,
  saveProviderConfig: saveProviderConfigMock,
  deleteProviderConfig: deleteProviderConfigMock,
  listProviderConfigs: listProviderConfigsMock,
}));

import { ModelProvidersPane } from "./ModelProvidersPane";

beforeEach(() => {
  for (const m of [modelsConfigureMock, modelsListMock, setSecretMock, deleteSecretMock, saveProviderConfigMock, deleteProviderConfigMock, listProviderConfigsMock]) m.mockReset();
  modelsListMock.mockResolvedValue({ providers: [] });
  listProviderConfigsMock.mockResolvedValue([]);
  modelsConfigureMock.mockResolvedValue({ configured: true });
  setSecretMock.mockResolvedValue(undefined);
  deleteSecretMock.mockResolvedValue(undefined);
  saveProviderConfigMock.mockResolvedValue(undefined);
  deleteProviderConfigMock.mockResolvedValue(undefined);
});

describe("ModelProvidersPane", () => {
  it("configures a DeepSeek provider and stores the key on Save (persist off by default)", async () => {
    render(<ModelProvidersPane />);
    await waitFor(() => expect(modelsListMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "deepseek-v4-flash" } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-deepseek" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(setSecretMock).toHaveBeenCalledWith("deepseek", "sk-deepseek", false));
    expect(modelsConfigureMock).toHaveBeenCalledWith({ id: "deepseek", kind: "deepseek", apiKey: "sk-deepseek", baseURL: undefined });
    // persist off => no metadata write
    expect(saveProviderConfigMock).not.toHaveBeenCalled();
  });

  it("persists metadata (with the key) when Save-to-Keychain is checked", async () => {
    render(<ModelProvidersPane />);
    await waitFor(() => expect(modelsListMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "deepseek-v4-pro" } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-persist" } });
    fireEvent.click(screen.getByLabelText(/keychain/i));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(setSecretMock).toHaveBeenCalledWith("deepseek", "sk-persist", true));
    expect(saveProviderConfigMock).toHaveBeenCalledWith({ id: "deepseek", kind: "deepseek", baseURL: undefined, model: "deepseek-v4-pro" });
  });

  it("requires a base URL for OpenAI-compatible and forwards it", async () => {
    render(<ModelProvidersPane />);
    await waitFor(() => expect(modelsListMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "openai-compatible" } });
    fireEvent.change(screen.getByLabelText(/base url/i), { target: { value: "https://host/v1" } });
    fireEvent.change(screen.getByLabelText(/^model$/i), { target: { value: "qwen3-coder" } });
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: "sk-oai" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(modelsConfigureMock).toHaveBeenCalledWith({ id: "openai-compatible", kind: "openai-compatible", apiKey: "sk-oai", baseURL: "https://host/v1" }));
  });

  it("hides the base URL field for DeepSeek", async () => {
    render(<ModelProvidersPane />);
    await waitFor(() => expect(modelsListMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/^provider$/i), { target: { value: "deepseek" } });
    expect(screen.queryByLabelText(/base url/i)).toBeNull();
  });

  it("removes a configured provider (key + metadata)", async () => {
    modelsListMock.mockResolvedValue({ providers: [{ id: "deepseek", kind: "deepseek" }] });
    listProviderConfigsMock.mockResolvedValue([{ id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash" }]);
    render(<ModelProvidersPane />);
    await waitFor(() => expect(screen.getByText("deepseek")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    await waitFor(() => expect(deleteSecretMock).toHaveBeenCalledWith("deepseek"));
    expect(deleteProviderConfigMock).toHaveBeenCalledWith("deepseek");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/components/ModelProvidersPane.test.tsx`
Expected: FAIL — cannot find module `./ModelProvidersPane`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/components/ModelProvidersPane.tsx`:

```tsx
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/components/ModelProvidersPane.test.tsx`
Expected: PASS (all 5).

- [ ] **Step 5: Delete the folded-in KeysScreen**

```bash
git rm apps/desktop/src/screens/KeysScreen.tsx apps/desktop/src/screens/KeysScreen.test.tsx
```

(SettingsDialog still imports KeysScreen — that import is removed in Task 9. Do not run the full suite yet; run it after Task 9. Typecheck will fail on the dangling import until then, which is expected and resolved in Task 9.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/ModelProvidersPane.tsx apps/desktop/src/components/ModelProvidersPane.test.tsx
git commit -m "feat(desktop): ModelProvidersPane — provider/model dropdowns + working save

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: OrchestratorsPane component

**Files:**
- Create: `apps/desktop/src/components/OrchestratorsPane.tsx`
- Test: `apps/desktop/src/components/OrchestratorsPane.test.tsx`

**Interfaces:**
- Consumes: `frontierLoginStatus`, `frontierLogin`, `frontierLogout`, `type FrontierAuthStatus` (engineClient).
- Produces: `export function OrchestratorsPane(): JSX.Element`. Project 1 renders the `claude-code` row only.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/OrchestratorsPane.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

afterEach(cleanup);

const { statusMock, loginMock, logoutMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  loginMock: vi.fn(),
  logoutMock: vi.fn(),
}));

vi.mock("../engineClient", () => ({
  frontierLoginStatus: statusMock,
  frontierLogin: loginMock,
  frontierLogout: logoutMock,
}));

import { OrchestratorsPane } from "./OrchestratorsPane";

beforeEach(() => {
  statusMock.mockReset();
  loginMock.mockReset();
  logoutMock.mockReset();
  loginMock.mockResolvedValue(undefined);
  logoutMock.mockResolvedValue(undefined);
});

describe("OrchestratorsPane", () => {
  it("shows Connected with a Sign out button when the CLI is logged in", async () => {
    statusMock.mockResolvedValue({ state: "connected" });
    render(<OrchestratorsPane />);
    await waitFor(() => expect(screen.getByText(/connected/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();
  });

  it("shows Connect when disconnected, and launches login then re-probes", async () => {
    statusMock.mockResolvedValueOnce({ state: "disconnected" }).mockResolvedValueOnce({ state: "connected" });
    render(<OrchestratorsPane />);
    const connect = await screen.findByRole("button", { name: /^connect$/i });
    fireEvent.click(connect);
    await waitFor(() => expect(loginMock).toHaveBeenCalledWith("claude-code"));
    await waitFor(() => expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy());
  });

  it("shows an install hint (no Connect) when the CLI is not installed", async () => {
    statusMock.mockResolvedValue({ state: "not-installed" });
    render(<OrchestratorsPane />);
    await waitFor(() => expect(screen.getByText(/isn't installed/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^connect$/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/components/OrchestratorsPane.test.tsx`
Expected: FAIL — cannot find module `./OrchestratorsPane`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/components/OrchestratorsPane.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { frontierLogin, frontierLoginStatus, frontierLogout, type FrontierAuthStatus, type FrontierEngineKind } from "../engineClient";

function friendlyMessage(err: unknown): string {
  if (typeof err === "string" && err.trim().length > 0) return err;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return "Something went wrong. Please try again.";
}

type RowState = { status: "checking" } | { status: "ready"; auth: FrontierAuthStatus } | { status: "error"; message: string };

interface OrchestratorRowProps {
  engine: FrontierEngineKind;
  label: string;
  installHint: string;
}

function OrchestratorRow({ engine, label, installHint }: OrchestratorRowProps) {
  const [state, setState] = useState<RowState>({ status: "checking" });
  const [busy, setBusy] = useState(false);

  const probe = useCallback(() => {
    setState({ status: "checking" });
    frontierLoginStatus(engine)
      .then((auth) => setState({ status: "ready", auth }))
      .catch((err: unknown) => setState({ status: "error", message: friendlyMessage(err) }));
  }, [engine]);

  useEffect(() => {
    probe();
  }, [probe]);

  const onConnect = useCallback(() => {
    setBusy(true);
    frontierLogin(engine)
      .then(probe)
      .catch((err: unknown) => setState({ status: "error", message: friendlyMessage(err) }))
      .finally(() => setBusy(false));
  }, [engine, probe]);

  const onSignOut = useCallback(() => {
    setBusy(true);
    frontierLogout(engine)
      .then(probe)
      .catch((err: unknown) => setState({ status: "error", message: friendlyMessage(err) }))
      .finally(() => setBusy(false));
  }, [engine, probe]);

  const connected = state.status === "ready" && state.auth.state === "connected";
  const notInstalled = state.status === "ready" && state.auth.state === "not-installed";

  return (
    <li className="orchestrator-row">
      <span className={`orchestrator-dot orchestrator-dot-${connected ? "on" : "off"}`} aria-hidden="true" />
      <span className="orchestrator-name">{label}</span>
      <span className="orchestrator-status">
        {state.status === "checking" && "Checking…"}
        {state.status === "error" && <span className="error-text">{state.message}</span>}
        {state.status === "ready" && connected && "Connected"}
        {state.status === "ready" && state.auth.state === "disconnected" && "Not connected"}
        {state.status === "ready" && notInstalled && `${label} isn't installed`}
      </span>
      <span className="orchestrator-action">
        {connected && (
          <button type="button" onClick={onSignOut} disabled={busy}>
            Sign out
          </button>
        )}
        {state.status === "ready" && state.auth.state === "disconnected" && (
          <button type="button" onClick={onConnect} disabled={busy}>
            Connect
          </button>
        )}
        {notInstalled && <span className="muted-text">{installHint}</span>}
      </span>
    </li>
  );
}

/** The frontier orchestrators pane. Project 1 renders the Claude Code row
 * only; the Codex row is added with its adapter (Project 2). */
export function OrchestratorsPane() {
  return (
    <section className="settings-pane">
      <h2 className="settings-section-title">Orchestrators</h2>
      <p className="settings-lede">Run the frontier tier on your own subscription. Connect signs in through the official CLI — your token never touches OpenFusion.</p>
      <ul className="orchestrator-list">
        <OrchestratorRow engine="claude-code" label="Claude Code" installHint="Install the Claude Code CLI to connect." />
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/components/OrchestratorsPane.test.tsx`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/OrchestratorsPane.tsx apps/desktop/src/components/OrchestratorsPane.test.tsx
git commit -m "feat(desktop): OrchestratorsPane — Claude Code connect + live status

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Startup reconfigure + App wiring

**Files:**
- Modify: `apps/desktop/src/engineClient.ts`
- Test: `apps/desktop/src/engineClient.test.ts`
- Modify: `apps/desktop/src/App.tsx`

**Interfaces:**
- Consumes: `getSecret`, `listProviderConfigs`, `engineClient.modelsConfigure`.
- Produces: `export async function reconfigureProvidersOnLaunch(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Add to `engineClient.test.ts`:

```ts
it("reconfigureProvidersOnLaunch re-registers each persisted provider from its stored key", async () => {
  invokeMock.mockImplementation((cmd: string, args?: any) => {
    if (cmd === "list_provider_configs") return Promise.resolve([
      { id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash" },
      { id: "openai-compatible", kind: "openai-compatible", baseURL: "https://h/v1", model: "qwen3-coder" },
    ]);
    if (cmd === "get_secret") return Promise.resolve(args.id === "deepseek" ? "sk-ds" : "sk-oai");
    if (cmd === "engine_call") return Promise.resolve({ configured: true });
    return Promise.resolve(undefined);
  });

  await reconfigureProvidersOnLaunch();

  expect(invokeMock).toHaveBeenCalledWith("engine_call", {
    method: "engine.models.configure",
    params: { id: "deepseek", kind: "deepseek", apiKey: "sk-ds", baseURL: undefined },
    timeoutMs: undefined,
  });
  expect(invokeMock).toHaveBeenCalledWith("engine_call", {
    method: "engine.models.configure",
    params: { id: "openai-compatible", kind: "openai-compatible", apiKey: "sk-oai", baseURL: "https://h/v1" },
    timeoutMs: undefined,
  });
});

it("reconfigureProvidersOnLaunch skips a provider whose key is missing", async () => {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "list_provider_configs") return Promise.resolve([{ id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash" }]);
    if (cmd === "get_secret") return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
  await reconfigureProvidersOnLaunch();
  const configureCalls = invokeMock.mock.calls.filter(([c, a]: [string, any]) => c === "engine_call" && a?.method === "engine.models.configure");
  expect(configureCalls).toHaveLength(0);
});
```

Add `reconfigureProvidersOnLaunch` to the test file's import from `./engineClient`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/engineClient.test.ts -t "reconfigure"`
Expected: FAIL — `reconfigureProvidersOnLaunch is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `engineClient.ts`:

```ts
/** On launch, re-register every persisted provider with the engine (whose
 * registry starts empty each run) by pairing its saved metadata with its
 * Keychain key. The key value is read into a local and passed straight to
 * `modelsConfigure` — never rendered, never logged. A provider whose key is
 * missing (e.g. a Keychain entry was removed out-of-band) is skipped. */
export async function reconfigureProvidersOnLaunch(): Promise<void> {
  const metas = await listProviderConfigs();
  await Promise.all(
    metas.map(async (meta) => {
      const apiKey = await getSecret(meta.id);
      if (apiKey === null) return;
      await engineClient.modelsConfigure({ id: meta.id, kind: meta.kind, apiKey, baseURL: meta.baseURL });
    }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/engineClient.test.ts` → Expected: PASS.

- [ ] **Step 5: Wire into `App.tsx`**

In `App.tsx`, import it and call it once on mount (best-effort — a failure must not crash the shell):

```tsx
import { engineClient, reconfigureProvidersOnLaunch, type EngineNotification } from "./engineClient";
```

Add a second effect inside `App`, after the existing `onEngineEvent` effect:

```tsx
  useEffect(() => {
    // Best-effort: re-register persisted BYOK providers with the fresh engine
    // registry. A failure here must never block the shell from rendering.
    void reconfigureProvidersOnLaunch().catch(() => {});
  }, []);
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @openfusion/desktop exec tsc --noEmit` → Expected: exit 0 (App.tsx is otherwise unchanged; the dangling KeysScreen import lives in SettingsDialog and is fixed next task — if tsc still flags it, proceed to Task 9 which resolves it, then re-run).

```bash
git add apps/desktop/src/engineClient.ts apps/desktop/src/engineClient.test.ts apps/desktop/src/App.tsx
git commit -m "feat(desktop): reconfigure persisted providers on launch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Assemble SettingsDialog + styles

**Files:**
- Modify: `apps/desktop/src/components/SettingsDialog.tsx`
- Create: `apps/desktop/src/components/SettingsDialog.test.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify (if needed): `apps/desktop/src/App.test.tsx`

**Interfaces:**
- Consumes: `OrchestratorsPane`, `ModelProvidersPane`.
- Produces: unchanged `SettingsDialog` props (`{ open, onClose }`).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/SettingsDialog.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

afterEach(cleanup);

const { statusMock, modelsListMock, listProviderConfigsMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  modelsListMock: vi.fn(),
  listProviderConfigsMock: vi.fn(),
}));

vi.mock("../engineClient", () => ({
  engineClient: { modelsList: modelsListMock, modelsConfigure: vi.fn() },
  frontierLoginStatus: statusMock,
  frontierLogin: vi.fn(),
  frontierLogout: vi.fn(),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  saveProviderConfig: vi.fn(),
  deleteProviderConfig: vi.fn(),
  listProviderConfigs: listProviderConfigsMock,
}));

import { SettingsDialog } from "./SettingsDialog";

beforeEach(() => {
  statusMock.mockResolvedValue({ state: "disconnected" });
  modelsListMock.mockResolvedValue({ providers: [] });
  listProviderConfigsMock.mockResolvedValue([]);
});

describe("SettingsDialog", () => {
  it("renders both groups when open", async () => {
    render(<SettingsDialog open onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /orchestrators/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /model providers/i })).toBeTruthy();
    await waitFor(() => expect(statusMock).toHaveBeenCalledWith("claude-code"));
  });

  it("renders nothing when closed", () => {
    render(<SettingsDialog open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @openfusion/desktop exec vitest run src/components/SettingsDialog.test.tsx`
Expected: FAIL — SettingsDialog still imports the deleted `KeysScreen`, or the headings don't exist.

- [ ] **Step 3: Rewrite `SettingsDialog.tsx`**

Replace the body-composition and drop the `KeysScreen`/`ProvidersPane` code. The dialog shell (backdrop, focus, Esc — keep exactly as-is) now renders the two panes:

```tsx
import { useEffect, useRef } from "react";
import { ModelProvidersPane } from "./ModelProvidersPane";
import { OrchestratorsPane } from "./OrchestratorsPane";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

/** The Settings overlay: the frontier Orchestrators group (Connect to your
 * subscription via the official CLI) and the BYOK Model providers group.
 * Both panes mount fresh on every open, re-fetching their state for free. */
export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="dialog"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <h1 id="settings-title">Settings</h1>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close settings">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="dialog-body">
          <OrchestratorsPane />
          <ModelProvidersPane />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add styles**

Append to `styles.css` (reuse existing `--` tokens; no new colors):

```css
/* -------------------------------------------------------- orchestrators -- */
.orchestrator-list {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}
.orchestrator-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  background: var(--panel);
}
.orchestrator-row + .orchestrator-row {
  border-top: 1px solid var(--line);
}
.orchestrator-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
}
.orchestrator-dot-on {
  background: var(--pass-fg);
}
.orchestrator-dot-off {
  background: var(--ink-3);
}
.orchestrator-name {
  font-weight: 600;
  font-size: 13px;
}
.orchestrator-status {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--ink-2);
}
.orchestrator-action {
  margin-left: auto;
}
```

- [ ] **Step 5: Reconcile `App.test.tsx` (only if it references Settings internals)**

Run the full suite first: `pnpm --filter @openfusion/desktop test 2>&1 | tail -25`.

The M7-era `App.test.tsx` opens Settings and asserts `getByText(/No keys set yet/)`. That copy no longer exists. Update those assertions to the new empty-state copy, e.g. replace `/No keys set yet/` with `/No model providers yet/`, and (if present) the "Keys is not navigation" block still holds. Make ONLY the minimal edits needed for the Settings-related assertions; do not touch unrelated (route) assertions that the concurrent refactor owns. If an assertion belongs to the separately-broken route refactor (a "Project" heading), leave it — note it in the commit body as pre-existing and out of scope.

Re-run: `pnpm --filter @openfusion/desktop test 2>&1 | tail -25` → Expected: the ModelProviders/Orchestrators/SettingsDialog/engineClient/providerCatalog suites all PASS; any remaining failures are the pre-existing route-refactor ones (documented in Task-9 commit body), not from this plan.

- [ ] **Step 6: Typecheck + full Rust suite + commit**

Run: `pnpm --filter @openfusion/desktop exec tsc --noEmit` → Expected: exit 0.
Run: `pnpm --filter @openfusion/desktop test:rust 2>&1 | tail -10` → Expected: PASS.

```bash
git add apps/desktop/src/components/SettingsDialog.tsx apps/desktop/src/components/SettingsDialog.test.tsx apps/desktop/src/styles.css apps/desktop/src/App.test.tsx
git commit -m "feat(desktop): assemble redesigned Settings (Orchestrators + Model providers)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Manual end-to-end (real app)**

Run `./dev.sh app`. Verify: (a) add a DeepSeek key with Keychain on → Save; restart the app → the provider is still listed and a routed orchestrate run resolves to it; (b) open Settings → the Claude Code row shows Checking… then Connected/Not connected; if logged out, Connect launches the CLI login and the row flips to Connected on return. Record any argv corrections from Task 3 §9 here.

---

## Self-Review

**Spec coverage:**
- §4.1 missing wire + durability → Tasks 1 (modelsConfigure), 2 (metadata store), 4 (wrappers), 8 (startup reconfigure), 6 (save flow). ✓
- §4.2 frontier connect via CLI → Tasks 3 (host commands), 4 (wrappers), 7 (pane). ✓
- §5.1 Orchestrators states → Task 7 (checking/connected/disconnected/not-installed/error). ✓
- §5.2 Model providers form (dropdowns, conditional base URL, key + Keychain, list + Remove) → Tasks 5, 6. ✓
- §5.3 catalog + DeepSeek retirement → Task 5. ✓
- §6 invariants → metadata-no-key test (Task 2), no-value-logging preserved (Tasks 6/8 never render key; existing grep tests unchanged), no token handling (Task 3 delegates only). ✓
- §7 error/empty states → Tasks 6 (listError/formError/empty), 7 (error/not-installed). ✓
- §8 testing (frontend + Rust + manual) → each task's tests + Task 9 §7 manual. ✓
- §9 verification items → Task 3 constants + manual step; app config dir → Task 2 lib.rs. ✓

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". The one deferred item (exact CLI argv) is explicitly a manual-verification constant with a tested mapping around it, not a code gap. ✓

**Type consistency:** `ProviderKind`, `ProviderConfigInput`, `ProviderMeta`, `FrontierAuthStatus`, `FrontierEngineKind` defined in Tasks 1/4 and consumed unchanged in 5–9. Rust `ProviderMeta.base_url` ↔ serde `baseURL` ↔ TS `ProviderMeta.baseURL` consistent. Command names (`list_provider_configs`, `save_provider_config`, `delete_provider_config`, `frontier_login_status`, `frontier_login`, `frontier_logout`) identical across Rust (Tasks 2/3) and TS wrappers (Task 4). `engine.models.configure` params `{id, kind, apiKey, baseURL}` match the engine's `ProviderConfigSchema`. ✓

## Known limitation (v1, documented)

Removing a provider clears its key + metadata (so it won't re-register next launch) but the engine's in-memory registry keeps the live entry until the next restart — the engine exposes no `models.unconfigure`. Routing therefore still resolves to a just-removed provider until relaunch. Adding an engine unconfigure method is a follow-up, out of this plan's scope (spec §5.2 accepts "re-registers nothing" on remove).
