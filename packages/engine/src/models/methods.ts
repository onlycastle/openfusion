import { z } from "zod";
import type { Engine } from "../engine.js";
import { registerMethod } from "../rpc/register.js";
import { ProviderConfigSchema, ProviderRegistry } from "./providers.js";

const EmptyParamsSchema = z.object({});

// CostMeter (usage recording/totals) arrives in Task 4 — this service holds
// only the provider registry for now.
export class ModelsService {
  readonly registry = new ProviderRegistry();
}

export function registerModelsMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.models.configure", ProviderConfigSchema, (config) => {
    engine.models.registry.configure(config);
    return { configured: true };
  });

  registerMethod(engine.dispatcher, "engine.models.list", EmptyParamsSchema, () => {
    return { providers: engine.models.registry.list() };
  });
}
