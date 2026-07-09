// engine.runs.list — read-only surface over the per-project run ledger.
import { z } from "zod";
import type { Engine } from "../engine.js";
import { registerMethod } from "../rpc/register.js";
import { readRuns } from "./ledger.js";

const ListParamsSchema = z.object({
  projectDir: z.string().min(1),
  kind: z.enum(["orchestrate", "evals", "generate", "card"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

// Sibling-pattern marker (mirrors EvalsService / OrchestrateService).
export class RunsService {}

export function registerRunsMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.runs.list", ListParamsSchema, async (params) => {
    // No git guard: an absent ledger is a normal empty state; works on any dir.
    return readRuns(params.projectDir, {
      kind: params.kind,
      limit: params.limit,
    });
  });
}
