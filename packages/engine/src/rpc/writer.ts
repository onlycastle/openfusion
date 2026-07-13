import type { Writable } from "node:stream";

export const MAX_BUFFERED_OUTBOUND_BYTES = 4 * 1024 * 1024;

interface QueueEntry {
  line: string;
  bytes: number;
  terminal: boolean;
  key?: string;
  resolve?: () => void;
}

interface CapacityWaiter {
  entry: QueueEntry;
}

export type NdjsonWriter = ((line: string) => Promise<void>) & {
  /** Progress/observer data may be coalesced or dropped under pressure. */
  notification(line: string, key?: string): boolean;
  whenIdle(): Promise<void>;
  bufferedBytes(): number;
  droppedNotifications(): number;
};

export interface NdjsonWriterOptions {
  onError?: (err: unknown) => void;
  onQueueWarning?: (bufferedBytes: number) => void;
  maxBufferedBytes?: number;
  /** Legacy test/diagnostic threshold; byte caps remain authoritative. */
  queueWarnThreshold?: number;
}

/**
 * One ordered stdout writer with byte-bounded application buffering.
 * Terminal JSON-RPC responses wait for capacity and are never dropped;
 * observer notifications are coalesced by key or dropped when the cap is
 * reached. Awaiting overload responses naturally propagates backpressure to
 * stdin through StdioPipeline.
 */
export function createNdjsonWriter(
  stream: Writable,
  options: NdjsonWriterOptions = {},
): NdjsonWriter {
  const limit = options.maxBufferedBytes ?? MAX_BUFFERED_OUTBOUND_BYTES;
  const queue: QueueEntry[] = [];
  const capacityWaiters: CapacityWaiter[] = [];
  const idleWaiters: Array<() => void> = [];
  let bufferedBytes = 0;
  let pendingWriteBytes = 0;
  let draining = false;
  let broken = false;
  let warned = false;
  let dropped = 0;
  const warnForPressure = (force = false): void => {
    if (warned) return;
    const legacyThreshold = options.queueWarnThreshold;
    if (legacyThreshold === undefined && !force) return;
    if (legacyThreshold !== undefined && queue.length < legacyThreshold) return;
    warned = true;
    options.onQueueWarning?.(legacyThreshold === undefined ? bufferedBytes : queue.length);
  };

  const isIdle = (): boolean =>
    broken || (queue.length === 0 && capacityWaiters.length === 0 && pendingWriteBytes === 0);

  const settleIdle = (): void => {
    if (!isIdle()) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  };

  const markBroken = (error: unknown): void => {
    if (broken) return;
    broken = true;
    for (const entry of queue.splice(0)) entry.resolve?.();
    for (const waiter of capacityWaiters.splice(0)) waiter.entry.resolve?.();
    bufferedBytes = 0;
    options.onError?.(error);
    settleIdle();
  };

  stream.on("error", markBroken);

  const canFit = (entry: QueueEntry): boolean =>
    bufferedBytes + entry.bytes <= limit || (bufferedBytes === 0 && entry.bytes > limit);

  const admitWaitingTerminals = (): void => {
    while (capacityWaiters.length > 0 && canFit(capacityWaiters[0]!.entry)) {
      const { entry } = capacityWaiters.shift()!;
      queue.push(entry);
      bufferedBytes += entry.bytes;
      entry.resolve?.();
    }
  };

  const pump = (): void => {
    if (broken || draining) return;
    admitWaitingTerminals();
    while (queue.length > 0) {
      const entry = queue.shift()!;
      bufferedBytes -= entry.bytes;
      pendingWriteBytes += entry.bytes;
      let writable: boolean;
      try {
        writable = stream.write(entry.line, () => {
          pendingWriteBytes -= entry.bytes;
          admitWaitingTerminals();
          pump();
          settleIdle();
        });
      } catch (error) {
        pendingWriteBytes -= entry.bytes;
        entry.resolve?.();
        markBroken(error);
        return;
      }
      if (!writable) {
        draining = true;
        stream.once("drain", () => {
          draining = false;
          admitWaitingTerminals();
          pump();
        });
        return;
      }
      admitWaitingTerminals();
    }
    settleIdle();
  };

  const writeTerminal = ((line: string): Promise<void> => {
    if (broken) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const entry: QueueEntry = {
        line,
        bytes: Buffer.byteLength(line, "utf8"),
        terminal: true,
        resolve,
      };
      if (canFit(entry) && capacityWaiters.length === 0) {
        queue.push(entry);
        bufferedBytes += entry.bytes;
        resolve();
      } else {
        capacityWaiters.push({ entry });
        warnForPressure(true);
      }
      warnForPressure();
      pump();
    });
  }) as NdjsonWriter;

  writeTerminal.notification = (line: string, key?: string): boolean => {
    if (broken) return false;
    const bytes = Buffer.byteLength(line, "utf8");
    if (key !== undefined) {
      const existing = queue.find((entry) => !entry.terminal && entry.key === key);
      if (existing !== undefined) {
        if (bufferedBytes - existing.bytes + bytes <= limit) {
          bufferedBytes += bytes - existing.bytes;
          existing.line = line;
          existing.bytes = bytes;
          return true;
        }
        dropped += 1;
        return false;
      }
    }
    if (bufferedBytes + bytes > limit) {
      dropped += 1;
      warnForPressure(true);
      return false;
    }
    queue.push({ line, bytes, terminal: false, ...(key === undefined ? {} : { key }) });
    bufferedBytes += bytes;
    warnForPressure();
    pump();
    return true;
  };

  writeTerminal.whenIdle = (): Promise<void> => {
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  };
  writeTerminal.bufferedBytes = () => bufferedBytes;
  writeTerminal.droppedNotifications = () => dropped;
  return writeTerminal;
}
