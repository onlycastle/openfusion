//! Integration tests for the Tauri command layer (`src/commands.rs`), run
//! against real mock-sidecar-backed `EngineBridge` instances (see Task 3's
//! `src/bin/mock_*.rs` fixtures + `src/bin/support/mock_common.rs`).
//!
//! These deliberately do NOT bootstrap a Tauri `App`/`State`/window.
//! `route_engine_call` takes a bare `&EngineBridge`, and `forward_notifications`
//! takes a bare `broadcast::Receiver<Value>` + `tauri::ipc::Channel<Value>`
//! (which is itself constructible with a plain closure via `Channel::new`,
//! no webview required) — so this exercises the actual command *logic*
//! directly. The `#[tauri::command]` wrappers in `commands.rs` are thin
//! `state.inner()` extractions around these two functions; wiring a real
//! Tauri `State` in a unit/integration test would mostly test Tauri's own
//! plumbing, not this crate's code.
//!
//! Why these live in `tests/commands.rs` rather than inline in
//! `src/commands.rs`: `CARGO_BIN_EXE_<name>` (used by `mock_path` below to
//! locate the mock sidecar binaries) is only set by Cargo for integration
//! tests/benchmarks, not for a lib crate's own inline unit tests — the same
//! reason Task 3 split process-based tests into `tests/engine_bridge.rs`
//! and kept only pure-function tests inline in `engine_bridge.rs` itself.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{broadcast, watch};

use openfusion_desktop_lib::commands::{forward_notifications, route_engine_call, EngineCallError};
use openfusion_desktop_lib::engine_bridge::EngineBridge;

/// Builds a channel that forwards every received body onto an
/// `mpsc::UnboundedReceiver<Value>` a test can read from — the same helper
/// shape `engine_events_forwards_notification_to_channel` already used
/// inline, factored out since the new pump-teardown tests below need the
/// same construction repeatedly.
fn observing_channel() -> (tauri::ipc::Channel<Value>, tokio::sync::mpsc::UnboundedReceiver<Value>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let channel = tauri::ipc::Channel::new(move |body| {
        let tauri::ipc::InvokeResponseBody::Json(json_str) = body else {
            panic!("expected a JSON channel body, got raw bytes");
        };
        let value: Value = serde_json::from_str(&json_str).expect("channel body should be valid JSON");
        tx.send(value).expect("test receiver should still be open");
        Ok(())
    });
    (channel, rx)
}

fn mock_path(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(match name {
        "echo" => env!("CARGO_BIN_EXE_mock_echo"),
        "error" => env!("CARGO_BIN_EXE_mock_error"),
        "notify" => env!("CARGO_BIN_EXE_mock_notify"),
        "slow_response_echo" => env!("CARGO_BIN_EXE_mock_slow_response_echo"),
        other => panic!("no mock binary registered for scenario '{other}'"),
    })
}

#[tokio::test]
async fn engine_call_success_passes_through_bridge_result() {
    let bridge = EngineBridge::spawn(mock_path("echo")).expect("spawn mock_echo");

    let result = route_engine_call(&bridge, "wiki.search", json!({"n": 7}), None).await;

    assert_eq!(result, Ok(json!({"n": 7})));
}

#[tokio::test]
async fn engine_call_error_maps_rpc_error_to_engine_call_error() {
    let bridge = EngineBridge::spawn(mock_path("error")).expect("spawn mock_error");

    let err = route_engine_call(&bridge, "worker.run", json!({}), None)
        .await
        .expect_err("error scenario always fails");

    assert_eq!(
        err,
        EngineCallError { code: 123, message: "boom".to_string(), data: Some(json!({"detail": "nope"})) }
    );
}

#[tokio::test]
async fn engine_call_with_timeout_ms_times_out_and_maps_to_engine_call_error() {
    // mock_slow_response_echo sleeps 250ms before responding; a 20ms
    // `timeout_ms` must fire well before that, proving the M7b Task 1
    // `timeoutMs` wiring reaches `EngineBridge::call_with_timeout`, not just
    // `EngineBridge::call`.
    let bridge = EngineBridge::spawn(mock_path("slow_response_echo")).expect("spawn mock_slow_response_echo");

    let err = route_engine_call(&bridge, "worker.run", json!({}), Some(20))
        .await
        .expect_err("a 20ms timeout against a 250ms-delayed response must time out");
    assert_eq!(err.code, -32006, "the timeout must map to the dedicated timeout error code");

    // The stream must stay usable afterward -- same framing-safety property
    // `tests/engine_bridge.rs`'s own timeout test asserts directly against
    // `EngineBridge`, exercised here through the command-layer entry point.
    let second = tokio::time::timeout(
        Duration::from_secs(2),
        route_engine_call(&bridge, "worker.run", json!({"marker": "ok"}), None),
    )
    .await
    .expect("a subsequent call through the command layer must resolve promptly");
    assert_eq!(second, Ok(json!({"marker": "ok"})));
}

#[tokio::test]
async fn engine_events_forwards_notification_to_channel() {
    let bridge = EngineBridge::spawn(mock_path("notify")).expect("spawn mock_notify");
    let rx = bridge.subscribe();
    let shutdown_rx = bridge.shutdown_signal();

    let (channel, mut received) = observing_channel();

    forward_notifications(rx, shutdown_rx, channel);

    // mock_notify answers the call and then emits an unsolicited
    // "orchestrate.progress" notification (see Task 3's
    // `notification_reaches_subscriber` test for the same shape).
    bridge.call("orchestrate.run", json!({})).await.expect("call succeeds");

    let notification = tokio::time::timeout(Duration::from_secs(2), received.recv())
        .await
        .expect("forwarded notification should arrive within bound")
        .expect("forwarding channel should not have closed");

    assert_eq!(notification["method"], "orchestrate.progress");
    assert_eq!(notification["params"]["pct"], 50);
}

#[tokio::test]
async fn engine_events_stops_forwarding_once_channel_closes() {
    let bridge = EngineBridge::spawn(mock_path("notify")).expect("spawn mock_notify");
    let rx = bridge.subscribe();
    let shutdown_rx = bridge.shutdown_signal();

    // A channel whose on_message always errors simulates the webview side
    // having gone away. forward_notifications must not panic/hang; it
    // should just stop pumping. There is no direct observable here beyond
    // "this test completes" (no panic, no hang) within a bound. The
    // specific error variant is arbitrary — only "on_message returns Err"
    // matters here, not its meaning.
    let channel = tauri::ipc::Channel::new(|_body| Err(tauri::Error::CannotReparentWebviewWindow));

    forward_notifications(rx, shutdown_rx, channel);

    let outcome = tokio::time::timeout(Duration::from_secs(2), bridge.call("orchestrate.run", json!({}))).await;
    assert!(outcome.is_ok(), "call should still resolve promptly even though the forwarding channel errors");
}

// --- M7a Task 5: notification-pump teardown -------------------------------
//
// The tests below exercise `forward_notifications`'s shutdown-signal
// select() directly (constructing bare `broadcast`/`watch` channels rather
// than going through a full `EngineBridge`), so each scenario — dropped
// broadcast sender, a lagging receiver, an explicit shutdown signal, a
// signal that already fired before the pump started — is deterministic and
// independent of the others. `forward_notifications` now returns the
// pump's `JoinHandle`, so "the pump exited" is asserted directly (awaiting
// the handle), not inferred from side effects.

#[tokio::test]
async fn forward_notifications_exits_when_broadcast_sender_dropped() {
    let (tx, rx) = broadcast::channel::<Value>(4);
    // Keep the shutdown sender alive and never signal it, so the exit
    // below is unambiguously caused by the broadcast sender dropping
    // (`RecvError::Closed`), not by the shutdown signal.
    let (_shutdown_tx, shutdown_rx) = watch::channel(false);
    let (channel, _received) = observing_channel();

    let handle = forward_notifications(rx, shutdown_rx, channel);
    drop(tx);

    let outcome = tokio::time::timeout(Duration::from_secs(2), handle).await;
    assert!(
        outcome.is_ok(),
        "the pump must exit once the broadcast sender is dropped (RecvError::Closed), not hang"
    );
}

#[tokio::test]
async fn forward_notifications_continues_after_lagged_receiver() {
    // A small capacity makes it trivial to overflow deterministically: the
    // pump's Lagged-handling doesn't depend on the specific capacity that
    // produced the lag (production wires this to EngineBridge's real
    // 256-slot notify channel; the `continue`-on-Lagged branch under test
    // is capacity-agnostic).
    let (tx, rx) = broadcast::channel::<Value>(4);
    let (_shutdown_tx, shutdown_rx) = watch::channel(false);
    let (channel, mut received) = observing_channel();

    // Flood — and send the post-lag marker — *before* the pump is spawned,
    // while `rx` is still a plain, un-polled local receiver that only we can
    // touch. `forward_notifications` hands `rx` off to
    // `tauri::async_runtime::spawn`, which (since no test in this file ever
    // calls `tauri::async_runtime::set`) lazily boots its own independent
    // multi-threaded Tokio runtime the first time it's called — a separate
    // thread pool from this `#[tokio::test]`'s own runtime. That means the
    // pump task runs with genuine OS-level concurrency against this test
    // body, not just cooperative interleaving: spawning the pump *before*
    // flooding let its worker thread occasionally win the race and drain
    // messages as fast as they were produced, keeping pace with the
    // capacity-4 channel and never lagging at all — which buried the
    // `after-lag` marker past the read budget below and made the test flaky
    // (~1-in-20). A receiver's lag is purely a function of "how many sends
    // happened past capacity while this receiver's read cursor didn't
    // move" — arithmetic, not scheduling — so doing all the sends against
    // `rx` here, before the pump (and thus any contending task) exists,
    // pins the "17 messages behind" state up front. Whenever the pump
    // *does* get scheduled afterward, its very first `rx.recv()` is
    // guaranteed to observe `RecvError::Lagged`, regardless of which
    // runtime's thread pool wins that race.
    for i in 0..20u32 {
        tx.send(json!({"n": i})).expect("rx is still alive and subscribed, so sends must succeed");
    }
    // A distinguishable message sent after the flood — if Lagged caused the
    // pump to exit or panic instead of `continue`-ing the loop, this would
    // never arrive.
    tx.send(json!({"marker": "after-lag"})).expect("rx is still alive and subscribed, so sends must succeed");

    let handle = forward_notifications(rx, shutdown_rx, channel);

    let mut saw_marker = false;
    for _ in 0..8 {
        let value = tokio::time::timeout(Duration::from_secs(2), received.recv())
            .await
            .expect("pump should still be forwarding after a Lagged gap, not stuck/exited")
            .expect("forwarding channel should not have closed");
        if value.get("marker").and_then(Value::as_str) == Some("after-lag") {
            saw_marker = true;
            break;
        }
    }
    assert!(saw_marker, "the post-lag marker must eventually arrive; the pump must survive a Lagged gap");

    assert!(
        !handle.inner().is_finished(),
        "the pump must still be running (looping on rx.recv()), not have exited, after handling Lagged"
    );
}

#[tokio::test]
async fn forward_notifications_exits_when_shutdown_signal_fires() {
    let (tx, rx) = broadcast::channel::<Value>(4);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (channel, _received) = observing_channel();

    let handle = forward_notifications(rx, shutdown_rx, channel);

    // `tx` deliberately stays alive across the signal so the exit below is
    // unambiguously caused by the shutdown signal, not the broadcast
    // sender dropping (that's the separate
    // `forward_notifications_exits_when_broadcast_sender_dropped` test).
    shutdown_tx.send(true).expect("the pump's receiver is still alive");

    let outcome = tokio::time::timeout(Duration::from_secs(2), handle).await;
    assert!(outcome.is_ok(), "the pump must exit once the shutdown signal fires, not hang");

    drop(tx);
}

#[tokio::test]
async fn forward_notifications_exits_immediately_if_already_shut_down() {
    // Keep `_tx` alive so a `Closed` broadcast can't be the cause of the
    // exit asserted below — this test is specifically about the
    // already-true-before-subscribe edge case.
    let (_tx, rx) = broadcast::channel::<Value>(4);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    shutdown_tx.send(true).expect("receiver constructed above is still alive");

    let (channel, _received) = observing_channel();
    let handle = forward_notifications(rx, shutdown_rx, channel);

    let outcome = tokio::time::timeout(Duration::from_secs(2), handle).await;
    assert!(
        outcome.is_ok(),
        "a pump started after the shutdown signal already fired must exit immediately, not block on \
         `changed()` for a transition that already happened before it subscribed"
    );
}
