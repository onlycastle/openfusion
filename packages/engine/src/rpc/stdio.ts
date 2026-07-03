import type { RpcDispatcher } from "./dispatcher.js";
import { encodeNdjson, type DecodedLine } from "./ndjson.js";

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
