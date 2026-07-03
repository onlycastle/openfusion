import type { RpcDispatcher } from "./dispatcher.js";
import { encodeNdjson, type DecodedLine } from "./ndjson.js";

/**
 * StdioPipeline: JSON-RPC 2.0 over stdio in ndjson encoding.
 *
 * Concurrency ownership: the client owns bounding of in-flight expensive calls
 * (engine.models.complete, engine.frontier.prompt). The pipeline itself is
 * intentionally uncapped — responses flow in completion order, allowing parallel
 * requests to finish out-of-order while the dispatcher batches independently.
 * This design (M2 final review) trades unbounded memory for simpler state
 * management and natural task-parallelism (e.g., multiple model completions
 * starting and finishing at different rates within a single frontier session).
 */
export class StdioPipeline {
  #dispatcher: RpcDispatcher;
  #write: (line: string) => void;
  #onError: (err: unknown) => void;
  #pending = new Set<Promise<void>>();

  constructor(
    dispatcher: RpcDispatcher,
    write: (line: string) => void,
    onError: (err: unknown) => void = () => {},
  ) {
    this.#dispatcher = dispatcher;
    this.#write = write;
    this.#onError = onError;
  }

  handleDecoded(line: DecodedLine): void {
    const task = (async () => {
      const response = line.ok
        ? await this.#dispatcher.dispatch(line.value)
        : this.#dispatcher.parseError();
      if (response !== null) {
        this.#write(encodeNdjson(response));
      }
    })().catch((err: unknown) => {
      // dispatch() converts handler errors to responses; this guards the pipeline itself.
      this.#onError(err);
    });
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }
}
