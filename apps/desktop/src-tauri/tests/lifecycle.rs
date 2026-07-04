//! Integration test for the M7a Task 5 "app-exit -> clean shutdown, no
//! orphaned engine process" lifecycle property.
//!
//! Production wiring: `RunEvent::ExitRequested` fires
//! `shutdown_engine_bridge_on_exit` (`src/lib.rs`), a synchronous function
//! that pulls the `Arc<EngineBridge>` out of Tauri state and calls
//! `tauri::async_runtime::block_on(shutdown_engine_bridge_bounded(bridge, ..))`.
//! That needs a live Tauri `App`/`AppHandle`/window to fire at all — exactly
//! the kind of windowing-runtime bootstrap `tests/commands.rs` and
//! `tests/engine_bridge.rs` already avoid pulling in for their own headless
//! coverage (see those files' module docs). This test exercises
//! `shutdown_engine_bridge_bounded` directly instead: the same bounded
//! shutdown logic the sync `RunEvent::ExitRequested` handler calls via
//! `block_on`, against a real (mock-sidecar-backed) `EngineBridge`, and
//! proves the property that actually matters — the child is reaped, bounded,
//! not left as an orphaned OS process.

use std::time::{Duration, Instant};

use openfusion_desktop_lib::engine_bridge::EngineBridge;
use openfusion_desktop_lib::shutdown_engine_bridge_bounded;

fn mock_path(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(match name {
        "ignore_eof" => env!("CARGO_BIN_EXE_mock_ignore_eof"),
        "clean_exit_on_eof" => env!("CARGO_BIN_EXE_mock_clean_exit_on_eof"),
        other => panic!("no mock binary registered for scenario '{other}'"),
    })
}

/// `ps -p <pid>` exits non-zero once `pid` is gone from the OS process
/// table — the direct, external proof that a child was actually reaped
/// (not left running, not a zombie), independent of this crate's own
/// internal bookkeeping. This is the headless version of the OPERATOR
/// SMOKE documented in `apps/desktop/README.md` ("app exit leaves no
/// orphaned engine process — verify with `ps`").
fn pid_still_in_process_table(pid: u32) -> bool {
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string()])
        // `ps`'s own stdout/stderr are irrelevant to the assertion (only
        // its exit status matters) and, being a separate OS process, would
        // otherwise print directly to this test binary's stdout regardless
        // of pass/fail (Rust's per-test output capture only covers this
        // process's own writes, not a child process's).
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("`ps` must be runnable on this platform")
        .success()
}

#[tokio::test]
async fn app_exit_shutdown_reaps_a_well_behaved_child_within_bound() {
    let bridge = EngineBridge::spawn_with_shutdown_timeout(mock_path("clean_exit_on_eof"), Duration::from_secs(2))
        .expect("spawn mock_clean_exit_on_eof");
    let pid = bridge.child_id().await.expect("freshly spawned child must report a pid");

    let started = Instant::now();
    shutdown_engine_bridge_bounded(&bridge, Duration::from_secs(5)).await;
    let elapsed = started.elapsed();

    assert!(
        elapsed < Duration::from_secs(2),
        "a well-behaved child exiting on stdin EOF should make the exit-path shutdown return promptly, took {elapsed:?}"
    );
    assert!(
        !pid_still_in_process_table(pid),
        "pid {pid} must no longer exist in the OS process table once shutdown_engine_bridge_bounded resolves"
    );
}

#[tokio::test]
async fn app_exit_shutdown_reaps_a_child_that_ignores_eof_leaving_no_orphaned_process() {
    // mock_ignore_eof never exits on its own, even after stdin EOF -- the
    // exact shape that would leave an orphaned engine process behind if the
    // exit path only asked nicely (closed stdin) and never force-killed.
    // A short bridge-level shutdown_timeout keeps this test fast while
    // still genuinely exercising the kill-on-overrun path.
    let bridge = EngineBridge::spawn_with_shutdown_timeout(mock_path("ignore_eof"), Duration::from_millis(300))
        .expect("spawn mock_ignore_eof");
    let pid = bridge.child_id().await.expect("freshly spawned child must report a pid");

    let started = Instant::now();
    // The outer bound here mirrors `EXIT_SHUTDOWN_TIMEOUT` in `lib.rs`
    // (defense in depth over the bridge's own internal bound) — comfortably
    // larger than the bridge's 300ms `shutdown_timeout` so it is never the
    // one that fires in a passing run.
    shutdown_engine_bridge_bounded(&bridge, Duration::from_secs(8)).await;
    let elapsed = started.elapsed();

    assert!(
        elapsed < Duration::from_secs(5),
        "the exit-path shutdown must kill an unresponsive child rather than waiting it out, took {elapsed:?}"
    );
    assert!(
        !pid_still_in_process_table(pid),
        "pid {pid} must no longer exist in the OS process table -- a hung engine must still be reaped, not orphaned"
    );
}
