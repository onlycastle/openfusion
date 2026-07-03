import { createDeepSeek } from "@ai-sdk/deepseek";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import { RpcMethodError } from "../rpc/errors.js";

const MOONSHOT_DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";
const ZAI_DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4";

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["moonshot", "zai", "deepseek", "openai-compatible"]),
  apiKey: z.string().min(1),
  baseURL: z.string().url().optional(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

interface RegisteredProvider {
  config: ProviderConfig;
  fetchImpl?: typeof fetch;
}

// Holds provider configs (including API keys) and resolves them to live
// `ai` SDK model instances on demand. API keys live only in this in-memory
// map for the lifetime of the process: never logged, never returned from
// list(), never persisted to disk.
export class ProviderRegistry {
  #providers = new Map<string, RegisteredProvider>();
  #testModels = new Map<string, LanguageModel>();

  configure(config: ProviderConfig, fetchImpl?: typeof fetch): void {
    if (config.kind === "openai-compatible" && config.baseURL === undefined) {
      throw new RpcMethodError(
        RpcErrorCodes.INVALID_PARAMS,
        `provider "${config.id}": kind "openai-compatible" requires baseURL`,
      );
    }
    this.#providers.set(config.id, { config, fetchImpl });
  }

  list(): Array<Omit<ProviderConfig, "apiKey">> {
    return [...this.#providers.values()].map(({ config }) => ({
      id: config.id,
      kind: config.kind,
      baseURL: config.baseURL,
    }));
  }

  resolve(providerId: string, modelId: string): LanguageModel {
    const testModel = this.#testModels.get(providerId);
    if (testModel !== undefined) return testModel;

    const registered = this.#providers.get(providerId);
    if (registered === undefined) {
      throw new RpcMethodError(
        RpcErrorCodes.SERVER_ERROR,
        `provider not configured: ${providerId}`,
      );
    }
    const { config, fetchImpl } = registered;

    switch (config.kind) {
      case "moonshot":
        return createMoonshotAI({
          apiKey: config.apiKey,
          baseURL: config.baseURL ?? MOONSHOT_DEFAULT_BASE_URL,
          fetch: fetchImpl,
        })(modelId);
      case "deepseek":
        return createDeepSeek({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          fetch: fetchImpl,
        })(modelId);
      case "zai":
        return createOpenAICompatible({
          name: "zai",
          apiKey: config.apiKey,
          baseURL: config.baseURL ?? ZAI_DEFAULT_BASE_URL,
          fetch: fetchImpl,
        })(modelId);
      case "openai-compatible":
        // config.baseURL is guaranteed defined here — configure() rejects
        // this kind without one.
        return createOpenAICompatible({
          name: config.id,
          apiKey: config.apiKey,
          baseURL: config.baseURL as string,
          fetch: fetchImpl,
        })(modelId);
    }
  }

  // Test hook: bypasses the SDK factories entirely so unit tests can inject
  // a mock LanguageModel (e.g. `ai/test`'s MockLanguageModelV4) without a
  // configured provider or live credentials.
  setTestModel(providerId: string, model: LanguageModel): void {
    this.#testModels.set(providerId, model);
  }
}
