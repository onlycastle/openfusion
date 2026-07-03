import type { SymbolHit } from "./store.js";

export interface RankedFile {
  file: string;
  score: number;
  definedSymbols: string[];
}

export function rankFiles(
  symbols: SymbolHit[],
  refs: SymbolHit[],
  options: { damping?: number; iterations?: number } = {},
): RankedFile[] {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 30;

  const definers = new Map<string, string[]>();
  const files = new Set<string>();
  const symbolsByFile = new Map<string, string[]>();
  for (const s of symbols) {
    files.add(s.file);
    (definers.get(s.name) ?? definers.set(s.name, []).get(s.name)!).push(s.file);
    (symbolsByFile.get(s.file) ?? symbolsByFile.set(s.file, []).get(s.file)!).push(s.name);
  }

  // edges: referencing file -> defining file, noise-filtered by defined names
  const outEdges = new Map<string, Map<string, number>>();
  for (const r of refs) {
    const targets = definers.get(r.name);
    if (targets === undefined) continue; // name defined nowhere: noise
    files.add(r.file);
    const out = outEdges.get(r.file) ?? new Map<string, number>();
    outEdges.set(r.file, out);
    const w = 1 / targets.length;
    for (const t of targets) {
      if (t === r.file) continue;
      out.set(t, (out.get(t) ?? 0) + w);
    }
  }

  const n = files.size;
  if (n === 0) return [];
  let rank = new Map<string, number>();
  for (const f of files) rank.set(f, 1 / n);
  for (let i = 0; i < iterations; i += 1) {
    const next = new Map<string, number>();
    for (const f of files) next.set(f, (1 - damping) / n);
    for (const [src, out] of outEdges) {
      const total = [...out.values()].reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      const srcRank = rank.get(src) ?? 0;
      for (const [dst, w] of out) {
        next.set(dst, (next.get(dst) ?? 0) + damping * srcRank * (w / total));
      }
    }
    rank = next;
  }

  return [...files]
    .map((file) => ({
      file,
      score: rank.get(file) ?? 0,
      definedSymbols: [...new Set(symbolsByFile.get(file) ?? [])],
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

export function renderRepoMap(ranked: RankedFile[], budgetTokens: number): string {
  const budgetChars = budgetTokens * 4;
  const lines: string[] = [];
  let used = 0;
  for (const r of ranked) {
    if (r.definedSymbols.length === 0) continue;
    const block = `${r.file}\n  ${r.definedSymbols.slice(0, 8).join(", ")}\n`;
    if (used + block.length > budgetChars) break;
    lines.push(block);
    used += block.length;
  }
  return lines.join("");
}
