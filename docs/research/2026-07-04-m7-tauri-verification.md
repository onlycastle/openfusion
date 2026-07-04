# M7 Desktop-Shell Tech Verification (verified 2026-07-04)

Local toolchain probed: Rust 1.94.1 (aarch64-apple-darwin), Node 25.3 + pnpm
11.9, `node:sea` available, `codesign`/`xcrun`/`notarytool` present (Xcode
installed → operator can sign/notarize on this machine with their Developer ID
+ notarization creds). Workspace already declares `apps/*` → desktop app lives
at `apps/desktop`. No Tauri scaffold yet.

## Tauri 2 (current, GA)
- `@tauri-apps/cli` 2.11.4, `@tauri-apps/api` 2.11.1, `tauri` crate 2.11.5. v2
  GA since Oct 2024; v3 has a milestone (gtk3→gtk4 Linux) but NO committed date
  — don't plan around it. [V]
- **Sidecar bundling**: `tauri.conf.json` `bundle.externalBin: ["binaries/openfusion-engine"]`
  (path rel to `src-tauri/`); bundler auto-appends the target triple
  (`-aarch64-apple-darwin`). JS `Command.sidecar('binaries/openfusion-engine')`
  from `@tauri-apps/plugin-shell`; capability needs `shell:allow-spawn` + an
  args allow-list with `"sidecar": true`. [V]
- **Node CANNOT run as a raw sidecar** — must compile to a self-contained
  binary. Tauri's tutorial uses `@yao-pkg/pkg` (maintained pkg fork). Node SEA
  (stable Node 22+, `node:sea` present locally) is a valid alt. CHOICE DRIVER:
  our engine has a NATIVE addon (better-sqlite3) + wasm assets (web-tree-sitter,
  @vscode/tree-sitter-wasm). pkg has the broader native-module story; SEA needs
  manual asset/addon handling. **Verify at impl: which cleanly bundles
  better-sqlite3's .node + the tree-sitter .wasm files.** [V/U]
- **Long-lived bidirectional stdio JSON-RPC server WORKS** via plugin-shell
  `Command.spawn()` (NOT `.execute()` which blocks): returns a `Child` handle;
  write JSON-RPC to stdin, stream ndjson from `CommandEvent::Stdout` lines. Rust
  owns the child. NO separate socket needed — this is the recommended pattern.
  Gotcha: child-side stdout buffering — our engine writes ndjson line-by-line to
  stdout already; verify no batching wrapper. [V]
- **Frontend↔Rust**: `Channel<T>` (`@tauri-apps/api/core`) is the current
  primitive for streaming (used internally for child-process output) → forward
  engine progress notifications to the webview via a Channel per long-running
  call; `invoke` for request/response RPC. [V]

## macOS signing + notarization (the fragile part)
- Tauri bundler runs `codesign` + `xcrun notarytool` INLINE during `tauri build`
  when env vars set: `APPLE_SIGNING_IDENTITY`/`APPLE_CERTIFICATE`(+PW), notarize
  via App Store Connect API key (`APPLE_API_ISSUER`/`_KEY`/`_KEY_PATH` — CI-
  recommended) or Apple-ID app-specific PW. [V]
- **Entitlements** (in a dedicated `Entitlements.plist` via
  `bundle.macOS.entitlements`, NOT Info.plist):
  - `com.apple.security.cs.disable-library-validation` — **NEEDED** because our
    Node sidecar loads a native addon (better-sqlite3 `.node`); hardened runtime
    enforces same-Team-ID library validation without it (real bug class:
    ERR_DLOPEN_FAILED on native addons). [V — for our arch]
  - `allow-jit` + `allow-unsigned-executable-memory` — every Tauri guide pairs
    these (JIT), but WKWebView runs JS in Apple's own entitled helper, so they
    MAY be unnecessary for a system-webview app (unlike Electron). **[U] verify
    empirically: build signed WITHOUT them first, ship only if the app crashes.**
  - **Spawning the external `claude`/`codex` CLI needs NO entitlement** — they're
    outside the .app bundle (user-installed, vendor-signed), and Developer-ID
    (non-App-Store) apps don't enable App Sandbox. Only in-bundle binaries are
    scanned/restricted. [V]
- **Nested signing**: every binary INSIDE the .app (incl. the externalBin Node
  sidecar + its native .node) must be independently hardened-runtime-signed,
  bottom-up. OPEN TAURI BUG #11992: sidecar signing during bundling can fail
  ("signature of the binary is invalid"). **Budget manual pre-sign of the
  sidecar** (`codesign --sign <id> --options runtime --entitlements
  sidecar-ent.plist <binary>`) before the bundler runs; test on a clean machine.
  [V]
- **Staple the .dmg itself** (`xcrun stapler staple App.dmg`), not just the .app,
  or the DMG mount warns. Notarized+stapled → no right-click-open. [V]

## Keychain for BYOK secrets
- NO first-party Tauri Keychain plugin. Recommended: call the Rust `keyring`
  crate DIRECTLY from a custom Tauri command (thin, no plugin-dep risk; wraps
  macOS Security framework). Stronghold is the wrong tool (encrypted-vault-with-
  password) and is on a path out by v3. [V]
- **Shape for our constraint** (memory-only default, opt-in persist): BYOK keys
  in a Rust-side `Mutex<HashMap>` for the session; on explicit user opt-in,
  write-through `keyring` to Keychain under a stable service name; read-through
  on next launch only if previously opted in. (M7b scope.) [V]

## Sanity
- Pin sidecar runtime to **Node 24** (Active LTS as of 2026-07; Node 22 winding
  down, Node 26 becomes LTS Oct 2026). Dev machine has Node 25 — separate from
  the pinned sidecar runtime. [V]
- Common gotcha: one unsigned dylib anywhere in the bundled node_modules fails
  notarization cryptically → the nested-signing discipline above. External
  claude/codex exempt (not in bundle). [V]

## Verify at implementation time (unsettled)
1. pkg (`@yao-pkg/pkg`) vs Node SEA for OUR engine (better-sqlite3 .node +
   tree-sitter .wasm) — which bundles the native addon + wasm assets cleanly.
2. allow-jit/allow-unsigned-executable-memory actually required for WKWebView-
   based Tauri (test signed build without them).
3. `Command.sidecar()` arg = bare filename vs full externalBin string — confirm
   against installed plugin-shell TS types.
4. Tauri #11992 sidecar-signing bug — plan manual pre-sign fallback.

## Architecture for M7 (backbone)
webview (cockpit UI) ──invoke/Channel──▶ Rust (Tauri core) ──stdio ndjson
JSON-RPC──▶ openfusion-engine sidecar (compiled Node binary) ──spawns──▶
claude/codex CLI (external) + open-model HTTPS (BYOK). Rust owns the engine
child's lifecycle (spawn on startup, clean shutdown on window close). Engine's
existing RPC surface (wiki/models/frontier/worker/orchestrate/evals) is the
backend, unchanged.
