// M7b Task 2: engine-side cancellation of long engine.orchestrate /
// engine.evals.run RPC calls, via a new engine.cancel { runId } method.
//
// KEY INVARIANT (read before touching any call site): only the OUTERMOST RPC
// handler that MINTS a runId — engine.orchestrate's own handler
// (orchestrate/methods.ts) and engine.evals.run's own handler
// (evals/methods.ts) — ever calls register()/deregister(). Every nested call
// that merely RECEIVES the same runId string (the internal orchestrate()
// pipeline function, engine.worker.run's handler, runEvals's per-task loop)
// only ever calls the read-only get(). This is what lets a runId threaded
// down through nested calls (evals.run -> orchestrate() -> engine.worker.run)
// always resolve to the SAME AbortController, so engine.cancel({runId})
// reaches whichever sub-operation is currently in flight, however deep —
// without any nested layer accidentally re-registering (and thereby
// orphaning) its own controller.
import { z } from "zod";
import type { Engine } from "../engine.js";
import { registerMethod } from "./register.js";

// Thrown the instant a cancellable sub-operation notices its own abortSignal
// fired. A distinct type mainly so a cancellation reads clearly in a stack
// trace / test failure — the actual "was this run cancelled" determination
// everywhere in this codebase is done by checking the resolved cancelSignal's
// own `.aborted` flag (mirrors worker/methods.ts's existing
// timeoutSignal.aborted / controller.signal.aborted convention), not
// `instanceof RunCancelledError`, so it stays robust even if some
// intermediate call wraps/rethrows a different error.
export class RunCancelledError extends Error {
  constructor() {
    super("run cancelled");
    this.name = "RunCancelledError";
  }
}

const CancelParamsSchema = z.object({ runId: z.string().min(1) });

// runId (string) -> AbortController, plus the engine.cancel RPC method
// itself. See this module's header comment for the register/get ownership
// split every call site must respect.
export class CancelRegistry {
  #controllers = new Map<string, AbortController>();

  // Called ONLY by the outermost RPC handler that owns a runId's lifecycle
  // (engine.orchestrate's / engine.evals.run's own handler).
  register(runId: string): AbortController {
    const controller = new AbortController();
    this.#controllers.set(runId, controller);
    return controller;
  }

  // Read-only lookup — every nested call (the orchestrate() pipeline
  // function, engine.worker.run's handler, runEvals's per-task loop) uses
  // only this, never register()/deregister().
  get(runId: string): AbortController | undefined {
    return this.#controllers.get(runId);
  }

  // Paired with register(), in the owning handler's own `finally` — success,
  // failure, or cancellation — or this map leaks an entry for the life of the
  // process.
  deregister(runId: string): void {
    this.#controllers.delete(runId);
  }

  // engine.cancel's primitive: aborts the named run and returns true, or —
  // unknown / already-finished (deregistered) runId — returns false WITHOUT
  // throwing. A cancel racing a run's own natural completion is harmless:
  // nothing is listening to an already-settled run's signal by the time this
  // fires.
  cancel(runId: string): boolean {
    const controller = this.#controllers.get(runId);
    if (controller === undefined) return false;
    controller.abort(new RunCancelledError());
    return true;
  }

  // Testability: should return to 0 once every run this registry has ever
  // seen has completed — the "no leak" property this task requires.
  size(): number {
    return this.#controllers.size;
  }
}

export function registerCancelMethod(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.cancel", CancelParamsSchema, (params) => {
    const cancelled = engine.cancelRegistry.cancel(params.runId);
    engine.log(`cancel ${params.runId}: ${cancelled ? "aborted" : "unknown or already finished"}`);
    return { cancelled };
  });
}
