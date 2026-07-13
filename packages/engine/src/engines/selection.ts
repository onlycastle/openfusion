import { z } from "zod";

/** A concrete frontier runtime plus an optional runtime-owned model id. */
export const FrontierSelectionSchema = z.object({
  engine: z.string().min(1),
  model: z.string().min(1).optional(),
});
export type FrontierSelection = z.infer<typeof FrontierSelectionSchema>;

export const OrchestrateFrontierSelectionsSchema = z.object({
  review: FrontierSelectionSchema.optional(),
  escalation: FrontierSelectionSchema.optional(),
});
export type OrchestrateFrontierSelections = z.infer<typeof OrchestrateFrontierSelectionsSchema>;

export const EvalsFrontierSelectionsSchema = OrchestrateFrontierSelectionsSchema.extend({
  baseline: FrontierSelectionSchema.optional(),
});
export type EvalsFrontierSelections = z.infer<typeof EvalsFrontierSelectionsSchema>;

export const DEFAULT_FRONTIER_SELECTION: FrontierSelection = { engine: "claude-code" };

export function resolveFrontierSelection(selection: FrontierSelection | undefined): FrontierSelection {
  return selection ?? DEFAULT_FRONTIER_SELECTION;
}
