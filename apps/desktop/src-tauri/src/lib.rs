// M7a shell backbone: a Tauri 2 builder with the shell plugin registered,
// the Task 3 `engine_bridge` (spawns the engine sidecar via tokio::process
// and speaks JSON-RPC 2.0 over its stdio — see that module's docs for the
// process-mechanism decision), the Task 4 `commands` layer (the
// `engine_call`/`engine_events` Tauri commands that bridge the webview's
// `invoke`/`Channel` surface to the bridge), and Task 5's engine lifecycle
// ownership (spawn in `.setup()`, explicit bounded `shutdown()` wired to
// `RunEvent::ExitRequested` — see `shutdown_engine_bridge_on_exit` below).
// See docs/research/2026-07-04-m7-tauri-verification.md for the full
// architecture this scaffold is built toward, and
// docs/superpowers/specs/2026-07-03-harness-fusion-app-design.md §5/§9 for
// how this realizes the spec's shell architecture.
pub mod commands;
pub mod engine_bridge;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use engine_bridge::EngineBridge;
use tauri::Manager;

/// Outer bound on the app-exit shutdown path (`shutdown_engine_bridge_on_exit`).
/// `EngineBridge::shutdown()` already bounds each of its own internal steps
/// (stdin-close, wait-or-kill, reader/stderr task join — see
/// `engine_bridge.rs`), so it always returns on its own; this timeout is
/// defense in depth, not load-bearing, so a future regression in
/// `shutdown()`'s own bounds can never turn into "the app hangs on quit" —
/// it fails open (lets exit proceed) instead, with the sidecar's
/// `kill_on_drop(true)` as the last-resort backstop if that ever triggers.
const EXIT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(8);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let binary_path = resolve_dev_sidecar_binary_path()?;

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
                EngineBridge::spawn(binary_path)?
            };
            app.manage(Arc::new(bridge));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::engine_call, commands::engine_events])
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
/// the last window closing, `AppHandle::exit`/`restart`, or (on macOS)
/// Cmd+Q. This is the load-bearing hook for "no orphaned engine process on
/// exit", for two reasons:
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
///    `AppHandle::exit()`/`restart()` and would need per-window bookkeeping
///    for "is this the last window" in any future multi-window UI (M7b's
///    cockpit). `RunEvent::ExitRequested` is the one hook that already
///    accounts for all of that, which is why it — not `CloseRequested` — is
///    used here.
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
/// ## The mechanism (implementable now, verified against Tauri's own source)
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
/// ## M8 boundary — why this is NOT wired into `.setup()`'s dispatch yet
///
/// `setup()` above unconditionally calls [`resolve_dev_sidecar_binary_path`].
/// Switching between that and this function at runtime needs a reliable
/// "am I in a packaged build or `tauri dev`" signal. Tauri provides exactly
/// one, a `cfg(dev)` alias `tauri-build`'s `build.rs` sets — but it derives
/// from the crate's own `custom-protocol` Cargo feature
/// (`dev = !custom_protocol`), and this scaffold's `Cargo.toml` (Task 2)
/// never defined that feature or wired the Tauri CLI's usual
/// `--no-default-features`-in-dev / default-features-in-build convention —
/// so `cfg(dev)` would evaluate `true` unconditionally here, in *both*
/// `tauri dev` and `tauri build`. Branching on it as-is would silently
/// always pick the dev path, which is worse than not branching at all.
///
/// Wiring that convention (the `custom-protocol` feature + `cfg(dev)`
/// dispatch) belongs with the rest of M8's packaging work — the same
/// milestone that does signing/entitlements/notarization (see
/// `apps/desktop/README.md`'s "Packaging (M8)" section) and is the first
/// point this path can actually be exercised end-to-end anyway (it only
/// means anything inside a real `tauri build` bundle). Flagging the exact
/// gap here rather than guessing at a half-wired runtime switch.
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
}
