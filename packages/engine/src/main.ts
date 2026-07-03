#!/usr/bin/env node
import process from "node:process";
import { createEngine } from "./engine.js";
import { NdjsonDecoder, encodeNdjson } from "./rpc/ndjson.js";

// stdout carries JSON-RPC only; all diagnostics go to stderr (spec §4.1).
async function main(): Promise<void> {
  const dispatcher = createEngine();
  const decoder = new NdjsonDecoder();
  process.stdin.setEncoding("utf8");
  process.stderr.write(`openfusion-engine started (pid ${process.pid})\n`);
  for await (const chunk of process.stdin) {
    for (const line of decoder.push(chunk as string)) {
      const response = line.ok
        ? await dispatcher.dispatch(line.value)
        : dispatcher.parseError();
      if (response !== null) {
        process.stdout.write(encodeNdjson(response));
      }
    }
  }
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`fatal: ${detail}\n`);
  process.exitCode = 1;
});
