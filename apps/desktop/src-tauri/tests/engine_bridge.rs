//! Integration tests for `EngineBridge` against scripted mock sidecars
//! (see `src/bin/mock_*.rs` + `src/bin/support/mock_common.rs`).
//!
//! These run headlessly under `cargo test` — no Tauri app, no window, no
//! real engine binary required. Each mock binary is a genuine separate
//! process (built by Cargo as an ordinary `[[bin]]` target and located via
//! `CARGO_BIN_EXE_<name>`), so these tests exercise the real
//! `tokio::process` spawn/stdio/kill path, not a fake.

use serde_json::json;
use std::time::{Duration, Instant};

use openfusion_desktop_lib::engine_bridge::EngineBridge;

fn mock_path(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(match name {
        "echo" => env!("CARGO_BIN_EXE_mock_echo"),
        "reverse3" => env!("CARGO_BIN_EXE_mock_reverse3"),
        "error" => env!("CARGO_BIN_EXE_mock_error"),
        "notify" => env!("CARGO_BIN_EXE_mock_notify"),
        "malformed_between" => env!("CARGO_BIN_EXE_mock_malformed_between"),
        "die_on_request" => env!("CARGO_BIN_EXE_mock_die_on_request"),
        "clean_exit_on_eof" => env!("CARGO_BIN_EXE_mock_clean_exit_on_eof"),
        "ignore_eof" => env!("CARGO_BIN_EXE_mock_ignore_eof"),
        "stdin_black_hole" => env!("CARGO_BIN_EXE_mock_stdin_black_hole"),
        other => panic!("no mock binary registered for scenario '{other}'"),
    })
}

const SHORT_TIMEOUT: Duration = Duration::from_millis(300);

#[tokio::test]
async fn call_correlates_response_by_id() {
    let bridge = EngineBridge::spawn(mock_path("echo")).expect("spawn mock_echo");

    let result = bridge
        .call("wiki.search", json!({"n": 1}))
        .await
        .expect("echo scenario always succeeds");

    assert_eq!(result, json!({"n": 1}));
}

#[tokio::test]
async fn concurrent_calls_each_get_their_own_response_no_cross_talk() {
    let bridge = EngineBridge::spawn(mock_path("reverse3")).expect("spawn mock_reverse3");

    // mock_reverse3 reads all 3 requests, then answers in REVERSE arrival
    // order, each response echoing back that request's own params. If the
    // bridge ever mis-routed a response to the wrong pending caller, one of
    // these assertions would fail (result != what that call sent).
    let (a, b, c) = tokio::join!(
        bridge.call("m.a", json!({"who": "a"})),
        bridge.call("m.b", json!({"who": "b"})),
        bridge.call("m.c", json!({"who": "c"})),
    );

    assert_eq!(a.expect("call a"), json!({"who": "a"}));
    assert_eq!(b.expect("call b"), json!({"who": "b"}));
    assert_eq!(c.expect("call c"), json!({"who": "c"}));
}

#[tokio::test]
async fn error_response_becomes_rpc_error() {
    let bridge = EngineBridge::spawn(mock_path("error")).expect("spawn mock_error");

    let err = bridge
        .call("worker.run", json!({}))
        .await
        .expect_err("error scenario always fails");

    assert_eq!(err.code, 123);
    assert_eq!(err.message, "boom");
    assert_eq!(err.data, Some(json!({"detail": "nope"})));
}

#[tokio::test]
async fn notification_reaches_subscriber() {
    let bridge = EngineBridge::spawn(mock_path("notify")).expect("spawn mock_notify");
    let mut notifications = bridge.subscribe();

    // mock_notify answers the call AND THEN emits an unsolicited
    // notification, so by the time call() resolves the notification has
    // already been written to stdout (possibly not yet read/routed by the
    // reader task, but subscribe() was created before either happened, so
    // the broadcast channel holds it regardless of exact timing).
    bridge.call("orchestrate.run", json!({})).await.expect("call succeeds");

    let notification = tokio::time::timeout(Duration::from_secs(2), notifications.recv())
        .await
        .expect("notification should arrive within bound")
        .expect("channel should not have lagged/closed");

    assert_eq!(notification["method"], "orchestrate.progress");
    assert_eq!(notification["params"]["pct"], 50);
}

#[tokio::test]
async fn malformed_stdout_line_does_not_crash_reader() {
    let bridge = EngineBridge::spawn(mock_path("malformed_between")).expect("spawn mock_malformed_between");

    // mock_malformed_between writes: response, GARBAGE line, response.
    // Both calls must still resolve successfully — the garbage line in
    // between must not have killed the reader task.
    let (first, second) = tokio::join!(bridge.call("a", json!({})), bridge.call("b", json!({})),);

    let first = first.expect("first call should still succeed despite malformed line");
    let second = second.expect("second call should still succeed despite malformed line");

    let mut slots: Vec<&str> = vec![first["slot"].as_str().unwrap(), second["slot"].as_str().unwrap()];
    slots.sort_unstable();
    assert_eq!(slots, vec!["first", "second"]);
}

#[tokio::test]
async fn child_death_mid_call_resolves_to_error_not_a_hang() {
    let bridge = EngineBridge::spawn(mock_path("die_on_request")).expect("spawn mock_die_on_request");

    // mock_die_on_request reads the request then exits(1) without ever
    // responding. The call must resolve to an Err once stdout closes,
    // within a bound — not hang forever. (5s, not 5ms: this just needs to
    // rule out "hangs forever", and leaves headroom under parallel-test
    // scheduling load; in practice it resolves in well under 100ms.)
    let outcome = tokio::time::timeout(Duration::from_secs(5), bridge.call("orchestrate.run", json!({})))
        .await
        .expect("call must resolve within the bound, not hang");

    assert!(outcome.is_err(), "a dead child must produce an RpcError, not a successful result");
}

#[tokio::test]
async fn cancelled_call_does_not_leak_its_pending_map_entry() {
    let bridge = EngineBridge::spawn(mock_path("ignore_eof")).expect("spawn mock_ignore_eof");

    // mock_ignore_eof reads and discards stdin lines forever without ever
    // writing a response, so this call() can never resolve on its own.
    // Wrapping it in a short timeout and letting that timeout fire drops
    // the call() future mid-flight -- exactly the cancellation shape a
    // Tauri command with a per-call deadline will produce.
    let outcome = tokio::time::timeout(Duration::from_millis(100), bridge.call("never.responds", json!({}))).await;
    assert!(outcome.is_err(), "the mock never responds; the timeout should fire, not the call");

    assert_eq!(
        bridge.pending_len(),
        0,
        "cancelling the call() future must remove its pending-map entry, not leak it"
    );
}

#[tokio::test]
async fn second_call_after_full_child_death_also_resolves_promptly_not_a_hang() {
    let bridge = EngineBridge::spawn(mock_path("die_on_request")).expect("spawn mock_die_on_request");

    // mock_die_on_request reads a request then exit(1)s without
    // responding. The first call resolves to an error once stdout closes
    // (covered by `child_death_mid_call_resolves_to_error_not_a_hang`
    // above) -- this test's concern is what happens *after* the child is
    // fully, unambiguously dead: does a second call still resolve
    // promptly, or does it hang because e.g. stale state from the first
    // call lingers?
    let first = tokio::time::timeout(Duration::from_secs(5), bridge.call("first", json!({})))
        .await
        .expect("first call must resolve within the bound, not hang");
    assert!(first.is_err(), "child dies without responding; the first call must error");

    // Give the child's exit and the reader task's EOF-driven cleanup a
    // moment to fully settle, so this genuinely exercises "child already
    // fully dead" rather than racing the tail end of its exit.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let second = tokio::time::timeout(Duration::from_secs(5), bridge.call("second", json!({})))
        .await
        .expect("second call must resolve within the bound, not hang");
    assert!(
        second.is_err(),
        "a second call after the child is fully dead must also error (broken-pipe write), not hang"
    );
}

#[tokio::test]
async fn shutdown_terminates_cleanly_when_child_exits_on_eof() {
    let bridge = EngineBridge::spawn_with_shutdown_timeout(mock_path("clean_exit_on_eof"), Duration::from_secs(2))
        .expect("spawn mock_clean_exit_on_eof");

    let started = Instant::now();
    bridge.shutdown().await;
    let elapsed = started.elapsed();

    assert!(
        elapsed < Duration::from_secs(2),
        "a well-behaved child should exit on EOF well before the shutdown timeout, took {elapsed:?}"
    );

    // A call after shutdown must error, not hang.
    let outcome = tokio::time::timeout(Duration::from_secs(1), bridge.call("noop", json!({})))
        .await
        .expect("post-shutdown call must resolve promptly");
    assert!(outcome.is_err(), "post-shutdown call should error");
}

#[tokio::test]
async fn shutdown_kills_child_that_ignores_eof() {
    let bridge = EngineBridge::spawn_with_shutdown_timeout(mock_path("ignore_eof"), SHORT_TIMEOUT)
        .expect("spawn mock_ignore_eof");

    // mock_ignore_eof deliberately never exits on its own (it sleeps for an
    // hour after seeing EOF). shutdown() must not wait that long — it
    // should hit the SHORT_TIMEOUT bound and force-kill the child instead.
    let started = Instant::now();
    bridge.shutdown().await;
    let elapsed = started.elapsed();

    assert!(
        elapsed < Duration::from_secs(5),
        "shutdown() must kill an unresponsive child rather than waiting it out, took {elapsed:?}"
    );
}

#[tokio::test]
async fn shutdown_bounds_stdin_close_against_a_stuck_concurrent_write() {
    // mock_stdin_black_hole never reads a byte from stdin and never exits
    // on its own. A large-enough payload makes write_all() fill the OS
    // pipe buffer and then block waiting for the (never-happening) drain,
    // holding the bridge's stdin lock for the whole test unless something
    // intervenes.
    let bridge = std::sync::Arc::new(
        EngineBridge::spawn_with_shutdown_timeout(mock_path("stdin_black_hole"), SHORT_TIMEOUT)
            .expect("spawn mock_stdin_black_hole"),
    );

    // Comfortably larger than any realistic OS pipe buffer (macOS/Linux
    // both cap well under 1 MiB) so write_all() is guaranteed to block
    // rather than have the whole request fit in the kernel buffer.
    let big_payload = "x".repeat(4 * 1024 * 1024); // 4 MiB
    let call_bridge = bridge.clone();
    let stuck_call = tokio::spawn(async move { call_bridge.call("stuck.write", json!({"payload": big_payload})).await });

    // Give write_all() a generous head start to actually reach the
    // blocked-on-full-pipe state before shutdown() races against it.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let started = Instant::now();
    // Outer safety bound so a regression here fails the test instead of
    // hanging the whole suite forever.
    let shutdown_outcome = tokio::time::timeout(Duration::from_secs(5), bridge.shutdown()).await;
    let elapsed = started.elapsed();

    assert!(
        shutdown_outcome.is_ok(),
        "shutdown() must return within a bound even when a concurrent call()'s write_all is stuck on a full pipe \
         (it did not return within 5s)"
    );
    assert!(
        elapsed < SHORT_TIMEOUT + Duration::from_secs(2),
        "shutdown() took {elapsed:?}, expected well under {:?}",
        SHORT_TIMEOUT + Duration::from_secs(2)
    );

    let outcome = tokio::time::timeout(Duration::from_secs(2), stuck_call)
        .await
        .expect("the stuck call must resolve, not hang, once shutdown() kills the child")
        .expect("the call task itself must not panic");
    assert!(outcome.is_err(), "the stuck call should resolve to an error once the child is killed, not succeed");
}

#[tokio::test]
async fn shutdown_is_idempotent() {
    let bridge = EngineBridge::spawn_with_shutdown_timeout(mock_path("clean_exit_on_eof"), Duration::from_secs(2))
        .expect("spawn mock_clean_exit_on_eof");

    bridge.shutdown().await;
    // Second call must not panic/hang/double-kill.
    let started = Instant::now();
    bridge.shutdown().await;
    assert!(started.elapsed() < Duration::from_secs(1), "idempotent shutdown should return immediately");
}
