import type { Writable } from "node:stream";

/**
 * A line-writing function with two extra capabilities beyond plain
 * `(line: string) => void`: `whenIdle()` lets a caller wait for the outbound
 * queue to fully drain (see `whenIdle`'s own doc below), used by main.ts's
 * shutdown to avoid truncating notifications still in flight. It's modeled
 * as a callable function carrying an extra method (rather than a `{ write,
 * whenIdle }` object) so existing call sites that just need
 * `(line: string) => void` (engine.notify, StdioPipeline's response writer)
 * keep working unchanged.
 */
export type NdjsonWriter = ((line: string) => void) & {
  whenIdle(): Promise<void>;
};

export interface NdjsonWriterOptions {
  /**
   * Called when the underlying stream becomes unusable (stream.write()
   * threw synchronously, or the stream emitted 'error' — both cases Node
   * uses to signal a broken pipe, e.g. EPIPE after the Rust host process
   * died and closed its end). Receives the raw error for logging as
   * metadata (message/class) — never log queued line content here.
   */
  onError?: (err: unknown) => void;
  /**
   * Called at most once, the first time the pending queue length reaches
   * `queueWarnThreshold` — production visibility into a slow/stalled
   * consumer. Receives the queue length only (metadata, never content).
   */
  onQueueWarning?: (queueLength: number) => void;
  /** Defaults to 10_000 pending lines. */
  queueWarnThreshold?: number;
}

/**
 * Wraps a Writable (stdout in production) so ndjson lines are written
 * respecting the stream's own backpressure signal.
 *
 * `Writable.write()` returning `false` means "the internal buffer is over
 * its highWaterMark — please wait for 'drain' before writing more." Ignoring
 * that signal and calling `write()` again anyway doesn't corrupt or drop
 * data (Node still queues each chunk faithfully, in order), but it does mean
 * every line we've handed to a slow/blocked consumer (e.g. the Rust
 * EngineBridge's stdout reader falling behind under heavy notification
 * traffic) piles up invisibly inside Node's stream internals with nothing
 * pacing it — an unbounded-buffering-via-slow-consumer variant of the same
 * memory risk the ndjson line cap closes on the read side.
 *
 * This writer instead keeps its own explicit FIFO queue: lines are written
 * to the underlying stream one at a time, and as soon as `write()` reports
 * backpressure, no further `stream.write()` calls happen until `'drain'`
 * fires. Queued lines are flushed strictly in arrival order, so a slow
 * consumer still receives every line, in order, uncorrupted — it just
 * naturally paces how fast the backlog grows instead of leaving Node to
 * buffer an unbounded amount on our behalf.
 */
export function createNdjsonWriter(
  stream: Writable,
  options: NdjsonWriterOptions = {},
): NdjsonWriter {
  /**
   * The pending-lines FIFO. Deliberately unbounded — an ACCEPTED tradeoff,
   * not an oversight: the alternative (dropping or capping) would lose or
   * reorder notifications, and letting Node's own internal stream buffer
   * grow instead (by ignoring backpressure — see the class doc above) has
   * the same unbounded-memory shape anyway without this queue's ordering
   * guarantee. A genuinely stuck consumer is a host-health problem outside
   * this module's remit; `queueWarnThreshold`/`onQueueWarning` below exist so
   * that condition is at least observable (stderr metadata, not a silent
   * leak) rather than attempting a fix (dropping messages) that would be
   * worse than the disease.
   */
  const queue: string[] = [];
  let draining = false;
  // Set once the underlying stream is confirmed unusable (write() threw, or
  // an 'error' event fired — both are how Node surfaces a broken pipe, e.g.
  // EPIPE after the host process died). Once broken, we stop calling
  // stream.write() entirely: the host is gone, so there is nothing to
  // deliver to and no point retrying (that would just be a crash-loop).
  let broken = false;
  let pendingWriteCount = 0;
  let warned = false;
  const queueWarnThreshold = options.queueWarnThreshold ?? 10_000;
  const idleWaiters: Array<() => void> = [];

  const isIdle = (): boolean => broken || (queue.length === 0 && pendingWriteCount === 0);

  const settleIfIdle = (): void => {
    if (!isIdle()) return;
    while (idleWaiters.length > 0) {
      idleWaiters.shift()!();
    }
  };

  const markBroken = (err: unknown): void => {
    if (broken) return;
    broken = true;
    // Nothing queued after this point can be delivered either — the pipe is
    // gone — so there's no data-loss tradeoff in dropping it, only in
    // pretending we could still deliver it.
    queue.length = 0;
    options.onError?.(err);
    settleIfIdle();
  };

  stream.on("error", (err) => markBroken(err));

  const pump = (): void => {
    if (broken || draining) return;
    while (queue.length > 0) {
      const line = queue[0]!;
      pendingWriteCount++;
      let ok: boolean;
      try {
        ok = stream.write(line, () => {
          pendingWriteCount--;
          settleIfIdle();
        });
      } catch (err) {
        // Node can throw synchronously from write() on a dead fd (EPIPE)
        // rather than (or in addition to) emitting 'error'.
        pendingWriteCount--;
        markBroken(err);
        return;
      }
      queue.shift();
      if (!ok) {
        draining = true;
        stream.once("drain", () => {
          draining = false;
          pump();
        });
        return;
      }
    }
    settleIfIdle();
  };

  const write = ((line: string): void => {
    if (broken) return; // host is gone; drop silently rather than grow forever
    queue.push(line);
    if (!warned && queue.length >= queueWarnThreshold) {
      warned = true;
      options.onQueueWarning?.(queue.length);
    }
    pump();
  }) as NdjsonWriter;

  /**
   * Resolves once every currently-queued line has been handed to the stream
   * AND that last write's own completion callback has fired (i.e. Node's
   * stream machinery has actually flushed it, not merely accepted it into
   * this module's FIFO) — or immediately if the stream is already broken,
   * since nothing further can be flushed to it either way. Used by
   * main.ts's shutdown to avoid exiting mid-flush and truncating
   * notifications still in the queue.
   */
  write.whenIdle = (): Promise<void> => {
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  };

  return write;
}
