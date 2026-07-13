import { ApprovalGrantSchema } from "@openfusion/shared";
import { z } from "zod";
import type { Engine } from "../engine.js";
import { RpcErrorCodes } from "@openfusion/shared";
import { RpcMethodError } from "../rpc/errors.js";
import { requireGitRepo } from "../rpc/guards.js";
import { registerMethod } from "../rpc/register.js";

const ReadSchema = z.object({ candidateId: z.string().min(1) }).strict();
const PrepareApplySchema = z.object({
  candidateId: z.string().min(1),
  projectDir: z.string().min(1),
}).strict();

function candidateError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, message);
}

export function registerCandidateMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.candidates.read", ReadSchema, async ({ candidateId }) => {
    try {
      return await engine.candidates.read(candidateId);
    } catch (error) {
      return candidateError(error);
    }
  });
  registerMethod(
    engine.dispatcher,
    "engine.candidates.prepareApply",
    PrepareApplySchema,
    async ({ candidateId, projectDir }) => {
      requireGitRepo(projectDir);
      try {
        return { approvalGrant: ApprovalGrantSchema.parse(await engine.candidates.prepareApply(candidateId, projectDir)) };
      } catch (error) {
        return candidateError(error);
      }
    },
  );
}
