export type DecodedLine =
  | { ok: true; value: unknown }
  | { ok: false; raw: string };

export class NdjsonDecoder {
  #buffer = "";

  push(chunk: string): DecodedLine[] {
    this.#buffer += chunk;
    const out: DecodedLine[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.#buffer.slice(0, newlineIndex).trim();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          out.push({ ok: true, value: JSON.parse(line) });
        } catch {
          out.push({ ok: false, raw: line });
        }
      }
      newlineIndex = this.#buffer.indexOf("\n");
    }
    return out;
  }
}

export function encodeNdjson(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
