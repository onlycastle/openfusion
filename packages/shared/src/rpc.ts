import { z } from "zod";

export const JSONRPC_VERSION = "2.0" as const;

export const RpcErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export const RpcIdSchema = z.union([z.string(), z.number()]);

export const RpcRequestSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RpcIdSchema.optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const RpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const RpcResponseSchema = z
  .object({
    jsonrpc: z.literal(JSONRPC_VERSION),
    id: RpcIdSchema.nullable(),
    result: z.unknown().optional(),
    error: RpcErrorSchema.optional(),
  })
  .refine((r) => (r.result === undefined) !== (r.error === undefined), {
    message: "response must have exactly one of result or error",
  });

export type RpcId = z.infer<typeof RpcIdSchema>;
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type RpcError = z.infer<typeof RpcErrorSchema>;
export type RpcResponse = z.infer<typeof RpcResponseSchema>;
