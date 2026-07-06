# Settings redesign: working BYOK + frontier Connect — design

Status: approved design (2026-07-06). Scope: **Project 1** of a three-project
decomposition (see §2). This spec covers only Project 1.

## 1. Motivation

The current Settings dialog is a wiring diagram, not a control panel. It asks
for a free-text "Provider id", stores a key by an arbitrary string, and shows a
read-only "Model providers" list that is populated engine-side. Two problems
follow:

1. **Adding a key does nothing.** The saved secret is never forwarded to the
   engine's provider registry (`engine.models.configure` is never called from
   the app), and the registry starts empty on every launch. A configured key
   has no effect on routing — the BYOK promise is unwired.
2. **The mental model is inverted.** A user thinks "I want to use DeepSeek with
   this key," not "I will type the string `deepseek` into an id field and
   separately hope a provider exists." The UI should let you pick a provider,
   pick a model, and paste a key.

Separately, the app has no way to connect the frontier orchestrators (Claude
Code, Codex) to the user's subscription. The engine runs on whatever the
official CLI is logged into, but nothing in the app helps the user get logged
in or shows whether they are.

**Goal:** a simple, Apple-like Settings dialog where (a) adding a BYOK provider
actually configures a usable, persistent provider, and (b) the user can connect
their subscription-based Claude Code (and, in Project 2, Codex) and see live
status — all without the app ever handling a subscription token.

## 2. Scope and decomposition

The original request ("dropdowns for provider/model, key field, OAuth for
Codex + Claude Code, social login") spans three independent subsystems. They
are split so each gets its own spec → plan → implementation cycle:

- **Project 1 (this spec):** Settings dialog redesign, working BYOK
  configuration + durability, and frontier **Connect** for Claude Code via
  delegation to the official CLI. Ships the reusable "detect + launch official
  CLI login" host plumbing.
- **Project 2 (separate spec):** Codex orchestration adapter — the engine
  subsystem that makes a *connected* Codex usable as an orchestrator (no
  adapter exists today). The Codex row in the Orchestrators group appears when
  this lands, reusing Project 1's Connect plumbing.
- **Project 3 (separate spec, deferred):** Social login / user identity.
  Requires a backend identity service and native OAuth (the webview CSP
  forbids external calls); it is a product/privacy decision, not a settings
  screen. Out of scope here.

### Non-goals for Project 1

- No Codex orchestration (Project 2). The Codex CLI login plumbing is generic
  and built here, but the Codex *row* and adapter ship with Project 2.
- No social login / accounts (Project 3).
- No multiple providers of the same kind. Routing resolves a bare model `kind`
  to the single configured provider of that kind (and throws on ambiguity), so
  v1 configures exactly one provider per kind (`id === kind`). Multi-provider-
  of-a-kind is a future concern.
- The app never implements an OAuth flow, and never sees, stores, prompts for,
  or routes a subscription token. This is a hard invariant, not a goal to
  balance (see §6).

## 3. Auth posture (the load-bearing constraint)

Anthropic's terms (verbatim in `docs/research/2026-07-03-m3-api-verification.md`)
prohibit a third-party developer from offering the claude.ai login or routing
Free/Pro/Max credentials on a user's behalf. OpenAI's equivalent for embedding
a ChatGPT subscription is unresolved and it recommends API keys for
programmatic use. OpenFusion ships as a **distributed, signed public DMG** — so
an embedded provider login would make OpenFusion itself the prohibited "third
party offering the login," not a personal-use gray area.

**Decision (approved): delegate to the official CLIs.** The engine already
spawns the official `claude` CLI (via the Agent SDK), which holds its own login
and makes its own API calls. "Connect" only needs to (a) detect whether that
CLI is logged in and (b) if not, launch the CLI's *own* login. The token lives
inside the official CLI; OpenFusion never touches it. This is the exact
mitigation the design spec's ToS risk #5 anticipated, and it keeps the engine's
"auth-agnostic" invariant intact.

Rejected alternative: OpenCode-style — the app runs the OAuth PKCE flow itself,
stores the subscription token, and calls the APIs directly
(`opencode-openai-codex-auth` does this at `~/.opencode/auth/openai.json`).
Rejected because it is prohibited for a distributed app on Anthropic, gray on
OpenAI, and would require rebuilding the frontier engine off the CLI-subprocess
model.

## 4. Architecture

Three layers, matching the existing boundaries (webview → Rust host → engine
sidecar; secrets are host-owned, engine RPC is webview-driven).

```
┌─ webview (React) ───────────────────────────────────────────────┐
│  SettingsDialog                                                  │
│   ├─ OrchestratorsPane   → frontier_* host commands              │
│   └─ ModelProvidersPane  → provider metadata host commands       │
│                            + set_secret / get_secret (host)      │
│                            + engine.models.configure (engine RPC)│
│  App startup hook: reconfigureProvidersOnLaunch()                │
└──────────────────────────────────────────────────────────────────┘
        │ Tauri invoke                         │ engine_call
┌─ Rust host ───────────────────────┐   ┌─ engine sidecar ─────────┐
│ secrets.rs      (keychain, exists)│   │ ProviderRegistry         │
│ providers.rs    (metadata, NEW)   │   │  .configure(...) (exists)│
│ frontier.rs     (CLI auth,  NEW)  │   │  auth-agnostic (unchanged)│
└───────────────────────────────────┘   └──────────────────────────┘
```

### 4.1 Making BYOK real (the missing wire + durability)

Two engine/host facts drive this:

- The engine's `ProviderRegistry` is **in-memory and ephemeral** — it holds
  `{id, kind, apiKey, baseURL}` and starts empty every launch. Providers exist
  only after an `engine.models.configure` call.
- The keychain (`secrets.rs`) persists the *key value* but knows nothing about
  provider kind, base URL, or model. Those are non-secret metadata with no home
  today.

So durability needs a small **non-secret provider-metadata store**, host-owned,
paired with the keychain on startup:

- **New host commands** (`apps/desktop/src-tauri/src/providers.rs`), storing a
  JSON file (`providers.json`) in the app config dir. It holds only non-secret
  fields — never an API key:
  - `list_provider_configs() -> Vec<ProviderMeta>` where
    `ProviderMeta = { id, kind, baseURL?: string, model: string }`.
  - `save_provider_config(meta: ProviderMeta)`.
  - `delete_provider_config(id: string)`.
- **New engine client wrapper** (`engineClient.ts`):
  `modelsConfigure({ id, kind, apiKey, baseURL? })` → `engine.models.configure`.
- **Save flow** (add a provider):
  1. `set_secret(id, apiKey, persist)` — id equals the provider id (`=== kind`
     in v1). `persist` follows the Keychain toggle.
  2. `modelsConfigure({ id, kind, apiKey, baseURL })` — registers it live.
  3. If `persist`: `save_provider_config({ id, kind, baseURL, model })` so it
     survives restart. If not persisted, skip metadata (a memory-only key can't
     survive a restart anyway).
- **Startup reconfigure** (`reconfigureProvidersOnLaunch()`, called once from
  `App`): after `load_persisted_secrets()`, read `list_provider_configs()`; for
  each entry, `get_secret(id)` → `modelsConfigure(...)`. This is the ONLY place
  besides Save that touches a key value. The value is read into a local, passed
  to configure, and never rendered or logged (see §6). `secrets.rs`'s own doc
  anticipates exactly this get_secret → models.configure forwarding.

### 4.2 Frontier Connect (delegate to the official CLI)

Auth detection/launch lives in the **Rust host**, not the engine — the engine
stays auth-agnostic. New host commands
(`apps/desktop/src-tauri/src/frontier.rs`), parameterized by engine kind
(`"claude-code"` in Project 1; `"codex"` reused in Project 2):

- `frontier_login_status(engine) -> FrontierAuthStatus` where
  `FrontierAuthStatus = { state: "connected" | "disconnected" | "not-installed",
  detail?: string }`. Probes the official CLI (exact probe is an
  implementation-verification item — see §8).
- `frontier_login(engine) -> void`. Launches the official CLI's own login
  (its OAuth opens in the user's browser). Returns once the login process is
  initiated; the pane re-probes status to reflect completion.
- `frontier_logout(engine) -> void`. Runs the CLI's own logout, if available.

No token ever crosses this boundary — these commands invoke the official binary
and observe its exit/status only.

## 5. UX — the redesigned Settings dialog

Style: the frosted, minimal macOS direction already established (translucent
shell, quiet surfaces, one accent). Copy is active-voice and honest (a control
says what it does; an empty screen invites an action; an error explains and
directs).

Two groups (no account/social section):

### 5.1 Orchestrators

A row per frontier engine. Project 1 renders the **Claude Code** row only.

- **States:** `Checking…` (on open) → then one of:
  - `Connected` — filled status dot, "Connected", a **Sign out** button.
  - `Not connected` — hollow dot, a **Connect** button. Connect calls
    `frontier_login`; the row re-probes on return.
  - `Not installed` — "Claude Code isn't installed" + the one-line install
    hint; no Connect button until it is.
  - `Error` — a friendly sentence, never a stack trace.
- Status is probed with `frontier_login_status` when the dialog opens.

### 5.2 Model providers (BYOK workers)

- **Configured list:** each configured provider shows its kind, its model, its
  base URL (only when custom), and a **Remove** action. Remove calls
  `delete_secret(id)` + `delete_provider_config(id)` and re-registers nothing.
  Empty state: "No model providers yet. Add one to route work to cheaper
  models."
- **Add a provider form:**
  - **Provider** — `<select>`: Moonshot / Z.ai / DeepSeek / OpenAI-compatible
    (the four real `kind`s; no Anthropic/OpenAI — those are the frontier tier).
  - **Model** — `<select>` populated per provider from the catalog (§5.3);
    OpenAI-compatible is a free-text input instead of a fixed list.
  - **Base URL** — prefilled default and editable for Moonshot/Z.ai; **required**
    for OpenAI-compatible; **hidden** for DeepSeek (SDK default).
  - **API key** — write-only password field (never pre-filled, cleared on
    success), plus the **Save to Keychain** toggle (defaults off, per the
    existing per-key opt-in posture).
  - **Save** runs the §4.1 flow. On the engine rejecting the config
    (`INVALID_PARAMS`, e.g. OpenAI-compatible without a base URL), keep the form
    and show the message.
  - **Test connection** (per configured row, optional): runs a minimal
    `engine.models.complete` against the stored model to verify the key, showing
    "Reached <provider>" or a friendly failure. Save itself does not block on a
    network call (keeps the UI simple and instant); Test is the opt-in check.

### 5.3 Model catalog

Sourced from the engine's pricing table (`packages/engine/src/models/pricing.ts`)
— the de-facto list of known model ids. The UI hardcodes this list (the engine
exposes no model-enumeration RPC) and must be kept in sync with pricing.ts:

- **Moonshot:** `kimi-k2.6`, `kimi-k2.7-code`
- **Z.ai:** `glm-5.2`
- **DeepSeek:** `deepseek-v4-flash`, `deepseek-v4-pro`. The aliases
  `deepseek-chat` and `deepseek-reasoner` **hard-retire 2026-07-24** and are
  omitted from the dropdown.
- **OpenAI-compatible:** free text, with `qwen3-coder-next`, `qwen3-coder`,
  `minimax-m2.5` offered as suggestions.

"Model" here means the model tied to this provider (used by Test connection and
shown in the list). It does **not** override routing — which model runs a given
task is decided per-project by the generated harness's routing
(`orchestrate/routing.ts`). The label reflects that (it is the provider's
model, not a global default).

## 6. Security & privacy invariants

- **No token handling for frontier auth.** `frontier_*` commands invoke the
  official CLI and observe status/exit only. OpenFusion never reads, stores,
  prompts for, or routes a subscription token. The engine stays auth-agnostic.
- **No OAuth implementation.** The app does not run any OAuth flow or callback
  receiver.
- **Provider metadata store holds no secrets.** `providers.json` contains only
  `{id, kind, baseURL?, model}`. The API key lives only in the keychain (if
  persisted) or process memory (if not).
- **Key values never rendered or logged.** The startup reconfigure and Save are
  the only code paths that read a key value; both pass it straight to
  `models.configure` and never place it in the DOM or a log. The existing
  `noConsoleLogging.test.ts` and `secrets.rs` no-value-logging test continue to
  hold.
- **CSP unchanged.** No new external network origins; the webview still talks
  only to `self` + the Tauri IPC.

## 7. Error handling & empty states

- Engine unreachable when the dialog opens → each pane shows a friendly
  `role="alert"` line; the dialog still opens and closes normally.
- `engine.models.configure` rejects → surfaced inline on the Add form; nothing
  is persisted.
- CLI not installed → the Orchestrators row shows the install hint rather than a
  dead Connect button.
- Test connection failure → "Couldn't reach <provider> with that key." — the
  provider stays configured (the key may be fine and the endpoint down); the
  message directs, it does not delete.

## 8. Testing

- **Frontend (vitest + Testing Library):** the redesigned `SettingsDialog`
  renders both groups; the Add form configures a provider (mocked
  `set_secret` + `modelsConfigure` + `save_provider_config`) and clears the key
  field on success; conditional base-URL behavior per kind; DeepSeek dropdown
  omits the retiring aliases; Remove calls both delete paths; each Orchestrator
  state renders from a mocked `frontier_login_status`; startup reconfigure
  issues one `modelsConfigure` per persisted provider and never renders a key.
- **Rust host (`cargo test --features test-mocks`):** `providers.rs` round-trips
  metadata and never serializes an apiKey field; `frontier.rs` status parsing
  maps CLI states to `FrontierAuthStatus` (against a mock CLI), and no command
  logs credentials/argv (mirroring the `secrets.rs` no-value-logging test).
- **Manual (real app):** `./dev.sh app` — add a DeepSeek key, confirm a routed
  orchestrate run resolves to it; restart and confirm the provider is still
  configured; Connect Claude Code and confirm the status flips to Connected.

## 9. Implementation-verification items (resolve during the plan)

These are delegated-to-CLI mechanics that must be confirmed against the actual
CLIs during implementation, not assumed:

1. **Claude Code login-status probe.** Exact, non-interactive way to detect
   whether the `claude` CLI is authenticated (a status subcommand, a credential
   file check, or a cheap `--print` probe that distinguishes an auth failure
   from other errors). Must not trigger a prompt or a billed turn.
2. **Claude Code login launch.** The command/UX that starts the CLI's own login
   from a GUI app (it may need a terminal/PTY or a browser hand-off). Confirm it
   completes out-of-process and the app can re-probe.
3. **Codex equivalents** (for Project 2 reuse): `codex login` /
   `codex login --device-auth`, and status via `~/.codex/auth.json` or a status
   subcommand.
4. **App config dir** for `providers.json` (Tauri path API) and its migration
   posture if the shape changes.

## 10. Files touched (anticipated)

- `apps/desktop/src/components/SettingsDialog.tsx` — rewritten into
  Orchestrators + Model providers panes.
- `apps/desktop/src/screens/KeysScreen.tsx` — folded into the Model providers
  pane (the free-text "Provider id" form is replaced).
- `apps/desktop/src/engineClient.ts` — add `modelsConfigure`; add typed
  wrappers for the new host commands.
- `apps/desktop/src/App.tsx` — call `reconfigureProvidersOnLaunch()` once.
- `apps/desktop/src-tauri/src/providers.rs` — NEW metadata store + commands.
- `apps/desktop/src-tauri/src/frontier.rs` — NEW CLI auth commands.
- `apps/desktop/src-tauri/src/lib.rs` — register the new commands + capabilities.
- `apps/desktop/src/styles.css` — Orchestrators/provider-form styling in the
  existing system.
- Tests alongside each.
