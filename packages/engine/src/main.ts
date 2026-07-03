#!/usr/bin/env node
import process from "node:process";
import { createEngine } from "./engine.js";
import { encodeNdjson, NdjsonDecoder } from "./rpc/ndjson.js";
import { StdioPipeline } from "./rpc/stdio.js";

// stdout carries JSON-RPC only; all diagnostics go to stderr (spec §4.1).
async function main(): Promise<void> {
  // Single write function shared by the StdioPipeline's response writer and
  // engine.notify's server-initiated lines (e.g. frontier.event) — both
  // funnel through this one function so two sources writing to stdout can
  // never interleave a partial ndjson line; each call here always writes
  // exactly one already-newline-terminated line.
  const write = (line: string) => void process.stdout.write(line);
  const engine = createEngine({
    log: (message) => process.stderr.write(`${message}\n`),
    notify: (method, params) => write(encodeNdjson({ jsonrpc: "2.0", method, params })),
  });
  const decoder = new NdjsonDecoder();
  process.stdin.setEncoding("utf8");
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

  for await (const chunk of process.stdin) {
    for (const line of decoder.push(chunk as string)) {
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
