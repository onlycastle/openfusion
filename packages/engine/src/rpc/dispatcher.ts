import {
  JSONRPC_VERSION,
  RpcErrorCodes,
  RpcRequestSchema,
  type RpcResponse,
} from "@openfusion/shared";

export type RpcHandler = (params: unknown) => Promise<unknown> | unknown;

export class RpcDispatcher {
  #handlers = new Map<string, RpcHandler>();

  register(method: string, handler: RpcHandler): void {
    if (this.#handlers.has(method)) {
      throw new Error(`method already registered: ${method}`);
    }
    this.#handlers.set(method, handler);
  }

  parseError(): RpcResponse {
    return {
      jsonrpc: JSONRPC_VERSION,
      id: null,
      error: { code: RpcErrorCodes.PARSE_ERROR, message: "parse error" },
    };
  }

  async dispatch(message: unknown): Promise<RpcResponse | null> {
    const parsed = RpcRequestSchema.safeParse(message);
    if (!parsed.success) {
      return {
        jsonrpc: JSONRPC_VERSION,
        id: null,
        error: {
          code: RpcErrorCodes.INVALID_REQUEST,
          message: "invalid request",
        },
      };
    }
    const { id, method, params } = parsed.data;
    const handler = this.#handlers.get(method);
    if (handler === undefined) {
      if (id === undefined) return null;
      return {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: {
          code: RpcErrorCodes.METHOD_NOT_FOUND,
          message: `method not found: ${method}`,
        },
      };
    }
    try {
      const result = await handler(params);
      if (id === undefined) return null;
      // JSON-RPC requires a result member; undefined would serialize to nothing.
      return { jsonrpc: JSONRPC_VERSION, id, result: result ?? null };
    } catch (err) {
      if (id === undefined) return null;
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: { code: RpcErrorCodes.INTERNAL_ERROR, message },
      };
    }
  }
}
