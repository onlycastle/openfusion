//! Tauri command layer: bridges the webview's `invoke`/`Channel` surface to
//! the Rust-owned `EngineBridge` (see `engine_bridge.rs`).
//!
//! Two commands, both thin wrappers over a plain, directly-testable
//! function:
//!
//! - `engine_call` — generic JSON-RPC passthrough (`invoke('engine_call',
//!   {method, params})`). The wrapper only extracts the bridge from Tauri
//!   `State`; the actual routing is [`route_engine_call`].
//! - `engine_events` — subscribes the caller to the bridge's notification
//!   broadcast and forwards every message onto an `invoke`-supplied
//!   `Channel<Value>` until the channel or the broadcast closes. The
//!   wrapper only extracts state + subscribes; the pump loop is
//!   [`forward_notifications`].
//!
//! Both `route_engine_call` and `forward_notifications` are `pub` (not
//! `pub(crate)`) specifically so `tests/commands.rs` can exercise them
//! directly against a mock-sidecar-backed `EngineBridge`, without
//! bootstrapping a Tauri `App`/`State`/window — see that file's module doc
//! for why that's the real coverage here.
//!
//! ## No-content-logging invariant
//!
//! Neither function here ever logs a call's `method`/`params`/`result` or a
//! notification's body — same invariant `engine_bridge.rs` holds. If this
//! module ever grows a log line, it must stay metadata-only (e.g. "channel
//! closed", never the JSON payload that was being forwarded).

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::broadcast;

use crate::engine_bridge::{EngineBridge, RpcError};

/// Serializable mirror of `RpcError` (JSON-RPC `{code, message, data}`).
///
/// `RpcError` (see `engine_bridge.rs`) intentionally does not derive
/// `serde::Serialize` — Task 3's concern was the bridge's transport
/// correctness, not the command boundary. `#[tauri::command]` requires its
/// `Err` variant to be `Serialize` (Tauri serializes it to deliver a
/// rejected promise to the webview), so this type is the seam: a 1:1 field
/// copy, converted via `From<RpcError>`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EngineCallError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl From<RpcError> for EngineCallError {
    fn from(err: RpcError) -> Self {
        EngineCallError { code: err.code, message: err.message, data: err.data }
    }
}

impl std::fmt::Display for EngineCallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "engine call error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for EngineCallError {}

/// `invoke('engine_call', { method, params })` — generic JSON-RPC
/// passthrough to the engine sidecar.
///
/// Deliberately does NOT wrap `EngineBridge::call` in a timeout. A per-call
/// deadline is an M7b concern (see the module-level engine_bridge.rs
/// discussion of cancellation); this backbone passthrough must not
/// introduce mid-write cancellation, so this is a plain awaited call.
#[tauri::command]
pub async fn engine_call(
    state: State<'_, std::sync::Arc<EngineBridge>>,
    method: String,
    params: Value,
) -> Result<Value, EngineCallError> {
    route_engine_call(state.inner(), &method, params).await
}

/// The actual `engine_call` routing logic, factored out of the
/// `#[tauri::command]` wrapper so it can be exercised in `cargo test`
/// against a real (mock-sidecar-backed) `EngineBridge` without a Tauri
/// `State`/`App`.
pub async fn route_engine_call(bridge: &EngineBridge, method: &str, params: Value) -> Result<Value, EngineCallError> {
    bridge.call(method, params).await.map_err(EngineCallError::from)
}

/// `invoke('engine_events', { channel })` — the webview calls this once to
/// start receiving engine progress notifications (JSON-RPC messages with
/// no `id`, e.g. `orchestrate.progress`/`evals.progress`) on `channel`.
/// Subscribes to the bridge's broadcast and spawns a background task (via
/// [`forward_notifications`]) that pumps messages onto the channel until
/// either side closes.
#[tauri::command]
pub fn engine_events(state: State<'_, std::sync::Arc<EngineBridge>>, channel: Channel<Value>) {
    forward_notifications(state.inner().subscribe(), channel);
}

/// Spawns a background task that forwards every message received on `rx`
/// onto `channel`, until `channel.send` starts erroring (the webview/IPC
/// side went away) or the broadcast sender is dropped (the bridge shut
/// down). A lagged receiver (slow subscriber missed some notifications)
/// is not fatal — it just resumes forwarding from the next message.
///
/// `pub` (not `pub(crate)`) for the same reason as [`route_engine_call`]:
/// `tauri::ipc::Channel::new` takes a plain closure and needs no Tauri
/// `App`/webview to construct, so `tests/commands.rs` calls this directly
/// with a closure that captures received values for assertion.
pub fn forward_notifications(mut rx: broadcast::Receiver<Value>, channel: Channel<Value>) {
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(value) => {
                    if channel.send(value).is_err() {
                        break; // Webview/IPC side went away.
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Pure-function coverage only (no process/child needed) — the
    // mock-sidecar-backed behaviors (success passthrough, error mapping,
    // notification forwarding) live in `tests/commands.rs`, same split as
    // `engine_bridge.rs`'s own inline tests vs. `tests/engine_bridge.rs`.

    #[test]
    fn engine_call_error_from_rpc_error_preserves_code_message_data() {
        // RpcError's fields are all `pub` (no public constructor needed) —
        // built directly via struct literal for this pure conversion test.
        let rpc_err = RpcError { code: -32601, message: "method not found".to_string(), data: Some(json!({"method": "x"})) };
        let engine_err: EngineCallError = rpc_err.into();
        assert_eq!(engine_err.code, -32601);
        assert_eq!(engine_err.message, "method not found");
        assert_eq!(engine_err.data, Some(json!({"method": "x"})));
    }

    #[test]
    fn engine_call_error_serializes_to_code_message_data_json() {
        let err = EngineCallError { code: 7, message: "boom".to_string(), data: None };
        let value = serde_json::to_value(&err).expect("EngineCallError must serialize");
        assert_eq!(value, json!({"code": 7, "message": "boom", "data": null}));
    }
}
