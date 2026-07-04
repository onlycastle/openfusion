import { readFile } from "node:fs/promises";
import path from "node:path";
import { Language, Parser, Query } from "web-tree-sitter";
import { isPackagedSidecar, packagedAssetPath } from "../util/sidecar-runtime.js";
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

export class WikiParser {
  #parser: Parser;
  #byExtension: Map<string, LoadedLanguage>;

  private constructor(parser: Parser, byExtension: Map<string, LoadedLanguage>) {
    this.#parser = parser;
    this.#byExtension = byExtension;
  }

  static async create(): Promise<WikiParser> {
    // Compiled-sidecar case: Parser.init() loads tree-sitter's own core
    // runtime wasm (distinct from the per-language grammar wasm files
    // Language.load() takes an explicit path for below) via an Emscripten
    // `locateFile` hook that defaults to resolving next to `import.meta.url`
    // — meaningless once bundled/compiled (see wasmDir()'s doc comment).
    // build-sidecar.mjs copies the real file to
    // "<binary>.assets/wasm/web-tree-sitter.wasm".
    await Parser.init(
      isPackagedSidecar()
        ? { locateFile: (fileName: string) => packagedAssetPath("wasm", fileName) }
        : undefined,
    );
    const parser = new Parser();
    const byExtension = new Map<string, LoadedLanguage>();
    const queryCache = new Map<string, string>();
    for (const spec of LANGUAGE_SPECS) {
      const language = await Language.load(path.join(wasmDir(), spec.wasmFile));
      let tags = queryCache.get(spec.queryDir);
      if (tags === undefined) {
        tags = await readFile(
          path.join(queriesDir(), spec.queryDir, "tags.scm"),
          "utf8",
        );
        queryCache.set(spec.queryDir, tags);
      }
      const query = new Query(language, tags);
      const loaded: LoadedLanguage = { id: spec.id, language, query };
      for (const ext of spec.extensions) byExtension.set(ext, loaded);
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
      const seenSymbols = new Set<string>();
      const seenRefs = new Set<string>();
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
        const isDefinition = tag.isDefinition;
        const seen = isDefinition ? seenSymbols : seenRefs;
        const key = `${entry.name}\0${entry.row}\0${entry.col}`;
        if (seen.has(key)) continue;
        seen.add(key);
        (isDefinition ? symbols : refs).push(entry);
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
