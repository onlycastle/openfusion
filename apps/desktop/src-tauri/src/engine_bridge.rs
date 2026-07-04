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
//! owns stdout, a drain task owns stderr, and a dedicated writer task owns
//! stdin (see "M7b Task 1" below for why `call()` itself no longer touches
//! it directly). That ownership split is exactly what a bidirectional,
//! concurrently-called JSON-RPC client needs.
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
//! ## M7b Task 1: atomic wire-writes via a dedicated writer task
//!
//! `call()` never touches `ChildStdin` directly. A single **writer task**
//! (spawned once, in [`EngineBridge::spawn_with_shutdown_timeout`]) owns the
//! `ChildStdin` handle for the bridge's entire lifetime and is the only code
//! that ever calls `write_all` on it. `call()` instead serializes its
//! request line and hands the finished `Vec<u8>` to the writer task over an
//! `mpsc::UnboundedSender<Vec<u8>>`, then awaits its response.
//!
//! **Why this matters (the hard gate this task closes):** in the prior
//! design, `call()` awaited `write_all` directly, holding the stdin lock
//! across it. If the *caller's* future was dropped mid-await (a wrapping
//! `tokio::time::timeout` firing, or the cockpit's future cancel/cancel
//! button — Task 2), whatever prefix of the request line had already been
//! flushed to the OS pipe stayed there, unterminated, and the *next*
//! request's bytes would land right after it. The child's line-oriented
//! reader has no way to tell "a request got cut off here" from "these are
//! just two long lines" — it concatenates them into one unparseable blob,
//! and the next request desyncs. Nothing in M7a ever cancelled a `call()`
//! mid-write (no caller wrapped it in a timeout), so this bug was latent;
//! the cockpit's upcoming per-call timeouts (Task 2) would trigger it
//! routinely.
//!
//! **Why the fix works:** `mpsc::UnboundedSender::send` is a synchronous,
//! non-blocking call — it either fully enqueues the request's `Vec<u8>` or
//! it doesn't (the channel is closed); there is no "partially enqueued"
//! state, so a caller cancelled while sending never leaves a fragment
//! behind. Once a request's bytes are enqueued, they belong to the writer
//! task, not to the calling `call()`'s future — dropping the caller's
//! future (a `tokio::time::timeout` firing, an explicit cancel) has no
//! effect on the writer task, which is a separate `tokio::spawn`ed future
//! entirely. The writer task's own `stdin.write_all(&bytes).await` always
//! runs to completion (or to a hard I/O error, e.g. the child died) — never
//! to a caller-cancellation. So every request is either written to the wire
//! in full, or never sent at all; partial writes are no longer possible.
//!
//! **mpsc channel choice — unbounded, not bounded:** this bridge exists to
//! serve request/response RPC calls the cockpit issues one at a time or in
//! small bursts (a handful of concurrent orchestration calls at most), not
//! a high-throughput byte stream — so there is no meaningful backpressure
//! case to design for, and an unbounded queue's worst case (a wedged child
//! that never drains stdin) is already bounded by `shutdown()`'s existing
//! kill-on-overrun path (see below), not by queue capacity. A bounded
//! channel would be equally cancellation-safe (a `Sender::send` on a full
//! bounded channel that gets cancelled mid-await also never partially
//! enqueues), but it would just relocate today's "a stuck write blocks the
//! next request" problem from the stdin lock to the channel's capacity
//! without buying any additional safety — so the unbounded channel is kept
//! for its simplicity: `call()` never needs an extra `.await` point (and
//! therefore an extra cancellation-safety argument) just to hand bytes to
//! the writer.
//!
//! **Ordering invariant:** requests are written in the order `call()`
//! enqueues them. `call()` acquires `writer_tx`'s `AsyncMutex` only for the
//! synchronous `send()` call itself (never across an `.await`), so the order
//! in which concurrent callers acquire that lock is the order their bytes
//! land in the mpsc queue, which is the order the writer task drains and
//! writes them (`mpsc` is FIFO). Response correlation still happens purely
//! by `id` (assigned before the write is even queued), so out-of-order
//! *responses* from the child remain perfectly fine — only write *order*
//! is FIFO, not response order.
//!
//! **Per-call timeout, safe now:** [`EngineBridge::call_with_timeout`] wraps
//! only the response-`oneshot` await in `tokio::time::timeout` — never the
//! write. On timeout, the response wait is dropped; [`PendingGuard`] removes
//! the pending entry (a late response, if the child does eventually answer,
//! finds no entry and is logged + dropped, same as any other
//! unknown/already-resolved id); the request itself was already handed off
//! to (or written by) the writer task, so the stream is never corrupted by
//! a timeout the way a mid-write cancel used to corrupt it. This is exactly
//! why the writer-task refactor had to land first: without it, adding
//! per-call timeouts would have made the mid-write-cancel bug routine
//! instead of latent.
//!
//! **Shutdown adapts accordingly:** `shutdown()` no longer closes `ChildStdin`
//! directly (there is no `ChildStdin` on `EngineBridge` anymore — the writer
//! task owns it locally). Instead it drops the bridge's `writer_tx` sender,
//! which closes the mpsc channel; the writer task drains anything already
//! queued, then its `rx.recv()` returns `None`, its local `ChildStdin`
//! binding goes out of scope (EOF to the child), and the task exits. That
//! drain-and-exit is bounded by `shutdown_timeout` exactly like the old
//! stdin-close step was — a writer stuck mid-`write_all` (a wedged child
//! that never reads its stdin) can't be un-stuck by closing the channel
//! alone, so a timed-out drain falls through to killing the child directly,
//! which unblocks the writer's write with a broken-pipe error so it can
//! finish and be joined.
//!
//! ## M8 Task 2: `OPENFUSION_ASSETS_DIR` on spawn
//!
//! The sidecar self-locates its runtime assets (better-sqlite3's native
//! addon, tree-sitter wasm files, tags.scm queries) via
//! `${process.execPath}.assets` by default, but that self-location breaks
//! once the sidecar is bundled into a packaged `.app`: `bundle.externalBin`
//! puts the binary in `Contents/MacOS/`, while `bundle.resources` puts the
//! `.assets/` dir in a *different* directory, `Contents/Resources/` (see
//! `lib.rs`'s "M8 Task 2" section and `tauri.conf.json`'s `bundle.resources`
//! entry). The engine sidecar (Task 1) accepts `OPENFUSION_ASSETS_DIR` as an
//! override that takes priority over `${execPath}.assets`; this module is
//! the other end of that contract — [`EngineBridge::spawn_with_assets_dir`]
//! sets it on the child's environment via [`build_command`]. `lib.rs`
//! resolves the correct directory for whichever mode it's running in
//! (dev or packaged) and always passes `Some(..)` — see its "M8 Task 2"
//! section for why setting it in dev too (rather than leaving it unset) is
//! the simpler, more uniform choice, not a functional necessity.
//!
//! [`spawn`](EngineBridge::spawn) and
//! [`spawn_with_shutdown_timeout`](EngineBridge::spawn_with_shutdown_timeout)
//! keep their existing signatures unchanged (no `assets_dir` parameter) so
//! every pre-existing call site — in particular the large `tests/*.rs` mock-
//! sidecar suite — keeps compiling and passing verbatim; both are now thin
//! wrappers over the same private [`spawn_with_options`](EngineBridge::spawn_with_options)
//! constructor [`spawn_with_assets_dir`](EngineBridge::spawn_with_assets_dir) also delegates to.
//!
//! ## What this module deliberately does NOT log
//!
//! Diagnostic lines below (`eprintln!`) are metadata only — method names,
//! ids, byte-level parse failures, process lifecycle. Call `params` and
//! `result`/`error.data` bodies are never printed; they only ever flow
//! through the typed `Result<Value, RpcError>` returned to the caller.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc, oneshot, watch, Mutex as AsyncMutex};
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
/// Per-call timeout (`call_with_timeout`) fired before the engine responded.
/// The task brief's suggested code (-32001) is already `ERR_CHILD_EXITED`
/// in this codebase, so this uses the next free slot instead — still a
/// distinct, dedicated code a caller can match on, same spirit as the rest
/// of this block.
const ERR_TIMEOUT: i64 = -32006;

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

    fn timed_out() -> Self {
        Self::internal(ERR_TIMEOUT, "request timed out")
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RPC error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// Builds the sidecar's `tokio::process::Command`: stdio wiring
/// (piped in/out/err), `kill_on_drop`, and — when `assets_dir` is provided —
/// the `OPENFUSION_ASSETS_DIR` environment override (see the module's "M8
/// Task 2" doc section). Factored out of
/// [`EngineBridge::spawn_with_options`] purely so tests can inspect the
/// constructed `Command` (via `tokio::process::Command::as_std().get_envs()`)
/// without actually spawning a child process — "spy the Command env", per
/// the M8 task brief.
fn build_command(binary_path: &Path, assets_dir: Option<&Path>) -> Command {
    let mut command = Command::new(binary_path);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(dir) = assets_dir {
        command.env("OPENFUSION_ASSETS_DIR", dir);
    }
    command
}

/// Owns the spawned engine sidecar child and speaks JSON-RPC 2.0 over its
/// stdio. See module docs for the tokio::process-vs-plugin-shell decision,
/// and the "M7b Task 1" module doc section for why `ChildStdin` is owned by
/// a dedicated writer task rather than by this struct directly.
pub struct EngineBridge {
    child: AsyncMutex<Child>,
    /// The writer task's request queue. `call()` only ever holds this lock
    /// for a synchronous, non-blocking `send()` — never across an `.await`
    /// — so a caller cancelled while sending never leaves anything
    /// half-enqueued. `None` once `shutdown()` has dropped it (closing the
    /// channel so the writer task can drain + exit).
    writer_tx: AsyncMutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    pending: PendingMap,
    next_id: AtomicU64,
    notify_tx: broadcast::Sender<Value>,
    closed: AtomicBool,
    shutdown_timeout: Duration,
    reader_task: AsyncMutex<Option<JoinHandle<()>>>,
    stderr_task: AsyncMutex<Option<JoinHandle<()>>>,
    writer_task: AsyncMutex<Option<JoinHandle<()>>>,
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
        Self::spawn_with_options(binary_path, None, DEFAULT_SHUTDOWN_TIMEOUT)
    }

    /// Same as [`spawn`](Self::spawn) but with a configurable bound for
    /// `shutdown()`'s wait-for-exit-before-kill. Kept as a separate
    /// constructor (rather than a parameter on `spawn`) so the
    /// Task-4-facing signature matches the brief exactly; tests use this to
    /// shrink the bound well below the 5s production default so the
    /// kill-on-overrun path doesn't make the test suite slow.
    pub fn spawn_with_shutdown_timeout(binary_path: PathBuf, shutdown_timeout: Duration) -> std::io::Result<Self> {
        Self::spawn_with_options(binary_path, None, shutdown_timeout)
    }

    /// Same as [`spawn`](Self::spawn), but also sets `OPENFUSION_ASSETS_DIR`
    /// on the sidecar's environment when `assets_dir` is `Some` (see the
    /// module's "M8 Task 2" doc section). `lib.rs`'s `.setup()` is the real
    /// call site — it always resolves *some* assets dir (dev or packaged)
    /// and passes `Some(..)`; `None` is kept as a distinct, meaningful state
    /// for tests (a bridge spawned with no override at all).
    pub fn spawn_with_assets_dir(binary_path: PathBuf, assets_dir: Option<PathBuf>) -> std::io::Result<Self> {
        Self::spawn_with_options(binary_path, assets_dir, DEFAULT_SHUTDOWN_TIMEOUT)
    }

    /// The shared constructor every `spawn*` variant above delegates to.
    fn spawn_with_options(
        binary_path: PathBuf,
        assets_dir: Option<PathBuf>,
        shutdown_timeout: Duration,
    ) -> std::io::Result<Self> {
        let mut child = build_command(&binary_path, assets_dir.as_deref()).spawn()?;

        let stdin = child.stdin.take().expect("child spawned with piped stdin");
        let stdout = child.stdout.take().expect("child spawned with piped stdout");
        let stderr = child.stderr.take().expect("child spawned with piped stderr");

        let pending: PendingMap = Arc::new(StdMutex::new(HashMap::new()));
        let (notify_tx, _initial_receiver) = broadcast::channel(NOTIFY_CHANNEL_CAPACITY);
        let (shutdown_signal_tx, _initial_shutdown_receiver) = watch::channel(false);
        let (writer_tx, writer_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        let reader_task = tokio::spawn(read_stdout(stdout, pending.clone(), notify_tx.clone()));
        let stderr_task = tokio::spawn(drain_stderr(stderr));
        let writer_task = tokio::spawn(run_writer(stdin, writer_rx, pending.clone()));

        Ok(Self {
            child: AsyncMutex::new(child),
            writer_tx: AsyncMutex::new(Some(writer_tx)),
            pending,
            next_id: AtomicU64::new(1),
            notify_tx,
            closed: AtomicBool::new(false),
            shutdown_timeout,
            reader_task: AsyncMutex::new(Some(reader_task)),
            stderr_task: AsyncMutex::new(Some(stderr_task)),
            writer_task: AsyncMutex::new(Some(writer_task)),
            shutdown_signal_tx,
        })
    }

    /// Sends `{method, params}` as a JSON-RPC request and awaits the
    /// matching-id response, with no deadline (the call waits as long as
    /// the bridge/child lets it). Safe to call concurrently — each call
    /// gets its own id and its own oneshot; the background reader task
    /// correlates responses back to the right caller no matter what order
    /// they arrive in.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.call_with_optional_timeout(method, params, None).await
    }

    /// Same as [`call`](Self::call), but the response wait is bounded by
    /// `timeout`. If the engine hasn't responded within `timeout`, this
    /// returns an [`RpcError`] with the dedicated timeout code
    /// (`ERR_TIMEOUT`) instead of waiting indefinitely.
    ///
    /// Safe to add now (M7b Task 1) precisely *because* the write itself is
    /// never part of what gets cancelled: the request was already handed
    /// off to (or fully written by) the writer task before this ever starts
    /// waiting on the response, so a fired timeout can never leave a
    /// partial line on the wire — see the module's "M7b Task 1" doc section.
    /// [`PendingGuard`] cleans up the pending-map entry exactly as it does
    /// for any other cancelled `call()`; a late response that arrives after
    /// the timeout finds no matching entry and is logged + dropped (same as
    /// any unknown/already-resolved id).
    pub async fn call_with_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
        self.call_with_optional_timeout(method, params, Some(timeout)).await
    }

    async fn call_with_optional_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, RpcError> {
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

        // Hand the fully-serialized line off to the writer task. This lock
        // is only ever held for the synchronous `UnboundedSender::send`
        // call below — never across an `.await` — so there is no window in
        // which a cancelled caller could leave a partial enqueue behind:
        // either `send` returns before this future can be dropped (the
        // bytes are now the writer task's problem, not this call's), or the
        // channel is already closed and nothing was sent at all. See the
        // module's "M7b Task 1" doc section for the full argument.
        let enqueued = {
            let guard = self.writer_tx.lock().await;
            match guard.as_ref() {
                Some(tx) => tx.send(line).is_ok(),
                None => false,
            }
        };
        if !enqueued {
            return Err(RpcError::bridge_closed());
        }

        let response = match timeout {
            Some(bound) => match tokio::time::timeout(bound, rx).await {
                Ok(inner) => inner,
                // The deadline fired while waiting on the response, not the
                // write (the request was already handed to the writer task
                // above, so it is either fully written or the writer hasn't
                // gotten to it yet — never partially written). Dropping
                // `rx` here is exactly what a cancelled `call()` already did
                // before per-call timeouts existed; `_pending_guard`'s Drop
                // removes the pending entry the same way.
                Err(_elapsed) => return Err(RpcError::timed_out()),
            },
            None => rx.await,
        };

        match response {
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

    /// Test-support only, same spirit as `pending_len()`: reports whether
    /// the writer task's `JoinHandle` has already resolved. Lets tests
    /// directly observe "the writer task actually exited" (e.g. once it
    /// detects a broken pipe after the child dies) rather than only
    /// inferring it from side effects like a `call()` erroring.
    pub async fn writer_task_finished(&self) -> bool {
        match self.writer_task.lock().await.as_ref() {
            Some(handle) => handle.is_finished(),
            None => true, // already taken/joined by a prior shutdown()
        }
    }

    /// Closes the writer task's input (EOF — the engine's cue to exit),
    /// waits up to the configured bound for the child to exit, and kills it
    /// if it overruns. Idempotent: a second call is a no-op. After this
    /// returns, any call() still pending (or made afterward) resolves to an
    /// error rather than hanging.
    pub async fn shutdown(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }

        // Signal every notification-pump task tied to this bridge to exit.
        // Fired first (before the potentially slower drain/kill/reap steps
        // below) so pumps can drain and exit promptly rather than waiting
        // on the child's own teardown. See `shutdown_signal`'s doc comment
        // for why this explicit signal is necessary at all.
        let _ = self.shutdown_signal_tx.send(true);

        // Close the writer task's input: drop the mpsc sender so no new
        // request can be enqueued and the writer's `rx.recv()` returns
        // `None` once it has drained anything already queued. Unlike the
        // old direct-stdin-lock design, this never blocks — `call()` never
        // holds this same lock across a slow write (see `call_with_optional_timeout`),
        // so grabbing it here to `take()` is always fast; no timeout is
        // needed just for this step.
        self.writer_tx.lock().await.take();

        // Bound how long we wait for the writer task itself to actually
        // finish draining its queue and exit (which is what sends the
        // child its graceful EOF — the writer's local `ChildStdin` only
        // drops once its loop returns). A well-behaved child lets this
        // resolve promptly; a child that never reads its stdin at all
        // leaves the writer permanently blocked inside a single in-flight
        // `write_all`, which closing the sender above cannot un-stick — so
        // this needs its own bound, exactly like the old code bounded the
        // stdin-lock acquisition. `&mut handle` (not `handle` by value) so
        // that if this *does* time out, the still-unresolved `JoinHandle`
        // remains valid to await again later, after the kill below gives it
        // a real chance to finish.
        let mut writer_handle = self.writer_task.lock().await.take();
        let writer_drain_timed_out = match writer_handle.as_mut() {
            Some(handle) => tokio::time::timeout(self.shutdown_timeout, handle).await.is_err(),
            None => false,
        };
        if !writer_drain_timed_out {
            // Polled to completion above (successfully) — a `JoinHandle`
            // must not be polled again after resolving, so don't retain it
            // for the later bounded join further down.
            writer_handle = None;
        }

        {
            let mut child = self.child.lock().await;
            if writer_drain_timed_out {
                // The writer never got to finish draining (a stuck
                // concurrent write is still in flight), so the graceful
                // EOF cue never went out — there's nothing to wait for.
                // Go straight to kill: this also unblocks the writer's
                // stuck `write_all` (the child's stdin read end closes,
                // turning the pending write into a broken-pipe error
                // instead of hanging forever).
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

        // If the writer was still draining when we moved on to killing the
        // child above, give it a bounded moment now to actually unwind (the
        // kill should have turned its stuck write into a broken-pipe error)
        // so its `JoinHandle` gets reclaimed rather than leaked.
        if let Some(handle) = writer_handle {
            let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
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

        fail_all_pending(&self.pending, RpcError::bridge_closed());
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
    fail_all_pending(&pending, RpcError::child_exited());
}

/// The dedicated writer task (see the module's "M7b Task 1" doc section):
/// owns `stdin` for the bridge's entire lifetime and is the only code that
/// ever calls `write_all` on it. Drains `rx` strictly in FIFO order —
/// `call()` enqueues fully-serialized request lines, and each one is
/// written to completion before the next is even looked at, so writes can
/// never interleave and a line can never be partially written because some
/// *caller's* future got dropped (dropping a caller's `call()` cannot touch
/// this task, which is entirely separate from it).
///
/// Exits when either:
/// - `rx.recv()` returns `None` — every `mpsc::UnboundedSender` clone was
///   dropped, i.e. `shutdown()` took and dropped the bridge's sender and
///   nothing was left queued. This is the clean-shutdown path: `stdin`
///   (owned locally by this task) drops when the function returns, which is
///   the actual EOF cue delivered to the child.
/// - `write_all` fails — almost always because the child died (its stdin
///   read end closed, turning our next write into a broken-pipe error).
///
/// Either way, any request already sitting in the pending map that this
/// task will now never get a chance to write for (or already tried and
/// failed) can never receive a response — so this fails every remaining
/// pending call before exiting, exactly mirroring what `read_stdout` already
/// does on its own EOF/error path. Whichever of the two tasks notices first
/// drains the (shared) pending map; the other's call is then a harmless
/// no-op (draining an already-empty map).
async fn run_writer(mut stdin: ChildStdin, mut rx: mpsc::UnboundedReceiver<Vec<u8>>, pending: PendingMap) {
    let mut write_error = None;
    while let Some(line) = rx.recv().await {
        if let Err(err) = stdin.write_all(&line).await {
            eprintln!("[engine-bridge] writer task: stdin write failed ({err}); stopping writer");
            write_error = Some(err);
            break;
        }
    }
    match write_error {
        Some(err) => fail_all_pending(&pending, RpcError::io(&err)),
        None => fail_all_pending(&pending, RpcError::bridge_closed()),
    }
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

fn fail_all_pending(pending: &PendingMap, error: RpcError) {
    let stragglers: Vec<_> = {
        let mut pending = pending.lock().expect("pending mutex poisoned");
        pending.drain().collect()
    };
    for (_, tx) in stragglers {
        let _ = tx.send(Err(error.clone()));
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

    // --- M8 Task 2: OPENFUSION_ASSETS_DIR on spawn --------------------
    //
    // "Spy the Command env" per the task brief: `build_command` is spawned
    // nowhere here — these inspect the `std::process::Command` env overrides
    // via `as_std().get_envs()` directly, so the packaged/dev distinction is
    // proven without needing a real child process or a real `.app`.

    fn env_value<'a>(command: &'a Command, key: &str) -> Option<Option<&'a std::ffi::OsStr>> {
        command.as_std().get_envs().find(|(k, _)| *k == std::ffi::OsStr::new(key)).map(|(_, v)| v)
    }

    #[test]
    fn build_command_sets_assets_dir_env_to_the_resolved_path_when_provided() {
        // Stands in for the packaged case: `lib.rs`'s
        // `resolve_packaged_assets_dir` resolves something shaped like this
        // (`Contents/Resources/assets`) and passes it through here.
        let assets_dir = Path::new("/Applications/OpenFusion.app/Contents/Resources/assets");
        let command = build_command(Path::new("/bin/true"), Some(assets_dir));

        let value = env_value(&command, "OPENFUSION_ASSETS_DIR");
        assert_eq!(
            value,
            Some(Some(assets_dir.as_os_str())),
            "OPENFUSION_ASSETS_DIR must be set to exactly the resolved assets dir"
        );
    }

    #[test]
    fn build_command_sets_assets_dir_env_for_the_dev_shaped_path_too() {
        // Stands in for the dev case: `lib.rs`'s `dev_assets_dir_from_binary_path`
        // resolves `<binary_path>.assets`.
        let assets_dir = Path::new("/repo/apps/desktop/src-tauri/binaries/openfusion-engine-aarch64-apple-darwin.assets");
        let command = build_command(Path::new("/repo/apps/desktop/src-tauri/binaries/openfusion-engine-aarch64-apple-darwin"), Some(assets_dir));

        assert_eq!(env_value(&command, "OPENFUSION_ASSETS_DIR"), Some(Some(assets_dir.as_os_str())));
    }

    #[test]
    fn build_command_does_not_set_assets_dir_env_when_none() {
        let command = build_command(Path::new("/bin/true"), None);
        assert_eq!(
            env_value(&command, "OPENFUSION_ASSETS_DIR"),
            None,
            "no override was requested, so the env var must not appear at all (not even set-to-empty)"
        );
    }
}
