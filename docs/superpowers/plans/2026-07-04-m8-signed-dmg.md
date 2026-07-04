# M8: Signed & Notarized DMG Distribution — Implementation Plan (FINAL milestone)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenFusion installable as a signed + notarized `.dmg` that runs on a clean Mac without the Gatekeeper right-click dance. Two things must be true: (1) the packaged app can FIND and load its sidecar + native addon + wasm assets at runtime (they land in different bundle dirs than dev), and (2) every nested Mach-O is hardened-runtime-signed so notarization passes. This milestone splits into HEADLESS code/config we build+test here, and an OPERATOR RUNBOOK the user runs on their Mac with their Apple Developer credentials (which the engine/CI cannot supply).

**Architecture:** Task 1 (engine) makes the sidecar resolve its assets from an `OPENFUSION_ASSETS_DIR` env var (the packaged `.app` separates the binary from its assets, so `${execPath}.assets` self-location breaks). Task 2 (Rust) resolves the packaged sidecar-binary path + the assets dir and passes the env var on spawn, and configures `bundle.resources` to ship `.assets/`. Task 3 authors the signing pipeline: a `beforeBundleCommand` that pre-signs the `.node` native addon (Tauri never signs `bundle.resources` content — the real notarization blocker), the entitlements, the bundle config, and a notarize+staple-the-DMG script. Task 4 is docs + the complete operator runbook.

**Tech Stack (verified 2026-07-04, docs/research/2026-07-04-m8-signing-verification.md):** Tauri 2.11 (`hardenedRuntime` default true), `bundle.externalBin` → `Contents/MacOS/openfusion-engine` (triple stripped), `bundle.resources` → `Contents/Resources/`, `codesign --options runtime`, `xcrun notarytool submit --wait` + `stapler staple` (App Store Connect API key auth), the `@yao-pkg/pkg` sidecar from M7a.

## Global Constraints

- Everything standing: strict TS NodeNext `.js` imports (engine), conventional commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, nothing under `.superpowers/`/`.claude/`, auth-agnostic, no secret/prompt/model-output logging, the sidecar's stdout stays JSON-RPC only.
- **HEADLESS vs OPERATOR (this milestone is mostly operator-gated):** Tasks 1-2 are fully headless (engine vitest + cargo tests + a real packaged-layout simulation). Task 3's SCRIPTS + config are authored + validated headlessly (config parses, scripts are correct, `tauri build --help`-level checks) but the ACTUAL signed build + notarization + "DMG installs and runs" are OPERATOR steps needing the user's Apple Developer cert + notarization credentials (App Store Connect API key: issuer id + key id + `.p8`, OR Apple ID + app-specific password + team id). NEVER claim a signed/notarized artifact was produced — it can't be, here.
- **No secret material in the repo:** signing certs, the `.p8` key, passwords — NONE committed or logged. The scripts read them from env vars the operator sets. The runbook tells the operator how to provide them.
- **No regression:** engine 564 + shared 13 + desktop 89 component tests + the Rust cargo suite + `cargo clippy -D warnings` stay green throughout. The engine asset-resolution change must NOT break dev mode OR the M7a-1 standalone-sidecar-binary test (which relies on `${execPath}.assets`).

---

### Task 1: sidecar asset resolution via OPENFUSION_ASSETS_DIR (engine — the packaged-runtime fix)

**Files:** Modify `packages/engine/src/util/sidecar-runtime.ts` (the `isPackagedSidecar()` + asset-path logic), `packages/engine/src/wiki/languages.ts`/`parser.ts`/`store.ts` (the consumers that locate the `.node`/`.wasm`); tests.

**Why:** In the packaged `.app`, the sidecar binary is `Contents/MacOS/openfusion-engine` (triple stripped) but its assets are shipped to `Contents/Resources/` (a different dir). So `${process.execPath}.assets` self-location CANNOT find them. The Rust host (Task 2) will resolve the real assets dir and pass it via an env var.

**Interfaces:**
- `sidecar-runtime.ts`: the function that returns the assets base dir must resolve in this ORDER: (1) if `process.env.OPENFUSION_ASSETS_DIR` is set + exists → use it (the packaged `.app` case, set by the Rust host); (2) else if `isPackagedSidecar()` (`"pkg" in process`) → `${process.execPath}.assets` (the M7a standalone-binary case — dev/test/the sidecar-binary.test); (3) else the normal dev node_modules paths (un-packaged engine). So: env var wins, then the existing two paths unchanged. Document the precedence.
- The `.node` (better-sqlite3 nativeBinding) and the `.wasm` (tree-sitter locateFile) + `queries/` consumers all derive from that base dir — verify all three use the resolved base, so the env var covers them all.
- Do NOT log the resolved path content (a path is fine metadata, but keep it minimal).

- [ ] **Step 1: Failing tests** — with `OPENFUSION_ASSETS_DIR` set to a tmp dir containing a fake `better_sqlite3.node`/`wasm/`/`queries/` layout, the resolver returns that dir (precedence over both other paths); with it UNSET, the existing behavior is unchanged (isPackagedSidecar → execPath.assets; else dev paths — the M7a sidecar-binary.test + the normal engine tests still pass). A test proving env-var precedence + a test proving unset-behavior-unchanged.
- [ ] **Step 2: RED → implement → GREEN** — engine 564 (+N); the M7a `sidecar-binary.test` still GREEN (build the sidecar + run it WITHOUT the env var → still self-locates via execPath.assets), AND a NEW check that the compiled binary WITH `OPENFUSION_ASSETS_DIR` pointed at a relocated assets dir still works (simulate the packaged layout: move `.assets` elsewhere, set the env var, spawn → the JSON-RPC + native-addon proof still passes). This is the load-bearing proof that the packaged layout will work.
- [ ] **Step 3: Commit** `feat(engine): sidecar resolves assets from OPENFUSION_ASSETS_DIR (packaged-app layout)`

---

### Task 2: Rust packaged-path dispatch + bundle.resources (desktop)

**Files:** Modify `apps/desktop/src-tauri/src/lib.rs` (the sidecar spawn / EngineBridge path resolution — the packaged-path resolver from M7a-5 is pre-built but unwired), `apps/desktop/src-tauri/src/engine_bridge.rs` (accept + set the assets env var on spawn if needed), `apps/desktop/src-tauri/tauri.conf.json` (`bundle.resources`); cargo tests.

**Interfaces:**
- Resolve the SIDECAR BINARY path for both modes (wire the pre-built resolver): DEV → `packages/engine/dist-sidecar/openfusion-engine-<triple>` (or the staged `binaries/`); PACKAGED → `Contents/MacOS/openfusion-engine` (the triple-stripped name), resolved via Tauri's path API (the resolved resource/exe dir). Use `cfg`/the `dev`-cfg the M7a scaffold emits (`cargo:rustc-cfg=dev`) OR Tauri's runtime `is_dev`/resource resolution — pick the one that reliably distinguishes dev from a packaged `.app` and document.
- Resolve the ASSETS DIR: PACKAGED → `app.path().resolve("assets", BaseDirectory::Resource)` (→ `Contents/Resources/assets` or wherever `bundle.resources` places it); DEV → the sidecar's own `${execPath}.assets` still works (so pass NOTHING / don't set the env var in dev, letting the engine fall through). Set `OPENFUSION_ASSETS_DIR` on the sidecar spawn (the EngineBridge's tokio::process Command `.env(...)`) ONLY in packaged mode (or always, pointing at the correct dir).
- `tauri.conf.json` `bundle.resources`: ship the sidecar's `.assets/` dir into the bundle (into `Contents/Resources/`). The `stage-sidecar.mjs` script (M7a-2) stages the binary + `.assets` into `src-tauri/binaries/` for dev; for the bundle, `bundle.resources` must reference the `.assets` path so it lands in Resources. Configure the resources entry to map the staged `.assets` → a known Resources subdir (e.g. `assets/`). Document the mapping so Task 3's pre-sign script knows where the `.node` is in the STAGED tree (to sign it before bundling).

- [ ] **Step 1: Failing cargo tests** — the path resolver returns the dev path in dev-cfg and the packaged `Contents/MacOS/openfusion-engine` path in packaged-cfg (test both branches, mocking the base dirs); the EngineBridge spawn sets `OPENFUSION_ASSETS_DIR` to the resolved assets dir in packaged mode (spy the Command env); dev mode leaves it unset (engine falls through to execPath.assets). `bundle.resources` config is valid (the conf parses + `cargo build` / a config-validation check).
- [ ] **Step 2: RED → implement → GREEN** — cargo test + clippy -D warnings clean; `cargo build` + desktop build clean; engine untouched.
- [ ] **Step 3: Commit** `feat(desktop): packaged sidecar-path dispatch + assets-dir env on spawn; ship .assets via bundle.resources`

---

### Task 3: signing pipeline — pre-sign the native addon, entitlements, notarize+staple-DMG script

**Files:** Create `apps/desktop/scripts/presign-sidecar-assets.mjs` (the beforeBundleCommand pre-sign), `apps/desktop/scripts/notarize-staple-dmg.mjs` (post-build DMG staple), modify `apps/desktop/src-tauri/tauri.conf.json` (`beforeBundleCommand`, `bundle.macOS` signing config, entitlements), `apps/desktop/src-tauri/Entitlements.plist`; a small unit test for the scripts' logic where feasible.

**Interfaces:**
- **`presign-sidecar-assets.mjs`** (wired as `beforeBundleCommand` OR a documented pre-build step): finds every Mach-O in the staged `.assets/` (primarily `better_sqlite3.node`) and runs `codesign --sign "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp --force <file>`. This closes Blocker A (Tauri never signs `bundle.resources` content, so the `.node` would be an unsigned nested Mach-O → notarization fails). `.wasm`/JSON/text are skipped (not Mach-O). The script: detects Mach-O (via `file` or a magic-byte check), signs only those, is idempotent, and FAILS LOUDLY if `APPLE_SIGNING_IDENTITY` is unset (so a build without a cert fails clearly rather than shipping unsigned). Do NOT sign in the script if the env is unset AND it's a dev/unsigned build — but for a release build the identity is required. Document.
- **`bundle.macOS`**: `signingIdentity` (or via `APPLE_SIGNING_IDENTITY`), `entitlements: "Entitlements.plist"`, `hardenedRuntime` left default-true. The notarization creds come from env (`APPLE_API_KEY`/`_ISSUER`/`_KEY_PATH`) — `tauri build` runs notarytool for the `.app` inline.
- **`Entitlements.plist`**: `com.apple.security.cs.disable-library-validation` (needed — the sidecar loads the `.node` we sign separately). `allow-jit`/`allow-unsigned-executable-memory` stay COMMENTED with a note: build signed WITHOUT them first, add only if the app crashes post-notarization (WKWebView likely doesn't need them — operator-empirical).
- **`notarize-staple-dmg.mjs`**: post-`tauri build`, staple the `.dmg` itself (Tauri only staples the `.app`, not the `.dmg`) — `xcrun stapler staple <path/to.dmg>` (the `.dmg` was already notarized as it contains the notarized `.app`; if the DMG needs its own notarization submission, do `notarytool submit --wait <dmg>` then staple — CONFIRM at operator time which is needed; the script handles both with a flag). FAILS LOUDLY without creds.
- HEADLESS validation: the scripts are syntactically correct + their logic unit-tested where possible (e.g. the Mach-O detection on a fixture, the "fails loudly without identity" path); the tauri.conf.json parses; `cargo build` (unsigned) still works. The ACTUAL signing is an OPERATOR step (no cert here).

- [ ] **Step 1:** author the scripts + config; unit-test the script logic that's testable (Mach-O detection, fail-without-identity); confirm `cargo build` + desktop build still clean (unsigned dev build unaffected — the presign script must NO-OP or be skipped for an unsigned dev build).
- [ ] **Step 2: Commit** `feat(desktop): pre-sign sidecar native addon, entitlements, notarize+staple-DMG scripts`
- [ ] **OPERATOR STEPS (documented in Task 4, NOT run here):** the real signed `tauri build` + notarization + staple + install-and-run.

---

### Task 4: docs + the OPERATOR RUNBOOK

**Files:** Create `apps/desktop/BUILDING.md` (or a "Distribution" section), modify root README, spec §8/§11 (distribution).

**Content — a COMPLETE, PRECISE operator runbook** (the user runs this on their Mac; be exact):
- **Prerequisites**: an Apple Developer account; a "Developer ID Application" certificate installed in the login keychain (or as a base64 `.p12` + password for CI); notarization credentials — the App Store Connect API key (Issuer ID + Key ID + the `AuthKey_XXX.p8` file) [recommended] OR an Apple ID + an app-specific password + Team ID.
- **The exact env vars** to set (`APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"`, `APPLE_API_KEY`/`APPLE_API_ISSUER`/`APPLE_API_KEY_PATH`, etc.) with a note that NONE are committed.
- **The build sequence**: (1) `pnpm --filter @openfusion/engine build:sidecar` (produce the sidecar binary + `.assets`); (2) `node apps/desktop/scripts/stage-sidecar.mjs` (stage into `binaries/`); (3) set the signing env vars; (4) `pnpm --filter @openfusion/desktop tauri build` (this pre-signs the `.node` via beforeBundleCommand, builds, signs, notarizes the `.app` inline); (5) `node apps/desktop/scripts/notarize-staple-dmg.mjs` (staple the `.dmg`). Show the exact commands.
- **Verification (the operator smokes, consolidated)**: `spctl -a -vvv -t install <App>.app` (Gatekeeper accepts), `codesign -dvvv --entitlements - <App>.app`, `stapler validate <App>.dmg`; install on a CLEAN Mac (or a fresh user) → the app launches with NO right-click dance; run a real orchestration + evals in the cockpit; verify NO console CSP violations; verify NO orphaned engine process on quit (`ps`). The **JIT empirical check**: if the app crashes on launch post-notarization, add `allow-jit`/`allow-unsigned-executable-memory` to Entitlements.plist and rebuild — otherwise leave them out.
- **Troubleshooting**: the top notarization rejections (unsigned nested Mach-O → the presign script; hardened runtime; cert type) with the `notarytool log <submission-id>` command to read the rejection detail.
- Consolidate ALL pending operator smokes (the 5 engine smokes incl. the M6 first-real-savings-number; the desktop batch) into one "before you trust / ship this" checklist.
- Spec: note the realized distribution + that a signed DMG requires the operator's Apple credentials.

- [ ] Implement the runbook + docs; all suites green (docs + scripts don't break tests); commit `docs: M8 operator runbook for signed+notarized DMG distribution`

---

## Milestone exit checklist

- [ ] Engine (564+) + shared + desktop component tests + Rust cargo + clippy all green; the sidecar asset-resolution change did NOT break dev, the standalone-binary test, OR normal engine tests
- [ ] HEADLESS-PROVEN: the sidecar finds its assets via `OPENFUSION_ASSETS_DIR` (packaged layout simulated + the compiled binary works with a relocated `.assets`); the Rust path dispatch resolves dev vs packaged + sets the env on spawn; `bundle.resources` ships `.assets`; the presign + staple scripts are correct + validated (Mach-O detection, fail-without-identity); tauri.conf.json parses; unsigned `cargo build`/desktop build clean
- [ ] The signing pipeline is COMPLETE + documented but UN-RUN (no Apple creds here) — never claimed as a produced signed artifact
- [ ] OPERATOR RUNBOOK is complete + precise (prerequisites, exact env vars, build sequence, verification smokes incl. the JIT empirical check, troubleshooting, the consolidated smoke checklist)
- [ ] ROADMAP COMPLETE: M0→M8 shipped. OpenFusion is a signed-DMG-buildable macOS app implementing Harness Fusion (frontier orchestration + cheap open-model workers) with an LLM wiki, specialist agents, honest cost-vs-quality evals, and a project cockpit. The remaining gate to a public release is the operator running the signing + the full smoke suite (which yields the first real savings number).
