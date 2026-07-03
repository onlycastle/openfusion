import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { resolveProjectKey } from "../rpc/guards.js";
import { registerMethod } from "../rpc/register.js";
import { HarnessGenError } from "./driver.js";
import { exportHarness } from "./exporters.js";
import { generateHarness, type GenerateHarnessResult } from "./generate.js";
import { validateHarness } from "./schema.js";
import { HarnessValidationError, harnessStatus, loadHarness } from "./store.js";

const ProjectParamsSchema = z.object({ projectDir: z.string().min(1) });

const ExportParamsSchema = z.object({
  projectDir: z.string().min(1),
  format: z.enum(["agents-md", "claude-subagents"]),
});

// Holds the per-project in-flight generation map. Mirrors WikiService.build's
// #building coalescing exactly: a second engine.harness.generate call for a
// project already generating returns the SAME promise instead of racing a
// second frontier session (and a second writeHarness) against the first.
export class HarnessService {
  #generating = new Map<string, Promise<GenerateHarnessResult>>();

  generate(engine: Engine, projectDir: string): Promise<GenerateHarnessResult> {
    const key = resolveProjectKey(projectDir);
    const inFlight = this.#generating.get(key);
    if (inFlight !== undefined) return inFlight;

    const promise = generateHarness(engine, projectDir).finally(() => {
      this.#generating.delete(key);
    });
    this.#generating.set(key, promise);
    return promise;
  }
}

export function registerHarnessMethods(engine: Engine): void {
  registerMethod(engine.dispatcher, "engine.harness.generate", ProjectParamsSchema, async ({ projectDir }) => {
    try {
      const result = await engine.harness.generate(engine, projectDir);
      engine.log(`harness.generate ${projectDir}: ${result.pages} pages, ${result.agents} agents`);
      return result;
    } catch (err) {
      // HarnessGenError (driver.ts, or thrown directly by generateHarness's
      // own write-stage structural gate) is the ONE expected failure mode
      // of the pipeline — every other throw (a non-git projectDir, an
      // unregistered frontier engine) already arrives as an RpcMethodError
      // and passes through the rethrow below untouched.
      if (err instanceof HarnessGenError) {
        engine.log(`harness.generate ${projectDir} failed at stage ${err.stage ?? "unknown"}`);
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, err.message, {
          stage: err.stage,
          issues: err.issues,
        });
      }
      throw err;
    }
  });

  registerMethod(engine.dispatcher, "engine.harness.status", ProjectParamsSchema, ({ projectDir }) => {
    try {
      return harnessStatus(projectDir);
    } catch (err) {
      if (err instanceof HarnessValidationError) {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, err.message, { issues: err.issues });
      }
      throw err;
    }
  });

  registerMethod(engine.dispatcher, "engine.harness.export", ExportParamsSchema, async ({ projectDir, format }) => {
    let bundle;
    try {
      bundle = loadHarness(projectDir);
    } catch (err) {
      if (err instanceof HarnessValidationError) {
        throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, err.message, { issues: err.issues });
      }
      throw err;
    }
    // Requires a harness that is both PRESENT (loadHarness didn't return
    // null — something has been generated) and STRUCTURALLY VALID
    // (validateHarness's cross-artifact referential check, the same gate
    // generateHarness itself enforces at write time) — a bundle that loads
    // but fails that check (e.g. hand-edited via the Harness editor into a
    // dangling routing reference) is just as unexportable as no harness at
    // all, so both collapse to the same error MESSAGE. They are NOT
    // identical failures, though: the loadHarness-null case genuinely has
    // nothing to report, but a validateHarness failure has concrete issues
    // that would otherwise be silently discarded — those are carried in
    // error.data.issues so a caller can see exactly what's broken instead of
    // re-running validateHarness itself to find out.
    if (bundle === null) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no valid harness; run engine.harness.generate first");
    }
    const structuralIssues = validateHarness(bundle);
    if (structuralIssues.length > 0) {
      throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, "no valid harness; run engine.harness.generate first", {
        issues: structuralIssues,
      });
    }
    const result = await exportHarness(projectDir, bundle, format);
    engine.log(`harness.export ${projectDir} (${format}): ${result.files.length} files`);
    return result;
  });
}
