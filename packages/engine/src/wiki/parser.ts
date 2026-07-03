import { readFile } from "node:fs/promises";
import path from "node:path";
import { Language, Parser, Query } from "web-tree-sitter";
import { LANGUAGE_SPECS, queriesDir, wasmDir } from "./languages.js";
import type { SymbolEntry } from "./store.js";

export interface ParseResult {
  symbols: SymbolEntry[];
  refs: SymbolEntry[];
}

interface LoadedLanguage {
  id: string;
  language: Language;
  query: Query;
}

// Workaround for web-tree-sitter 0.26.10 / tree-sitter-wasms 0.1.13 incompatibility
// tree-sitter-wasms has "dylink" (6 bytes) but web-tree-sitter expects "dylink.0" (8 bytes)
// We rename "dylink" to "dylink.0" by expanding the buffer and updating size encodings
async function patchWasmDylink(buffer: Buffer): Promise<Uint8Array> {
  const src = new Uint8Array(buffer);

  // Find the dylink custom section: 0x06 followed by "dylink"
  let pos = 9; // After magic(4) + version(4) + section_id(1)

  // Skip LEB128 size bytes
  while (pos < src.length && (src[pos]! & 0x80)) pos++;
  if (pos >= src.length) return src;
  const sizeEndPos = pos + 1;

  // Check for name length = 6
  if (sizeEndPos >= src.length || src[sizeEndPos] !== 0x06) return src;

  // Check for "dylink"
  const nameStart = sizeEndPos + 1;
  if (nameStart + 6 > src.length) return src;

  let isDylink = true;
  const dylink = [0x64, 0x79, 0x6c, 0x69, 0x6e, 0x6b]; // "dylink"
  for (let i = 0; i < 6; i++) {
    if (src[nameStart + i] !== dylink[i]) {
      isDylink = false;
      break;
    }
  }

  if (!isDylink) return src;

  // Found dylink! Now we need to:
  // 1. Read the current section size (positions 9 to sizeEndPos-1)
  // 2. Calculate new size = oldSize + 2 (adding 2 bytes to name)
  // 3. Create new WASM with expanded name
  // 4. Update the section size LEB128 encoding

  // Read old size
  let oldSize = 0, mult = 1;
  for (let i = 9; i < sizeEndPos; i++) {
    oldSize |= (src[i]! & 0x7f) * mult;
    mult *= 128;
  }

  const newSize = oldSize + 2;
  const oldDataStart = nameStart + 6;

  // Encode newSize as LEB128
  const newSizeBytes: number[] = [];
  let sz = newSize;
  do {
    let byte = sz & 0x7f;
    sz >>= 7;
    if (sz !== 0) byte |= 0x80;
    newSizeBytes.push(byte);
  } while (sz !== 0);

  // Build new buffer
  const headerSize = 9;
  const newNameSize = 8;
  const dataSize = src.length - oldDataStart;
  const newLen = headerSize + newSizeBytes.length + 1 + newNameSize + dataSize;
  const result = new Uint8Array(newLen);

  // Copy header (magic + version + section_id)
  result.set(src.slice(0, 9), 0);

  // Write new size
  result.set(new Uint8Array(newSizeBytes), 9);
  let writePos = 9 + newSizeBytes.length;

  // Write new name length (8)
  result[writePos++] = 0x08;

  // Write new name ("dylink.0")
  const newName = [0x64, 0x79, 0x6c, 0x69, 0x6e, 0x6b, 0x2e, 0x30]; // "dylink.0"
  result.set(new Uint8Array(newName), writePos);
  writePos += 8;

  // Copy remaining data
  result.set(src.slice(oldDataStart), writePos);

  return result;
}

export class WikiParser {
  #parser: Parser;
  #byExtension: Map<string, LoadedLanguage>;

  private constructor(parser: Parser, byExtension: Map<string, LoadedLanguage>) {
    this.#parser = parser;
    this.#byExtension = byExtension;
  }

  static async create(): Promise<WikiParser> {
    await Parser.init();
    const parser = new Parser();
    const byExtension = new Map<string, LoadedLanguage>();
    const queryCache = new Map<string, string>();
    const queries = new Map<string, Query>();

    for (const spec of LANGUAGE_SPECS) {
      const wasmPath = path.join(wasmDir(), spec.wasmFile);
      const wasmBuffer = await readFile(wasmPath);

      let language: Language;
      try {
        const patchedWasm = await patchWasmDylink(wasmBuffer);
        language = await Language.load(patchedWasm);
      } catch (error) {
        console.warn(`Warning: Could not load language for ${spec.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      let tags = queryCache.get(spec.queryDir);
      if (tags === undefined) {
        tags = await readFile(
          path.join(queriesDir(), spec.queryDir, "tags.scm"),
          "utf8",
        );
        queryCache.set(spec.queryDir, tags);
      }

      let query: Query | null = null;
      try {
        query = new Query(language, tags);
        queries.set(spec.id, query);
      } catch (error) {
        // Fallback for unsupported doc-directives
        console.warn(`Warning: Could not load query for ${spec.id}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (query !== null) {
        const loaded: LoadedLanguage = { id: spec.id, language, query };
        for (const ext of spec.extensions) byExtension.set(ext, loaded);
      }
    }

    return new WikiParser(parser, byExtension);
  }

  supportedExtensions(): Set<string> {
    return new Set(this.#byExtension.keys());
  }

  languageFor(relPath: string): string | null {
    return this.#byExtension.get(path.extname(relPath))?.id ?? null;
  }

  parseFile(relPath: string, source: string): ParseResult | null {
    const loaded = this.#byExtension.get(path.extname(relPath));
    if (loaded === undefined) return null;
    this.#parser.setLanguage(loaded.language);
    const tree = this.#parser.parse(source);
    if (tree === null) return null;
    try {
      const symbols: SymbolEntry[] = [];
      const refs: SymbolEntry[] = [];
      for (const match of loaded.query.matches(tree.rootNode)) {
        let nameNode: { text: string; startPosition: { row: number; column: number } } | null =
          null;
        let tag: { kind: string; isDefinition: boolean } | null = null;
        for (const capture of match.captures) {
          if (capture.name === "name") {
            nameNode = capture.node;
          } else if (capture.name.startsWith("definition.")) {
            tag = { kind: capture.name.slice("definition.".length), isDefinition: true };
          } else if (capture.name.startsWith("reference.")) {
            tag = { kind: capture.name.slice("reference.".length), isDefinition: false };
          }
        }
        if (nameNode === null || tag === null) continue;
        const entry: SymbolEntry = {
          name: nameNode.text,
          kind: tag.kind,
          row: nameNode.startPosition.row,
          col: nameNode.startPosition.column,
        };
        (tag.isDefinition ? symbols : refs).push(entry);
      }
      return { symbols, refs };
    } finally {
      tree.delete();
    }
  }

  dispose(): void {
    for (const loaded of new Set(this.#byExtension.values())) {
      loaded.query.delete();
    }
    this.#parser.delete();
  }
}
