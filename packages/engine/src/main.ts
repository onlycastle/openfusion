#!/usr/bin/env node
import process from "node:process";
import { createEngine } from "./engine.js";
import { NdjsonDecoder } from "./rpc/ndjson.js";
import { StdioPipeline } from "./rpc/stdio.js";

// stdout carries JSON-RPC only; all diagnostics go to stderr (spec §4.1).
async function main(): Promise<void> {
  const engine = createEngine({
    log: (message) => process.stderr.write(`${message}\n`),
  });
  const decoder = new NdjsonDecoder();
  process.stdin.setEncoding("utf8");
  process.stderr.write(`openfusion-engine started (pid ${process.pid})\n`);
  const pipeline = new StdioPipeline(
    engine.dispatcher,
    (line) => void process.stdout.write(line),
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
