// M7a shell backbone: a bare Tauri 2 builder with the shell plugin
// registered. Task 3 adds `engine_bridge` (spawns the engine sidecar via
// tokio::process and speaks JSON-RPC 2.0 over its stdio — see that
// module's docs for the process-mechanism decision); it is not yet wired
// into a Tauri command/managed state (that's Task 4), but is exposed here
// so both the app and its tests can use it. See
// docs/research/2026-07-04-m7-tauri-verification.md for the full
// architecture this scaffold is built toward.
pub mod engine_bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    // Trivial smoke: proves the crate's `run` symbol exists and the crate
    // compiles as a lib target, not just as the `main.rs` bin. The real
    // bridge logic + its tests are Task 3.
    #[test]
    fn run_symbol_exists() {
        let _ = super::run as fn();
    }
}
