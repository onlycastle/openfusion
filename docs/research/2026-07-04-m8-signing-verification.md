# M8 macOS Signing / Notarization / DMG Verification (verified 2026-07-04)

Verified against live Tauri v2 docs, Apple developer docs, and the `tauri-apps/tauri`
bundler source at tag `tauri-v2.11.5`. [V] verified live / [U] unconfirmed (operator-verify).

## THE TWO REAL BLOCKERS (both require code/config we build headlessly)

### Blocker A — unsigned `.node` in `.assets/` fails notarization [V]
- Tauri DOES auto-sign the externalBin sidecar binary itself (`codesign --force -s <id>
  --options runtime`) — that part just works. #11992 is still OPEN (no fix, no maintainer
  activity) but is NOT our failure mode.
- The gap: anything shipped via `bundle.resources` (the ONLY way to ship the sibling
  `.assets/` dir — Tauri has no sibling-file mechanism for externalBin) is copied into the
  bundle but NEVER SIGNED. Our `.assets/better_sqlite3.node` is an unsigned nested Mach-O →
  notary rejects "signature of the binary is invalid" / "not signed".
- FIX: manually `codesign --sign <identity> --options runtime --timestamp <path/to.node>`
  (and any Mach-O in `.assets/`) BEFORE the bundler copies it. `.wasm`/JSON/text do NOT need
  signing (Apple only scans Mach-O). Run via `beforeBundleCommand` in tauri.conf.json (runs
  before Tauri's copy/sign step; codesign survives the plain file copy). [beforeBundleCommand
  for this is functional but not an officially-documented sidecar-signing pattern — [U] on
  "blessed", [V] on "works"]. `TAURI_SKIP_SIDECAR_SIGNATURE_CHECK` is Windows-only — useless.

### Blocker B — packaged app can't find its assets at runtime [V]
- externalBin lands in `<App>.app/Contents/MacOS/`, and Tauri STRIPS the target-triple suffix:
  `openfusion-engine-aarch64-apple-darwin` → `openfusion-engine` (a string replace in
  `copy_binaries`, settings.rs ~L1168). So `${execPath}.assets` would look for
  `Contents/MacOS/openfusion-engine.assets` — which does NOT exist.
- `bundle.resources` ships `.assets/` into `Contents/Resources/` — a DIFFERENT dir from the
  binary in `Contents/MacOS/`. So the sidecar's `${execPath}.assets` self-location cannot work
  in the packaged app.
- FIX (required regardless of A): change the sidecar's asset resolution to PREFER an env var
  (`OPENFUSION_ASSETS_DIR`) over `${execPath}.assets`. The Rust host resolves the packaged
  assets dir via `app.path().resolve("assets", BaseDirectory::Resource)` / `resource_dir()`
  (→ `Contents/Resources`) and passes it to the sidecar spawn via the Command's env. Dev keeps
  the existing dist-sidecar `${execPath}.assets` fallback; the env var wins when set.

## Tauri 2.11 macOS config [V]
- `bundle.macOS`: `signingIdentity`, `entitlements` (→ Entitlements.plist), `hardenedRuntime`
  (bool, DEFAULT true — notarization prereq met by default), `minimumSystemVersion` (10.13),
  `dmg.{background,windowPosition,windowSize=660x400,appPosition,applicationFolderPosition}`.
  DMG target present + default.
- Env vars: cert `APPLE_CERTIFICATE`(+`_PASSWORD`), `APPLE_SIGNING_IDENTITY`; ASC API key
  `APPLE_API_KEY`/`APPLE_API_ISSUER`/`APPLE_API_KEY_PATH`; Apple-ID `APPLE_ID`/`APPLE_PASSWORD`
  (supports `@keychain:`/`@env:`)/`APPLE_TEAM_ID` (REQUIRED for the Apple-ID path).
- `tauri build` signs inside-out then runs `notarytool submit --wait` + staple INLINE for the
  `.app` when creds present. Flags: `--skip-stapling`, `--no-sign`.
- GAP: Tauri only CODE-SIGNS the `.dmg`, never notarizes/staples the `.dmg` itself. For the DMG
  to pass Gatekeeper offline → manual `xcrun stapler staple App.dmg` post-build. [V]

## notarytool / Apple (2026) [V]
- notarytool + stapler current; altool notarization dead since 2023-11-01.
- Auth: API key `--key <p8> --key-id <id> --issuer <issuer>` (CI-recommended); or Apple-ID
  `--apple-id <id> --team-id <id> --password <app-specific-pw>`; or `--keychain-profile <name>`
  (via `notarytool store-credentials`).
- Rejection checklist for our stack: invalid binary signature, cert not Developer ID, missing
  secure timestamp, hardened runtime not enabled on ANY nested binary, `get-task-allow`
  entitlement present, malformed entitlements, ANY UNSIGNED NESTED MACH-O (← Blocker A).

## JIT entitlement — OPERATOR-EMPIRICAL [U]
- No authoritative source confirms WKWebView-based (non-Electron) Tauri needs
  `com.apple.security.cs.allow-jit`. WKWebView JITs in Apple's own entitled
  `com.apple.WebKit.WebContent` XPC helper (outside our bundle), unlike Electron's in-process
  V8. Plausible we DON'T need it. RECOMMENDATION: build signed+notarized WITHOUT allow-jit /
  allow-unsigned-executable-memory FIRST; launch-test post-notarization; add ONLY if it crashes.
- disable-library-validation stays (sidecar loads a native addon we didn't sign as the app).

## M8 priority actions
1. (headless) sidecar asset resolution accepts `OPENFUSION_ASSETS_DIR` (Blocker B) — engine.
2. (headless) Rust packaged-path dispatch: resolve sidecar binary (MacOS/ packaged, dist-sidecar
   dev) + assets dir (Resources/ packaged via resource_dir), pass OPENFUSION_ASSETS_DIR on spawn.
   `bundle.resources` ships `.assets/`.
3. (headless authoring, OPERATOR run) beforeBundleCommand pre-signs the `.node` in `.assets/`
   with --options runtime; notarize+staple-the-.dmg script; entitlements (JIT commented).
4. (OPERATOR) signed `tauri build` (APPLE_SIGNING_IDENTITY+cert) → notarize (ASC API key) →
   staple .dmg → install-and-run + JIT empirical check on the operator's Mac.
