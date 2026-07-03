# M3 API Verification Cheat-Sheet (verified 2026-07-03)

Frontier-engines layer. [V] verified against official source this week.

## Claude Agent SDK — the first-class path [V]

- `@anthropic-ai/claude-agent-sdk@0.3.199` (2026-07-02, ESM). Spawns the
  real `claude` CLI as a SUBPROCESS (not in-process) — plan lifecycle:
  spawn/monitor/reap; orphan risk on abnormal parent exit (issue #142).
- Core API: `query({ prompt, options })` → AsyncIterable of messages;
  discriminators `assistant | user | result | system | stream_event`;
  terminal `result` carries `total_cost_usd`, cumulative `usage`,
  `modelUsage`, `session_id`. Cost figures are CLIENT-SIDE ESTIMATES from a
  bundled price table — never bill off them.
- MCP attach (programmatic): `mcpServers: { wiki: { type: "http", url } }`
  — `"http"` only (the `"streamable-http"` alias works only in .mcp.json).
  Tools surface as `mcp__wiki__*` and must be in `allowedTools`.
- Headless permissions: `permissionMode` + `canUseTool(tool, input, {signal})`
  callback (no TTY in SDK mode — all unresolved prompts route there).
  Order: hooks → deny → ask → mode → allow → canUseTool.
- Resume: `options.continue` / `options.resume: sessionId` (mutually
  exclusive); GOTCHA: mismatched cwd silently starts a FRESH session.
- Node floor: SDK needs >=18 (our >=22 fine).

## Auth posture — decided [V]

SDK honors the CLI's 6-tier auth chain (cloud creds → ANTHROPIC_AUTH_TOKEN →
ANTHROPIC_API_KEY → apiKeyHelper → CLAUDE_CODE_OAUTH_TOKEN → subscription
/login OAuth). Anthropic docs VERBATIM: "Anthropic does not permit
third-party developers to offer claude.ai login or to route requests
through Free/Pro/Max plan credentials on behalf of their users."

**OpenFusion posture: auth-agnostic.** The engine never handles, prompts
for, stores, or routes frontier credentials. It spawns the official CLI,
which uses whatever auth the OPERATOR configured themselves (their own
subscription login for their own use, or an API key). The app must never
ship a claude.ai login flow. (Subscription-credit program for SDK use was
announced then PAUSED — do not design around it.)

## ACP — later, not now [V]

Protocol v1 (schema v1.17.0); TS client `@agentclientprotocol/sdk@1.1.0`;
adapter `@agentclientprotocol/claude-agent-acp@0.55.0` (community-
maintained wrapper AROUND the Agent SDK; subscription auth explicitly
unsupported there; usage reporting feature-flagged/unstable). Anthropic
closed native-ACP as not-planned. → Keep our FrontierEngine interface
ACP-shaped; implement via Agent SDK; revisit ACP when editor interop
matters.

## Codex — defer to M3.5+ [V]

`codex proto` is GONE; `app-server` is [experimental] and its docs point
automation at `@openai/codex-sdk@0.142.x` (pre-1.0, near-daily releases,
spawns `codex exec --experimental-json`). ChatGPT-subscription embedding
ToS unresolved (openai/codex#8338). MCP config mature. → Defer; when added,
SDK + API-key auth recommended.

## MCP SDK v2 — decision closed [V]

Not GA as of 2026-07-03 (latest 1.29.0; Agent SDK itself peer-depends
^1.29). Stay on v1. Re-check post-2026-07-28.

## Usage/cost for the savings story

Per-assistant-message `usage` (dedupe by message id — parallel tool calls
share one id); per-query() `result.total_cost_usd` + `modelUsage`. No
cross-call session total — accumulate ourselves. No documented shape
difference between subscription and API-key auth (one auth-linked diff:
subscription gets 1h cache TTL vs 5min default).
