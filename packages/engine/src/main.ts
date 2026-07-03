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
  for await (const chunk of process.stdin) {
    for (const line of decoder.push(chunk as string)) {
      pipeline.handleDecoded(line);
    }
  }
  await pipeline.drain();
  await engine.close();
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`fatal: ${detail}\n`);
  process.exitCode = 1;
});
