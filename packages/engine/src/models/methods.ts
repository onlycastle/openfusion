import { APICallError, generateText, RetryError, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { providerKindOf } from "../rpc/guards.js";
import { registerMethod } from "../rpc/register.js";
import { CostMeter } from "./meter.js";
import { estimateCostUsd, lookupPricing, normalizeUsage, type NormalizedUsage } from "./pricing.js";
import { ProviderConfigSchema, ProviderRegistry } from "./providers.js";

const EmptyParamsSchema = z.object({});

const ProviderIdParamsSchema = z.object({
  id: z.string().min(1),
});

const ConnectionCheckParamsSchema = ProviderConfigSchema.extend({
  model: z.string().min(1),
});

type ConnectionCheckParams = z.infer<typeof ConnectionCheckParamsSchema>;

const CONNECTION_CHECK_TIMEOUT_MS = 15_000;

const MessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const FallbackSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});

const CompleteParamsSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    prompt: z.string().optional(),
    messages: z.array(MessageSchema).optional(),
    maxOutputTokens: z.number().int().min(1).max(65536).optional(),
    fallbacks: z.array(FallbackSchema).max(3).optional(),
    // Per-ATTEMPT deadline (not a whole-chain budget): each candidate in the
    // fallback chain gets its own fresh `AbortSignal.timeout(timeoutMs)`, so
    // a chain of N candidates can take up to N * timeoutMs in the worst
    // case. A hung provider is exactly the failure mode failover exists
    // for, so a timed-out attempt is retryable (see isRetryableModelError).
    timeoutMs: z.number().int().min(1000).max(600000).optional(),
  })
  .refine((p) => (p.prompt !== undefined) !== (p.messages !== undefined), {
    message: "exactly one of prompt or messages is required",
  });

type CompleteParams = z.infer<typeof CompleteParamsSchema>;
type CompleteMessage = z.infer<typeof MessageSchema>;

interface Attempt {
  providerId: string;
  model: string;
  error?: string;
}

export class ModelsService {
  readonly registry = new ProviderRegistry();
  readonly meter = new CostMeter();
}

// Converts our wire-shape message ({role, content: string}) into the AI
// SDK's ModelMessage discriminated union. A plain `as ModelMessage[]` cast
// does not typecheck here: ModelMessage is a union of exact per-role shapes
// and TS won't distribute a broadened `role: "system"|"user"|"assistant"`
// literal across it, so each message is rebuilt through a role switch that
// lets TS narrow per-branch instead.
function toModelMessages(messages: CompleteMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user":
        return { role: "user", content: m.content };
      case "assistant":
        return { role: "assistant", content: m.content };
    }
  });
}

// Detects an abort/timeout failure regardless of how the AI SDK happened to
// surface it. Empirically (Node 22, ai@7.0.11, @ai-sdk/openai-compatible),
// `AbortSignal.timeout()` firing produces a raw `DOMException` with
// `name: "TimeoutError"` that reaches here UNWRAPPED: reading
// `retryWithExponentialBackoffInternal` in `@ai-sdk/provider-utils` shows
// `isAbortError(error)` is checked and rethrown before the `maxRetries === 0`
// short-circuit, so this bypasses both the SDK's own retry wrapping and the
// `APICallError` wrapping that `postToApi` applies to non-abort failures
// (`handleFetchError` also returns abort errors unchanged). A `DOMException`
// is `instanceof Error` in this runtime, so the first branch below is the
// hot path. The `APICallError`-with-abort-`cause` and manual
// `AbortController.abort()` (`name: "AbortError"`) branches are kept as
// defense-in-depth for adapters/runtimes that wrap differently.
function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return true;
  }
  if (APICallError.isInstance(err) && err.cause !== undefined && isTimeoutError(err.cause)) {
    return true;
  }
  return false;
}

// Classifies a `generateText`/provider failure as safe to retry against the
// next candidate in the fallback chain. Checked first: timeouts (see
// `isTimeoutError`) — a hung provider is exactly the failure mode failover
// exists for. Then the AI SDK's own `AI_RetryError`, thrown when
// `generateText`'s internal retry budget is exhausted (`reason:
// "maxRetriesExceeded"`) — not an APICallError, so it must be unwrapped and
// judged on its `lastError` (or trusted outright on exhaustion) rather than
// falling through to "not retryable". With `maxRetries: 0` set on the
// `generateText` call below this branch is defense-in-depth rather than the
// hot path, since the SDK now rethrows the raw error on the first failure
// instead of wrapping it — see the call site comment. Otherwise retryable:
// AI SDK APICallError with isRetryable true or a 5xx/429 statusCode,
// network-level fetch TypeErrors, and (for test doubles) any thrown value
// exposing a truthy `isRetryable` property or 5xx/429 `statusCode`.
export function isRetryableModelError(err: unknown): boolean {
  if (isTimeoutError(err)) return true;
  if (RetryError.isInstance(err)) {
    return err.reason === "maxRetriesExceeded" || isRetryableModelError(err.lastError);
  }
  if (APICallError.isInstance(err)) {
    if (err.isRetryable) return true;
    return err.statusCode !== undefined && (err.statusCode >= 500 || err.statusCode === 429);
  }
  if (err instanceof TypeError) return true;
  if (typeof err === "object" && err !== null) {
    const candidate = err as { isRetryable?: unknown; statusCode?: unknown };
    if (candidate.isRetryable === true) return true;
    if (
      typeof candidate.statusCode === "number" &&
      (candidate.statusCode >= 500 || candidate.statusCode === 429)
    ) {
      return true;
    }
  }
  return false;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// AbortSignal.timeout()'s DOMException message ("The operation was aborted
// due to timeout", verified empirically) does not contain the substring
// "timed out" — normalize it so attempt error strings reliably do, per the
// task contract (log scrapers / callers grep for it rather than parsing
// DOMException wording that varies by runtime).
function timeoutAttemptMessage(err: unknown, timeoutMs: number): string {
  const raw = errorMessage(err);
  return raw.toLowerCase().includes("timed out")
    ? raw
    : `model call timed out after ${timeoutMs}ms: ${raw}`;
}

function connectionCheckErrorMessage(err: unknown): string {
  if (isTimeoutError(err)) {
    return "Connection check timed out after 15 seconds.";
  }
  if (APICallError.isInstance(err)) {
    switch (err.statusCode) {
      case 401:
      case 403:
        return "Authentication failed. Check the API key and account access.";
      case 404:
        return "The endpoint or model was not found. Check the base URL and model.";
      case 429:
        return "The provider rate-limited the connection check. Try again shortly.";
      default:
        return err.statusCode === undefined
          ? "The provider rejected the connection check. Check the API key, model, and endpoint."
          : `The provider returned HTTP ${err.statusCode}. Check the API key, model, and endpoint.`;
    }
  }
  if (err instanceof TypeError) {
    return "Could not reach the provider. Check the base URL and network connection.";
  }
  return "The provider rejected the connection check. Check the API key, model, and endpoint.";
}

/** Make one minimal model request without registering the provider or
 * recording usage. Exported so the network-free model seam can be tested
 * with an AI SDK mock rather than real credentials. */
export async function checkLanguageModelConnection(
  model: LanguageModel,
  timeoutMs = CONNECTION_CHECK_TIMEOUT_MS,
  cancellationSignal?: AbortSignal,
): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  await generateText({
    model,
    prompt: "Reply with OK.",
    maxOutputTokens: 1,
    maxRetries: 0,
    abortSignal: cancellationSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([cancellationSignal, timeoutSignal]),
  });
}

async function runConnectionCheck(engine: Engine, params: ConnectionCheckParams): Promise<{ connected: true }> {
  const { model, ...config } = params;
  const scratchRegistry = new ProviderRegistry();
  scratchRegistry.configure(config);

  try {
    await engine.providerGateway.execute(
      { providerId: config.id, cacheStatus: "miss" },
      (signal) => checkLanguageModelConnection(scratchRegistry.resolve(config.id, model), CONNECTION_CHECK_TIMEOUT_MS, signal),
    );
    return { connected: true };
  } catch (err) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, connectionCheckErrorMessage(err));
  }
}

async function runComplete(
  engine: Engine,
  params: CompleteParams,
): Promise<{
  text: string;
  finishReason: string;
  usage: NormalizedUsage;
  costUsd: number | null;
  providerId: string;
  model: string;
  attempts: Attempt[];
  providerMetadata?: unknown;
}> {
  const candidates = [{ providerId: params.providerId, model: params.model }, ...(params.fallbacks ?? [])];
  const attempts: Attempt[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const { providerId, model } = candidate;
    const kind = providerKindOf(engine.models.registry, providerId);

    try {
      const languageModel = engine.models.registry.resolve(providerId, model);
      const promptOptions =
        params.prompt !== undefined
          ? { prompt: params.prompt }
          : { messages: toModelMessages(params.messages!) };

      // A fresh AbortSignal.timeout() is constructed per loop iteration, so
      // `timeoutMs` is a PER-ATTEMPT deadline: each candidate in the
      // fallback chain gets its own full budget rather than sharing one
      // deadline across the whole chain.
      const abortSignal =
        params.timeoutMs !== undefined ? AbortSignal.timeout(params.timeoutMs) : undefined;

      const result = await engine.providerGateway.execute(
        { providerId, ...(abortSignal === undefined ? {} : { signal: abortSignal }), cacheStatus: "unknown" },
        (signal) => generateText({
          model: languageModel,
          ...promptOptions,
          maxOutputTokens: params.maxOutputTokens,
          // The fallback chain is the single retry layer; SDK-internal retries
          // would stack backoff under it (M2 final review, Important #2).
          maxRetries: 0,
          abortSignal: signal,
        }),
      );

      const usage = normalizeUsage(result.usage);
      const pricing = lookupPricing(kind, model);
      const costUsd = pricing !== null ? estimateCostUsd(pricing, usage) : null;
      const pricingConfidence = pricing !== null ? pricing.confidence : "unpriced";

      engine.providerGateway.recordUsage({
        providerId,
        kind,
        model,
        usage,
        costUsd,
        at: Date.now(),
        source: "complete",
        pricingConfidence,
      });
      attempts.push({ providerId, model });

      engine.log(`models.complete ${kind}/${model} ${i === 0 ? "ok" : "failover"}`);

      return {
        text: result.text,
        finishReason: result.finishReason,
        usage,
        costUsd,
        providerId,
        model,
        attempts,
        // Passed through verbatim for the pre-savings live-metering smoke
        // (Moonshot/GLM cache-field discovery). Never logged — see the
        // `engine.log` calls in this function, which only ever emit
        // provider/model/kind strings.
        providerMetadata: result.providerMetadata,
      };
    } catch (err) {
      const message =
        params.timeoutMs !== undefined && isTimeoutError(err)
          ? timeoutAttemptMessage(err, params.timeoutMs)
          : errorMessage(err);
      attempts.push({ providerId, model, error: message });

      const canRetry = isRetryableModelError(err) && i < candidates.length - 1;
      if (!canRetry) {
        engine.log(`models.complete ${kind}/${model} failed`);
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, message, { attempts });
      }
    }
  }

  // Unreachable: candidates always has at least one entry, and the loop body
  // either returns or throws on its last iteration.
  throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no candidates attempted", { attempts });
}

export function registerModelsMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.models.check", ConnectionCheckParamsSchema, async (params) => {
    try {
      const result = await runConnectionCheck(engine, params);
      engine.log(`models.check ${params.kind}/${params.model} ok`);
      return result;
    } catch (err) {
      engine.log(`models.check ${params.kind}/${params.model} failed`);
      throw err;
    }
  });

  registerMethod(engine.dispatcher, "engine.models.configure", ProviderConfigSchema, (config) => {
    engine.models.registry.configure(config);
    return { configured: true };
  });

  registerMethod(engine.dispatcher, "engine.models.unconfigure", ProviderIdParamsSchema, ({ id }) => {
    return { unconfigured: engine.models.registry.unconfigure(id) };
  });

  registerMethod(engine.dispatcher, "engine.models.list", EmptyParamsSchema, () => {
    return { providers: engine.models.registry.list() };
  });

  registerMethod(engine.dispatcher, "engine.models.complete", CompleteParamsSchema, (params) => {
    return runComplete(engine, params);
  });

  registerMethod(engine.dispatcher, "engine.models.usage", EmptyParamsSchema, () => {
    return engine.models.meter.totals();
  });
}
