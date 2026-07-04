// M7a shell backbone: a Tauri 2 builder with the shell plugin registered,
// the Task 3 `engine_bridge` (spawns the engine sidecar via tokio::process
// and speaks JSON-RPC 2.0 over its stdio — see that module's docs for the
// process-mechanism decision), and the Task 4 `commands` layer (the
// `engine_call`/`engine_events` Tauri commands that bridge the webview's
// `invoke`/`Channel` surface to the bridge). See
// docs/research/2026-07-04-m7-tauri-verification.md for the full
// architecture this scaffold is built toward.
pub mod commands;
pub mod engine_bridge;

use std::path::PathBuf;
use std::sync::Arc;

use engine_bridge::EngineBridge;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
/// **Packaged-path resolution is explicitly out of scope here.** A real
/// `.app` bundle copies the externalBin into `Contents/MacOS/<name>` with
/// the triple suffix stripped, which this function does not handle — per
/// the Task 4 brief, that's Task 5/M8's job (along with the rest of
/// lifecycle finalization: shutdown-on-window-close, etc.). This function
/// exists solely to make Task 4's end-to-end proof runnable in `tauri dev`.
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

#[cfg(test)]
mod tests {
    // Trivial smoke: proves the crate's `run` symbol exists and the crate
    // compiles as a lib target, not just as the `main.rs` bin.
    #[test]
    fn run_symbol_exists() {
        let _ = super::run as fn();
    }
}
