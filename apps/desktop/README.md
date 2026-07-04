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
┌─────────────────────────────┐   invoke /   ┌──────────────────────────┐  stdio ndjson  ┌───────────────────────┐
│ webview (src/main.tsx)      │   Channel    │ Rust — Tauri core        │  JSON-RPC 2.0  │ openfusion-engine      │
│ React 18 + Vite             │◄────────────►│  commands.rs             │◄──────────────►│ sidecar (compiled      │
│ @tauri-apps/api/core        │              │  engine_bridge.rs        │                │ Node binary)           │
│ 4 cockpit screens: Project /│              │  lib.rs (lifecycle)      │                │ packages/engine        │
│ Keys / Orchestrate / Evals  │              │                          │                │                        │
└─────────────────────────────┘              └──────────────────────────┘                └───────────────────────┘
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

**Running the Rust tests:** use `pnpm --filter @openfusion/desktop test:rust`
(equivalently, `cargo test --manifest-path src-tauri/Cargo.toml --features
test-mocks` from the repo root) — a bare `cargo test` fails to compile,
because the `src/bin/mock_*.rs` fixture binaries the integration tests spawn
are gated behind the `test-mocks` feature (see `Cargo.toml`'s `[[bin]]`
comments) so they never ship inside a notarized release bundle. `pnpm
--filter @openfusion/desktop test` runs only the Vite/vitest script tests —
it does not run the Rust suite; `test:rust` is the canonical, separate
command for that. (Note: this is not yet wired into CI — `.github/workflows/ci.yml`
has no cargo-test step, a pre-existing gap.)

## The Cockpit: Four Screens

The desktop app exposes a "cockpit" UI with four screens:

### Project Screen
Discover and index a local git repository. The app prompts for a project
directory, then calls `engine.wiki.build` to construct the symbol index and
wiki. A live progress panel streams `wiki.build.progress` notifications
(projectDir, detail) as indexing runs. Once complete, the screen renders
summary stats (files indexed, symbols found, refs resolved). This screen owns
project discovery and wiki construction only — it carries no eval references;
the eval report card (verdict, savings, per-task results) lives on its own
Evals screen, described below.

### Keys Screen
Configure frontier engine access (Claude Code / Codex OAuth) and open-model
providers (BYOK: Moonshot, Z.ai, DeepSeek, OpenAI-compatible). The shell
securely stores all keys in macOS Keychain — the engine never touches
credentials, only holds references to them at runtime. Keys configured here
are write-only to the UI; there is no "view my keys" export (defense in depth
against accidental exposure).

### Orchestrate Screen
The marquee "route → cheap worker diff → frontier review → escalate → apply"
loop, live. Picks a project directory, takes a free-text task description,
and calls `engineClient.runOrchestrate` — a cancellable run that mints a UUID
runId and streams progress notifications (`orchestrate.progress`, carrying
runId + stage + detail). The screen displays:
- **Route:** which agent and model the task was assigned to (likely an open
  model by default, escalating to frontier if the worker fails twice).
- **Live progress:** status updates as the worker or frontier session executes.
- **Diff review:** the changes the worker or frontier engine produced
  (a simple syntax-colored preview, not a full diff editor).
- **Review verdict:** whether the diff was approved or flagged for changes
  (and if escalated to frontier, a simple "escalated" note).
- **Cost breakdown:** worker cost and frontier cost separately, both
  estimate-class and tagged with a pricingConfidence caveat.
- **Apply button:** `engine.orchestrate.apply` stages the diff into the
  working tree via `git apply --3way` (never commits; the diff is left staged
  for human review and commit).

A **Cancel button** is available while a run is in progress. It calls
`engine.cancel({runId})` (the engine's true stop mechanism), which causes
the run's promise to reject with a `RunCancelledError` — distinct from a
genuine failure. The UI renders a "Cancelled" state, not "Failed," once
the cancellation settles. The app mints a UUID `runId` for every run and
passes it to the engine so that `engine.cancel` can reliably reach the
right in-flight request without relying on a per-call timeout (timeouts
would abandon the promise while the run continued on the engine side).

### Evals Screen
Run baseline-vs-harness evals to measure whether the generated harness
held quality against open-model workers vs an all-frontier baseline. Takes
a list of commit shas and a test command, calls `engineClient.runEvals` as
a cancellable run streaming `evals.progress` notifications (carrying runId
for correlation), and renders:
- **Verdict badge:** pass (green: quality held, savings > 0, ≥5 tasks),
  fail (red ETH-HAZARD badge: harness degraded quality below baseline —
  flagged and never shipped regardless of cost savings), or inconclusive
  (amber: too few tasks, unpriced models, zero baseline pass rate, or ≥20%
  measurement failures).
- **Savings percentage:** e.g., "42.5% (estimate-class, pricing confidence:
  provider-reported)". If models are unpriced or the run is inconclusive,
  displays "not computable" instead of a fake number.
- **Per-task table:** each task row shows baseline pass/fail, harness pass/fail,
  and measurement status (oracle mismatch or infra failure recorded; clean
  baseline and harness results factored into the verdict only, measurement
  failures excluded from both).
- **Clean-subset counts:** cleanTaskCount (tasks where NEITHER side hit a
  measurement failure — the clean subset the verdict is actually computed
  from, per `packages/engine/src/evals/run.ts`), cleanBaselinePassed
  (baseline row of that subset), cleanHarnessPassed, cleanSavingsPct, and
  measurementFailureCount (infra issues; affects verdict inconclusiveness).

The app **never displays the raw "we saved 42.5% cost but the harness failed
8 of 10 tasks"** — a quality regression is an ETH hazard, flagged in the UI
and never shipped as a savings win. All cost estimates carry a `pricingConfidence`
caveat (verified/provider-reported/secondary/unverified/unpriced) — if that's
not "verified," a small badge notes it. Unpriced calls taint the entire run to
"inconclusive" rather than a fake savings number.

A **Cancel button** behaves exactly as in Orchestrate: calls `engine.cancel({runId})`,
renders "Cancelled" once it settles (distinct from "Failed").

## Content-Security-Policy (CSP)

The app runs under a strict, local-only Content-Security-Policy:

**Production (`tauri build`):** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; ...`

This policy permits:
- Scripts and styles only from the bundled app code (no inline scripts, no `<script src="...external">`).
- Images from the app bundle or embedded `data:` URIs.
- Network connections only to `ipc:` and `http://ipc.localhost` — both are Tauri's own IPC origin (the
  `invoke`/`Channel` transport the webview uses to talk to the Rust core), not a loopback into the engine
  sidecar: the sidecar is a stdio-only child process (stdin/stdout ndjson JSON-RPC), never reachable over
  HTTP. This matters for anyone tuning `connect-src` at M8 — relaxing or tightening this entry affects only
  the webview↔Rust IPC channel, never the engine.
- No external CDNs, no inline event handlers, no `eval()`.

**Development (`tauri dev`):** Relaxed `devCsp` allows `style-src 'unsafe-inline'` (for Vite HMR hot-reload CSS), `script-src 'unsafe-inline'` (`@vitejs/plugin-react` injects an inline `<script type="module">` react-refresh preamble in dev; without this, `script-src 'self'` blocks it and `tauri dev` fails to load), and `ws://localhost:*` (the dev server's own WebSocket). Both `unsafe-inline` relaxations are **dev only** — the production `security.csp`'s `script-src 'self'` (no inline scripts) is unchanged, since the built bundle has no inline scripts to allow. Styling/script issues that appear in `tauri dev` but not `tauri build` are dev-only artifacts; the production CSP is the authoritative definition.

CSP correctness is an **operator smoke** verified against a real running app
(see below) — `tauri build` compiles the policy into the binary, but only
invoking the app and checking for console CSP violation logs confirms it
works end to end.

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
4. **Orchestrate screen: route → cheap-worker diff → frontier review → escalate → apply, with a working Cancel button.** Open a real project, enter a task
   ("add a test for the signup form"), and watch the orchestrator:
   classify the task → route it to an open model → worker spawns an isolated
   git worktree → produces a diff → frontier review gate evaluates it → diff
   is approved/rejected (or escalated to frontier if rejected twice). Once
   approved, click the Apply button — verify that `git apply --3way` stages
   the diff (a `git status` shows "Changes to be committed"). Midway through
   a run, click Cancel and verify it transitions to "Cancelled" (not "Failed").
5. **Evals screen: run a real eval and see the honest report card.** Run evals
   on a few golden tasks (commits from the repo's history). Verify that the
   Evals screen renders:
   - A verdict (pass/fail/inconclusive — if "fail," there's an ETH-HAZARD red
     badge, never shown as a savings win).
   - A savings percentage with a `pricingConfidence` label (e.g., "28% (provider-reported)"),
     or a generic "not computable" if the figure can't be priced (unpriced models, an empty
     clean subset, zero clean-baseline cost, or subscription-auth zero-metering — never a fake number).
   - Per-task results (baseline pass/fail, harness pass/fail, measurement status).
   - Clean-subset counts at the top (cleanTaskCount, cleanBaselinePassed, etc.).
   - A working Cancel button that renders "Cancelled" once it settles.
6. **CSP under a production build.** Run `pnpm --filter @openfusion/desktop build` to produce a
   release binary (`tauri build` output), launch it directly, open the app,
   and invoke the Command-line-exposed JSON-RPC calls (or render a simple test screen
   that makes a Tauri invoke call). Watch the browser console (DevTools via Cmd+Option+I)
   — verify NO CSP violations appear (no "Content Security Policy has blocked…"
   messages). If CSP violations appear, that's a regression in the policy or a
   new inline script/style somewhere in the bundle.

## Packaging, signing, entitlements (M8)

This scaffold's `Entitlements.plist` already documents
`com.apple.security.cs.disable-library-validation` (needed because the
engine sidecar dlopen()s better-sqlite3's native addon under macOS's
hardened runtime) and leaves `allow-jit`/`allow-unsigned-executable-memory`
commented out pending empirical verification against a signed build.

- **Packaged sidecar + assets-dir dispatch — DONE (M8 Task 2).** `.setup()`
  now resolves both the sidecar binary path and its assets dir for whichever
  mode it's running in, and passes the assets dir to the sidecar via
  `OPENFUSION_ASSETS_DIR` on spawn. Dev-vs-packaged is decided by
  `exe_dir_has_packaged_sidecar` in `lib.rs`: a filesystem check ("does
  `<exe_dir>/openfusion-engine` — the triple-stripped bundled name — exist
  next to the running executable?"), deliberately **not** `cfg(dev)`/
  `tauri::is_dev()` (both are driven by a `custom-protocol` Cargo feature
  this crate's `Cargo.toml` never forwards to `tauri`, so they'd evaluate
  `true` unconditionally in every build, packaged or not — see that
  function's doc comment for the full reasoning). `tauri.conf.json`'s new
  `bundle.resources` entry (`"binaries/openfusion-engine.assets": "assets"`)
  ships the sidecar's `.assets/` dir into `Contents/Resources/assets`;
  `stage-sidecar.mjs` now also stages a triple-less `.assets` copy at a fixed
  path for that entry to reference (`tauri.conf.json` is static and can't
  glob/interpolate the host's target triple the way `externalBin` does).
  Empirically verified with a real `pnpm tauri build --debug --bundles app`:
  the resulting `.app` has `Contents/MacOS/openfusion-engine` (no triple) and
  `Contents/Resources/assets/{better_sqlite3.node,wasm/*.wasm,queries/**}`
  exactly as expected, and launching that `.app` directly showed the engine
  sidecar spawning from the packaged path and exiting cleanly (no orphan) on
  quit — see `.superpowers/sdd/m8-task-2-report.md` for the full account.
- **Nested code signing**, including the manual sidecar pre-sign fallback
  for the known Tauri bundler bug (#11992: sidecar signing during bundling
  can produce an invalid signature) — still open, M8 Task 3.
- **Notarization** (`xcrun notarytool`) and **stapling the `.dmg`** itself
  (not just the `.app`) — still open, M8 Task 3/4.
- Verifying empirically whether `allow-jit`/`allow-unsigned-executable-memory`
  are actually needed for a WKWebView-based (not Electron-based) app — still
  open, needs a signed+notarized build.

See `docs/research/2026-07-04-m7-tauri-verification.md` and
`docs/research/2026-07-04-m8-signing-verification.md` for the full
investigation behind these notes.
