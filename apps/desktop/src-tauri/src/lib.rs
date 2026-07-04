// M7a shell backbone: a bare Tauri 2 builder with the shell plugin
// registered so `Command::sidecar` is available to the bridge landing in
// Task 3. No engine bridge / custom commands here yet — this crate's only
// job right now is to compile and open a single default window. See
// docs/research/2026-07-04-m7-tauri-verification.md for the full
// architecture this scaffold is built toward.
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
