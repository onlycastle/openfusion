import type { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { RpcDispatcher } from "./dispatcher.js";
import { RpcMethodError } from "./errors.js";

export function registerMethod<S extends z.ZodType>(
  dispatcher: RpcDispatcher,
  method: string,
  schema: S,
  handler: (params: z.infer<S>) => Promise<unknown> | unknown,
): void {
  dispatcher.register(method, (params) => {
    const parsed = schema.safeParse(params);
    if (!parsed.success) {
      throw new RpcMethodError(
        RpcErrorCodes.INVALID_PARAMS,
        `invalid params for ${method}: ${parsed.error.message}`,
      );
    }
    return handler(parsed.data as z.infer<S>);
  });
}
