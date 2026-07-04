import type { Writable } from "node:stream";

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
export function createNdjsonWriter(stream: Writable): (line: string) => void {
  const queue: string[] = [];
  let draining = false;

  const pump = (): void => {
    if (draining) return;
    while (queue.length > 0) {
      const line = queue[0]!;
      const ok = stream.write(line);
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
  };

  return (line: string): void => {
    queue.push(line);
    pump();
  };
}
