// engine.runs.list — the read-only RPC surface over the run ledger
// (./ledger.ts). Mirrors the evals/methods.ts split: a thin params-validation
// + registration layer over an already-tested, engine-independent function
// (readRuns) — there is no pipeline logic here, only wiring.
//
// NO GIT GUARD, deliberately: unlike engine.harness.read (which requires a
// generated harness to mean anything), an absent or empty ledger is a normal
// state for ANY project directory, generated or not — readRuns already
// treats a missing runs.jsonl as empty history (see ledger.ts), so this
// method must work unconditionally, without checking for a .git or
// .openfusion directory first.
import { z } from "zod";
import type { Engine } from "../engine.js";
import { registerMethod } from "../rpc/register.js";
import { readRuns } from "./ledger.js";

const ListParamsSchema = z.object({
  projectDir: z.string().min(1),
  kind: z.enum(["orchestrate", "evals", "generate", "card"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

// Sibling-pattern marker class (mirrors EvalsService/OrchestrateService on
// Engine) — holds no state of its own; readRuns is a plain sync function.
export class RunsService {}

export function registerRunsMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.runs.list", ListParamsSchema, (params) => {
    return readRuns(params.projectDir, { kind: params.kind, limit: params.limit });
  });
}
