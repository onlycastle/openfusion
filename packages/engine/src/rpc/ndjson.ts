import { Buffer } from "node:buffer";

/**
 * Per-line byte cap enforced by NdjsonDecoder (see below). 32 MiB comfortably
 * fits legitimate large single-line payloads this transport carries today
 * (e.g. a big diff embedded in worker.progress params, or a large
 * engine.models.complete response) while still bounding the worst case: a
 * client that never sends a newline — or that keeps one "line" growing
 * forever — cannot force this process to keep buffering bytes indefinitely
 * (the OOM-via-giant-line DoS this cap exists to close). Exported so callers
 * (and tests) can reference the exact number rather than a magic constant.
 */
export const MAX_NDJSON_LINE_BYTES = 32 * 1024 * 1024; // 32 MiB

export interface NdjsonDecoderOptions {
  /** Overrides MAX_NDJSON_LINE_BYTES — tests use a small value to exercise the cap cheaply. */
  maxLineBytes?: number;
}

export type DecodedLine =
  | { ok: true; value: unknown }
  | { ok: false; oversized: false; raw: string }
  // No `raw` here on purpose: a line this reader rejects for being oversized
  // is, by construction, never fully retained — see NdjsonDecoder.push's
  // header comment. `discardedBytes` is metadata only (never the content).
  | { ok: false; oversized: true; discardedBytes: number };

/**
 * Splits an incoming byte stream into ndjson lines, one parsed JSON value
 * (or parse failure) per line.
 *
 * Buffers raw bytes, not strings: a chunk boundary can legally fall in the
 * middle of a multi-byte UTF-8 character (e.g. stdin delivering a request
 * whose JSON string contains non-ASCII text, split across two `data`
 * events). Decoding each chunk independently (`chunk.toString()`) would
 * corrupt that character into U+FFFD on each side of the split. Because a
 * JSON-encoded string can never contain a raw 0x0A byte (RFC 8259 requires
 * control characters, including newline, to be escaped inside JSON strings),
 * scanning the raw byte buffer for 0x0A to find line boundaries is safe even
 * before we know the line is valid JSON — so we only decode a line to a
 * string (via one strict UTF-8 `toString`) once we hold its complete bytes.
 *
 * CRLF tolerance: a trailing `\r` right before the `\n` is stripped by the
 * final `.trim()` (JS's definition of whitespace for `.trim()` includes
 * `\r`), so a `\r\n`-terminated line parses identically to a bare `\n` one.
 */
export class NdjsonDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  readonly #maxLineBytes: number;

  constructor(options: NdjsonDecoderOptions = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? MAX_NDJSON_LINE_BYTES;
  }

  push(chunk: Buffer | Uint8Array | string): DecodedLine[] {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.#buffer = this.#buffer.length === 0 ? incoming : Buffer.concat([this.#buffer, incoming]);

    const out: DecodedLine[] = [];
    let newlineIndex = this.#buffer.indexOf(0x0a);
    while (newlineIndex !== -1) {
      if (newlineIndex > this.#maxLineBytes) {
        // A complete line arrived (we found its terminating newline) but its
        // body alone already exceeds the cap. Reject it — don't spend effort
        // parsing a policy-violating multi-megabyte blob just to try to
        // recover its id — and move on to whatever follows in the buffer.
        out.push({ ok: false, oversized: true, discardedBytes: newlineIndex });
      } else {
        const line = this.#buffer.subarray(0, newlineIndex).toString("utf8").trim();
        if (line.length > 0) {
          try {
            out.push({ ok: true, value: JSON.parse(line) });
          } catch {
            out.push({ ok: false, oversized: false, raw: line });
          }
        }
      }
      this.#buffer = this.#buffer.subarray(newlineIndex + 1);
      newlineIndex = this.#buffer.indexOf(0x0a);
    }

    // What's left has no newline yet — it's the partial start of the next
    // line. If it has already grown past the cap, there is no telling
    // whether (or when) a terminating newline will ever show up, so there is
    // no id to recover either way: reject now and reset rather than keep
    // accumulating bytes waiting on a newline that may never arrive.
    if (this.#buffer.length > this.#maxLineBytes) {
      out.push({ ok: false, oversized: true, discardedBytes: this.#buffer.length });
      this.#buffer = Buffer.alloc(0);
    }
    return out;
  }
}

export function encodeNdjson(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
