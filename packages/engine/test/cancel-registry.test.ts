// M7c Task 5 (M7b Minor): CancelRegistry.register used to silently CLOBBER
// on a duplicate runId -- two engine.orchestrate/engine.evals.run calls
// racing on the SAME client-supplied runId would leave the first run's
// AbortController orphaned in the registry's own Map (the second register()
// call's `.set()` overwrites the first entry), so the first run's own
// engine.cancel({runId}) could never reach it again: an uncancellable run
// hiding behind a runId that LOOKS registered. This suite tests the fix in
// isolation (CancelRegistry alone, no Engine/dispatcher needed) -- the outer
// RPC handlers (orchestrate/methods.ts's and evals/methods.ts's own
// register() call sites) simply propagate whatever register() now throws,
// so a duplicate-runId call fails fast as a SERVER_ERROR instead of silently
// stealing the first run's controller.
import { describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { CancelRegistry } from "../src/rpc/cancel-registry.js";
import { RpcMethodError } from "../src/rpc/errors.js";

describe("CancelRegistry.register — duplicate runId rejection", () => {
  it("registering an already-active runId throws a SERVER_ERROR naming the runId, and leaves the first controller untouched", () => {
    const registry = new CancelRegistry();
    const first = registry.register("r1");

    let caught: unknown;
    try {
      registry.register("r1");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RpcMethodError);
    const err = caught as RpcMethodError;
    expect(err.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(err.message).toContain("r1");
    expect(err.message.toLowerCase()).toContain("already active");

    // The rejected second register() call must not touch the first
    // registration in any way -- same controller, not aborted, registry
    // still holds exactly one entry.
    expect(registry.get("r1")).toBe(first);
    expect(first.signal.aborted).toBe(false);
    expect(registry.size()).toBe(1);
  });

  it("after deregister, the same runId can be registered again with a fresh controller", () => {
    const registry = new CancelRegistry();
    const first = registry.register("r1");
    registry.deregister("r1");
    expect(registry.size()).toBe(0);

    const second = registry.register("r1");
    expect(second).not.toBe(first);
    expect(registry.get("r1")).toBe(second);
    expect(registry.size()).toBe(1);
  });

  it("distinct runIds register independently (no cross-talk from the duplicate check)", () => {
    const registry = new CancelRegistry();
    registry.register("a");
    registry.register("b");
    expect(registry.size()).toBe(2);
    expect(registry.cancel("a")).toBe(true);
    expect(registry.get("a")?.signal.aborted).toBe(true);
    expect(registry.get("b")?.signal.aborted).toBe(false);
  });
});
