# M2 API Verification Cheat-Sheet (verified 2026-07-03)

Pre-plan verification for the models layer. Confidence: [V] verified against
official source this week, [S] secondary, [U] unverified/conflicting.

## Vercel AI SDK

- **v7 is current** (`ai@7.0.14`, 2026-07-02); pin `"ai": "^7.0.0"`. [V]
- Usage shape (generateText/streamText result.usage):
  `{ inputTokens?, outputTokens?, totalTokens?, inputTokenDetails?: {
  noCacheTokens?, cacheReadTokens?, cacheWriteTokens? }, outputTokenDetails?:
  { textTokens?, reasoningTokens? } }`. Flat `cachedInputTokens`/
  `reasoningTokens` deprecated. [V]
- streamText usage: `onFinish(r => r.usage)` / `await result.usage` /
  `await result.totalUsage` (aggregated). Do NOT meter off telemetry spans —
  they still emit deprecated names (vercel/ai#12801). [S]

## Providers

| Target | Package | Base URL | Model IDs |
|---|---|---|---|
| Moonshot/Kimi | `@ai-sdk/moonshotai` (first-party) [V] | `https://api.moonshot.ai/v1` | `kimi-k2.6`, `kimi-k2.7-code` |
| Z.ai/GLM | `@ai-sdk/openai-compatible` (no official pkg) [S] | `https://api.z.ai/api/paas/v4` | `glm-5.2` |
| DeepSeek | `@ai-sdk/deepseek` (first-party) [S] | implicit api.deepseek.com | `deepseek-chat`/`deepseek-reasoner` **aliases retire 2026-07-24** → V4-Flash/thinking [V] |
| Generic (OpenRouter/Ollama/LM Studio) | `@ai-sdk/openai-compatible` [V] | caller-supplied | caller-supplied |

- Every provider factory accepts `fetch` — recorded-fixture HTTP tests are
  first-class. [S]
- Cache-token reporting: DeepSeek via
  `providerMetadata.deepseek.promptCacheHitTokens/MissTokens` [S]; Moonshot
  and GLM cache fields UNVERIFIED — log raw providerMetadata on first live
  call before trusting metering for those two. [U]

## Testing without live keys

- `ai/test`: `MockLanguageModelV4` (+ `simulateReadableStream` from `ai`).
  NOTE: mock `doGenerate` usage uses the PROVIDER-spec nested shape
  (`inputTokens: { total, noCache }`, `outputTokens: { total, text }`) — the
  SDK maps it to the flat-ish result.usage shape. [S]
- Integration path: inject `fetch` into `createOpenAICompatible` replaying a
  recorded chat.completions JSON (incl. `usage.prompt_tokens_details.cached_tokens`).

## Pricing ($/MTok) for the table

| Model | In | Out | Cache-read | Conf |
|---|---|---|---|---|
| kimi-k2.6 (official) | 0.95 | 4.00 | 0.16 | [U — conflicting source says 0.60/2.50; re-verify] |
| kimi-k2.7-code | 0.95 | 4.00 | 0.19 | [S] |
| glm-5.2 (direct) | 1.40 | 4.40 | ? | [S] |
| deepseek V4-Pro | 0.435 | 0.87 | 0.003625 | [V] |
| deepseek V4-Flash | 0.14 | 0.28 | 0.0028 | [V] |
| qwen3-coder-next (OpenRouter) | 0.11 | 0.80 | — | [S] |
| minimax-m2.5 (OpenRouter) | 0.12–0.30 | 0.48–1.20 | — | [U — 2.5× source spread] |
| claude-sonnet-5 (list) | 3.00 | 15.00 | 0.30 read | [S] (intro 2/10 until 2026-08-31) |
| claude-opus-4-8 | 5.00 | 25.00 | 0.50 read | [S] |
| gpt-5.5 | 5.00 | 30.00 | 0.50 | [V] |
| gpt-5.4 | 2.50 | 15.00 | 0.25 | [V] |

GPT-5.1/5.2 appear retired from OpenAI's price sheet — don't build fixtures
against them. [U]

## Re-check before locking the table (carry into M2 tasks)

1. Kimi K2.6 official price conflict.
2. MiniMax OpenRouter live price via /models API.
3. Moonshot + GLM cache-token field names (one live smoke each, post-M2).
4. DeepSeek alias retirement on 2026-07-24 — pricing table carries both
   aliases and v4 ids.
