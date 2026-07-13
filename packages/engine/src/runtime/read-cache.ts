import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface ReadCacheResult {
  bytes: Buffer;
  digest: string;
  cacheHit: boolean;
  mutationEpoch: number;
}

interface Entry {
  key: string;
  result: Omit<ReadCacheResult, "cacheHit">;
}

/** Per-session, worktree-scoped read de-duplication cache. */
export class RuntimeReadCache {
  #entries = new Map<string, Entry>();
  #mutationEpoch = 0;

  get mutationEpoch(): number {
    return this.#mutationEpoch;
  }

  read(file: string, range = "all"): ReadCacheResult {
    const canonical = path.resolve(file);
    const stat = statSync(canonical);
    const base = `${canonical}\0${range}\0${stat.mtimeMs}\0${stat.size}\0${this.#mutationEpoch}`;
    const existing = this.#entries.get(base);
    if (existing !== undefined) return { ...existing.result, bytes: Buffer.from(existing.result.bytes), cacheHit: true };

    const bytes = readFileSync(canonical);
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const key = `${base}\0${digest}`;
    const result = { bytes: Buffer.from(bytes), digest, mutationEpoch: this.#mutationEpoch };
    this.#entries.set(base, { key, result });
    return { ...result, bytes: Buffer.from(bytes), cacheHit: false };
  }

  invalidateAll(): number {
    this.#mutationEpoch += 1;
    this.#entries.clear();
    return this.#mutationEpoch;
  }

  size(): number {
    return this.#entries.size;
  }
}
