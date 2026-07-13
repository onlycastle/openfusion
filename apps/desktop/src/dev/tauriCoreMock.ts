export class Channel<T> {
  onmessage: ((message: T) => void) | undefined;
}

const PROJECT = { path: "/Users/demo/openfusion", name: "openfusion" };

const TEAM = {
  agents: [
    { name: "coder", role: "Implements focused product changes", taskClasses: ["codegen", "fix"], model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" } },
    { name: "reviewer", role: "Checks correctness and regressions", taskClasses: ["review"], model: "frontier" },
    { name: "test-writer", role: "Builds reliable verification", taskClasses: ["tests"], model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" } },
  ],
  defaults: {},
  escalation: 2,
  card: {
    state: "draft",
    digest: "OpenFusion is a local macOS utility that builds and evaluates project-specific AI coding harnesses.",
    body: "# OpenFusion\n\nA local-first Tauri app with a TypeScript engine and a React desktop shell.",
  },
};

const WIKI = {
  built: true,
  headSha: "demo123",
  currentSha: "demo123",
  stale: false,
  files: 284,
  symbols: 1932,
  refs: 4410,
};

const HARNESS = {
  present: true,
  structural: "pass",
  headSha: "demo123",
  card: "draft",
};

const HEALTH = {
  checkedAt: "2026-07-10T00:00:00.000Z",
  overall: "healthy",
  harness: { present: true, structural: "passed", freshness: "current", card: "draft" },
  wiki: { operational: "passed", index: "passed", retrieval: "passed", delivery: "passed" },
  operational: {
    status: "healthy",
    sampleSize: 8,
    successfulRuns: 7,
    failedRuns: 1,
    errorRuns: 0,
    cancelledRuns: 1,
    escalatedRuns: 2,
    reviewRequestChanges: 3,
    toolErrors: 0,
    applySucceeded: 5,
    applyFailed: 0,
    lastRunAt: "2026-07-10T00:00:00.000Z",
  },
  issues: [],
};

function engineResponse(method: string): unknown {
  if (method === "engine.models.list") return { providers: [{ id: "deepseek", kind: "deepseek" }] };
  if (method === "engine.frontier.models") {
    return {
      models: [
        { engine: "claude-code", id: "default", displayName: "Default", description: "Claude account default", isDefault: true },
        { engine: "claude-code", id: "opus[1m]", displayName: "Opus", description: "Claude Opus", isDefault: false },
        { engine: "codex", id: "gpt-5.5", displayName: "GPT-5.5", description: "OpenAI GPT-5.5", isDefault: true },
      ],
      unavailable: [],
    };
  }
  if (method === "engine.models.check") return { connected: true };
  if (method === "engine.models.configure") return { configured: true };
  if (method === "engine.models.unconfigure") return { unconfigured: true };
  if (method === "engine.wiki.status") return WIKI;
  if (method === "engine.wiki.build") return { filesSeen: 284, filesIndexed: 284, filesSkipped: 0, filesFailed: 0, filesRemoved: 0, symbols: 1932, refs: 4410, headSha: "demo123", sourceFingerprint: `sha256:${"a".repeat(64)}`, coverage: { supportedTracked: 284, currentEntries: 284, unchanged: 0, oversized: 0, unreadable: 0, parseFailed: 0, removed: 0 } };
  if (method === "engine.harness.status") return HARNESS;
  if (method === "engine.harness.health") return HEALTH;
  if (method === "engine.harness.read") return TEAM;
  if (method.startsWith("engine.harness.update")) return { updated: true };
  if (method === "engine.harness.card.update" || method === "engine.harness.card.approve") return undefined;
  if (method === "engine.cancel") return { cancelled: true };
  return undefined;
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (command === "engine_call") return engineResponse(String(args?.method)) as T;
  if (command === "list_projects") return [PROJECT] as T;
  if (command === "list_provider_configs") {
    return [{ id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash" }] as T;
  }
  if (command === "frontier_login_status") return { state: "connected" } as T;
  if (command === "get_secret") return null as T;
  if (command === "list_secret_ids") return [] as T;
  return undefined as T;
}
