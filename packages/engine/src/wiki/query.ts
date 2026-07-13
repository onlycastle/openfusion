// Shared, pure read-helpers over an already-open WikiStore (Task 7).
// Extracted verbatim from mcp.ts's wiki_query/wiki_map tool bodies so both
// the MCP server (mcp.ts) and the in-process worker toolset
// (worker/tools.ts) share one implementation instead of two copies that can
// drift. Deliberately NOT responsible for the "wiki not built" guard: each
// caller keeps its own — mcp.ts still returns notBuiltResult() itself, and
// worker/methods.ts only ever constructs ctx.wiki once it has already
// confirmed the wiki is built (see that module's wiring).
import { rankFiles, renderRepoMap } from "./rank.js";
import type { SymbolHit, WikiStore } from "./store.js";

export function querySymbols(
  store: WikiStore,
  symbol: string,
): { definitions: SymbolHit[]; references: SymbolHit[] } {
  return {
    definitions: store.symbolsByName(symbol),
    references: store.refsByName(symbol),
  };
}

export interface RepositoryMapResult {
  map: string;
  files: number;
  renderable: number;
  rendered: number;
  matchedFiles: number;
}

export function buildRepositoryMap(
  store: WikiStore,
  options: { budgetTokens?: number; query?: string } = {},
): RepositoryMapResult {
  const query = options.query?.trim();
  const searchHits = query === undefined || query.length === 0 ? [] : store.searchFiles(query);
  const personalization = new Map(searchHits.map((hit) => [hit.file, hit.score]));
  const ranked = rankFiles(store.allSymbols(), store.allRefs(), {
    ...(personalization.size > 0 ? { personalization } : {}),
  });
  const map = renderRepoMap(ranked, options.budgetTokens ?? 1024);
  const renderable = ranked.filter(
    (entry) => entry.definedSymbols.length > 0 || (entry.taskRelevance ?? 0) > 0,
  ).length;
  const rendered =
    map.length === 0
      ? 0
      : map.split("\n").filter((line) => !line.startsWith("  ") && line.length > 0).length;
  return {
    map,
    files: ranked.length,
    renderable,
    rendered,
    matchedFiles: personalization.size,
  };
}

// budgetTokens defaults to 1024, matching the MCP tool's own prior default
// (mcp.ts's `budgetTokens ?? 1024`).
export function renderMap(store: WikiStore, budgetTokens = 1024, query?: string): string {
  return buildRepositoryMap(store, {
    budgetTokens,
    ...(query === undefined ? {} : { query }),
  }).map;
}
