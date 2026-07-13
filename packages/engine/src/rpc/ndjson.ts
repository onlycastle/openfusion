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
export const MAX_NDJSON_LINE_BYTES = 8 * 1024 * 1024; // 8 MiB

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
  // True while resyncing past the tail of a message already rejected for
  // being oversized (see the "growing buffer past cap, no newline yet"
  // branch at the bottom of push()). A legitimate-but-oversized single
  // message (e.g. a big diff in a worker.progress notification) doesn't stop
  // sending once its prefix trips the cap — its remaining bytes keep
  // arriving as the tail of the SAME rejected message, across any number of
  // further push() calls, not as fresh input. While this flag is set, push()
  // discards bytes (never buffering them — see below) up to and including
  // the next real newline, which is that rejected message's own terminator;
  // only then does it clear the flag and resume normal line framing on
  // whatever follows. This keeps a single oversized rejection to exactly one
  // diagnostic (emitted at the moment of breach, below) instead of
  // re-tripping the cap on every subsequent oversized chunk, or — once a
  // newline eventually lands inside the tail's garbage bytes — misparsing it
  // as a new, merely-malformed line (a spurious parse-error attributable to
  // a message the engine already rejected).
  #skipping = false;

  constructor(options: NdjsonDecoderOptions = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? MAX_NDJSON_LINE_BYTES;
  }

  push(chunk: Buffer | Uint8Array | string): DecodedLine[] {
    const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.#buffer = this.#buffer.length === 0 ? incoming : Buffer.concat([this.#buffer, incoming]);

    const out: DecodedLine[] = [];

    if (this.#skipping) {
      const newlineIndex = this.#buffer.indexOf(0x0a);
      if (newlineIndex === -1) {
        // Still no terminator for the rejected message: none of these bytes
        // belong to a line we'll ever parse, so drop them immediately rather
        // than retain them — this is what keeps skipping memory-bounded even
        // against a tail that never terminates.
        this.#buffer = Buffer.alloc(0);
        return out;
      }
      // Found the rejected message's real terminator: discard through it
      // (inclusive) and fall through to resume normal framing on whatever
      // follows, all within this same push() call.
      this.#buffer = this.#buffer.subarray(newlineIndex + 1);
      this.#skipping = false;
    }

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
    // no id to recover either way: reject now rather than keep accumulating
    // bytes waiting on a newline that may never arrive. Enter skip mode
    // (rather than just resetting and resuming clean framing at the next
    // byte) so the rest of THIS message's tail — which keeps arriving across
    // however many further push() calls — is discarded as one unit through
    // its own terminating newline, instead of being misparsed as new lines;
    // see #skipping's doc comment above.
    if (this.#buffer.length > this.#maxLineBytes) {
      out.push({ ok: false, oversized: true, discardedBytes: this.#buffer.length });
      this.#buffer = Buffer.alloc(0);
      this.#skipping = true;
    }
    return out;
  }
}

export function encodeNdjson(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
