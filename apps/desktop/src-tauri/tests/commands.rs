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

use openfusion_desktop_lib::commands::{forward_notifications, route_engine_call, EngineCallError};
use openfusion_desktop_lib::engine_bridge::EngineBridge;

fn mock_path(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(match name {
        "echo" => env!("CARGO_BIN_EXE_mock_echo"),
        "error" => env!("CARGO_BIN_EXE_mock_error"),
        "notify" => env!("CARGO_BIN_EXE_mock_notify"),
        other => panic!("no mock binary registered for scenario '{other}'"),
    })
}

#[tokio::test]
async fn engine_call_success_passes_through_bridge_result() {
    let bridge = EngineBridge::spawn(mock_path("echo")).expect("spawn mock_echo");

    let result = route_engine_call(&bridge, "wiki.search", json!({"n": 7})).await;

    assert_eq!(result, Ok(json!({"n": 7})));
}

#[tokio::test]
async fn engine_call_error_maps_rpc_error_to_engine_call_error() {
    let bridge = EngineBridge::spawn(mock_path("error")).expect("spawn mock_error");

    let err = route_engine_call(&bridge, "worker.run", json!({}))
        .await
        .expect_err("error scenario always fails");

    assert_eq!(
        err,
        EngineCallError { code: 123, message: "boom".to_string(), data: Some(json!({"detail": "nope"})) }
    );
}

#[tokio::test]
async fn engine_events_forwards_notification_to_channel() {
    let bridge = EngineBridge::spawn(mock_path("notify")).expect("spawn mock_notify");
    let rx = bridge.subscribe();

    let (tx, mut received) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let channel = tauri::ipc::Channel::new(move |body| {
        let tauri::ipc::InvokeResponseBody::Json(json_str) = body else {
            panic!("expected a JSON channel body, got raw bytes");
        };
        let value: Value = serde_json::from_str(&json_str).expect("channel body should be valid JSON");
        tx.send(value).expect("test receiver should still be open");
        Ok(())
    });

    forward_notifications(rx, channel);

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

    // A channel whose on_message always errors simulates the webview side
    // having gone away. forward_notifications must not panic/hang; it
    // should just stop pumping. There is no direct observable here beyond
    // "this test completes" (no panic, no hang) within a bound. The
    // specific error variant is arbitrary — only "on_message returns Err"
    // matters here, not its meaning.
    let channel = tauri::ipc::Channel::new(|_body| Err(tauri::Error::CannotReparentWebviewWindow));

    forward_notifications(rx, channel);

    let outcome = tokio::time::timeout(Duration::from_secs(2), bridge.call("orchestrate.run", json!({}))).await;
    assert!(outcome.is_ok(), "call should still resolve promptly even though the forwarding channel errors");
}
