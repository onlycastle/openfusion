// M7a shell backbone: a Tauri 2 builder,
// the Task 3 `engine_bridge` (spawns the engine sidecar via tokio::process
// and speaks JSON-RPC 2.0 over its stdio — see that module's docs for the
// process-mechanism decision), the Task 4 `commands` layer (the
// `engine_call`/`engine_events` Tauri commands that bridge the webview's
// `invoke`/`Channel` surface to the bridge), and Task 5's engine lifecycle
// ownership (spawn in `.setup()`, explicit bounded `shutdown()` wired to
// `RunEvent::ExitRequested` — see `shutdown_engine_bridge_on_exit` below).
// M7b Task 4 adds `secrets` — the Keychain BYOK secret store (memory-default,
// opt-in persist; see that module's docs for the full flow and the
// opted-in-persisted-ids index mechanism).
// See docs/research/2026-07-04-m7-tauri-verification.md for the full
// architecture this scaffold is built toward, and
// docs/superpowers/specs/2026-07-03-harness-fusion-app-design.md §5/§9 for
// how this realizes the spec's shell architecture.
pub mod commands;
pub mod engine_bridge;
pub mod frontier;
pub mod providers;
pub mod secrets;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use engine_bridge::EngineBridge;
use providers::{FileMetaBackend, ProviderConfigStore};
use secrets::{KeyringImpl, SecretStore};
use tauri::Manager;

/// Outer bound on the app-exit shutdown path (`shutdown_engine_bridge_on_exit`).
/// `EngineBridge::shutdown()` already bounds each of its own internal steps
/// (stdin-close, wait-or-kill, reader/stderr task join — see
/// `engine_bridge.rs`), so it always returns on its own; this timeout is
/// defense in depth, not load-bearing, so a future regression in
/// `shutdown()`'s own bounds can never turn into "the app hangs on quit" —
/// it fails open (lets exit proceed) instead. Note that `kill_on_drop(true)`
/// is NOT what backstops that fail-open case: `App::run()` exits via
/// `std::process::exit`, which skips Rust destructors, so the
/// `tokio::process::Child`'s `Drop` (and therefore `kill_on_drop`) never
/// fires on this path regardless of whether this timeout is hit. The real
/// backstop for abnormal termination is the engine's own stdin-EOF-exit
/// discipline: `std::process::exit` tears down this process's file
/// descriptors, which closes the sidecar's stdin pipe from this end; the
/// sidecar's own main loop (`packages/engine/src/main.ts`) treats stdin EOF
/// as "the client is gone" and exits itself, no Rust-side kill required.
const EXIT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // The Project screen's "Choose project…" directory picker
        // (`apps/desktop/src/screens/ProjectScreen.tsx`) calls
        // `@tauri-apps/plugin-dialog`'s `open({directory: true})` — that JS
        // API is backed by this plugin's own Tauri commands (not something
        // `commands.rs` wraps), so it needs registering here plus the
        // `dialog:allow-open` permission grant in
        // `capabilities/default.json` (capabilities gate webview->plugin
        // calls the same way they would gate a call into `commands.rs`).
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // M8 Task 2: dev-vs-packaged dispatch. See
            // `exe_dir_has_packaged_sidecar`'s doc comment for why this is a
            // filesystem existence check rather than `cfg(dev)`/
            // `tauri::is_dev()`. Computed once here (both the binary-path
            // and assets-dir resolutions below reuse `exe_dir`) so the two
            // can never disagree about which mode they're in.
            let exe_path = std::env::current_exe()?;
            let exe_dir = exe_path.parent().ok_or_else(|| {
                std::io::Error::other(format!("current_exe() {} has no parent directory", exe_path.display()))
            })?;
            let binary_path = resolve_sidecar_binary_path_for_exe_dir(exe_dir)?;
            let assets_dir = resolve_assets_dir_for_exe_dir(app, exe_dir, &binary_path)?;

            // `EngineBridge::spawn` is synchronous but calls `tokio::spawn`
            // internally (its reader/stderr background tasks) — it must run
            // inside an entered tokio runtime context. Tauri's own async
            // runtime (`tauri::async_runtime`) is exactly that runtime (see
            // that module's docs: it lazily creates a multi-thread tokio
            // Runtime, stored for the app's whole lifetime, the first time
            // any of its functions are called) — `enter()`'ing its handle
            // for the duration of `spawn()` gives `tokio::spawn` a valid
            // context without needing an `async fn`/`block_on` here. The
            // runtime itself outlives this guard (it lives in a `static`),
            // so the reader/stderr tasks keep running after `setup` returns.
            let bridge = {
                let runtime_handle = tauri::async_runtime::handle();
                let _guard = runtime_handle.inner().enter();
                EngineBridge::spawn_with_assets_dir(binary_path, Some(assets_dir))?
            };
            app.manage(Arc::new(bridge));

            // Keychain BYOK secret store (see `secrets.rs` module doc for
            // the full memory-default/opt-in-persist flow). Managed state
            // is created fresh (empty memory map) every launch; the
            // `load_persisted()` call right after is what restores any
            // previously opted-in-to-persist secrets from the Keychain
            // BEFORE the webview can possibly ask for one — this is the
            // Rust-side half of the "persist a key -> quit -> relaunch ->
            // restored" operator smoke (see `secrets.rs` tests module doc).
            let secret_store = Arc::new(SecretStore::new(Arc::new(KeyringImpl::new())));
            secret_store.load_persisted();
            app.manage(secret_store);

            // Non-secret provider metadata store (see `providers.rs`). Pairs with the
            // Keychain on startup-reconfigure (webview-driven) to re-register providers.
            let providers_path = app
                .path()
                .app_config_dir()
                .map_err(|err| std::io::Error::other(format!("no app config dir: {err}")))?
                .join("providers.json");
            app.manage(Arc::new(ProviderConfigStore::new(Arc::new(FileMetaBackend::new(providers_path)))));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::engine_call,
            commands::engine_events,
            secrets::set_secret,
            secrets::get_secret,
            secrets::delete_secret,
            secrets::list_secret_ids,
            secrets::load_persisted_secrets,
            providers::list_provider_configs,
            providers::save_provider_config,
            providers::delete_provider_config,
            frontier::frontier_login_status,
            frontier::frontier_login,
            frontier::frontier_logout,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // `.run()` (not `.build().run()` with the context passed directly) so
    // this closure can observe `RunEvent::ExitRequested` — the one point in
    // Tauri's lifecycle, guaranteed to fire before the process actually
    // exits, where the engine sidecar can still be shut down gracefully.
    // See `shutdown_engine_bridge_on_exit`'s doc comment for why this is
    // the load-bearing hook (not `kill_on_drop`, and not a window
    // `CloseRequested` handler).
    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            shutdown_engine_bridge_on_exit(app_handle);
        }
    });
}

/// Runs on `RunEvent::ExitRequested` — fired once, whichever comes first of
/// the last window closing, `AppHandle::exit()`, or (on macOS) Cmd+Q. This
/// is the load-bearing hook for "no orphaned engine process on exit", for
/// two reasons:
///
/// 1. **`kill_on_drop(true)` (`engine_bridge.rs`) is not actually reachable
///    on the normal quit path.** Tauri's own `App::run()` docs say plainly:
///    "When the application finishes, the process is exited directly using
///    `std::process::exit`" — which does not run Rust destructors. The
///    `Arc<EngineBridge>` sitting in Tauri's managed state (and the
///    `tokio::process::Child` inside it) would never have its `Drop` run at
///    all on a graceful quit, so `kill_on_drop` alone is not a safety net
///    for *this* path — it only helps on an abnormal unwind. Calling
///    `shutdown()` explicitly, from here, is therefore the only way the
///    sidecar reliably gets its stdin-EOF chance to exit gracefully (and,
///    failing that, a bounded kill+reap) before the process disappears.
/// 2. A single `WindowEvent::CloseRequested` handler would only cover "the
///    user clicked this window's close button" — it would miss
///    `AppHandle::exit()` and would need per-window bookkeeping for "is
///    this the last window" in any future multi-window UI (M7b's cockpit).
///    `RunEvent::ExitRequested` is the one hook that already accounts for
///    all of that, which is why it — not `CloseRequested` — is used here.
///
/// **Does NOT cover main-thread `AppHandle::restart()`.** Tauri 2.11's
/// `App::run()` (`app.rs:588`) explicitly skips delivering `ExitRequested`
/// (and the rest of the exit-callback machinery) when `restart()` is called
/// from the main thread — its own comment says "we cannot guarantee the
/// delivery of those events, so we skip them." A future M8 auto-updater
/// that wants a clean sidecar shutdown before restarting must call
/// `request_restart()` instead of `restart()`: unlike main-thread
/// `restart()`, `request_restart()` always goes through the normal
/// `request_exit` runtime path and DOES deliver `ExitRequested`, so this
/// same `shutdown_engine_bridge_on_exit` hook still runs. Reaching for
/// `restart()` directly on the main thread would reintroduce the orphaned-
/// engine-process bug this milestone fixes.
///
/// `RunEvent` handlers are synchronous (Tauri's event loop calls this
/// closure directly on the main/event-loop thread), but `EngineBridge::shutdown()`
/// is `async fn`. `tauri::async_runtime::block_on` bridges the two: it
/// blocks *this* thread while driving the future to completion on Tauri's
/// own tokio runtime, which runs on its own worker threads — never the
/// main/event-loop thread — so blocking here cannot self-deadlock.
fn shutdown_engine_bridge_on_exit(app_handle: &tauri::AppHandle) {
    let Some(state) = app_handle.try_state::<Arc<EngineBridge>>() else {
        // `.setup()` never reached `app.manage(...)` (e.g. it failed and
        // the app is already panicking its way out) — nothing to shut down.
        return;
    };
    let bridge: &EngineBridge = state.inner();
    tauri::async_runtime::block_on(shutdown_engine_bridge_bounded(bridge, EXIT_SHUTDOWN_TIMEOUT));
}

/// The actual "shut the bridge down within a bound" logic, factored out of
/// [`shutdown_engine_bridge_on_exit`] so `cargo test` can exercise it
/// directly against a mock-sidecar-backed `EngineBridge` (see
/// `tests/lifecycle.rs`) without bootstrapping a real Tauri
/// `App`/`AppHandle`/window — the same split `commands.rs` uses for
/// `route_engine_call`/`forward_notifications`. `pub` for that reason.
pub async fn shutdown_engine_bridge_bounded(bridge: &EngineBridge, bound: Duration) {
    let _ = tokio::time::timeout(bound, bridge.shutdown()).await;
}

/// Dev-only resolution of the engine sidecar binary staged by
/// `pnpm --filter @openfusion/desktop stage-sidecar`
/// (`apps/desktop/scripts/stage-sidecar.mjs`), which copies Task 1's
/// compiled `packages/engine/dist-sidecar/openfusion-engine-<triple>`
/// (+ its `.assets` sibling directory) into
/// `apps/desktop/src-tauri/binaries/`.
///
/// Rather than re-deriving the platform->Rust-target-triple table
/// `stage-sidecar.mjs` (and, before it, `packages/engine`'s own
/// `build-sidecar.mjs`) already own — a third copy of that mapping would
/// just be one more place for the three to silently drift — this scans
/// `binaries/` for the one staged entry: any file (not its `.assets`
/// directory sibling) whose name starts with `openfusion-engine-`.
/// `stage-sidecar.mjs` only ever stages one binary per host, so "the one
/// matching entry" is an unambiguous, triple-agnostic selector.
///
/// **Packaged-path resolution lives separately**, in
/// [`resolve_packaged_sidecar_binary_path`] below — see that function's doc
/// comment for the M8 boundary (why it exists but isn't wired into
/// `.setup()`'s dispatch yet). This function exists solely to make `tauri
/// dev`'s end-to-end proof runnable.
fn resolve_dev_sidecar_binary_path() -> std::io::Result<PathBuf> {
    let binaries_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let entries = std::fs::read_dir(&binaries_dir).map_err(|err| {
        std::io::Error::new(
            err.kind(),
            format!(
                "engine sidecar binaries dir not found at {} ({err}). Run \
                 `pnpm --filter @openfusion/engine build:sidecar && pnpm --filter @openfusion/desktop stage-sidecar` \
                 first.",
                binaries_dir.display()
            ),
        )
    })?;

    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("openfusion-engine-") && !name.ends_with(".assets") && entry.file_type()?.is_file() {
            return Ok(entry.path());
        }
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!(
            "no staged engine sidecar binary found in {}. Run \
             `pnpm --filter @openfusion/engine build:sidecar && pnpm --filter @openfusion/desktop stage-sidecar` \
             first.",
            binaries_dir.display()
        ),
    ))
}

/// Packaged-build (`tauri build` `.app`/installer) resolution of the engine
/// sidecar binary path.
///
/// ## The mechanism (verified against Tauri's own source)
///
/// A bundled sidecar lands next to the app's own executable —
/// `<App>.app/Contents/MacOS/` on macOS — with the `externalBin` naming
/// convention's `-<triple>` suffix stripped (`tauri.conf.json`:
/// `"externalBin": ["binaries/openfusion-engine"]`). This mirrors exactly
/// what `tauri-plugin-shell`'s own `Command::sidecar` does internally
/// (`relative_command_path` in that crate: join `current_exe()`'s parent
/// directory with the sidecar's bare name) — confirmed by reading
/// `tauri-plugin-shell` 2.3.5's source directly rather than assuming, since
/// this crate deliberately does not depend on that resolution helper (see
/// `engine_bridge.rs`'s module doc for why `tokio::process` is used
/// directly instead of `Command::sidecar`).
///
/// [`packaged_sidecar_path_from_exe_dir`] is the pure half of this (unit
/// tested below with a fake directory, since faking `current_exe()` itself
/// isn't possible without OS-level tricks); this function is the thin,
/// untestable-without-a-real-binary wrapper around it.
///
/// Wired into `.setup()`'s dispatch via [`resolve_sidecar_binary_path_for_exe_dir`]
/// — see that function's doc comment, and [`exe_dir_has_packaged_sidecar`]'s,
/// for the dev-vs-packaged signal that decides when this gets called instead
/// of [`resolve_dev_sidecar_binary_path`].
pub fn resolve_packaged_sidecar_binary_path() -> std::io::Result<PathBuf> {
    let exe_path = std::env::current_exe()?;
    let exe_dir = exe_path.parent().ok_or_else(|| {
        std::io::Error::other(format!("current_exe() {} has no parent directory", exe_path.display()))
    })?;
    Ok(packaged_sidecar_path_from_exe_dir(exe_dir))
}

/// Pure half of [`resolve_packaged_sidecar_binary_path`]: joins the running
/// executable's directory with the bundled (triple-suffix-stripped) sidecar
/// name. Factored out so it can be unit tested against a fake directory
/// without needing a real packaged `.app` on disk.
fn packaged_sidecar_path_from_exe_dir(exe_dir: &Path) -> PathBuf {
    let name = if cfg!(windows) { "openfusion-engine.exe" } else { "openfusion-engine" };
    exe_dir.join(name)
}

// --- M8 Task 2: dev-vs-packaged dispatch ------------------------------

/// True if `exe_dir` (the directory containing the currently-running
/// executable) also contains the packaged sidecar binary sitting right next
/// to it. This — not `cfg(dev)`/`tauri::is_dev()` — is the dev-vs-packaged
/// signal [`resolve_sidecar_binary_path_for_exe_dir`] and
/// [`resolve_assets_dir_for_exe_dir`] dispatch on.
///
/// ## Why not `cfg(dev)` / `tauri::is_dev()`
///
/// [`resolve_packaged_sidecar_binary_path`]'s previous doc comment (see git
/// history) found that `tauri-build`'s `cfg(dev)` alias evaluates `true`
/// unconditionally here, in *both* `tauri dev` and `tauri build`: it derives
/// from `dev = !custom_protocol`, where `custom_protocol` is whether the
/// `tauri` crate itself was compiled with its own `custom-protocol`
/// feature, and this crate's `Cargo.toml` never forwards that feature
/// (`tauri/custom-protocol`) — so it's permanently off, and `cfg(dev)`
/// permanently true. `tauri::is_dev()` (`tauri`'s public runtime helper,
/// `!cfg!(feature = "custom-protocol")` evaluated inside the `tauri` crate
/// itself) is driven by the *exact same* feature and has the identical gap.
///
/// Fixing that gap by adding `custom-protocol = ["tauri/custom-protocol"]`
/// to `Cargo.toml` (the standard Tauri scaffold convention) is possible, but
/// it would mean trusting that the Tauri CLI reliably toggles that feature
/// between `tauri dev` and `tauri build` invocations — real, documented
/// Tauri behavior, but its exact invocation flags live inside a compiled
/// `@tauri-apps/cli` platform binary, not source available in this repo to
/// independently confirm. Getting this wrong would silently break the
/// packaged app's sidecar dispatch in a way this milestone's headless tests
/// cannot catch (the packaged branch can only be proven end-to-end against
/// a real `.app` — see the module-level "M8 boundary" notes throughout this
/// file).
///
/// ## The mechanism actually used
///
/// A packaged `.app` always ships the sidecar right next to its main
/// executable (`Contents/MacOS/openfusion-engine`, see
/// [`packaged_sidecar_path_from_exe_dir`]); `tauri dev` never does — the
/// main binary runs from `target/debug/`, and the staged sidecar is a
/// *differently named* (triple-suffixed), sibling-directory file
/// (`binaries/openfusion-engine-<triple>`), never a bare
/// `openfusion-engine` sitting next to `target/debug/openfusion-desktop`.
/// Checking "does `<exe_dir>/openfusion-engine` exist" is therefore a
/// direct, self-verifying test of the exact condition this dispatch cares
/// about — no Cargo feature, no assumption about CLI invocation flags, and
/// (unlike `cfg(dev)`) it is a *runtime* check, so both branches of the
/// dispatch it feeds are real, reachable code paths a single test binary
/// can exercise by injecting a fake `exe_dir` (see the tests module below).
fn exe_dir_has_packaged_sidecar(exe_dir: &Path) -> bool {
    packaged_sidecar_path_from_exe_dir(exe_dir).is_file()
}

/// Resolves the engine sidecar binary path for either mode, given the
/// directory the running executable lives in. The only I/O here is
/// [`exe_dir_has_packaged_sidecar`]'s `is_file` check and, in the dev
/// branch, [`resolve_dev_sidecar_binary_path`]'s directory scan — so tests
/// exercise both branches by injecting a fake `exe_dir` (a temp dir with or
/// without a dummy packaged-sidecar file), without needing a real `.app`.
/// `.setup()` is the only real call site, passing the actual running
/// process's own exe dir.
fn resolve_sidecar_binary_path_for_exe_dir(exe_dir: &Path) -> std::io::Result<PathBuf> {
    if exe_dir_has_packaged_sidecar(exe_dir) {
        Ok(packaged_sidecar_path_from_exe_dir(exe_dir))
    } else {
        resolve_dev_sidecar_binary_path()
    }
}

/// Dev-mode assets dir: the engine sidecar's own `${execPath}.assets`
/// self-location convention (see `stage-sidecar.mjs`'s module doc) —
/// computed directly from the resolved `binary_path` so this crate and the
/// engine can never disagree about it, rather than re-deriving
/// `CARGO_MANIFEST_DIR`-relative paths a second time. Setting
/// `OPENFUSION_ASSETS_DIR` to this in dev too (rather than leaving it unset
/// and relying purely on the engine's own fallback) is deliberate: one
/// resolution path for both modes is simpler to reason about and test than
/// "set it in packaged, leave it unset in dev" would be, and it is
/// semantically a no-op in dev — the value computed here is identical to
/// what `${execPath}.assets` already resolves to on the engine side, since
/// `binary_path` in dev *is* the sidecar's own `execPath`.
fn dev_assets_dir_from_binary_path(binary_path: &Path) -> PathBuf {
    let mut assets = binary_path.as_os_str().to_os_string();
    assets.push(".assets");
    PathBuf::from(assets)
}

/// Packaged-mode assets dir shape: `<resource_dir>/assets`. Pure half of
/// [`resolve_packaged_assets_dir`] below, unit-tested with a fake resource
/// dir since a real one needs a live `tauri::App` — mirrors the
/// [`packaged_sidecar_path_from_exe_dir`] split above.
///
/// This is the same shape `app.path().resolve("assets",
/// BaseDirectory::Resource)` produces: reading tauri 2.11.5's
/// `path::resolve_path` (`tauri-2.11.5/src/path/mod.rs`) shows that for a
/// single-component relative path like `"assets"` — no root/`..` components
/// to sanitize — `BaseDirectory::Resource` resolution reduces to exactly
/// `resource_dir().join("assets")`. Calling `resource_dir()` and joining
/// ourselves (see [`resolve_packaged_assets_dir`]) is therefore equivalent
/// while staying independently testable here.
fn packaged_assets_dir_from_resource_dir(resource_dir: &Path) -> PathBuf {
    resource_dir.join("assets")
}

/// Packaged-mode assets dir, resolved through Tauri's own resource-dir API
/// (`${exe_dir}/../Resources` on macOS, i.e. `Contents/Resources`). Needs a
/// real `tauri::App` — like [`resolve_packaged_sidecar_binary_path`], this
/// is the thin, untestable-without-a-real-app wrapper around the tested
/// pure half, [`packaged_assets_dir_from_resource_dir`].
///
/// `tauri.conf.json`'s `bundle.resources` entry
/// (`"binaries/openfusion-engine.assets": "assets"`) maps the staged
/// `.assets/` dir to an `assets/` subdirectory of `Contents/Resources`,
/// matching this exactly — see that file and `stage-sidecar.mjs` for the
/// other end of this mapping.
fn resolve_packaged_assets_dir(app: &tauri::App) -> tauri::Result<PathBuf> {
    let resource_dir = app.path().resource_dir()?;
    Ok(packaged_assets_dir_from_resource_dir(&resource_dir))
}

/// `.setup()`'s assets-dir dispatch, using the exact same
/// [`exe_dir_has_packaged_sidecar`] signal as
/// [`resolve_sidecar_binary_path_for_exe_dir`] so the two resolutions can
/// never disagree about which mode they're in (`.setup()` computes
/// `exe_dir` once and passes it to both).
fn resolve_assets_dir_for_exe_dir(app: &tauri::App, exe_dir: &Path, binary_path: &Path) -> tauri::Result<PathBuf> {
    if exe_dir_has_packaged_sidecar(exe_dir) {
        resolve_packaged_assets_dir(app)
    } else {
        Ok(dev_assets_dir_from_binary_path(binary_path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Trivial smoke: proves the crate's `run` symbol exists and the crate
    // compiles as a lib target, not just as the `main.rs` bin.
    #[test]
    fn run_symbol_exists() {
        let _ = super::run as fn();
    }

    #[test]
    fn packaged_sidecar_path_joins_exe_dir_with_triple_less_name() {
        let exe_dir = Path::new("/Applications/OpenFusion.app/Contents/MacOS");
        let resolved = packaged_sidecar_path_from_exe_dir(exe_dir);
        let expected_name = if cfg!(windows) { "openfusion-engine.exe" } else { "openfusion-engine" };
        assert_eq!(resolved, exe_dir.join(expected_name));
        // The triple suffix (e.g. `-aarch64-apple-darwin`, which
        // `resolve_dev_sidecar_binary_path` above must scan for) must NOT
        // appear here -- the bundler strips it, matching
        // `tauri-plugin-shell`'s own sidecar-resolution convention.
        assert!(!resolved.to_string_lossy().contains("-apple-darwin"));
    }

    // --- M8 Task 2: dev-vs-packaged dispatch --------------------------

    /// Creates a fresh, empty temp directory unique to this test process +
    /// an incrementing counter (parallel `cargo test` runs many tests
    /// concurrently in the same process, so a counter -- not just the pid --
    /// keeps every call's directory distinct). No `tempfile` dependency
    /// needed for this: plain `std::fs` is enough for a directory that only
    /// needs to exist for the duration of one test.
    fn unique_temp_dir(label: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("openfusion-desktop-test-{label}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create unique temp test dir");
        dir
    }

    #[test]
    fn exe_dir_has_packaged_sidecar_false_when_absent() {
        let dir = unique_temp_dir("no-sidecar");
        assert!(!exe_dir_has_packaged_sidecar(&dir), "an empty dir must not look packaged");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn exe_dir_has_packaged_sidecar_true_when_present() {
        let dir = unique_temp_dir("with-sidecar");
        let expected_name = if cfg!(windows) { "openfusion-engine.exe" } else { "openfusion-engine" };
        std::fs::write(dir.join(expected_name), b"#!/bin/sh\n").expect("write dummy sidecar file");
        assert!(exe_dir_has_packaged_sidecar(&dir), "a dir with the triple-less sidecar name must look packaged");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn exe_dir_has_packaged_sidecar_false_for_a_directory_of_that_name() {
        // The check is deliberately `is_file`, not just `exists` -- a
        // directory happening to share the name must not be mistaken for
        // the packaged sidecar binary.
        let dir = unique_temp_dir("sidecar-is-a-dir");
        let expected_name = if cfg!(windows) { "openfusion-engine.exe" } else { "openfusion-engine" };
        std::fs::create_dir_all(dir.join(expected_name)).expect("create dir shadowing the sidecar name");
        assert!(!exe_dir_has_packaged_sidecar(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_sidecar_binary_path_for_exe_dir_prefers_packaged_when_present() {
        let dir = unique_temp_dir("dispatch-packaged");
        let expected_name = if cfg!(windows) { "openfusion-engine.exe" } else { "openfusion-engine" };
        std::fs::write(dir.join(expected_name), b"#!/bin/sh\n").expect("write dummy sidecar file");

        let resolved =
            resolve_sidecar_binary_path_for_exe_dir(&dir).expect("packaged branch never touches CARGO_MANIFEST_DIR");
        assert_eq!(resolved, dir.join(expected_name));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_sidecar_binary_path_for_exe_dir_falls_back_to_dev_when_absent() {
        // No packaged sidecar next to this fake exe_dir -- falls through to
        // `resolve_dev_sidecar_binary_path`, which scans the REAL
        // `binaries/` dir staged by `stage-sidecar.mjs` for this crate's own
        // tests (see that function's doc comment). This is the "dev-cfg"
        // branch proof: a real filesystem scan, not a further mock.
        let dir = unique_temp_dir("dispatch-dev");

        let resolved = resolve_sidecar_binary_path_for_exe_dir(&dir).expect(
            "dev binaries dir should be staged for tests -- run `pnpm --filter @openfusion/engine build:sidecar \
             && pnpm --filter @openfusion/desktop stage-sidecar` first",
        );
        assert!(
            resolved.to_string_lossy().contains("openfusion-engine-"),
            "dev resolution must return the triple-suffixed staged binary, got {resolved:?}"
        );
        // Must NOT be inside our fake packaged exe_dir -- proves the dev
        // branch, not the packaged one, was actually taken.
        assert!(!resolved.starts_with(&dir));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dev_assets_dir_appends_dot_assets_suffix_to_binary_filename() {
        let binary = Path::new("/repo/apps/desktop/src-tauri/binaries/openfusion-engine-aarch64-apple-darwin");
        let assets = dev_assets_dir_from_binary_path(binary);
        assert_eq!(
            assets,
            PathBuf::from("/repo/apps/desktop/src-tauri/binaries/openfusion-engine-aarch64-apple-darwin.assets")
        );
    }

    #[test]
    fn packaged_assets_dir_joins_resource_dir_with_assets() {
        let resource_dir = Path::new("/Applications/OpenFusion.app/Contents/Resources");
        let assets = packaged_assets_dir_from_resource_dir(resource_dir);
        assert_eq!(assets, resource_dir.join("assets"));
        assert_eq!(assets, PathBuf::from("/Applications/OpenFusion.app/Contents/Resources/assets"));
    }
}
