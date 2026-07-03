# M2: Models Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The engine can call open-weight model providers (Moonshot/Kimi, Z.ai/GLM, DeepSeek, any OpenAI-compatible endpoint) through the Vercel AI SDK with per-call cost metering against a sourced pricing table and ordered fallback chains — `engine.models.configure/list/complete/usage` — fully fixture-tested with zero live keys in CI. Plus the two architectural prerequisites inherited from the M1b review: pipelined stdio dispatch and index-build yield points.

**Architecture:** Task 1 makes the stdio loop concurrent (extracted `StdioPipeline`: dispatch per line without serial await, responses written in completion order — JSON-RPC correlates by id). Task 2 adds yield points to `buildIndex` so a large index build cannot starve concurrent RPC. Tasks 3–4 add `src/models/`: `pricing.ts` (data + cost math), `providers.ts` (registry: presets + openai-compatible, injectable fetch), `meter.ts` (in-memory cost ledger), `methods.ts` (`ModelsService` on Engine — same service pattern as WikiService). Task 5 is the map-density batch from the M1b review.

**Tech Stack (verified 2026-07-03, see docs/research/2026-07-03-m2-api-verification.md):** `ai@^7`, `@ai-sdk/moonshotai`, `@ai-sdk/deepseek`, `@ai-sdk/openai-compatible` (GLM + generic), `ai/test` MockLanguageModelV4 + injected-fetch fixtures.

## Global Constraints

- Everything from M0/M1: Node ≥22, strict TS NodeNext `.js` imports, tsconfig.test.json coverage, stdout = JSON-RPC only, tmp-dir fixtures, conventional commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, nothing under `.superpowers/`/`.claude/`.
- **Secrets:** API keys live in `ModelsService` memory only — never logged, never persisted, never echoed back by any RPC (`engine.models.list` returns configs WITHOUT keys). Grepping the diff for a key value must only ever hit the configure test's literal.
- **No live keys in CI:** every model test uses `MockLanguageModelV4` or an injected `fetch` replaying committed JSON fixtures. No test may read provider env vars.
- **Metering:** cost math reads `result.usage` (v7 shape: `inputTokens`/`outputTokens`/`inputTokenDetails.cacheReadTokens`) — never telemetry attributes.
- Pricing entries carry `source`, `verifiedAt`, `confidence: "verified" | "secondary" | "unverified"` — conflicting-source models ship as `"unverified"` with both figures in a comment.

---

### Task 1: Pipelined stdio dispatch

**Files:**
- Create: `packages/engine/src/rpc/stdio.ts`
- Modify: `packages/engine/src/main.ts` (use StdioPipeline; drain before close), `packages/engine/src/engine.ts` (re-export)
- Test: `packages/engine/test/stdio-pipeline.test.ts` (unit); existing `stdio.test.ts` integration tests must pass unchanged

**Interfaces:**
- Produces: `class StdioPipeline { constructor(dispatcher: RpcDispatcher, write: (line: string) => void, onError?: (err: unknown) => void); handleDecoded(line: DecodedLine): void; drain(): Promise<void> }` — `handleDecoded` returns immediately (no serial await); responses are written in COMPLETION order; `drain()` resolves after all in-flight dispatches settle. `main.ts` awaits `drain()` after stdin ends, before `engine.close()`.

- [ ] **Step 1: Write the failing unit test**

`packages/engine/test/stdio-pipeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RpcDispatcher } from "../src/rpc/dispatcher.js";
import { StdioPipeline } from "../src/rpc/stdio.js";

function setup() {
  const dispatcher = new RpcDispatcher();
  dispatcher.register("slow", async () => {
    await new Promise((r) => setTimeout(r, 50));
    return "slow-done";
  });
  dispatcher.register("fast", () => "fast-done");
  const lines: string[] = [];
  const pipeline = new StdioPipeline(dispatcher, (l) => lines.push(l));
  return { pipeline, lines };
}

describe("StdioPipeline", () => {
  it("does not serialize dispatches: fast response overtakes slow", async () => {
    const { pipeline, lines } = setup();
    pipeline.handleDecoded({ ok: true, value: { jsonrpc: "2.0", id: 1, method: "slow" } });
    pipeline.handleDecoded({ ok: true, value: { jsonrpc: "2.0", id: 2, method: "fast" } });
    await pipeline.drain();
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as { id: number };
    const second = JSON.parse(lines[1]!) as { id: number };
    expect(first.id).toBe(2);
    expect(second.id).toBe(1);
  });

  it("answers parse errors and suppresses notification responses", async () => {
    const { pipeline, lines } = setup();
    pipeline.handleDecoded({ ok: false, raw: "garbage" });
    pipeline.handleDecoded({ ok: true, value: { jsonrpc: "2.0", method: "fast" } });
    await pipeline.drain();
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { error: { code: number } }).error.code).toBe(-32700);
  });

  it("drain resolves when nothing is in flight", async () => {
    const { pipeline } = setup();
    await expect(pipeline.drain()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: RED run** — cannot resolve `../src/rpc/stdio.js`.

- [ ] **Step 3: Implement**

`packages/engine/src/rpc/stdio.ts`:

```ts
import type { RpcDispatcher } from "./dispatcher.js";
import { encodeNdjson, type DecodedLine } from "./ndjson.js";

export class StdioPipeline {
  #dispatcher: RpcDispatcher;
  #write: (line: string) => void;
  #onError: (err: unknown) => void;
  #pending = new Set<Promise<void>>();

  constructor(
    dispatcher: RpcDispatcher,
    write: (line: string) => void,
    onError: (err: unknown) => void = () => {},
  ) {
    this.#dispatcher = dispatcher;
    this.#write = write;
    this.#onError = onError;
  }

  handleDecoded(line: DecodedLine): void {
    const task = (async () => {
      const response = line.ok
        ? await this.#dispatcher.dispatch(line.value)
        : this.#dispatcher.parseError();
      if (response !== null) {
        this.#write(encodeNdjson(response));
      }
    })().catch((err: unknown) => {
      // dispatch() converts handler errors to responses; this guards the pipeline itself.
      this.#onError(err);
    });
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }
}
```

`main.ts` — replace the loop body:

```ts
  const pipeline = new StdioPipeline(
    engine.dispatcher,
    (line) => void process.stdout.write(line),
    (err) => engine.log(`pipeline error: ${err instanceof Error ? err.message : String(err)}`),
  );
  for await (const chunk of process.stdin) {
    for (const line of decoder.push(chunk as string)) {
      pipeline.handleDecoded(line);
    }
  }
  await pipeline.drain();
  await engine.close();
```

`engine.ts`: add `export { StdioPipeline } from "./rpc/stdio.js";`

- [ ] **Step 4: GREEN** — `pnpm build && pnpm typecheck && pnpm test`: 96 tests (93 + 3), stdio integration tests unchanged-green. Exact totals.
- [ ] **Step 5: Commit** — `feat(engine): pipelined stdio dispatch — responses in completion order, drain on stdin end`

---

### Task 2: Index-build yield points

**Files:**
- Modify: `packages/engine/src/wiki/indexer.ts`
- Test: extend `packages/engine/test/wiki-indexer.test.ts`

**Interfaces:** `buildIndex` signature unchanged; every 25 files the parse loop yields the event loop (`await new Promise(setImmediate)`), so concurrent RPC (ping, MCP) stays responsive during large builds.

- [ ] **Step 1: Write the failing test**

Append to `wiki-indexer.test.ts`:

```ts
  it("yields the event loop during large builds (concurrent timer fires mid-build)", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-idx-big-"));
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    for (let i = 0; i < 60; i += 1) {
      writeFileSync(path.join(dir, `f${i}.ts`), `export function fn${i}() {}\n`);
    }
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "many"]);
    store = openWikiStore(dir);
    let timerFired = false;
    const timer = setImmediate(() => {
      timerFired = true;
    });
    const stats = await buildIndex(dir, store, parser);
    clearImmediate(timer);
    expect(stats.filesIndexed).toBe(60);
    expect(timerFired).toBe(true);
  }, 30_000);
```

- [ ] **Step 2: RED run** — `timerFired` is false today (buildIndex is one macro-task; the setImmediate callback only runs after it returns... note: if the test passes trivially because `getHeadSha`'s execFileSync boundaries allow the immediate to fire, tighten by scheduling the immediate AFTER the first execFileSync — i.e., move `setImmediate` registration to just before `buildIndex` as written and verify RED empirically; if it does not go RED, replace the probe with a counter incremented by an interval timer and assert it ticked ≥2 times. Report which variant shipped.)

- [ ] **Step 3: Implement** — in the `for (const relPath of tracked)` loop, after the existing per-file work, add:

```ts
    processed += 1;
    if (processed % 25 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
```

(declare `let processed = 0;` before the loop).

- [ ] **Step 4: GREEN** — full suite green (97 tests). Exact totals.
- [ ] **Step 5: Commit** — `feat(engine): yield event loop every 25 files during index builds`

---

### Task 3: Pricing table + provider registry + configure/list RPC

**Files:**
- Modify: `packages/engine/package.json` (deps: ai, @ai-sdk/moonshotai, @ai-sdk/deepseek, @ai-sdk/openai-compatible)
- Create: `packages/engine/src/models/pricing.ts`, `packages/engine/src/models/providers.ts`
- Create: `packages/engine/src/models/methods.ts` (ModelsService skeleton + configure/list)
- Modify: `packages/engine/src/engine.ts` (models service + re-exports)
- Test: `packages/engine/test/models-pricing.test.ts`, `packages/engine/test/models-registry.test.ts`

**Interfaces:**
- `pricing.ts`: `interface ModelPricing { inputPerMtok: number; outputPerMtok: number; cacheReadPerMtok?: number; source: string; verifiedAt: string; confidence: "verified" | "secondary" | "unverified" }`; `PRICING: Record<string, ModelPricing>` keyed `"<providerKind>/<modelId>"`; `lookupPricing(kind: string, modelId: string): ModelPricing | null`; `estimateCostUsd(pricing: ModelPricing, usage: NormalizedUsage): number`; `interface NormalizedUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number }`; `normalizeUsage(raw: unknown): NormalizedUsage` (reads v7 `result.usage` shape, missing fields → 0).
- `providers.ts`: `const ProviderConfigSchema = z.object({ id: z.string().min(1), kind: z.enum(["moonshot", "zai", "deepseek", "openai-compatible"]), apiKey: z.string().min(1), baseURL: z.string().url().optional() })`; `type ProviderConfig = z.infer<...>`; `class ProviderRegistry { configure(config: ProviderConfig, fetchImpl?: typeof fetch): void; list(): Array<Omit<ProviderConfig, "apiKey">>; resolve(providerId: string, modelId: string): LanguageModel (throws RpcMethodError SERVER_ERROR if unconfigured); setTestModel(providerId: string, model: LanguageModel): void /* test hook: bypasses SDK factories */ }` — kind→factory: moonshot→createMoonshotAI (default baseURL https://api.moonshot.ai/v1), deepseek→createDeepSeek, zai→createOpenAICompatible(name:"zai", default baseURL https://api.z.ai/api/paas/v4), openai-compatible→createOpenAICompatible (baseURL REQUIRED — validate, else RpcMethodError INVALID_PARAMS at configure time).
- RPC: `engine.models.configure {id, kind, apiKey, baseURL?}` → `{ configured: true }`; `engine.models.list {}` → `{ providers: [{id, kind, baseURL?}] }` (NO apiKey field, ever).

**Pricing entries to ship (from docs/research/2026-07-03-m2-api-verification.md — copy source/confidence verbatim):** `moonshot/kimi-k2.6` 0.95/4.00/0.16 unverified (conflicting source 0.60/2.50 — comment both); `moonshot/kimi-k2.7-code` 0.95/4.00/0.19 secondary; `zai/glm-5.2` 1.40/4.40 (no cacheRead) secondary; `deepseek/deepseek-chat` AND `deepseek/deepseek-v4-flash` 0.14/0.28/0.0028 verified; `deepseek/deepseek-reasoner` AND `deepseek/deepseek-v4-pro` 0.435/0.87/0.003625 verified; `openai-compatible/qwen3-coder-next` 0.11/0.80 secondary; reference rows (counterfactual math, not callable presets): `reference/claude-sonnet-5` 3.00/15.00/0.30 secondary, `reference/claude-opus-4-8` 5.00/25.00/0.50 secondary, `reference/gpt-5.5` 5.00/30.00/0.50 verified, `reference/gpt-5.4` 2.50/15.00/0.25 verified. All `verifiedAt: "2026-07-03"`.

- [ ] **Step 1: Install** — `pnpm add ai @ai-sdk/moonshotai @ai-sdk/deepseek @ai-sdk/openai-compatible --filter @openfusion/engine`. Verify: `cd packages/engine && node -e "import('ai').then(m => console.log('ai-ok', typeof m.generateText))"` → `ai-ok function`; check installed `ai` major is 7 (`node -p "require('ai/package.json').version"`). If major ≠ 7 or imports fail, STOP → NEEDS_CONTEXT.

- [ ] **Step 2: Failing tests**

`models-pricing.test.ts`: lookup returns entry for `deepseek/deepseek-v4-flash` with confidence "verified"; `lookupPricing("nope","x")` → null; `normalizeUsage({ inputTokens: 100, outputTokens: 50, inputTokenDetails: { cacheReadTokens: 40 } })` → `{100, 50, 40}`; `normalizeUsage(undefined)` → zeros; `estimateCostUsd` math: pricing {input 1.0, output 2.0, cacheRead 0.1}, usage {inputTokens 1_000_000, outputTokens 500_000, cacheReadTokens 400_000} → (600000*1.0 + 400000*0.1 + 500000*2.0)/1e6 = 1.64 (use `toBeCloseTo(1.64, 10)`); cacheReadPerMtok absent → cacheRead billed at input rate (same usage, pricing {1.0, 2.0} → 2.0).

`models-registry.test.ts`: configure openai-compatible WITHOUT baseURL → throws (INVALID_PARAMS via RpcMethodError); configure valid zai → list() returns `[{id, kind, baseURL}]` and JSON.stringify(list()) does NOT contain the apiKey literal; resolve unknown id → RpcMethodError with code -32000; setTestModel + resolve returns the injected object.

- [ ] **Step 3: RED, implement, GREEN** — pricing.ts and providers.ts per Interfaces (estimateCostUsd: `((input - cacheRead) * inputPerMtok + cacheRead * (cacheReadPerMtok ?? inputPerMtok) + output * outputPerMtok) / 1e6`, clamp cacheRead to ≤ inputTokens); methods.ts: `class ModelsService { readonly registry = new ProviderRegistry(); readonly meter = new CostMeter(); }` — CostMeter arrives in Task 4; for this task create `meter.ts` with the class skeleton `record()`/`totals()` returning zeros is NOT acceptable — instead defer the meter file entirely to Task 4 and keep ModelsService `{ registry }` only; `registerModelsMethods(engine)` registers configure/list; Engine gains `readonly models = new ModelsService()` + constructor call + re-exports (`ModelsService`, `ProviderRegistry`, pricing exports).
- [ ] **Step 4: Full suite green** (expect ~105 tests). Exact totals.
- [ ] **Step 5: Commit** — `feat(engine): provider registry with sourced pricing table and models.configure/list RPC`

---

### Task 4: engine.models.complete + cost meter + fallback chains

**Files:**
- Create: `packages/engine/src/models/meter.ts`
- Modify: `packages/engine/src/models/methods.ts` (complete/usage RPCs), `packages/engine/src/engine.ts` (re-export CostMeter)
- Create: `packages/engine/test/models-complete.test.ts`, `packages/engine/test/fixtures/openai-compatible-completion.json`

**Interfaces:**
- `meter.ts`: `interface UsageRecord { providerId: string; kind: string; model: string; usage: NormalizedUsage; costUsd: number | null; at: number }`; `class CostMeter { record(r: UsageRecord): void; totals(): { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; unpricedCalls: number; byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }> } }` (byModel keyed `"<kind>/<model>"`; costUsd sums only priced calls; unpricedCalls counts costUsd:null records).
- RPC `engine.models.complete` params (zod): `{ providerId: string, model: string, prompt?: string, messages?: Array<{role: "system"|"user"|"assistant", content: string}>, maxOutputTokens?: int 1..65536, fallbacks?: Array<{providerId, model}> (max 3) }` — exactly one of prompt/messages (refine). Result: `{ text, finishReason, usage: NormalizedUsage, costUsd: number | null, providerId, model, attempts: Array<{providerId, model, error?: string}> }`. Behavior: try primary then each fallback in order; an attempt is retried-over ONLY on retryable failures (AI SDK `APICallError.isRetryable`, any fetch/network TypeError, or statusCode ≥ 500 / 429); non-retryable errors (400/401/403, validation) throw immediately as `RpcMethodError(SERVER_ERROR, message, { attempts })`. Every SUCCESSFUL attempt records to the meter (costUsd null when no pricing entry). All attempts appear in `attempts` with error strings for failures.
- RPC `engine.models.usage {}` → CostMeter.totals().

- [ ] **Step 1: Failing tests** (`models-complete.test.ts` — all via `createEngine().dispatcher.dispatch`; import `MockLanguageModelV4` from `ai/test`):
  1. Happy path: setTestModel a mock returning text "hi" + provider-shape usage (input {total 10, noCache 10}, output {total 20, text 20}); model id priced as `deepseek/deepseek-v4-flash` (configure kind deepseek, setTestModel override) → result.text "hi", usage {10,20,0}, costUsd toBeCloseTo((10*0.14 + 20*0.28)/1e6).
  2. Unpriced model → costUsd null, usage totals still recorded, engine.models.usage shows unpricedCalls 1.
  3. Fallback: primary mock throws a retryable error (construct `Object.assign(new Error("boom"), { isRetryable: true })` or use APICallError if importable), fallback mock succeeds → result.providerId is the fallback's, attempts has 2 entries with error on the first.
  4. Non-retryable: mock throws plain Error (not retryable) → RPC error SERVER_ERROR, `data.attempts` length 1.
  5. Param validation: both prompt and messages → INVALID_PARAMS.
  6. Fixture integration (real adapter path): configure `openai-compatible` provider with baseURL `http://fixture.local/v1` and injected fetch returning `fixtures/openai-compatible-completion.json` (a real chat.completions body: `{"id":"cmpl-1","object":"chat.completion","created":0,"model":"qwen3-coder-next","choices":[{"index":0,"message":{"role":"assistant","content":"fixture reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19,"prompt_tokens_details":{"cached_tokens":4}}}` — commit as the fixture file); registry.configure must accept `fetchImpl` and pass it to the factory. Assert text "fixture reply", usage {12,7,4}, costUsd computed from the `openai-compatible/qwen3-coder-next` pricing row.

- [ ] **Step 2: RED run.**
- [ ] **Step 3: Implement** — meter.ts per interface; methods.ts: `complete` handler resolves model via registry, builds `generateText({ model, prompt | messages, maxOutputTokens })` (v7: option name is `maxOutputTokens` — verify against installed types and report if it differs), normalizes usage, prices via `lookupPricing(kind, model)`, records, returns. Retry classifier in a small helper `isRetryableModelError(err)`. Keys/text NEVER logged; `engine.log` only `models.complete <kind>/<model> ok|failover|failed`.
- [ ] **Step 4: GREEN** — full suite (expect ~111+ tests). Exact totals.
- [ ] **Step 5: Commit** — `feat(engine): metered model completion with fallback chains and usage RPC`

---

### Task 5: Map density batch

**Files:**
- Modify: `packages/engine/src/wiki/parser.ts` (dedupe identical captures), `packages/engine/src/wiki/rank.ts` (skip empty-symbol blocks in render), `packages/engine/queries/README.md` (Go noise note)
- Test: extend `wiki-parser-langs.test.ts`, `wiki-rank.test.ts`

**Interfaces:** `parseFile` dedupes exact duplicate entries (same name+kind... NO — dedupe on name+row+col per category regardless of kind, keeping the FIRST kind, so Rust `method`+`function` double-captures collapse to one); `renderRepoMap` skips files whose `definedSymbols` is empty (they contribute no navigational value); README documents Go's upstream var/const gap and type self-reference noise.

- [ ] **Step 1: Failing tests** — parser: rust source `struct S; impl S { fn m(&self) {} }` → symbols filtered to name "m" have length 1 (currently 2); rank: renderRepoMap with `[{file:"a.ts",score:1,definedSymbols:[]},{file:"b.ts",score:0.5,definedSymbols:["x"]}]`, budget 1000 → map contains "b.ts", NOT "a.ts".
- [ ] **Step 2: RED, implement, GREEN** — parser: in parseFile, per-category `Set<string>` keyed `${name}\0${row}\0${col}`, skip duplicates; rank: `if (r.definedSymbols.length === 0) continue;` in the render loop; README note under a "Known upstream query gaps" heading. Full suite green (expect ~113). Exact totals.
- [ ] **Step 3: Commit** — `fix(engine): dedupe double-captured definitions, skip empty map blocks, document Go query gaps`

---

## Milestone exit checklist

- [ ] `pnpm install && pnpm build && pnpm typecheck && pnpm test` green from clean checkout, zero provider env vars set
- [ ] `grep -ri "apiKey" packages/engine/src --include="*.ts" | grep -v "apiKey: z\|apiKey}" ` review: no logging/persistence of keys
- [ ] Scratch smoke: `engine.models.configure` (fake key) + `engine.models.complete` against a mock/fixture → costUsd math sane; `engine.models.usage` totals match
- [ ] Next per roadmap: M3 (frontier engines) plan — verify Claude Agent SDK + ACP adapter APIs at plan time; MCP SDK v2 decision point (~GA 2026-07-28) folds in
