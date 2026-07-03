// Shared guards previously duplicated (intentionally, per each site's own
// doc comments) across wiki/methods.ts, harness/generate.ts, engines/
// methods.ts, worker/methods.ts (requireHeadSha), harness/methods.ts (keyFor),
// and models/methods.ts + worker/methods.ts (kindOf). M5b Task 1 lifts all
// three into one place: M5b's later tasks (orchestrator, escalation) add
// enough NEW call sites that re-duplicating a fourth/fifth copy each stopped
// being the cheaper option.
import { realpathSync } from "node:fs";
import path from "node:path";
import { RpcErrorCodes } from "@openfusion/shared";
import type { ProviderRegistry } from "../models/providers.js";
import { getHeadSha } from "../wiki/indexer.js";
import { RpcMethodError } from "./errors.js";

// Resolves projectDir's current HEAD sha, or throws the SERVER_ERROR every
// engine.* surface that operates against a project checkout (wiki, harness
// generation, frontier sessions, worker runs) has always thrown for a
// non-git projectDir — same code, same message shape as the copies this
// replaces.
export function requireGitRepo(projectDir: string): string {
  try {
    return getHeadSha(projectDir);
  } catch {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `not a git repository: ${projectDir}`);
  }
}

// Looks up the provider kind recorded at engine.models.configure() time —
// pricing.ts's table is keyed "<providerKind>/<modelId>", not by providerId,
// so metering a call needs this lookup. Falls back to the providerId itself
// (which simply fails pricing lookups harmlessly) for the — unsupported in
// practice — case of a resolve()-able provider that was never configured,
// matching the behavior of both copies this replaces.
export function providerKindOf(registry: ProviderRegistry, providerId: string): string {
  const registered = registry.list().find((p) => p.id === providerId);
  return registered?.kind ?? providerId;
}

// Resolves to the canonical, symlink-free path so distinct spellings of the
// same directory (or a symlinked one) share one per-project cache entry —
// used by WikiService/HarnessService/WorkerService to key their respective
// per-project stores/managers. Falls back to the merely-resolved path if the
// directory doesn't exist yet (requireGitRepo rejects that case with a clear
// error before it matters).
export function resolveProjectKey(projectDir: string): string {
  const resolved = path.resolve(projectDir);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
