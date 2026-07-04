//! Rust-owned JSON-RPC 2.0 client for the OpenFusion engine sidecar.
//!
//! ## Process mechanism: `tokio::process`, not plugin-shell `Command::sidecar`
//!
//! Tauri's shell plugin gives a `Command::sidecar(...).spawn()` API that
//! returns a `CommandChild` (write-only stdin handle) plus an `Receiver<CommandEvent>`
//! stream for stdout/stderr/exit. That's a reasonable shape for
//! fire-and-forget child processes, but it's a poor fit for a *long-lived
//! request/response correlator*:
//!
//! - The correlator needs to own a stdout stream it can read continuously
//!   in its own task and pair with a `HashMap<id, oneshot::Sender<..>>` — a
//!   plain `AsyncRead`/`BufReader` gives that directly. plugin-shell instead
//!   funnels stdout through an `mpsc::Receiver<CommandEvent>` that also
//!   carries stderr and lifecycle events interleaved, which means extra
//!   demuxing work to get back to "just the ndjson stdout lines" — solvable,
//!   but it's fighting the abstraction rather than using it.
//! - plugin-shell's `Command::sidecar` requires an `AppHandle` (it resolves
//!   the sidecar path through Tauri's resource resolver), which means this
//!   module could not be unit-tested headlessly with `cargo test` against a
//!   mock binary — exactly the TDD deliverable this task calls for. A
//!   `tokio::process::Command` takes a bare `PathBuf`, so tests inject a
//!   mock sidecar with zero Tauri runtime bootstrapping.
//! - Tauri's async runtime IS tokio (this crate already pulls it in
//!   transitively through `tauri`/`tauri-plugin-shell`), so there is no
//!   "borrowing a foreign runtime" cost to using `tokio::process` directly.
//!
//! `tokio::process::Child` gives us owned `ChildStdin`/`ChildStdout`/
//! `ChildStderr` handles we can hand to independent tasks — the reader task
//! owns stdout, a drain task owns stderr, and `call()` takes the stdin lock
//! only for the duration of a single write. That ownership split is exactly
//! what a bidirectional, concurrently-called JSON-RPC client needs.
//!
//! The tradeoff: this module resolves its own sidecar binary path (the
//! caller passes a `PathBuf`) rather than getting one for free from Tauri's
//! resource resolver. Dev-vs-packaged path resolution (staged
//! `binaries/openfusion-engine-<triple>` vs. the installed `.app`'s
//! `Contents/MacOS/` layout) is intentionally NOT decided here — the brief
//! scopes that to Task 5/M8 packaging. Taking the path as a parameter is
//! exactly what makes this module unit-testable today.
//!
//! ## Wire format
//!
//! Requests are written as `{"jsonrpc":"2.0","id":<n>,"method":..,"params":..}\n`
//! to the child's stdin. The child's stdout is ndjson: lines with an `id`
//! are responses (correlated back to the waiting `call()`); lines with no
//! `id` are notifications (pushed onto a `broadcast` channel for Task 4 to
//! forward to the webview). The child's stderr is diagnostics-only and is
//! drained to this process's own stderr, never mixed into stdout parsing
//! and never forwarded to the webview.
//!
//! ## What this module deliberately does NOT log
//!
//! Diagnostic lines below (`eprintln!`) are metadata only — method names,
//! ids, byte-level parse failures, process lifecycle. Call `params` and
//! `result`/`error.data` bodies are never printed; they only ever flow
//! through the typed `Result<Value, RpcError>` returned to the caller.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, oneshot, watch, Mutex as AsyncMutex};
use tokio::task::JoinHandle;

/// Default bound `shutdown()` waits for the child to exit on its own
/// before force-killing it.
const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
/// Ring buffer size for the notification broadcast channel. Generous
/// relative to expected progress-event rates; a slow/absent subscriber
/// only loses old notifications, it never blocks the reader task.
const NOTIFY_CHANNEL_CAPACITY: usize = 256;

const ERR_CHILD_EXITED: i64 = -32001;
const ERR_BRIDGE_CLOSED: i64 = -32002;
const ERR_IO: i64 = -32003;
const ERR_SERIALIZE: i64 = -32004;
const ERR_UNKNOWN: i64 = -32005;

type PendingMap = Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>>;

/// RAII guard that removes a `call()`'s entry from the pending map when
/// dropped. Created immediately after the entry is inserted and held for
/// the rest of `call()`'s body (including across the `rx.await`), so
/// *every* exit path removes the entry:
///
/// - Normal delivery: `route_message` already `remove`d the entry to
///   resolve the oneshot, so the guard's drop-time `remove` is a harmless
///   no-op (`HashMap::remove` on an absent key just returns `None`).
/// - An early `Err` return (serialize/write failure, stdin already
///   closed): the guard removes the entry when `call()`'s stack frame
///   unwinds at the `return`.
/// - Caller cancellation (e.g. the `call()` future is dropped because a
///   wrapping `tokio::time::timeout` fired): nothing else would ever touch
///   this entry again, so without this guard it would leak in the map
///   (and leak the `oneshot::Sender` with it) until the child dies or the
///   bridge shuts down. The guard's `Drop` fires as part of tearing down
///   the cancelled future and removes it immediately.
///
/// There is no double-remove hazard: `route_message` and this guard can
/// each only ever observe the entry once (removal is the hand-off point),
/// and a `remove` of a key that's already gone is a no-op, not an error.
struct PendingGuard {
    id: u64,
    pending: PendingMap,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.pending.lock().expect("pending mutex poisoned").remove(&self.id);
    }
}

/// A JSON-RPC 2.0 error: either relayed verbatim from the engine's
/// `{"error": {code, message, data}}` response envelope, or synthesized by
/// the bridge itself for transport-level failures (child died, bridge
/// closed, write/serialize failure).
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    fn from_error_value(value: &Value) -> Self {
        let code = value.get("code").and_then(Value::as_i64).unwrap_or(ERR_UNKNOWN);
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("(no message)")
            .to_string();
        let data = value.get("data").cloned();
        RpcError { code, message, data }
    }

    fn internal(code: i64, message: impl Into<String>) -> Self {
        RpcError { code, message: message.into(), data: None }
    }

    fn child_exited() -> Self {
        Self::internal(ERR_CHILD_EXITED, "engine sidecar exited before responding")
    }

    fn bridge_closed() -> Self {
        Self::internal(ERR_BRIDGE_CLOSED, "engine bridge is shut down")
    }

    fn io(err: &std::io::Error) -> Self {
        Self::internal(ERR_IO, format!("stdin write failed: {err}"))
    }

    fn serialize(err: &serde_json::Error) -> Self {
        Self::internal(ERR_SERIALIZE, format!("request serialization failed: {err}"))
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RPC error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// Owns the spawned engine sidecar child and speaks JSON-RPC 2.0 over its
/// stdio. See module docs for the tokio::process-vs-plugin-shell decision.
pub struct EngineBridge {
    child: AsyncMutex<Child>,
    stdin: AsyncMutex<Option<ChildStdin>>,
    pending: PendingMap,
    next_id: AtomicU64,
    notify_tx: broadcast::Sender<Value>,
    closed: AtomicBool,
    shutdown_timeout: Duration,
    reader_task: AsyncMutex<Option<JoinHandle<()>>>,
    stderr_task: AsyncMutex<Option<JoinHandle<()>>>,
    /// Signals `false` -> `true` exactly once, the moment `shutdown()` is
    /// called. See [`shutdown_signal`](Self::shutdown_signal) for why this
    /// exists (M7a Task 5: notification-pump teardown).
    shutdown_signal_tx: watch::Sender<bool>,
}

impl EngineBridge {
    /// Spawns the sidecar at `binary_path` and starts its background
    /// stdout-reader and stderr-drain tasks. Must be called from within a
    /// tokio runtime (Tauri's async commands and `#[tokio::test]` both
    /// qualify) since it uses `tokio::spawn` internally.
    pub fn spawn(binary_path: PathBuf) -> std::io::Result<Self> {
        Self::spawn_with_shutdown_timeout(binary_path, DEFAULT_SHUTDOWN_TIMEOUT)
    }

    /// Same as [`spawn`](Self::spawn) but with a configurable bound for
    /// `shutdown()`'s wait-for-exit-before-kill. Kept as a separate
    /// constructor (rather than a parameter on `spawn`) so the
    /// Task-4-facing signature matches the brief exactly; tests use this to
    /// shrink the bound well below the 5s production default so the
    /// kill-on-overrun path doesn't make the test suite slow.
    pub fn spawn_with_shutdown_timeout(binary_path: PathBuf, shutdown_timeout: Duration) -> std::io::Result<Self> {
        let mut child = Command::new(&binary_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let stdin = child.stdin.take().expect("child spawned with piped stdin");
        let stdout = child.stdout.take().expect("child spawned with piped stdout");
        let stderr = child.stderr.take().expect("child spawned with piped stderr");

        let pending: PendingMap = Arc::new(StdMutex::new(HashMap::new()));
        let (notify_tx, _initial_receiver) = broadcast::channel(NOTIFY_CHANNEL_CAPACITY);
        let (shutdown_signal_tx, _initial_shutdown_receiver) = watch::channel(false);

        let reader_task = tokio::spawn(read_stdout(stdout, pending.clone(), notify_tx.clone()));
        let stderr_task = tokio::spawn(drain_stderr(stderr));

        Ok(Self {
            child: AsyncMutex::new(child),
            stdin: AsyncMutex::new(Some(stdin)),
            pending,
            next_id: AtomicU64::new(1),
            notify_tx,
            closed: AtomicBool::new(false),
            shutdown_timeout,
            reader_task: AsyncMutex::new(Some(reader_task)),
            stderr_task: AsyncMutex::new(Some(stderr_task)),
            shutdown_signal_tx,
        })
    }

    /// Sends `{method, params}` as a JSON-RPC request and awaits the
    /// matching-id response. Safe to call concurrently — each call gets its
    /// own id and its own oneshot; the background reader task correlates
    /// responses back to the right caller no matter what order they arrive
    /// in.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(RpcError::bridge_closed());
        }

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().expect("pending mutex poisoned");
            pending.insert(id, tx);
        }
        // Held for the rest of this function, including across `rx.await`.
        // Its `Drop` is what guarantees the pending entry never outlives
        // this call — on every exit path, not just the happy one. See the
        // type's doc comment for why this is race-free.
        let _pending_guard = PendingGuard { id, pending: self.pending.clone() };

        let request = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let mut line = match serde_json::to_vec(&request) {
            Ok(bytes) => bytes,
            Err(err) => return Err(RpcError::serialize(&err)),
        };
        line.push(b'\n');

        let write_outcome = {
            let mut guard = self.stdin.lock().await;
            match guard.as_mut() {
                Some(stdin) => Some(stdin.write_all(&line).await),
                None => None,
            }
        };
        match write_outcome {
            Some(Ok(())) => {}
            Some(Err(err)) => return Err(RpcError::io(&err)),
            None => return Err(RpcError::bridge_closed()),
        }

        match rx.await {
            Ok(result) => result,
            // Sender dropped without sending — the reader task exited
            // (child died) in the narrow window after our insert but
            // before fail_all_pending drained it, or some other bridge
            // teardown. Either way: an error, not a hang.
            Err(_) => Err(RpcError::child_exited()),
        }
    }

    /// Subscribes to engine notifications (JSON-RPC messages with no
    /// `id` — e.g. `orchestrate.progress`/`evals.progress`). Task 4 forwards
    /// these to the webview.
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.notify_tx.subscribe()
    }

    /// Number of in-flight `call()`s currently registered in the pending
    /// map. Test-support only: it exists so the integration-test suite in
    /// `tests/engine_bridge.rs` can assert the pending map doesn't leak
    /// entries when a `call()` future is cancelled before a response
    /// arrives (e.g. a `tokio::time::timeout` that fires). Not part of the
    /// crate's functional API and carries no request/response content —
    /// just a count.
    pub fn pending_len(&self) -> usize {
        self.pending.lock().expect("pending mutex poisoned").len()
    }

    /// A receiver that observes a `false` -> `true` transition the moment
    /// `shutdown()` is called (and stays `true` afterward — `shutdown()`
    /// only ever sends once, guarded by the same idempotency check as the
    /// rest of the method). This exists for `forward_notifications`
    /// (`commands.rs`)'s notification-pump task: a real Tauri window close
    /// does NOT make `Channel::send()` start erroring (the IPC channel
    /// looks "open" right up until full process exit), so without an
    /// explicit signal like this, every `engine_events` invocation would
    /// leak its pump task + broadcast subscriber for the rest of the
    /// process's life. The pump `tokio::select!`s between this and
    /// `rx.recv()` so it exits promptly once the bridge shuts down.
    pub fn shutdown_signal(&self) -> watch::Receiver<bool> {
        self.shutdown_signal_tx.subscribe()
    }

    /// The spawned child's OS process id, or `None` if it has already been
    /// reaped (`tokio::process::Child::id()` returns `None` once `wait()`
    /// has resolved). Test-support only, same spirit as `pending_len()`
    /// above: lets `tests/lifecycle.rs` prove — via an external `ps -p
    /// <pid>` check — that `shutdown()` actually removed the process from
    /// the OS process table, not just that this bridge's own bookkeeping
    /// says so.
    pub async fn child_id(&self) -> Option<u32> {
        self.child.lock().await.id()
    }

    /// Closes stdin (EOF — the engine's cue to exit), waits up to the
    /// configured bound for the child to exit, and kills it if it overruns.
    /// Idempotent: a second call is a no-op. After this returns, any call()
    /// still pending (or made afterward) resolves to an error rather than
    /// hanging.
    pub async fn shutdown(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }

        // Signal every notification-pump task tied to this bridge to exit.
        // Fired first (before the potentially slower stdin-close/kill/reap
        // steps below) so pumps can drain and exit promptly rather than
        // waiting on the child's own teardown. See `shutdown_signal`'s doc
        // comment for why this explicit signal is necessary at all.
        let _ = self.shutdown_signal_tx.send(true);

        // Bound the stdin-close step itself, not just the wait-for-exit
        // below. `self.stdin` is the same lock a concurrent `call()` holds
        // for the full duration of its `write_all().await` — if that write
        // is blocked (a payload larger than the OS pipe buffer and a child
        // that isn't reading, which is a realistic shape for this bridge:
        // prompts/model output can be large), acquiring the lock here with
        // no timeout would queue shutdown() behind it indefinitely,
        // defeating the whole "bounded, kill-on-overrun" contract. Timing
        // out here instead falls through straight to killing the child:
        // the kill doesn't need stdin, and it's exactly what unblocks the
        // stuck write (the child's read end closes, so the pending
        // `write_all` gets a broken-pipe error instead of hanging forever).
        let stdin_close_timed_out = tokio::time::timeout(self.shutdown_timeout, async {
            let mut guard = self.stdin.lock().await;
            *guard = None; // drop ChildStdin -> EOF on the child's stdin
        })
        .await
        .is_err();

        {
            let mut child = self.child.lock().await;
            if stdin_close_timed_out {
                // The graceful EOF cue never went out (a stuck concurrent
                // write is still holding the stdin lock), so there's
                // nothing to wait for — go straight to kill.
                let _ = child.start_kill();
                let _ = child.wait().await;
            } else {
                match tokio::time::timeout(self.shutdown_timeout, child.wait()).await {
                    Ok(_) => {}
                    Err(_elapsed) => {
                        let _ = child.start_kill();
                        let _ = child.wait().await;
                    }
                }
            }
        }

        // The reader/stderr tasks end on their own once the child's
        // stdout/stderr pipes close (exit or kill both close them). Give
        // them a bounded moment to finish so we don't leak the JoinHandle,
        // without letting shutdown() hang if something is stuck.
        if let Some(handle) = self.reader_task.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        }
        if let Some(handle) = self.stderr_task.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        }

        fail_all_pending(&self.pending, RpcError::bridge_closed);
    }
}

async fn read_stdout(stdout: ChildStdout, pending: PendingMap, notify_tx: broadcast::Sender<Value>) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(value) => route_message(value, &pending, &notify_tx),
                    Err(_) => {
                        eprintln!("[engine-bridge] malformed stdout line (not valid JSON); skipping");
                    }
                }
            }
            Ok(None) => break, // EOF: child closed stdout (exited).
            Err(err) => {
                eprintln!("[engine-bridge] stdout read error: {err}; treating as child exit");
                break;
            }
        }
    }
    // The child is gone (or its stdout is unusable either way) — anyone
    // still waiting on a response needs to be told, not left hanging.
    fail_all_pending(&pending, RpcError::child_exited);
}

fn route_message(value: Value, pending: &PendingMap, notify_tx: &broadcast::Sender<Value>) {
    let has_id = matches!(value.get("id"), Some(id) if !id.is_null());
    if !has_id {
        // A `result`/`error` envelope with a null/absent `id` is a malformed
        // response (JSON-RPC responses must carry the request's original,
        // non-null id), not a progress notification — broadcasting it would
        // leak protocol noise into the webview event stream. Log metadata
        // only and drop it; genuine notifications (method-carrying, no id)
        // still flow through below.
        if value.get("result").is_some() || value.get("error").is_some() {
            eprintln!("[engine-bridge] response-shaped message with null/missing id; dropping");
            return;
        }
        // Notification. `send` errors only when there are zero
        // subscribers, which is a normal, non-error outcome here.
        let _ = notify_tx.send(value);
        return;
    }

    let Some(id) = value.get("id").and_then(Value::as_u64) else {
        eprintln!("[engine-bridge] response with non-numeric id; ignoring");
        return;
    };

    let sender = {
        let mut pending = pending.lock().expect("pending mutex poisoned");
        pending.remove(&id)
    };

    let Some(sender) = sender else {
        eprintln!("[engine-bridge] response for unknown/already-resolved id {id}; ignoring");
        return;
    };

    let result = if let Some(error) = value.get("error") {
        Err(RpcError::from_error_value(error))
    } else {
        Ok(value.get("result").cloned().unwrap_or(Value::Null))
    };

    // A dropped receiver (caller already gave up) is not our problem.
    let _ = sender.send(result);
}

fn fail_all_pending(pending: &PendingMap, error_factory: fn() -> RpcError) {
    let stragglers: Vec<_> = {
        let mut pending = pending.lock().expect("pending mutex poisoned");
        pending.drain().collect()
    };
    for (_, tx) in stragglers {
        let _ = tx.send(Err(error_factory()));
    }
}

async fn drain_stderr(stderr: ChildStderr) {
    let mut lines = BufReader::new(stderr).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => eprintln!("[engine stderr] {line}"),
            Ok(None) => break,
            Err(err) => {
                eprintln!("[engine-bridge] stderr read error: {err}");
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure-function coverage that doesn't need a child process at all —
    // the process-lifecycle behaviors (correlation, concurrency,
    // malformed lines, notifications, shutdown, child death) are covered
    // by the mock-sidecar integration tests in `tests/engine_bridge.rs`.

    #[test]
    fn rpc_error_from_error_value_parses_code_message_data() {
        let value = json!({"code": -32601, "message": "method not found", "data": {"method": "x"}});
        let err = RpcError::from_error_value(&value);
        assert_eq!(err.code, -32601);
        assert_eq!(err.message, "method not found");
        assert_eq!(err.data, Some(json!({"method": "x"})));
    }

    #[test]
    fn rpc_error_from_error_value_defaults_missing_fields() {
        let value = json!({});
        let err = RpcError::from_error_value(&value);
        assert_eq!(err.code, ERR_UNKNOWN);
        assert_eq!(err.message, "(no message)");
        assert_eq!(err.data, None);
    }

    #[test]
    fn route_message_treats_missing_id_as_notification() {
        let pending: PendingMap = Arc::new(StdMutex::new(HashMap::new()));
        let (tx, mut rx) = broadcast::channel(4);
        route_message(json!({"jsonrpc": "2.0", "method": "evals.progress", "params": {"pct": 10}}), &pending, &tx);
        let received = rx.try_recv().expect("notification should be broadcast");
        assert_eq!(received["method"], "evals.progress");
    }

    #[test]
    fn route_message_ignores_response_for_unknown_id() {
        // Must not panic — an id with no matching pending sender is logged
        // and dropped, not treated as an error condition.
        let pending: PendingMap = Arc::new(StdMutex::new(HashMap::new()));
        let (tx, _rx) = broadcast::channel(4);
        route_message(json!({"jsonrpc": "2.0", "id": 999, "result": {}}), &pending, &tx);
    }

    #[test]
    fn route_message_drops_result_with_null_id_instead_of_broadcasting() {
        // A `result` envelope with `id: null` is a malformed response, not a
        // notification — it must NOT be broadcast to `engine_events`
        // subscribers as protocol noise.
        let pending: PendingMap = Arc::new(StdMutex::new(HashMap::new()));
        let (tx, mut rx) = broadcast::channel(4);
        route_message(json!({"jsonrpc": "2.0", "id": null, "result": {}}), &pending, &tx);
        assert!(rx.try_recv().is_err(), "malformed null-id response must not be broadcast");
    }

    #[test]
    fn route_message_drops_error_with_missing_id_instead_of_broadcasting() {
        // Same as above but for an `error` envelope with the `id` field
        // absent entirely rather than explicitly `null`.
        let pending: PendingMap = Arc::new(StdMutex::new(HashMap::new()));
        let (tx, mut rx) = broadcast::channel(4);
        route_message(json!({"jsonrpc": "2.0", "error": {"code": -32000, "message": "boom"}}), &pending, &tx);
        assert!(rx.try_recv().is_err(), "malformed missing-id error response must not be broadcast");
    }
}
