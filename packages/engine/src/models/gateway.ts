import type {
  FrontierAdapter,
  FrontierEvent,
  FrontierPromptHandle,
  FrontierPromptOptions,
  FrontierSession,
} from "../engines/types.js";
import { RpcMethodError } from "../rpc/errors.js";
import type { CostMeter, UsageRecord } from "./meter.js";

export const MAX_ACTIVE_PROVIDER_CALLS = 8;
export const MAX_ACTIVE_CALLS_PER_PROVIDER = 4;
export const MAX_QUEUED_PROVIDER_CALLS = 64;

export interface ProviderGatewayOptions {
  meter: CostMeter;
  maxActive?: number;
  maxActivePerProvider?: number;
  maxQueued?: number;
}

export interface ProviderCallOptions {
  providerId: string;
  signal?: AbortSignal;
  maxRetries?: number;
  retryDelayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  cacheStatus?: "hit" | "miss" | "unknown";
}

export interface ProviderGatewayStats {
  logicalCalls: number;
  attempts: number;
  retries: number;
  cacheHits: number;
  cacheMisses: number;
  active: number;
  queued: number;
}

interface QueuedPermit {
  providerId: string;
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  onAbort?: () => void;
}

function cancelledError(): Error {
  const error = new Error("provider call cancelled");
  error.name = "AbortError";
  return error;
}

function busyError(): RpcMethodError {
  return new RpcMethodError(-32001, "provider gateway busy; retry later", {
    reasonCode: "provider-busy",
    retryAfterMs: 250,
  });
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw cancelledError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(cancelledError());
    };
    signal.addEventListener("abort", abort, { once: true });
    timer.unref?.();
  });
}

/** Central bounded admission, cancellation, retry, and usage seam for model traffic. */
export class ProviderGateway {
  readonly #meter: CostMeter;
  readonly #maxActive: number;
  readonly #maxActivePerProvider: number;
  readonly #maxQueued: number;
  readonly #activeByProvider = new Map<string, number>();
  readonly #queue: QueuedPermit[] = [];
  readonly #frontierAborts = new Set<() => void>();
  readonly #shutdown = new AbortController();
  #accepting = true;
  #active = 0;
  #logicalCalls = 0;
  #attempts = 0;
  #retries = 0;
  #cacheHits = 0;
  #cacheMisses = 0;

  constructor(options: ProviderGatewayOptions) {
    this.#meter = options.meter;
    this.#maxActive = options.maxActive ?? MAX_ACTIVE_PROVIDER_CALLS;
    this.#maxActivePerProvider = options.maxActivePerProvider ?? MAX_ACTIVE_CALLS_PER_PROVIDER;
    this.#maxQueued = options.maxQueued ?? MAX_QUEUED_PROVIDER_CALLS;
    for (const [label, value] of [
      ["maxActive", this.#maxActive],
      ["maxActivePerProvider", this.#maxActivePerProvider],
      ["maxQueued", this.#maxQueued],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
    }
  }

  recordUsage(record: UsageRecord): void {
    this.#meter.record(record);
  }

  stats(): ProviderGatewayStats {
    return {
      logicalCalls: this.#logicalCalls,
      attempts: this.#attempts,
      retries: this.#retries,
      cacheHits: this.#cacheHits,
      cacheMisses: this.#cacheMisses,
      active: this.#active,
      queued: this.#queue.length,
    };
  }

  async execute<T>(
    options: ProviderCallOptions,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!this.#accepting) throw cancelledError();
    this.#logicalCalls += 1;
    if (options.cacheStatus === "hit") this.#cacheHits += 1;
    if (options.cacheStatus === "miss") this.#cacheMisses += 1;
    const signal = options.signal === undefined
      ? this.#shutdown.signal
      : AbortSignal.any([options.signal, this.#shutdown.signal]);
    const retries = options.maxRetries ?? 0;
    for (let attempt = 0; ; attempt += 1) {
      const release = await this.#acquire(options.providerId, signal);
      this.#attempts += 1;
      try {
        if (signal.aborted) throw cancelledError();
        return await operation(signal);
      } catch (error) {
        if (signal.aborted) throw cancelledError();
        const retry = attempt < retries && options.shouldRetry?.(error, attempt) === true;
        if (!retry) throw error;
        this.#retries += 1;
      } finally {
        release();
      }
      await waitForRetry(options.retryDelayMs ?? Math.min(2_000, 250 * 2 ** attempt), signal);
    }
  }

  async createFrontierSession(
    adapter: FrontierAdapter,
    options: Parameters<FrontierAdapter["createSession"]>[0],
  ): Promise<FrontierSession> {
    if (!this.#accepting) throw cancelledError();
    const session = await adapter.createSession(options);
    const gateway = this;
    const sessionAborts = new Set<() => void>();
    return {
      id: session.id,
      projectDir: session.projectDir,
      prompt(text: string, promptOptions?: FrontierPromptOptions): FrontierPromptHandle {
        if (!gateway.#accepting) throw cancelledError();
        const providerId = `frontier:${adapter.kind}`;
        gateway.#logicalCalls += 1;
        const controller = new AbortController();
        let inner: FrontierPromptHandle | undefined;
        let innerAborted = false;
        const abortInner = () => {
          if (inner === undefined || innerAborted) return;
          innerAborted = true;
          inner.abort();
        };
        const setInner = (handle: FrontierPromptHandle) => {
          inner = handle;
          gateway.#frontierAborts.add(abortInner);
          sessionAborts.add(abortInner);
          if (controller.signal.aborted || gateway.#shutdown.signal.aborted) abortInner();
        };
        let release: (() => void) | undefined;
        if (gateway.#accepting && gateway.#canRun(providerId)) {
          release = gateway.#grant(providerId);
          gateway.#attempts += 1;
          try {
            setInner(session.prompt(text, promptOptions));
          } catch (error) {
            release();
            throw error;
          }
        }
        return {
          events: gateway.#frontierEvents(
            providerId,
            session,
            text,
            promptOptions,
            controller.signal,
            setInner,
            () => inner,
            abortInner,
            () => {
              gateway.#frontierAborts.delete(abortInner);
              sessionAborts.delete(abortInner);
            },
            release,
          ),
          abort(): void {
            controller.abort();
            abortInner();
            gateway.#frontierAborts.delete(abortInner);
            sessionAborts.delete(abortInner);
            release?.();
          },
        };
      },
      close: async () => {
        for (const abort of sessionAborts) abort();
        for (const abort of sessionAborts) gateway.#frontierAborts.delete(abort);
        sessionAborts.clear();
        await session.close();
      },
    };
  }

  stopAdmission(): void {
    this.#accepting = false;
  }

  abortAll(): void {
    this.#accepting = false;
    this.#shutdown.abort();
    for (const abort of this.#frontierAborts) abort();
    this.#frontierAborts.clear();
    for (const queued of this.#queue.splice(0)) {
      if (queued.onAbort !== undefined) queued.signal?.removeEventListener("abort", queued.onAbort);
      queued.reject(cancelledError());
    }
  }

  async *#frontierEvents(
    providerId: string,
    session: FrontierSession,
    text: string,
    promptOptions: FrontierPromptOptions | undefined,
    localSignal: AbortSignal,
    setInner: (handle: FrontierPromptHandle) => void,
    getInner: () => FrontierPromptHandle | undefined,
    abortInner: () => void,
    cleanupAbort: () => void,
    admittedRelease?: () => void,
  ): AsyncGenerator<FrontierEvent> {
    const signal = AbortSignal.any([localSignal, this.#shutdown.signal]);
    const release = admittedRelease ?? await this.#acquire(providerId, signal);
    if (admittedRelease === undefined) this.#attempts += 1;
    signal.addEventListener("abort", abortInner, { once: true });
    try {
      if (signal.aborted) throw cancelledError();
      let handle = getInner();
      if (handle === undefined) {
        handle = session.prompt(text, promptOptions);
        setInner(handle);
      }
      for await (const event of handle.events) {
        if (signal.aborted) throw cancelledError();
        yield event;
      }
    } finally {
      signal.removeEventListener("abort", abortInner);
      cleanupAbort();
      release();
    }
  }

  #canRun(providerId: string): boolean {
    return this.#active < this.#maxActive &&
      (this.#activeByProvider.get(providerId) ?? 0) < this.#maxActivePerProvider;
  }

  #grant(providerId: string): () => void {
    this.#active += 1;
    this.#activeByProvider.set(providerId, (this.#activeByProvider.get(providerId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      const next = (this.#activeByProvider.get(providerId) ?? 1) - 1;
      if (next === 0) this.#activeByProvider.delete(providerId);
      else this.#activeByProvider.set(providerId, next);
      this.#drain();
    };
  }

  #acquire(providerId: string, signal: AbortSignal): Promise<() => void> {
    if (!this.#accepting || signal.aborted) return Promise.reject(cancelledError());
    if (this.#canRun(providerId)) return Promise.resolve(this.#grant(providerId));
    if (this.#queue.length >= this.#maxQueued) return Promise.reject(busyError());
    return new Promise((resolve, reject) => {
      const queued: QueuedPermit = { providerId, signal, resolve, reject };
      const onAbort = () => {
        const index = this.#queue.indexOf(queued);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(cancelledError());
      };
      queued.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(queued);
    });
  }

  #drain(): void {
    for (let index = 0; index < this.#queue.length && this.#active < this.#maxActive;) {
      const queued = this.#queue[index]!;
      if (queued.signal?.aborted) {
        this.#queue.splice(index, 1);
        queued.reject(cancelledError());
        continue;
      }
      if (!this.#canRun(queued.providerId)) {
        index += 1;
        continue;
      }
      this.#queue.splice(index, 1);
      if (queued.onAbort !== undefined) queued.signal?.removeEventListener("abort", queued.onAbort);
      queued.resolve(this.#grant(queued.providerId));
    }
  }
}
