// M7a Task 4: the end-to-end proof screen. This is the whole chain in one
// page: webview (this file) --invoke--> Rust `engine_call` command
// --EngineBridge.call--> engine sidecar (stdio JSON-RPC) --> back. It also
// subscribes to `engine_events` (a `Channel<unknown>`) to display any
// engine progress notification the sidecar emits. See
// docs/research/2026-07-04-m7-tauri-verification.md for the architecture
// and apps/desktop/src-tauri/src/commands.rs for the Rust side of both
// calls. Kept deliberately minimal + typed — the real cockpit UI is a
// later milestone.
import { invoke, Channel } from "@tauri-apps/api/core";

// The method + empty params this proof screen calls. `engine.models.list`
// (packages/engine/src/models/methods.ts) takes no params and returns
// synchronously (no network/provider calls), so it's a fast, always-safe
// method to prove the full round trip with.
const PROOF_METHOD = "engine.models.list";

// Loose shape: this proof screen doesn't need to know `engine.models.list`'s
// exact provider schema, only that the round trip produced *some* JSON.
type EngineCallResult = Record<string, unknown>;

// Mirrors `commands::EngineCallError` (apps/desktop/src-tauri/src/commands.rs)
// — the JSON-RPC {code, message, data} shape a rejected `engine_call`
// invoke() delivers.
interface EngineCallError {
  code: number;
  message: string;
  data: unknown;
}

function isEngineCallError(value: unknown): value is EngineCallError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

const app = document.querySelector<HTMLDivElement>("#app");

const notifications: unknown[] = [];
let resultHtml = "<p>Calling the engine…</p>";

function escapeHtml(input: string): string {
  const escapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return input.replace(/[&<>"']/g, (ch) => escapes[ch] ?? ch);
}

function renderNotifications(): string {
  if (notifications.length === 0) {
    return "<p><em>none received yet</em></p>";
  }
  const items = notifications.map((n) => `<li><pre>${escapeHtml(JSON.stringify(n))}</pre></li>`).join("");
  return `<ul>${items}</ul>`;
}

function render(): void {
  if (!app) return;
  app.innerHTML = `
    <main style="font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem;">
      <h1>OpenFusion — engine proof</h1>
      <section>
        <h2><code>${escapeHtml(PROOF_METHOD)}</code> result</h2>
        ${resultHtml}
      </section>
      <section>
        <h2>Engine notifications</h2>
        ${renderNotifications()}
      </section>
    </main>
  `;
}

async function callEngine(): Promise<void> {
  try {
    const result = await invoke<EngineCallResult>("engine_call", { method: PROOF_METHOD, params: {} });
    resultHtml = `<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
  } catch (err: unknown) {
    const message = isEngineCallError(err) ? `[${err.code}] ${err.message}` : String(err);
    resultHtml = `<p style="color: #c00;">Error: ${escapeHtml(message)}</p>`;
  }
  render();
}

async function subscribeToEngineEvents(): Promise<void> {
  const channel = new Channel<unknown>();
  channel.onmessage = (message) => {
    notifications.push(message);
    render();
  };
  await invoke("engine_events", { channel });
}

render();
void callEngine();
void subscribeToEngineEvents();
