// The typed boundary between the React UI and the two things it talks to:
//
//   1. the engine sidecar, via the Rust `engine_call` / `engine_events`
//      commands (`apps/desktop/src-tauri/src/commands.rs`) — JSON-RPC 2.0
//      request/response plus a notification stream;
//   2. the OS keychain-backed secret store, via its own dedicated Rust
//      commands (`apps/desktop/src-tauri/src/secrets.rs`) — NOT engine RPC.
//
// Keeping those two invoke surfaces behind separate method groups here (the
// `EngineClient` class vs. the free `setSecret`/`getSecret`/... functions)
// mirrors that boundary: a caller reading this file's exports can always
// tell which one it's targeting.
//
// ## The M7a de-dup finding this fixes
//
// M7a's placeholder screen (see git history for the old `src/main.ts`)
// called `invoke('engine_events', { channel })` directly from a page-level
// `subscribeToEngineEvents()`. That's fine for exactly one caller ever
// subscribing, but the Rust side (`commands.rs::engine_events`) spawns a
// brand-new pump task and broadcast subscriber on EVERY invocation — so if
// two components each called it, the sidecar's notification stream would be
// forwarded twice, onto two different channels, doubling every downstream
// notification handler's work (and, worse, each pump silently leaking until
// app shutdown).
//
// `EngineClient` closes that gap: `onEngineEvent` is the only public way to
// receive notifications, and it lazily invokes `engine_events` AT MOST ONCE
// per `EngineClient` instance, no matter how many UI components subscribe.
// The app-wide singleton exported below (`engineClient`) is what every
// screen should import — one instance, one Channel, one invoke, for the
// whole app's lifetime.
//
// ## No-content-logging invariant
//
// Same rule as the Rust side of this bridge: nothing in this module ever
// logs a call's `method`/`params`/`result`, a notification's body, or a
// secret's value — only this doc comment's prose does. A dedicated grep
// test (`noConsoleLogging.test.ts`) enforces that no `console.*` call
// exists anywhere under `src/` at all, which is a stronger, simpler
// invariant to hold than "never log THESE specific fields."
import { invoke, Channel } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// engine_call + typed error mapping
// ---------------------------------------------------------------------------

/** Mirrors `commands::EngineCallError` (apps/desktop/src-tauri/src/commands.rs)
 * — the JSON-RPC `{code, message, data}` shape a rejected `engine_call`
 * invoke() rejects with. */
interface RawEngineCallError {
  code: number;
  message: string;
  data?: unknown;
}

function isRawEngineCallError(value: unknown): value is RawEngineCallError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code: unknown }).code === "number" &&
    typeof (value as { message: unknown }).message === "string"
  );
}

/** The typed error the UI catches. Carries the same `code`/`message`/`data`
 * as the Rust-side `EngineCallError`, so a catch site can branch on `code`
 * (a JSON-RPC error code) without parsing anything itself. */
export class EngineError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.data = data;
  }
}

export interface CallOptions {
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// engine_events notifications: a typed envelope + pub/sub
// ---------------------------------------------------------------------------

/** A JSON-RPC notification forwarded off the engine's broadcast channel: a
 * `method` (e.g. `"orchestrate.progress"`) and its `params`. This is a loose
 * envelope, not a full discriminated union over every method Task 6/M7c
 * will add — narrowing on `method` is left to each subscriber. */
export interface EngineNotification {
  method: string;
  params: unknown;
}

function toEngineNotification(message: unknown): EngineNotification {
  if (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { method?: unknown }).method === "string"
  ) {
    const { method, params } = message as { method: string; params?: unknown };
    return { method, params };
  }
  // Defensive fallback: the sidecar is expected to only ever emit
  // {method, params} notifications (see engine_bridge.rs), but a malformed
  // or unexpected message shouldn't crash a subscriber — surface it as an
  // "unknown" notification instead.
  return { method: "unknown", params: message };
}

export type EngineEventHandler = (notification: EngineNotification) => void;
export type Unsubscribe = () => void;

export interface ModelProviderSummary {
  id: string;
  kind: string;
  baseURL?: string;
}

export interface ModelsListResult {
  providers: ModelProviderSummary[];
}

export interface WikiBuildStats {
  filesIndexed: number;
  filesSkipped: number;
}

/** The engine-RPC half of the client (`call` + typed method wrappers) plus
 * the single-subscription notification pub/sub. Construct your own instance
 * in tests; the app itself imports the `engineClient` singleton below. */
export class EngineClient {
  #handlers = new Set<EngineEventHandler>();
  #subscribed = false;

  /** `invoke('engine_call', {method, params, timeoutMs})`, with a thrown
   * `EngineCallError` mapped to a typed `EngineError`. Any other rejection
   * (e.g. `invoke` itself failing outside the engine bridge) is rethrown
   * as-is. */
  async call<T>(method: string, params: unknown, opts?: CallOptions): Promise<T> {
    try {
      return await invoke<T>("engine_call", { method, params, timeoutMs: opts?.timeoutMs });
    } catch (err) {
      if (isRawEngineCallError(err)) {
        throw new EngineError(err.code, err.message, err.data);
      }
      throw err;
    }
  }

  /** Subscribe to engine notifications. Lazily establishes the ONE
   * `engine_events` Channel/invoke on this instance's first subscriber;
   * every subsequent subscriber (on the same instance) shares it — no
   * additional `engine_events` invoke is ever made. Returns an unsubscribe
   * function; unsubscribing one handler never tears down the shared
   * channel while any other handler remains subscribed (it is never torn
   * down at all — it lives for the instance's lifetime, matching "one
   * subscription for the whole app"). */
  onEngineEvent(handler: EngineEventHandler): Unsubscribe {
    this.#ensureSubscribed();
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  #ensureSubscribed(): void {
    if (this.#subscribed) return;
    this.#subscribed = true;
    const channel = new Channel<unknown>();
    channel.onmessage = (message) => {
      const notification = toEngineNotification(message);
      for (const handler of this.#handlers) {
        handler(notification);
      }
    };
    void invoke("engine_events", { channel });
  }

  // -- typed method wrappers (Task 6's cockpit screens need these) --------

  modelsList(opts?: CallOptions): Promise<ModelsListResult> {
    return this.call<ModelsListResult>("engine.models.list", {}, opts);
  }

  wikiBuild(projectDir: string, opts?: CallOptions): Promise<WikiBuildStats> {
    return this.call<WikiBuildStats>("engine.wiki.build", { projectDir }, opts);
  }
}

/** The app-wide singleton. Every screen/component subscribes through this
 * one instance so the single-subscription invariant holds across the whole
 * app, not just within one component. */
export const engineClient = new EngineClient();

// ---------------------------------------------------------------------------
// Secret commands — separate Rust commands, NOT engine_call/engine RPC.
// ---------------------------------------------------------------------------

/** `invoke('set_secret', {id, value, persist})`. `persist` opts into OS
 * Keychain storage; otherwise the value lives in memory only for this
 * process's lifetime. Never logs `value`. */
export function setSecret(id: string, value: string, persist: boolean): Promise<void> {
  return invoke("set_secret", { id, value, persist });
}

/** `invoke('get_secret', {id})`. Resolves `null` if unset — never throws
 * for a missing id. */
export function getSecret(id: string): Promise<string | null> {
  return invoke<string | null>("get_secret", { id });
}

/** `invoke('delete_secret', {id})`. */
export function deleteSecret(id: string): Promise<void> {
  return invoke("delete_secret", { id });
}

/** `invoke('list_secret_ids')`. Ids only — never values — for populating a
 * "your saved keys" list. */
export function listSecretIds(): Promise<string[]> {
  return invoke<string[]>("list_secret_ids");
}

/** `invoke('load_persisted_secrets')`. Loads every persisted id's value
 * from the Keychain back into the store's in-memory map (normally called
 * once at app startup; exposed here for completeness/tests). */
export function loadPersistedSecrets(): Promise<void> {
  return invoke("load_persisted_secrets");
}
