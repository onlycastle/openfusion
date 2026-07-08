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

// budgetTokens defaults to 1024, matching the MCP tool's own prior default
// (mcp.ts's `budgetTokens ?? 1024`).
export function renderMap(store: WikiStore, budgetTokens = 1024): string {
  const ranked = rankFiles(store.allSymbols(), store.allRefs());
  return renderRepoMap(ranked, budgetTokens);
}
