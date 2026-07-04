import { z } from "zod";

// engine.wiki.build's progress notification payload (M7c Task 1 — the M7b-
// flagged gap: engine.wiki.build previously emitted no progress at all,
// unlike engine.orchestrate/engine.evals.run's own `orchestrate.progress`/
// `evals.progress` notifications). The engine emits `wiki.build.progress`
// notifications with this exact shape (via `engine.notify`) while a build is
// in flight — see packages/engine/src/wiki/indexer.ts (the actual indexing
// loop, which owns the emit cadence) and packages/engine/src/wiki/methods.ts
// (which wires the callback into `engine.notify`).
//
// `projectDir` echoes back EXACTLY the projectDir string the caller invoked
// `engine.wiki.build` with — never a canonicalized/resolved path — so a
// subscriber's own filter can compare it against whatever it itself passed
// in (the desktop app's ProjectScreen does exactly this: it compares
// `params.projectDir === projectDirRef.current`, where `projectDirRef`
// holds the raw path from the native directory picker).
//
// `detail` is a short, human-readable phase/count string, e.g.
// "indexed 42/120 files" — a PATH or COUNT, NEVER file contents. Callers
// must not assume any particular cadence beyond "bounded, not one
// notification per file for a large repo" — see indexer.ts's own doc
// comment for the exact interval.
//
// SHARED-TYPE HOME NOTE: this lives in @openfusion/shared (rather than only
// engine-side) because the engine already depends on this package for its
// JSON-RPC envelope schemas, so defining it here costs no new dependency
// edge. The desktop app (apps/desktop) does NOT currently depend on
// @openfusion/shared, so it does not import this type today — its
// ProjectScreen.tsx mirrors the shape with its own loose inline cast
// (`{ projectDir?: string; detail?: string }`). Wiring an actual import is
// left as a future UI-side change; this package is where it should come
// from once that happens.
export const WikiBuildProgressSchema = z.object({
  projectDir: z.string().min(1),
  detail: z.string().min(1),
});

export type WikiBuildProgress = z.infer<typeof WikiBuildProgressSchema>;
