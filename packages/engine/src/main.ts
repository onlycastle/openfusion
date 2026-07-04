#!/usr/bin/env node
import process from "node:process";
import { createEngine } from "./engine.js";
import { encodeNdjson, NdjsonDecoder } from "./rpc/ndjson.js";
import { StdioPipeline } from "./rpc/stdio.js";
import { createNdjsonWriter } from "./rpc/writer.js";

// stdout carries JSON-RPC only; all diagnostics go to stderr (spec §4.1).
async function main(): Promise<void> {
  // Single write function shared by the StdioPipeline's response writer and
  // engine.notify's server-initiated lines (e.g. frontier.event) — both
  // funnel through this one function so two sources writing to stdout can
  // never interleave a partial ndjson line; each call here always writes
  // exactly one already-newline-terminated line. createNdjsonWriter also
  // makes this respect stdout's backpressure (write() returning false), so a
  // slow/blocked consumer (the Rust EngineBridge falling behind under heavy
  // notification traffic) can't force Node to buffer an unbounded backlog —
  // see writer.ts's header comment.
  const write = createNdjsonWriter(process.stdout);
  const engine = createEngine({
    log: (message) => process.stderr.write(`${message}\n`),
    notify: (method, params) => write(encodeNdjson({ jsonrpc: "2.0", method, params })),
  });
  const decoder = new NdjsonDecoder();
  // Deliberately NOT process.stdin.setEncoding("utf8") here: NdjsonDecoder
  // buffers raw bytes itself (see ndjson.ts) so a multi-byte UTF-8 character
  // split across two stdin `data` chunks reassembles correctly regardless of
  // how stdin happens to chunk the underlying pipe.
  process.stderr.write(`openfusion-engine started (pid ${process.pid})\n`);
  const pipeline = new StdioPipeline(
    engine.dispatcher,
    write,
    (err) => engine.log(`pipeline error: ${err instanceof Error ? err.message : String(err)}`),
  );

  let shuttingDown = false;
  // The shell contract prefers stdin-close for shutdown (below); SIGINT/SIGTERM
  // are the safety net for a caller that kills the process directly instead.
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    engine.frontier.abortAll();
    await pipeline.drain();
    await engine.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    for (const line of decoder.push(chunk)) {
      pipeline.handleDecoded(line);
    }
  }
  // stdin closed: client is gone — same shutdown as a signal (abortAll → drain → close)
  await shutdown();
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`fatal: ${detail}\n`);
  process.exitCode = 1;
});
