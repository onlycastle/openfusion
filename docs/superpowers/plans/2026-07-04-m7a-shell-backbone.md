# M7a: Desktop Shell Backbone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the load-bearing desktop architecture end to end: the `@openfusion/engine` Node app compiled to a self-contained sidecar binary, spawned and owned by a Tauri 2 Rust host, speaking newline-delimited JSON-RPC 2.0 over stdio, with request/response correlation + progress-notification streaming to a minimal webview that invokes one real engine method and renders the result. This de-risks packaging (native addon + wasm assets in a signed-capable binary) and the sidecar-as-long-lived-stdio-server pattern before any cockpit UI is built on top.

**Architecture:** webview ──invoke/Channel──▶ Rust (Tauri core, owns the engine child) ──stdio ndjson JSON-RPC──▶ openfusion-engine sidecar (compiled Node binary) ──▶ (unchanged) engine RPC surface. The engine is NOT modified except where the shell needs a lifecycle hook. New workspace member: `apps/desktop` (workspace already declares `apps/*`).

**Tech Stack (verified 2026-07-04, docs/research/2026-07-04-m7-tauri-verification.md):** Tauri 2.11 (`@tauri-apps/cli` 2.11.4, `tauri` crate 2.11.5), Rust 1.94 (aarch64-apple-darwin, local), `@tauri-apps/plugin-shell` `Command.spawn` for the long-lived sidecar, `Channel<T>` for notification streaming. Engine → self-contained binary via `@yao-pkg/pkg` or Node SEA (Task 1 decides, driven by better-sqlite3 native addon + tree-sitter wasm assets). Sidecar runtime pinned to Node 24 LTS.

## Global Constraints

- Everything standing where it applies: strict TS NodeNext `.js` imports (engine/frontend TS), conventional commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, nothing under `.superpowers/`/`.claude/` of THIS repo, auth-agnostic (the Rust host and engine NEVER handle frontier credentials — the engine spawns the external `claude`/`codex` CLI which uses the operator's own OAuth), open-model API keys memory-only (Keychain persistence is M7b), prompts/model-output/file-content never logged, stdout of the sidecar is JSON-RPC PROTOCOL ONLY (the Rust host parses it — any engine diagnostic must stay on stderr).
- **Headless vs operator split (IMPORTANT — this milestone is partly operator-gated):** each task's deliverable must be verifiable HEADLESSLY (a compiled binary that speaks JSON-RPC tested via a Node/Rust harness; `cargo test`; frontend build+typecheck). The actual Tauri APP LAUNCHING in a webview, and anything needing a display or Apple signing certs, is an OPERATOR SMOKE — enumerate each explicitly; never claim an un-runnable step passed.
- **No engine regression:** `pnpm --filter @openfusion/engine test` stays green (528 tests) throughout. The engine's stdout-protocol-purity is what makes the sidecar work — don't break it.
- Rust: `cargo build` + `cargo test` green; `cargo clippy` clean where run. Frontend: builds + typechecks.

---

### Task 1: engine → self-contained sidecar binary + headless JSON-RPC proof

**Files:**
- Create: `packages/engine/scripts/build-sidecar.mjs` (compile), `packages/engine/test/sidecar-binary.test.ts` (headless proof)
- Modify: `packages/engine/package.json` (a `build:sidecar` script + the compile toolchain devDep)

**This is the highest-risk task — do it first. It proves the engine can ship as a signed-capable binary carrying its native addon (better-sqlite3) + wasm assets (web-tree-sitter, @vscode/tree-sitter-wasm).**

**Approach:**
- Evaluate `@yao-pkg/pkg` vs Node SEA for compiling `packages/engine`'s built entrypoint into `openfusion-engine-<target-triple>` (start with the local `aarch64-apple-darwin`). The DECIDER: which one cleanly bundles/loads better-sqlite3's `.node` native addon AND the tree-sitter `.wasm` assets at runtime. Native addons typically can't be embedded in the binary — they must ride ALONGSIDE it (the binary + a sibling `node_modules`/assets dir, or pkg's asset mechanism). Document the chosen tool + how the native `.node` and `.wasm` are located at runtime (this dictates how M8 lays out the binary inside the .app bundle).
- `build-sidecar.mjs`: builds the engine (tsc) then produces `dist-sidecar/openfusion-engine-<triple>` (+ any sibling assets). Pin Node 24 as the embedded runtime. Emit the target triple in the filename (Tauri's externalBin convention). Idempotent; documents its output layout.
- **Headless proof test** (`sidecar-binary.test.ts`, env-gated on the binary existing since CI may not compile it every run — `it.skipIf(!existsSync(binaryPath))`, and a separate always-run test that builds+probes if fast enough): spawn the compiled binary as a child process, write a JSON-RPC request to its stdin (e.g. an engine method that exercises SQLite + a trivial call — `engine.models.list` or a wiki/store no-op that opens the DB), read the ndjson response from stdout, assert a well-formed JSON-RPC result. This proves the COMPILED BINARY is a working engine (native addon loads, stdio protocol intact), not just that tsc ran.

**Interfaces produced:** the binary path + naming convention + runtime asset layout (consumed by Task 2's externalBin config and M8's bundle layout).

- [ ] **Step 1: Failing test** — sidecar-binary.test.ts spawns the (to-be-built) binary, sends `{"jsonrpc":"2.0","id":1,"method":"engine.models.list","params":{}}\n`, expects a JSON-RPC result line. RED (no binary yet).
- [ ] **Step 2: build-sidecar.mjs** (tool chosen + documented) → binary builds → test GREEN. Also `pnpm --filter @openfusion/engine test` still 528 green.
- [ ] **Step 3: Commit** `feat(engine): compile engine to a self-contained sidecar binary with JSON-RPC-over-stdio proof`

---

### Task 2: scaffold the Tauri 2 app at apps/desktop

**Files:**
- Create: `apps/desktop/` (Tauri scaffold: `src-tauri/` [Cargo.toml, tauri.conf.json, src/main.rs, src/lib.rs, capabilities/, Entitlements.plist stub], a minimal frontend `src/` + `package.json` + `index.html` + vite config), workspace wiring.
- Modify: root `pnpm-workspace.yaml` already has `apps/*` (verify); add the desktop app's build scripts.

**Approach:**
- Scaffold a Tauri 2 app (vanilla-TS or a light framework — keep the frontend minimal for the backbone; the cockpit UI is M7b). Add `@tauri-apps/cli` + `@tauri-apps/api` + `@tauri-apps/plugin-shell` as devDeps of `apps/desktop`.
- `tauri.conf.json`: `bundle.externalBin: ["binaries/openfusion-engine"]`; a build hook (or documented manual step) that copies Task 1's `openfusion-engine-<triple>` (+ assets) into `src-tauri/binaries/`. Capability file granting `shell:allow-spawn` for the sidecar with an args allow-list (`"sidecar": true`). `bundle.macOS.entitlements: "Entitlements.plist"` (stub with `disable-library-validation`; the JIT entitlements left commented with a note to verify empirically per research).
- The scaffold must BUILD headlessly: `cargo build` (in src-tauri) compiles; the frontend builds+typechecks. (Actual `tauri dev`/app-launch is an OPERATOR SMOKE.)

- [ ] **Step 1:** scaffold builds — `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` compiles clean; frontend `pnpm --filter <desktop> build` + typecheck clean. (No unit test yet — the deliverable is a compiling scaffold; the bridge logic + its tests are Task 3.)
- [ ] **Step 2: Commit** `feat(desktop): scaffold Tauri 2 app with engine sidecar externalBin config`
- [ ] **OPERATOR SMOKE (document, don't run):** `pnpm --filter <desktop> tauri dev` launches a window (needs a display).

---

### Task 3: Rust engine-bridge — spawn, JSON-RPC client, notification routing, shutdown

**Files:**
- Create: `apps/desktop/src-tauri/src/engine_bridge.rs` (+ module wiring in lib.rs)
- Test: `apps/desktop/src-tauri/src/engine_bridge.rs` `#[cfg(test)]` tests (or a `tests/` integration test)

**Interfaces:**
- `EngineBridge`: owns the spawned sidecar child (via plugin-shell `Command.sidecar(...).spawn()` OR Rust `std::process`/`tokio::process` if that's cleaner for owning stdin+stdout streams — DECIDE and document; the research says plugin-shell `Command.spawn` supports persistent stdin + streaming stdout, but a Rust-owned `tokio::process::Child` may give cleaner async stream ownership for a JSON-RPC client — pick the one that gives reliable bidirectional streaming and justify).
- `async fn call(&self, method: &str, params: Value) -> Result<Value, RpcError>` — assigns a unique id, writes `{jsonrpc,id,method,params}\n` to the child's stdin, awaits the matching-id response from a stdout reader task that parses ndjson and correlates by id (a map of id→oneshot sender). RpcError carries the JSON-RPC error {code,message,data}.
- Notification routing: stdout lines that are JSON-RPC NOTIFICATIONS (no id — the engine's progress notifications) are pushed onto a broadcast channel the Tauri command layer (Task 4) subscribes to and forwards to the webview.
- `async fn shutdown(&self)` — closes stdin / sends the engine's shutdown, waits (bounded) for the child to exit, kills if it overruns. Called on app exit (Task 5).
- Robustness: a malformed stdout line → logged to the Rust host's own stderr (NOT the webview), never crashes the reader; the reader task surviving the child's exit; stdout is protocol-only (stderr of the child is drained separately to the host log).

**Testing (headless, cargo):** unit/integration tests using a MOCK sidecar — a tiny script (a shell/node one-liner, or a Rust test helper binary) that reads JSON-RPC from stdin and emits scripted ndjson responses + a notification. Assert: call() correlates a response by id; concurrent calls get their own responses (no cross-talk); a notification reaches the broadcast; a malformed line doesn't crash; shutdown terminates cleanly. (Using the REAL Task-1 binary is a nice integration test if fast — gate it on the binary existing.)

- [ ] **Step 1: Failing cargo tests** for call-correlation, concurrent-calls, notification-routing, malformed-line-resilience, shutdown — against a mock sidecar. RED.
- [ ] **Step 2:** implement EngineBridge → `cargo test` GREEN, `cargo clippy` clean.
- [ ] **Step 3: Commit** `feat(desktop): Rust engine bridge — JSON-RPC over stdio with notification routing`

---

### Task 4: Tauri commands + Channel streaming + minimal end-to-end frontend

**Files:**
- Create/Modify: `apps/desktop/src-tauri/src/commands.rs` (Tauri commands), lib.rs (register EngineBridge in state, register commands), the frontend `src/main.ts` + one screen.
- Test: cargo tests for the command layer (with the mock bridge/sidecar); frontend build+typecheck.

**Interfaces:**
- A generic `#[tauri::command] async fn engine_call(state, method: String, params: Value) -> Result<Value, String>` bridging invoke→EngineBridge.call (or a few typed commands — a generic passthrough is fine for the backbone; typed per-method commands are M7b).
- A `#[tauri::command] fn engine_events(channel: Channel<Value>)` (or wire the broadcast to a Channel) that streams engine progress notifications to the webview.
- Frontend: ONE screen that on load (or button click) `invoke('engine_call', {method:'engine.models.list', params:{}})` and renders the result, and subscribes to the engine-events Channel showing any notification. This is the end-to-end proof surface (its RUN is an operator smoke; its CODE builds+typechecks headlessly).

**Testing:** cargo tests for engine_call routing (mock bridge returns a value → command returns it; an RpcError → mapped to the command's Err); frontend builds + typechecks. The actual click-and-see-result is the OPERATOR SMOKE.

- [ ] **Step 1: Failing cargo tests** for engine_call success + error mapping. RED.
- [ ] **Step 2:** implement commands + minimal frontend → cargo GREEN, frontend build+typecheck clean.
- [ ] **Step 3: Commit** `feat(desktop): engine_call command, notification channel, minimal end-to-end frontend`
- [ ] **OPERATOR SMOKE (document):** launch the app → the screen shows the engine's models.list result (proves webview→Rust→sidecar→engine→back).

---

### Task 5: engine lifecycle ownership + shutdown + backbone docs

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (spawn EngineBridge on setup, shutdown on exit), `apps/desktop/README.md`, root README (desktop section), spec §5/§9 note.
- Test: a cargo test that the app-state EngineBridge spawns + shuts down cleanly (with the mock sidecar); no orphaned child on exit.

**Interfaces:**
- On Tauri `setup`: build the sidecar binary path (from the bundled `binaries/` location in a packaged app, or the dist-sidecar path in dev — resolve both, documented), spawn the EngineBridge, store in managed state.
- On window `CloseRequested` / app exit: call `EngineBridge::shutdown()` (bounded), ensuring the sidecar child is reaped (no orphaned engine process — the mirror of the engine's own no-orphan discipline). Test the shutdown path with the mock.
- Docs: `apps/desktop/README.md` — the architecture (webview↔Rust↔sidecar), how to build the sidecar + run dev, the OPERATOR SMOKES list, and the entitlements/signing notes deferred to M8. Root README: a "Desktop app (M7)" paragraph. Spec §5: note the realized shell architecture; §9: the sidecar stdio boundary + no-orphan shutdown.

- [ ] **Step 1: Failing cargo test** — spawn-then-shutdown reaps the child, bounded. RED.
- [ ] **Step 2:** implement lifecycle + docs → cargo GREEN; engine 528 still green; frontend builds.
- [ ] **Step 3: Commit** `feat(desktop): engine lifecycle ownership with clean shutdown; backbone docs`

---

## Milestone exit checklist

- [ ] Sidecar binary compiles and PROVABLY speaks JSON-RPC over stdio (native addon + wasm load) — headless test green
- [ ] Tauri app scaffold `cargo build`s; frontend builds+typechecks; `cargo test` green for bridge + commands + lifecycle
- [ ] `pnpm --filter @openfusion/engine test` still 528 green; no engine regression; clean tree; nothing under `.superpowers/`/`.claude/` committed
- [ ] OPERATOR SMOKES (documented, need a display / the operator's machine): `tauri dev` launches; the minimal screen renders the engine's models.list result via the full webview→Rust→sidecar→engine chain; app exit leaves no orphaned engine process
- [ ] Next: M7b (cockpit UI — project workspace screens for index/generate/orchestrate/eval-report-card + Keychain BYOK + evals.run CANCELLATION [M6 inherit] + run-scoped metering display), then M8 (sign + notarize + DMG, with the manual sidecar pre-sign fallback for Tauri #11992)
