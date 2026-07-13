import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PolicyDecisionKind } from "./policy.js";
import type { SandboxBackend } from "./sandbox.js";
import type { RuntimeStore } from "./store.js";

export interface RuntimeHookEventMap {
  "session.started": { sessionId: string; kind: string };
  "session.finished": { sessionId: string; outcome: string };
  "model.before": { sessionId: string; step: number };
  "model.after": { sessionId: string; step: number; inputTokens: number; outputTokens: number };
  "tool.before": { sessionId: string; tool: string; capability: string };
  "tool.after": { sessionId: string; tool: string; ok: boolean; resultBytes: number };
  "policy.evaluated": { sessionId: string; capability: string; decision: PolicyDecisionKind };
  "context.compacted": { sessionId: string; beforeTokens: number; afterTokens: number };
  "mcp.changed": { serverId: string; fingerprint: string };
  "skill.activated": { skillId: string; fingerprint: string };
  "child.changed": { parentSessionId: string; childSessionId: string; status: string };
}

type HookHandler<K extends keyof RuntimeHookEventMap> = (
  event: Readonly<RuntimeHookEventMap[K]>,
) => void | Promise<void>;

/** Typed in-process lifecycle bus. Handler failures are isolated. */
export class RuntimeHookBus {
  #handlers = new Map<keyof RuntimeHookEventMap, Set<(event: never) => void | Promise<void>>>();

  on<K extends keyof RuntimeHookEventMap>(type: K, handler: HookHandler<K>): () => void {
    const handlers = this.#handlers.get(type) ?? new Set();
    handlers.add(handler as (event: never) => void | Promise<void>);
    this.#handlers.set(type, handlers);
    return () => handlers.delete(handler as (event: never) => void | Promise<void>);
  }

  async emit<K extends keyof RuntimeHookEventMap>(type: K, event: RuntimeHookEventMap[K]): Promise<void> {
    const handlers = [...(this.#handlers.get(type) ?? [])];
    await Promise.allSettled(handlers.map((handler) =>
      Promise.resolve().then(() => handler(Object.freeze({ ...event }) as never))));
  }
}

export interface NormalizedRiskFacts {
  schemaVersion: 1;
  event: keyof RuntimeHookEventMap;
  sessionId?: string;
  sessionKind?: string;
  tool?: string;
  capability?: string;
  decision?: PolicyDecisionKind;
  risk: Array<"filesystem-read" | "filesystem-write" | "process" | "network" | "external-tool">;
}

export interface ProcessHookDefinition {
  id: string;
  fingerprint: string;
  mode: "observational" | "enforcing";
  executable: string;
  args?: string[];
  timeoutMs?: number;
}

export interface ProcessHookResult {
  hookId: string;
  status: "completed" | "ignored-failure" | "restricted";
  decision?: Exclude<PolicyDecisionKind, "allow">;
  reason?: string;
  artifactId?: string;
}

function extractDecision(text: string): { decision?: PolicyDecisionKind; reason?: string } {
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as { decision?: unknown; reason?: unknown };
    return {
      ...(["allow", "ask", "deny"].includes(String(value.decision))
        ? { decision: value.decision as PolicyDecisionKind }
        : {}),
      ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 512) } : {}),
    };
  } catch {
    return {};
  }
}

/** Runs an approved process hook with normalized facts only. */
export async function runProcessHook(input: {
  hook: ProcessHookDefinition;
  facts: NormalizedRiskFacts;
  interactive: boolean;
  sandbox: SandboxBackend;
  store: RuntimeStore;
  sessionId: string;
  cwd: string;
  privateTempRoot?: string;
  approvedFingerprints: ReadonlySet<string>;
}): Promise<ProcessHookResult> {
  if (!input.approvedFingerprints.has(input.hook.fingerprint)) {
    return {
      hookId: input.hook.id,
      status: "restricted",
      decision: input.interactive ? "ask" : "deny",
      reason: "process hook fingerprint is not approved",
    };
  }
  const temp = fs.mkdtempSync(path.join(input.privateTempRoot ?? os.tmpdir(), "openfusion-hook-"));
  const output = input.store.beginArtifact(input.sessionId, "hook-output", { maxBytes: 1024 * 1024 });
  try {
    const result = await input.sandbox.run({
      executable: input.hook.executable,
      args: input.hook.args ?? [],
      cwd: input.cwd,
      privateTempDir: temp,
      readablePaths: [path.dirname(input.hook.executable)],
      executablePaths: [path.dirname(input.hook.executable)],
      networkGranted: false,
      environment: {
        OPENFUSION_HOOK_FACTS_BASE64: Buffer.from(JSON.stringify(input.facts), "utf8").toString("base64"),
      },
      timeoutMs: Math.min(2_000, Math.max(1, input.hook.timeoutMs ?? 2_000)),
      output,
    });
    const parsed = extractDecision(result.preview);
    if (input.hook.mode === "observational") {
      return {
        hookId: input.hook.id,
        status: result.exitCode === 0 ? "completed" : "ignored-failure",
        artifactId: result.artifact.id,
      };
    }
    if (result.exitCode !== 0 || result.failure !== undefined) {
      return {
        hookId: input.hook.id,
        status: "restricted",
        decision: input.interactive ? "ask" : "deny",
        reason: "enforcing hook failed",
        artifactId: result.artifact.id,
      };
    }
    // An enforcing hook may only narrow authority. `allow` is observational.
    if (parsed.decision === "ask" || parsed.decision === "deny") {
      return {
        hookId: input.hook.id,
        status: "restricted",
        decision: parsed.decision,
        reason: parsed.reason,
        artifactId: result.artifact.id,
      };
    }
    return { hookId: input.hook.id, status: "completed", artifactId: result.artifact.id };
  } catch {
    output.abort();
    return input.hook.mode === "observational"
      ? { hookId: input.hook.id, status: "ignored-failure" }
      : {
          hookId: input.hook.id,
          status: "restricted",
          decision: input.interactive ? "ask" : "deny",
          reason: "enforcing hook failed",
        };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
