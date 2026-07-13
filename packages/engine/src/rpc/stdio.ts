import { JSONRPC_VERSION, RpcErrorCodes, RpcRequestSchema } from "@openfusion/shared";
import type { RpcDispatcher } from "./dispatcher.js";
import { encodeNdjson, type DecodedLine } from "./ndjson.js";

export const MAX_CONCURRENT_RPC_HANDLERS = 32;

/** Bounded JSON-RPC dispatch over stdin/stdout NDJSON. */
export class StdioPipeline {
  readonly #dispatcher: RpcDispatcher;
  readonly #write: (line: string) => unknown;
  readonly #onError: (err: unknown) => void;
  readonly #pending = new Set<Promise<void>>();
  #accepting = true;

  constructor(
    dispatcher: RpcDispatcher,
    write: (line: string) => unknown,
    onError: (err: unknown) => void = () => {},
  ) {
    this.#dispatcher = dispatcher;
    this.#write = write;
    this.#onError = onError;
  }

  stopAdmission(): void {
    this.#accepting = false;
  }

  /**
   * Returns a promise only for an overload response. main.ts awaits that
   * promise, pausing stdin consumption until stdout has capacity; admitted
   * requests remain concurrent up to the fixed handler ceiling.
   */
  handleDecoded(line: DecodedLine): void | Promise<void> {
    if (!line.ok && line.oversized) {
      this.#onError(
        new Error(`ndjson: rejected oversized line (${line.discardedBytes} bytes discarded)`),
      );
      return;
    }

    if (!this.#accepting || this.#pending.size >= MAX_CONCURRENT_RPC_HANDLERS) {
      if (!line.ok) {
        return Promise.resolve(this.#write(encodeNdjson(this.#dispatcher.parseError())))
          .then(
            () => undefined,
            (error: unknown) => {
              this.#onError(error);
            },
          );
      }
      const request = RpcRequestSchema.safeParse(line.value);
      if (!request.success || request.data.id === undefined) return;
      return Promise.resolve(
        this.#write(
          encodeNdjson({
            jsonrpc: JSONRPC_VERSION,
            id: request.data.id,
            error: {
              code: RpcErrorCodes.BUSY,
              message: "engine busy; retry later",
              data: {
                reasonCode: this.#accepting ? "rpc-saturated" : "admission-stopped",
                retryAfterMs: 250,
              },
            },
          }),
        ),
      )
        .then(
          () => undefined,
          (error: unknown) => {
            this.#onError(error);
          },
        );
    }

    const task = (async () => {
      const response = line.ok
        ? await this.#dispatcher.dispatch(line.value)
        : this.#dispatcher.parseError();
      if (response !== null) await this.#write(encodeNdjson(response));
    })().catch(this.#onError);
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }
}
