import type { FrontierRoleSelections, FrontierSelection } from "./engineClient";

const STORAGE_KEY = "openfusion.frontier-role-selections.v1";

export const DEFAULT_FRONTIER_ROLE_SELECTIONS: FrontierRoleSelections = {
  planning: { engine: "claude-code", model: "default" },
  review: { engine: "claude-code", model: "default" },
  escalation: { engine: "claude-code", model: "default" },
  baseline: { engine: "claude-code", model: "default" },
};

function isSelection(value: unknown): value is FrontierSelection {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FrontierSelection>;
  return (
    (candidate.engine === "claude-code" || candidate.engine === "codex") &&
    (candidate.model === undefined || (typeof candidate.model === "string" && candidate.model.length > 0))
  );
}

export function loadFrontierRoleSelections(): FrontierRoleSelections {
  if (typeof window === "undefined") return DEFAULT_FRONTIER_ROLE_SELECTIONS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_FRONTIER_ROLE_SELECTIONS;
    const parsed = JSON.parse(raw) as Partial<FrontierRoleSelections>;
    return {
      planning: isSelection(parsed.planning) ? parsed.planning : DEFAULT_FRONTIER_ROLE_SELECTIONS.planning,
      review: isSelection(parsed.review) ? parsed.review : DEFAULT_FRONTIER_ROLE_SELECTIONS.review,
      escalation: isSelection(parsed.escalation) ? parsed.escalation : DEFAULT_FRONTIER_ROLE_SELECTIONS.escalation,
      baseline: isSelection(parsed.baseline) ? parsed.baseline : DEFAULT_FRONTIER_ROLE_SELECTIONS.baseline,
    };
  } catch {
    return DEFAULT_FRONTIER_ROLE_SELECTIONS;
  }
}

export function saveFrontierRoleSelections(selections: FrontierRoleSelections): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selections));
  } catch {
    // A privacy-restricted webview may deny local storage. Keep the in-memory
    // selection usable for this mounted settings session.
  }
}

export function frontierSelectionValue(selection: FrontierSelection): string {
  return `${selection.engine}:${selection.model ?? ""}`;
}

export function parseFrontierSelectionValue(value: string): FrontierSelection | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const engine = value.slice(0, separator);
  const model = value.slice(separator + 1);
  if (engine !== "claude-code" && engine !== "codex") return null;
  return { engine, ...(model.length > 0 ? { model } : {}) };
}
