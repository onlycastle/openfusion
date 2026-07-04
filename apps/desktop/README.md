# OpenFusion desktop shell (M7a)

A Tauri 2 app: a thin Rust core, a system webview (no bundled Chromium), and
the OpenFusion engine running as a supervised sidecar process. The engine
holds all the intelligence (indexing, harness generation, orchestration,
evals — see the root README); this shell's job is to launch it, talk to it,
and shut it down cleanly. See `docs/superpowers/specs/2026-07-03-harness-fusion-app-design.md`
§4/§5/§9 for the full design and `docs/research/2026-07-04-m7-tauri-verification.md`
for the technology decisions this scaffold is built on.

## Architecture

```
┌────────────────────────┐   invoke /   ┌─────────────────────────┐  stdio ndjson  ┌───────────────────────┐
│ webview (src/main.ts)   │   Channel    │ Rust — Tauri core       │  JSON-RPC 2.0  │ openfusion-engine      │
│ @tauri-apps/api/core    │◄────────────►│  commands.rs             │◄──────────────►│ sidecar (compiled      │
│ (vanilla TS, no         │              │  engine_bridge.rs        │                │ Node binary)           │
│  framework yet)         │              │  lib.rs (lifecycle)      │                │ packages/engine        │
└────────────────────────┘              └─────────────────────────┘                └───────────────────────┘
```

- **`engine_bridge.rs`** owns the sidecar's `tokio::process::Child` directly
  (not `tauri-plugin-shell`'s `Command::sidecar` — see that file's module
  doc for why: a long-lived request/response correlator wants an owned
  stdout stream + its own pending-map, which plugin-shell's `CommandEvent`
  stream fights rather than helps, and a bare `PathBuf` keeps this module
  unit-testable with a mock binary and zero Tauri runtime bootstrap).
  `spawn()` starts the child (stdin/stdout/stderr all piped,
  `kill_on_drop(true)` as a last-resort backstop — see "Lifecycle" below for
  why it is *not* the primary shutdown mechanism), a background task reads
  ndjson lines off stdout and correlates responses to callers by `id` (or
  pushes no-`id` lines onto a notification broadcast channel), and a second
  task drains stderr to this process's own stderr (diagnostics only, never
  parsed, never forwarded to the webview).
- **`commands.rs`** is the Tauri command layer: `engine_call` is a generic
  JSON-RPC passthrough (`invoke('engine_call', {method, params})`);
  `engine_events` subscribes the caller to the bridge's notification
  broadcast and pumps messages onto an `invoke`-supplied `Channel<Value>`
  until the channel closes, the broadcast closes, or the bridge shuts down
  (see "Notification-pump teardown" below).
- **`lib.rs`** wires it together: `.setup()` resolves the sidecar binary
  path and spawns the bridge into Tauri managed state; `RunEvent::ExitRequested`
  drives the bridge's clean shutdown (see "Lifecycle" below).
- **No content logging anywhere in this chain.** `engine_bridge.rs` and
  `commands.rs` both hold the invariant that a call's `method`/`params`/`result`
  and a notification's body are never printed — only metadata (method
  names, ids, byte-level parse failures, process lifecycle events).

## Lifecycle: spawn, and clean shutdown on exit

The bridge is spawned once, in `.setup()`, and stored as `Arc<EngineBridge>`
in Tauri's managed state.

Shutdown is wired to `RunEvent::ExitRequested` (`lib.rs`,
`shutdown_engine_bridge_on_exit`) — **not** `WindowEvent::CloseRequested` and
**not** a reliance on `kill_on_drop`. Both of those are worth explaining,
because the reasoning isn't obvious:

- **`kill_on_drop(true)` is not reachable on the normal quit path.** Tauri's
  own `App::run()` documents that "when the application finishes, the
  process is exited directly using `std::process::exit`" — which skips Rust
  destructors entirely. The `Arc<EngineBridge>` (and the `tokio::process::Child`
  inside it) sitting in Tauri's managed state would never have its `Drop`
  run on a graceful quit, so `kill_on_drop` alone does **not** protect this
  path — it only helps if the process aborts some other way. An *explicit*
  `EngineBridge::shutdown()` call, made to run before that `process::exit`
  fires, is the only way the sidecar reliably gets its stdin-EOF chance to
  exit gracefully (and, failing that, a bounded kill+reap).
- **`RunEvent::ExitRequested`, not `WindowEvent::CloseRequested`.** The
  latter only covers "the user clicked this window's close button" — it
  misses `AppHandle::exit()` and would need per-window bookkeeping for "is
  this the last window" once a future multi-window cockpit UI (M7b) exists.
  `ExitRequested` fires once, covering the last window closing and
  `AppHandle::exit()`, right before the process actually exits.
  **Caveat: it does NOT cover main-thread `AppHandle::restart()`** — Tauri
  2.11's `App::run()` (`app.rs:588`) explicitly skips delivering
  `ExitRequested` when `restart()` is called from the main thread ("we
  cannot guarantee the delivery of those events, so we skip them"). A
  future M8 auto-updater must call `request_restart()` instead, which does
  go through the normal exit path and deliver `ExitRequested` — reaching
  for `restart()` directly would reintroduce the orphaned-engine-process
  bug this milestone fixes. See `lib.rs`'s `shutdown_engine_bridge_on_exit`
  doc comment for the full detail.

`RunEvent` handlers are synchronous, but `EngineBridge::shutdown()` is
`async`. `tauri::async_runtime::block_on` bridges the two — it blocks the
calling (main/event-loop) thread while driving the future to completion on
Tauri's own tokio runtime, which lives on separate worker threads, so this
cannot self-deadlock. The call is also wrapped in an outer bound
(`EXIT_SHUTDOWN_TIMEOUT`, 8s) as defense in depth: `shutdown()` already
bounds each of its own steps (stdin-close, wait-or-kill, reader/stderr task
join), so it always returns on its own — the outer timeout exists only so a
future regression in those internal bounds can never turn "shutdown is
slow" into "the app hangs on quit."

`tests/lifecycle.rs` proves the property end to end against mock sidecars
(including one that deliberately ignores stdin EOF and never exits on its
own): the exit-path shutdown always completes within its bound, and an
external `ps -p <pid>` check confirms the child is actually gone from the
OS process table afterward — not merely marked "shut down" in this crate's
own bookkeeping.

## Notification-pump teardown

`engine_events` spawns a background task (`forward_notifications`,
`commands.rs`) per invocation, pumping the bridge's broadcast channel onto a
webview `Channel`. A real Tauri window close does **not** make
`Channel::send()` start erroring — the IPC channel looks "open" right up
until the whole process exits — so without an explicit signal, every
`engine_events` invocation would leak its pump task and its broadcast
subscriber for the rest of the process's life.

`EngineBridge::shutdown_signal()` (a `tokio::sync::watch::Receiver<bool>`)
closes that gap: `shutdown()` flips it to `true` (once, idempotently) before
doing its own stdin-close/kill work, and `forward_notifications` is a
`tokio::select!` between `rx.recv()` (the notification broadcast) and
`shutdown_rx.changed()`. Every outstanding pump, no matter how many times
`engine_events` was called, exits as soon as the bridge shuts down.
`tests/commands.rs` covers: a dropped broadcast sender (`RecvError::Closed`),
a lagging receiver (`RecvError::Lagged` — the pump must `continue`, not
exit or panic), the shutdown signal firing while a pump is running, and a
pump started *after* the signal already fired (must exit immediately, not
block forever on a `watch::Receiver::changed()` for a transition it missed).

## Building and running

Requires the workspace root's toolchain (Node ≥ 22 via pnpm/corepack, plus a
Rust toolchain for `cargo`/`tauri`).

```sh
# 1. Build the engine into a self-contained sidecar binary (once, or after
#    engine changes):
pnpm --filter @openfusion/engine build:sidecar

# 2. Stage it into src-tauri/binaries/ (Tauri's externalBin convention):
pnpm --filter @openfusion/desktop stage-sidecar

# 3. Run the dev shell (spawns the Vite dev server + a Tauri window):
pnpm --filter @openfusion/desktop tauri dev
```

`stage-sidecar` (`scripts/stage-sidecar.mjs`) copies
`packages/engine/dist-sidecar/openfusion-engine-<triple>` (+ its `.assets`
sibling directory of native/wasm runtime assets — better-sqlite3's addon,
tree-sitter query files and wasm) into `src-tauri/binaries/`. This is a
dev-time-only manual step, run by hand rather than wired into `build.rs` —
but it is NOT optional for `cargo build`/`cargo test` in this crate.
`tauri-build`'s build script validates that every `tauri.conf.json`
`bundle.externalBin` entry (`binaries/openfusion-engine`) resolves to a real
file on disk *during the build itself*, before a single line of this
crate's own code compiles; with nothing staged, `cargo build` fails with
exit code 101 ("resource path `binaries/openfusion-engine-<triple>` doesn't
exist"). So steps 1 and 2 above are prerequisites for ANY `cargo
build`/`cargo test` in `apps/desktop`, not just `tauri dev` — a fresh
clone/CI runner must build and stage the sidecar before it can build or
test this crate at all. `lib.rs`'s `resolve_dev_sidecar_binary_path()` then
scans the staged directory for the one entry at `.setup()` time (a separate,
runtime-only check — the `tauri-build` validation above happens earlier, at
compile time).

## OPERATOR SMOKES

These require a display/window and are not run in CI or this development
environment — checked manually before considering a change to this shell
done:

1. **`tauri dev` launches.** A window titled "OpenFusion" appears, sized
   1024×720, no console errors on load.
2. **The full chain renders `engine.models.list`.** The window's "engine
   proof" screen (`src/main.ts`) shows a result section rendering
   `{"providers": [...]}` (or `[]` with no providers configured) — proving
   webview `invoke` → Rust `engine_call` → `EngineBridge::call` → sidecar
   stdin/stdout JSON-RPC → the engine's `engine.models.list` handler → back.
3. **App exit leaves no orphaned engine process.** With the app running,
   note the sidecar's pid (e.g. `pgrep -fl openfusion-engine`), quit the app
   (Cmd+Q or close the window), then confirm it's gone:
   `ps -p <pid>` should report no matching process. `tests/lifecycle.rs`
   proves this same property headlessly against mock sidecars; this smoke
   is the real-binary, real-window confirmation.

## Packaging, signing, entitlements (deferred to M8)

This scaffold's `Entitlements.plist` already documents
`com.apple.security.cs.disable-library-validation` (needed because the
engine sidecar dlopen()s better-sqlite3's native addon under macOS's
hardened runtime) and leaves `allow-jit`/`allow-unsigned-executable-memory`
commented out pending empirical verification against a signed build.
Everything else about packaging a real, distributable `.app`/DMG is **M8
scope**, not this milestone's:

- **Packaged sidecar path resolution.** `lib.rs`'s
  `resolve_packaged_sidecar_binary_path()` exists and is unit-tested (it
  mirrors `tauri-plugin-shell`'s own sidecar resolution: join
  `current_exe()`'s directory with the bundled, triple-suffix-stripped
  binary name), but it is **not yet wired into `.setup()`'s dispatch**.
  Switching between it and the dev-path resolver needs a reliable
  compile-time "packaged build vs `tauri dev`" signal (Tauri's `cfg(dev)`
  alias, driven by a `custom-protocol` Cargo feature this scaffold's
  `Cargo.toml` never wired up), and the packaged path can only really be
  exercised against a real bundled `.app` — so both the feature wiring and
  the runtime switch are left to M8, alongside the rest of packaging.
- **Nested code signing**, including the manual sidecar pre-sign fallback
  for the known Tauri bundler bug (#11992: sidecar signing during bundling
  can produce an invalid signature).
- **Notarization** (`xcrun notarytool`) and **stapling the `.dmg`** itself
  (not just the `.app`).
- Verifying empirically whether `allow-jit`/`allow-unsigned-executable-memory`
  are actually needed for a WKWebView-based (not Electron-based) app.

See `docs/research/2026-07-04-m7-tauri-verification.md` for the full
investigation behind these notes.
