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
