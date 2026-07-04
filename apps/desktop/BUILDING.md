# Building a signed & notarized OpenFusion DMG (operator runbook)

This is the runbook a human operator follows **on their own Mac, with their
own Apple Developer credentials**, to produce a `.dmg` that installs on a
clean Mac with no Gatekeeper right-click dance. Nothing here can run in CI
or in this development environment — it requires a real "Developer ID
Application" certificate and real notarization credentials, neither of
which this repository holds or can supply.

The headless half of this pipeline (sidecar asset resolution, packaged-path
dispatch, the signing scripts themselves) is already built and tested. This
document is the remaining, credential-gated half.

## 1. Prerequisites

- An **Apple Developer Program** account ($99/yr — the only mandatory paid
  dependency for distribution).
- A **"Developer ID Application"** certificate (NOT "Apple Development" or
  "Mac App Store" — those won't pass notarization) installed in your login
  keychain. Verify with:

  ```sh
  security find-identity -v -p codesigning
  ```

  For CI or a machine without the cert already in a keychain, Tauri also
  accepts the certificate as a base64-encoded `.p12` + its password (see
  §2 below) instead of a keychain entry.
- **Notarization credentials** — pick one:
  - **App Store Connect API key** (recommended): an Issuer ID, a Key ID, and
    the downloaded `AuthKey_<KeyID>.p8` file (generated once in App Store
    Connect → Users and Access → Integrations → Keys).
  - **Apple ID + app-specific password**: your Apple ID email, an
    app-specific password (generated at appleid.apple.com — **not** your
    normal Apple ID password), and your Team ID.
- **macOS** with the **Xcode command line tools** installed (`codesign`,
  `xcrun notarytool`, `xcrun stapler`). Verify with `xcrun --version`.
- **Node ≥ 22** and **pnpm** (via `corepack enable`), and a working **Rust**
  toolchain (`cargo`, `rustc`) for the Tauri build.

## 2. The exact environment variables

Set these **in your shell session only** — never in a committed file, a
`.env`, or anywhere that could end up in git. None of these are read from
disk by any script here; every one of them comes from `process.env`/`env`
at the moment the relevant command runs.

**Signing (required for any release build):**

| Variable | Value | Notes |
|---|---|---|
| `APPLE_SIGNING_IDENTITY` | `"Developer ID Application: <Your Name or Org> (<TEAMID>)"` | Must exactly match a cert `security find-identity` shows. **Required** — see §3 step 5: the build fails loudly without it. |
| `APPLE_CERTIFICATE` | base64-encoded `.p12` | Optional — only needed on a machine without the cert in a keychain (e.g. a CI runner). Read by Tauri itself, not by any script in this repo. |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12`'s password | Pairs with `APPLE_CERTIFICATE` above. |

**Notarization — pick ONE mode.** `tauri build` uses these to notarize +
staple the `.app` inline; `notarize-staple-dmg.mjs --notarize` (§3 step 6)
recognizes all three:

| Mode | Variables |
|---|---|
| ASC API key (recommended) | `APPLE_API_KEY` (Key ID), `APPLE_API_ISSUER` (Issuer ID), `APPLE_API_KEY_PATH` (absolute path to `AuthKey_<KeyID>.p8`) |
| Apple ID + app-specific password | `APPLE_ID`, `APPLE_PASSWORD` (app-specific, supports `@keychain:name` / `@env:VAR` per Tauri), `APPLE_TEAM_ID` |
| Keychain profile (script-only; `notarize-staple-dmg.mjs --notarize` only — `tauri build` itself does not read this one) | `APPLE_KEYCHAIN_PROFILE` (a name previously registered via `xcrun notarytool store-credentials`) |

Example session (ASC API key mode):

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Jane Doe (ABCDE12345)"
export APPLE_API_KEY="AB12CD34EF"
export APPLE_API_ISSUER="12345678-1234-1234-1234-123456789012"
export APPLE_API_KEY_PATH="/Users/jane/private_keys/AuthKey_AB12CD34EF.p8"
```

## 3. The build sequence

Run these in order, from the repository root, in the same shell session
where you exported the variables above.

```sh
# 1. Install dependencies (skip if already installed / lockfile unchanged)
pnpm install

# 2. Compile the engine into a self-contained sidecar binary + its
#    .assets sibling (native addon, tree-sitter wasm, tags.scm queries)
pnpm --filter @openfusion/engine build:sidecar

# 3. Stage the sidecar (+ two .assets copies) into src-tauri/binaries/,
#    where Tauri's bundle.externalBin / bundle.resources expect them
pnpm --filter @openfusion/desktop stage-sidecar

# 4. Signing + notarization env vars must already be exported (§2) —
#    do this BEFORE step 5, or the build fails at the presign step below.

# 5. Build the frontend, bundle the app, sign it, and (if notarization
#    creds are present) notarize + staple the .app — all in one command
pnpm --filter @openfusion/desktop tauri build

# 6. Staple the notarization ticket onto the .dmg container itself
#    (tauri build only staples the .app inside it, never the .dmg)
node apps/desktop/scripts/notarize-staple-dmg.mjs
```

**What step 5 actually does**, in order: it runs `beforeBuildCommand`
(`pnpm build`, compiling the React frontend), then Tauri's bundler starts,
which first runs `beforeBundleCommand` — `node
scripts/presign-sidecar-assets.mjs`, run **automatically**, no separate
manual invocation needed. That script code-signs every Mach-O file under
the staged `binaries/openfusion-engine.assets/` (in practice,
`better_sqlite3.node`) with `codesign --sign "$APPLE_SIGNING_IDENTITY"
--options runtime --timestamp --force <file>` **before** Tauri copies
`bundle.resources` into the app — this is the fix for the one thing Tauri
never signs itself (anything shipped via `bundle.resources` lands in
`Contents/Resources/` unsigned; only the externalBin sidecar binary itself,
in `Contents/MacOS/`, gets auto-signed by Tauri). Tauri then bundles the
`.app`, signs it with `APPLE_SIGNING_IDENTITY`, wraps it in a `.dmg`, and —
**only if** ASC API key or Apple-ID credentials are present in env —
submits the `.app` to `notarytool submit --wait` and staples the resulting
ticket onto the `.app`. If you set only `APPLE_SIGNING_IDENTITY` and no
notarization credentials, the `.app` is signed but not notarized, and step 6
below will fail (nothing to staple) until you either add notarization creds
and rebuild, or run step 6 with `--notarize` (§4).

**Where the artifacts land:**

- The app: `apps/desktop/src-tauri/target/release/bundle/macos/OpenFusion.app`
- The DMG: `apps/desktop/src-tauri/target/release/bundle/dmg/OpenFusion_<version>_<arch>.dmg`
  (e.g. `OpenFusion_0.0.1_aarch64.dmg`)

### If the presign step fails the whole build

`presign-sidecar-assets.mjs` (the `beforeBundleCommand`) has three
outcomes, decided purely by env:

- `APPLE_SIGNING_IDENTITY` set → signs the `.assets` Mach-O files, build
  continues.
- `APPLE_SIGNING_IDENTITY` unset **and** this is a `tauri build --debug`
  bundle → skips with a warning (an unsigned local/dev bundle is fine).
- `APPLE_SIGNING_IDENTITY` unset **and** this is a real (non-debug) release
  build → **fails the build loudly**, on purpose: shipping an unsigned
  nested Mach-O would only surface as an opaque notarization rejection
  later. Set `APPLE_SIGNING_IDENTITY` (§2) and re-run.

## 4. `notarize-staple-dmg.mjs` — exact flags

Run **after** `tauri build` has produced a `.dmg` (step 5 above):

```sh
node apps/desktop/scripts/notarize-staple-dmg.mjs                # staple only (default)
node apps/desktop/scripts/notarize-staple-dmg.mjs --notarize     # submit the .dmg itself, wait, then staple
node apps/desktop/scripts/notarize-staple-dmg.mjs --dmg <path>   # explicit .dmg path (skips auto-discovery)
```

- **Default (no flags):** staples whatever notarization ticket already
  exists — the right choice when `tauri build` notarized the `.app` inline
  (i.e. notarization credentials were present in env during step 5).
- **`--notarize`:** submits the `.dmg` itself to `xcrun notarytool submit
  --wait` (using whichever credential mode resolves from env — API key,
  Apple ID, or `APPLE_KEYCHAIN_PROFILE`), then staples. Use this if the
  `.app` wasn't notarized during `tauri build` (no notarization creds were
  set then), or if you rebuilt/re-signed the `.dmg` after the fact.
- **`--dmg <path>`:** the script otherwise auto-discovers the one `.dmg`
  under `target/release/bundle/dmg/` (checked first) or
  `target/debug/bundle/dmg/`; it refuses to guess and errors out if it finds
  zero or more than one candidate — pass `--dmg` explicitly to disambiguate
  (e.g. stale debug and release DMGs both present).

The script fails loudly (non-zero exit, clear stderr) if `xcrun` isn't on
`PATH`, no `.dmg` can be found/disambiguated, or `--notarize` is requested
without a resolvable credential set in env. It never logs credential values
— only which credential *mode* it resolved.

## 5. Verification (run every one of these before you trust the artifact)

```sh
spctl -a -vvv -t install "apps/desktop/src-tauri/target/release/bundle/macos/OpenFusion.app"
codesign -dvvv --entitlements - "apps/desktop/src-tauri/target/release/bundle/macos/OpenFusion.app"
stapler validate "apps/desktop/src-tauri/target/release/bundle/dmg/OpenFusion_<version>_<arch>.dmg"
```

- `spctl` should print `accepted` and `source=Notarized Developer ID`.
- `codesign -dvvv` should show `flags=0x10000(runtime)` (hardened runtime
  on) and an entitlements plist matching `Entitlements.plist`
  (`com.apple.security.cs.disable-library-validation` = true; no
  `allow-jit`/`allow-unsigned-executable-memory` unless you added them per
  the JIT check below).
- `stapler validate` should print `The validate action worked!`.
- **Install on a clean Mac (or a fresh user account) with no dev tools and
  no prior trust of this app**: mount the `.dmg`, drag the app to
  Applications, double-click it. It must launch directly — **no**
  right-click-then-Open dance, no "unidentified developer" warning.
- With the app running, open a real project (Project screen → build the
  wiki), run a real orchestration task (Orchestrate screen), and run a real
  eval (Evals screen) — confirm the full cockpit loop works against the
  signed, notarized binary, not just a dev build.
- Open DevTools (Cmd+Option+I) and confirm **no** "Content Security Policy
  has blocked…" messages appear anywhere in the console.
- Quit the app, then confirm no engine process was left behind:

  ```sh
  ps aux | grep openfusion-engine
  ```

  should show nothing but the `grep` itself.

### The JIT empirical check

`Entitlements.plist` deliberately ships **without**
`com.apple.security.cs.allow-jit` / `com.apple.security.cs.allow-unsigned-executable-memory`
— but **expect to likely need them**. The bundle contains two executables,
and Tauri's bundler signs both with hardened runtime + this SAME
`Entitlements.plist`:

- `Contents/MacOS/openfusion-engine` — the sidecar, a `@yao-pkg/pkg`-compiled
  Node binary that embeds and JITs V8 **in-process**. This is exactly the
  Electron-like case every Tauri signing guide has in mind when it pairs
  `allow-jit`/`allow-unsigned-executable-memory` with
  `disable-library-validation` — Node's own official release binaries ship
  both entitlements for this reason. A hardened-runtime V8 process without
  them typically **aborts at startup**. So the likely first-signed-build
  failure mode is **not** the app window crashing — it's the engine sidecar
  dying silently on launch while the window opens fine, and every cockpit
  screen then errors out because it has nothing to talk to.
- The WKWebView itself (secondary point) — Tauri's shell runs its JS inside
  Apple's own entitled, sandboxed WebContent helper process, so the window/
  webview likely does **not** need these entitlements. The sidecar is the
  probable JIT consumer, not the WebView.

Because the sidecar embeds V8, budget for one rebuild cycle with these
entitlements uncommented — the no-JIT build below is a cheap first probe,
not necessarily the end state. **Verify empirically:**

1. Build signed + notarized **without** them first (as above).
2. Launch-test on a clean Mac per §5 above.
3. **If the app window crashes on launch, OR the engine sidecar fails to
   start** post-notarization — cockpit screens error out immediately,
   `openfusion-engine` exits right after launch (check `ps aux | grep
   openfusion-engine`), or the app surfaces an engine-connection error —
   uncomment the `allow-jit`/`allow-unsigned-executable-memory` block in
   `apps/desktop/src-tauri/Entitlements.plist`, then redo the full sequence
   from step 5 (`tauri build`) onward — a full rebuild is required, not just
   a re-sign, since entitlements are baked in at signing time. This
   remediation works because the bundler applies the same
   `Entitlements.plist` to every binary it signs, including the sidecar.

If the app **and** the engine sidecar both launch fine without them, leave
them out — smaller attack surface, and one less thing notarization can flag
in the future. But don't be surprised if you need them: the sidecar's
in-process V8 is precisely the case these entitlements exist for.

## 6. Troubleshooting: top notarization rejections

Read a rejection's detail with (substitute your notarization credential
flags — API key shown, Apple ID mode uses `--apple-id --password --team-id`
instead):

```sh
xcrun notarytool log <submission-id> --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"
```

(The `<submission-id>` is printed by `notarytool submit` — either from
`tauri build`'s own inline notarization output in step 5, or from step 6's
`--notarize` output.)

| Rejection | Cause | Fix |
|---|---|---|
| "The signature of the binary is invalid" / "not signed" on a nested Mach-O (usually `better_sqlite3.node` under `Contents/Resources/assets/`) | `APPLE_SIGNING_IDENTITY` wasn't set when `tauri build` ran, so `presign-sidecar-assets.mjs` skipped (debug build) or the identity didn't match a real cert | Set `APPLE_SIGNING_IDENTITY` correctly (§2) and rebuild from step 5; check for `[presign-sidecar-assets] signing N Mach-O file(s)` in the build log to confirm it ran |
| "The executable does not have the hardened runtime enabled" | Should not happen — `tauri.conf.json`'s `bundle.macOS.hardenedRuntime` defaults to `true` and is never overridden here | Check `tauri.conf.json` hasn't been edited to disable it |
| Cert-type rejection (wrong certificate) | Signed with an "Apple Development" or "Mac App Store" cert instead of "Developer ID Application" | `security find-identity -v -p codesigning` — confirm you're using the Developer ID Application identity, not another one |
| Rejection citing the sidecar binary itself (`Contents/MacOS/openfusion-engine`), not the `.node` | Known open Tauri issue [#11992](https://github.com/tauri-apps/tauri/issues/11992) — externalBin signing during bundling can occasionally produce an invalid signature | Re-run `tauri build`; if it recurs, manually re-sign after bundling: `codesign --force -s "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp <App>.app/Contents/MacOS/openfusion-engine`, then re-bundle the `.dmg` |
| `get-task-allow` entitlement present / malformed entitlements | Something added a debug entitlement or broke the plist | Diff `Entitlements.plist` against the version in this repo; it should only ever contain `disable-library-validation` (and, if the JIT check required them, the two JIT keys) |

If `stapler staple` fails **immediately** after `notarize-staple-dmg.mjs
--notarize` logs "submission completed" — some `notarytool` versions exit 0
from `submit --wait` even when the submission's actual status is `Invalid`
(rejected), so a completed submit is not proof of acceptance. Treat the
staple step as the real verification, and read why with:

```sh
xcrun notarytool log <submission-id> --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER"
```

## 7. CI note

CI (`.github/workflows/ci.yml`) currently has **no cargo-test step at all**
— this is a pre-existing gap, not something introduced by this milestone.
Run the Rust suite manually before trusting a change to `apps/desktop`:

```sh
pnpm --filter @openfusion/desktop test:rust
```

(equivalently: `cargo test --manifest-path src-tauri/Cargo.toml --features
test-mocks` from the repo root — a bare `cargo test` fails to compile,
since the `src/bin/mock_*.rs` fixtures the integration tests spawn are
gated behind `test-mocks` so they never ship in a release bundle.) Wiring
this into CI is flagged as a follow-up for a maintainer, not solved here.

## See also

- The root [README](../README.md) — "Before you trust / ship this" has the
  full consolidated smoke checklist (the 5 engine operator smokes + the
  desktop cockpit batch + this document's DMG verification, all in one
  place).
- `apps/desktop/README.md` — the shell's architecture, dev-mode build/run,
  and the day-to-day (unsigned) operator smokes.
- `docs/research/2026-07-04-m8-signing-verification.md` — the verified
  research this pipeline is built on (Tauri bundler behavior, notarytool
  auth modes, the JIT-entitlement open question).
