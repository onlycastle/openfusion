import { realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { RpcMethodError } from "../rpc/errors.js";
import { registerMethod } from "../rpc/register.js";
import { HarnessGenError } from "./driver.js";
import { generateHarness, type GenerateHarnessResult } from "./generate.js";
import { HarnessValidationError, harnessStatus } from "./store.js";

const ProjectParamsSchema = z.object({ projectDir: z.string().min(1) });

// Same canonicalization as wiki/methods.ts's own keyFor: resolve to a
// symlink-free path so distinct spellings of the same directory share one
// in-flight generation, falling back to the merely-resolved path if the
// directory doesn't exist yet (generateHarness's own git guard rejects that
// case with a clear error).
function keyFor(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// Holds the per-project in-flight generation map. Mirrors WikiService.build's
// #building coalescing exactly: a second engine.harness.generate call for a
// project already generating returns the SAME promise instead of racing a
// second frontier session (and a second writeHarness) against the first.
export class HarnessService {
  #generating = new Map<string, Promise<GenerateHarnessResult>>();

  generate(engine: Engine, projectDir: string): Promise<GenerateHarnessResult> {
    const key = keyFor(projectDir);
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
}
