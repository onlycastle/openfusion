import { APICallError, generateText, type ModelMessage } from "ai";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { registerMethod } from "../rpc/register.js";
import { CostMeter } from "./meter.js";
import { estimateCostUsd, lookupPricing, normalizeUsage, type NormalizedUsage } from "./pricing.js";
import { ProviderConfigSchema, ProviderRegistry } from "./providers.js";

const EmptyParamsSchema = z.object({});

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

// Classifies a `generateText`/provider failure as safe to retry against the
// next candidate in the fallback chain. Retryable: AI SDK APICallError with
// isRetryable true or a 5xx/429 statusCode, network-level fetch TypeErrors,
// and (for test doubles) any thrown value exposing a truthy `isRetryable`
// property or 5xx/429 `statusCode`.
export function isRetryableModelError(err: unknown): boolean {
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

// Looks up the provider kind recorded at `configure()` time. Falls back to
// the providerId itself (which simply fails pricing lookups harmlessly) for
// the — unsupported in practice — case of a resolve()-able provider that was
// never configured.
function kindOf(engine: Engine, providerId: string): string {
  const registered = engine.models.registry.list().find((p) => p.id === providerId);
  return registered?.kind ?? providerId;
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
}> {
  const candidates = [{ providerId: params.providerId, model: params.model }, ...(params.fallbacks ?? [])];
  const attempts: Attempt[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const { providerId, model } = candidate;
    const kind = kindOf(engine, providerId);

    try {
      const languageModel = engine.models.registry.resolve(providerId, model);
      const promptOptions =
        params.prompt !== undefined
          ? { prompt: params.prompt }
          : { messages: toModelMessages(params.messages!) };

      const result = await generateText({
        model: languageModel,
        ...promptOptions,
        maxOutputTokens: params.maxOutputTokens,
      });

      const usage = normalizeUsage(result.usage);
      const pricing = lookupPricing(kind, model);
      const costUsd = pricing !== null ? estimateCostUsd(pricing, usage) : null;

      engine.models.meter.record({ providerId, kind, model, usage, costUsd, at: Date.now() });
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
      };
    } catch (err) {
      const message = errorMessage(err);
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
  registerMethod(engine.dispatcher, "engine.models.configure", ProviderConfigSchema, (config) => {
    engine.models.registry.configure(config);
    return { configured: true };
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
