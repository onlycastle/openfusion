import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { createEngine, ENGINE_VERSION, type Engine } from "../src/engine.js";
import type {
  FrontierAdapter,
  FrontierEvent,
  FrontierPromptHandle,
  FrontierSession,
} from "../src/engines/types.js";
import { harnessStatus, loadHarness } from "../src/harness/store.js";
import { CARD_SLUG, PROSE_PAGE_SLUGS } from "../src/harness/schema.js";

let dir: string;
let engine: Engine;

afterEach(async () => {
  await engine.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(prefix = "of-harness-gen-"): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", d]);
  execFileSync("git", ["-C", d, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", d, "config", "user.name", "t"]);
  writeFileSync(path.join(d, "x.ts"), "export function xray() {}\nxray();\n");
  // A minimal manifest so mineCommands (M4 task 2/4) has something real to
  // mine: no lockfile is present, so detectPackageManager defaults to "npm"
  // and this "test" script is mined as the command `npm run test` (source
  // "package.json:scripts.test") — the card stage's scripted response below
  // (CARD_CONTENT) deliberately proposes this exact command so it survives
  // validateCardContent's cross-check, alongside an unmined `npm run ghost`
  // that must get stripped (no "ghost" script exists in this manifest).
  writeFileSync(
    path.join(d, "package.json"),
    JSON.stringify({ name: "of-harness-gen-fixture", scripts: { test: "echo test" } }, null, 2) + "\n",
  );
  execFileSync("git", ["-C", d, "add", "-A"]);
  execFileSync("git", ["-C", d, "commit", "-qm", "init"]);
  return d;
}

async function call(method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

// --- Scripted-fake-adapter test helper -------------------------------------
//
// Builds a FrontierAdapter whose single session's Nth prompt() call returns
// the Nth entry of `scripts` as its event stream (clamped to the last entry
// if called more times than scripted, mirroring harness-driver.test.ts's own
// makeScriptedSession — same contract, wrapped in an adapter so it can be
// registered via the already-public engine.frontier.registerAdapter, which
// is generateHarness's sole injection point; see generate.ts's header
// comment for why no separate session-factory hook was needed).

function resultEvent(overrides: Partial<Extract<FrontierEvent, { type: "result" }>> = {}): FrontierEvent {
  return {
    type: "result",
    resultText: "",
    costUsd: 0.001,
    usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 },
    numTurns: 1,
    durationMs: 1,
    engineSessionId: null,
    ...overrides,
  };
}

function textEvent(text: string): FrontierEvent {
  return { type: "text", text };
}

function jsonScript(value: unknown): FrontierEvent[] {
  return [textEvent("```json\n" + JSON.stringify(value) + "\n```"), resultEvent()];
}

function badJsonScript(): FrontierEvent[] {
  return [textEvent("```json\n{\"nonsense\": true}\n```"), resultEvent()];
}

interface ScriptedAdapterOptions {
  scripts: FrontierEvent[][];
  closeSpy?: { closed: boolean; count: number };
  capturedPrompts?: string[];
  capturedToolPolicy?: Array<{ writeScope?: string[] } | undefined>;
  createSessionSpy?: { count: number };
  // Final review Fix 2: captures createSession's `resultLabel` argument so
  // tests can assert generateHarness tags its session "frontier-generate"
  // (not the pre-fix default of "frontier-review", which mislabeled an
  // hour-long harness-generation run as per-task review overhead).
  capturedResultLabel?: Array<string | undefined>;
}

function makeScriptedAdapter(opts: ScriptedAdapterOptions): FrontierAdapter {
  return {
    kind: "claude-code",
    async createSession({ projectDir, toolPolicy, resultLabel }): Promise<FrontierSession> {
      if (opts.createSessionSpy !== undefined) opts.createSessionSpy.count += 1;
      opts.capturedToolPolicy?.push(toolPolicy);
      opts.capturedResultLabel?.push(resultLabel);
      let callIndex = 0;
      return {
        id: "scripted-session",
        projectDir,
        prompt(text: string): FrontierPromptHandle {
          opts.capturedPrompts?.push(text);
          const events = opts.scripts[Math.min(callIndex, opts.scripts.length - 1)] ?? [];
          callIndex += 1;
          async function* gen(): AsyncGenerator<FrontierEvent> {
            for (const e of events) yield e;
          }
          return { events: gen(), abort: () => {} };
        },
        async close(): Promise<void> {
          if (opts.closeSpy !== undefined) {
            opts.closeSpy.closed = true;
            opts.closeSpy.count += 1;
          }
        },
      };
    },
  };
}

const OVERVIEW = {
  summary: "A tiny demo repository used to exercise the harness generation pipeline.",
  subsystems: [{ name: "core", path: "src", purpose: "does the one thing this repo does" }],
  conventions: ["use TypeScript", "prefer explicit types"],
  buildCommands: ["pnpm build"],
  testCommands: ["pnpm test"],
};

function pageValue(slug: string) {
  return {
    title: `${slug[0]!.toUpperCase()}${slug.slice(1)}`,
    digest: `Digest for ${slug}.`,
    body: `# ${slug}\n\nBody content for ${slug}.\n`,
  };
}

// Valid CardContentSchema JSON (M4 task 4's project-card stage): one command
// that matches the fixture repo's mined command exactly (`npm run test`, see
// makeRepo) — this one must survive validateCardContent — and one command
// naming a script that does not exist in any manifest (`npm run ghost`) —
// this one must be stripped, exercising the brief's stripping assertion in
// the happy path.
const CARD_CONTENT = {
  title: "Project Card",
  commands: [
    { command: "npm run test", why: "run the test suite" },
    { command: "npm run ghost", why: "a command that does not actually exist" },
  ],
  env: [],
  boundaries: [],
  anchors: [],
  glossary: [],
  gotchas: [],
};

const AGENTS_ROUTING = {
  agents: [
    {
      name: "codegen-worker",
      role: "worker",
      description: "Writes and edits code for codegen tasks.",
      prompt: "You are a codegen specialist. Follow the wiki digest.",
      taskClasses: ["codegen", "refactor"],
      model: { kind: "deepseek", model: "deepseek-chat" },
      escalation: { maxAttempts: 2 },
    },
    {
      name: "docs-worker",
      role: "worker",
      description: "Writes documentation and tests.",
      prompt: "You are a docs and test specialist.",
      taskClasses: ["docs", "tests", "search"],
      model: { kind: "deepseek", model: "deepseek-chat" },
      escalation: { maxAttempts: 2 },
    },
  ],
  routing: {
    version: 1,
    taskClasses: {
      codegen: { agent: "codegen-worker" },
      refactor: { agent: "codegen-worker" },
      docs: { agent: "docs-worker" },
      tests: { agent: "docs-worker" },
      search: { agent: "docs-worker" },
    },
    escalation: { failuresBeforeFrontier: 2 },
    defaults: { agent: "codegen-worker" },
  },
};

// One script per promptForJson call, in pipeline order: overview, then the
// 4 wiki pages (PROSE_PAGE_SLUGS order), then the project card (mining runs
// in between but makes no promptForJson call of its own), then agents-routing.
function happyScripts(): FrontierEvent[][] {
  return [
    jsonScript(OVERVIEW),
    ...PROSE_PAGE_SLUGS.map((slug) => jsonScript(pageValue(slug))),
    jsonScript(CARD_CONTENT),
    jsonScript(AGENTS_ROUTING),
  ];
}

describe("engine.harness.generate — happy path (scripted fake adapter)", () => {
  it("writes a full harness bundle, returns the report card, and emits stages in order", async () => {
    dir = makeRepo();
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    const closeSpy = { closed: false, count: 0 };
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts: happyScripts(), closeSpy }));

    const res = await call("engine.harness.generate", { projectDir: dir });
    expect(res.error).toBeUndefined();

    const result = res.result;
    expect(result.pages).toBe(5);
    expect(result.agents).toBe(2);
    expect(result.reportCard).toEqual({ structural: "pass", evals: "pending" });
    expect(result.note).toContain("UNVERIFIED");
    expect(result.note).toContain("M6");
    expect(typeof result.estimatedCostUsd).toBe("number");
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.files).toContain(path.join(".openfusion", "manifest.json"));
    expect(result.files).toContain(path.join(".openfusion", "routing.yaml"));
    expect(result.files).toContain(path.join(".openfusion", "wiki", "project-card.md"));

    // The unmined `npm run ghost` command must have been stripped at
    // generation (validateCardContent, M4 task 3) — surfaced on the result
    // so the desktop review panel (spec §3.4) can show it.
    expect(Array.isArray(result.cardStripped)).toBe(true);
    expect(result.cardStripped.some((s: { item: string }) => s.item === "npm run ghost")).toBe(true);

    // Files actually on disk, loaded back through the store (M4 task 2).
    const bundle = loadHarness(dir);
    expect(bundle).not.toBeNull();
    expect(bundle!.pages).toHaveLength(5);
    expect(bundle!.pages.map((p) => p.slug).sort()).toEqual([...PROSE_PAGE_SLUGS, CARD_SLUG].sort());
    expect(bundle!.agents).toHaveLength(2);
    expect(bundle!.manifest.verification).toEqual({ structural: "pass", evals: "pending", card: "draft" });
    expect(bundle!.manifest.generatorVersion).toBe(ENGINE_VERSION);
    expect(bundle!.manifest.engine).toBe("claude-code");
    expect(bundle!.manifest.headSha).toHaveLength(40);
    expect(bundle!.routing.escalation.failuresBeforeFrontier).toBe(2);

    // The project card page's on-disk digest keeps the trusted, mined
    // command and drops the stripped one entirely (not just from the
    // manifest bookkeeping — from the actual injected digest text).
    const cardPage = bundle!.pages.find((p) => p.slug === CARD_SLUG);
    expect(cardPage).toBeDefined();
    expect(cardPage!.digest).toContain("npm run test");
    expect(cardPage!.digest).not.toContain("ghost");

    // The card's human-approval gate (spec §3.4) starts at "draft" — never
    // auto-approved by generation itself.
    expect(harnessStatus(dir).card).toBe("draft");

    // Stage notification sequence, in order — exactly the 8 stages the task
    // brief enumerates, one each, though a stage may now emit MORE than one
    // notification (its own START line plus promptForJson's per-attempt
    // "attempt" notice relayed via opts.notify) — dedupe consecutive
    // same-stage entries to assert the STAGE TRANSITION order stays exactly
    // as before.
    const harnessNotices = notifications.filter((n) => n.method === "harness.progress");
    const stageSeq = harnessNotices.map((n) => (n.params as { stage: string }).stage);
    const dedupedStageSeq = stageSeq.filter((s, i) => s !== stageSeq[i - 1]);
    expect(dedupedStageSeq).toEqual([
      "wiki-check",
      "overview",
      "page:architecture",
      "page:subsystems",
      "page:conventions",
      "page:build-and-test",
      "mine",
      "page:project-card",
      "agents-routing",
      "write",
      "verify",
    ]);
    // Every promptForJson-backed stage (overview, the 4 pages, the project
    // card, agents-routing) now emits at least one extra "attempt: ..."
    // relay on top of its own START line. "mine" is not promptForJson-backed
    // (mineCommands makes no LLM call) so it's deliberately excluded here.
    for (const stage of [
      "overview",
      "page:architecture",
      "page:subsystems",
      "page:conventions",
      "page:build-and-test",
      "page:project-card",
      "agents-routing",
    ]) {
      const forStage = harnessNotices.filter((n) => (n.params as { stage: string }).stage === stage);
      expect(forStage.length).toBeGreaterThanOrEqual(2);
      expect(forStage.some((n) => (n.params as { detail: string }).detail.startsWith("attempt:"))).toBe(true);
    }
    for (const n of harnessNotices) {
      expect((n.params as { projectDir: string }).projectDir).toBe(dir);
      expect(typeof (n.params as { detail: string }).detail).toBe("string");
    }

    // Session must be closed once the pipeline finishes.
    expect(closeSpy.closed).toBe(true);
    expect(closeSpy.count).toBe(1);
  }, 30_000);

  // M6 Task 1 (eval-batch safety gate): generateHarness opens its session
  // directly off the registered adapter (bypassing engine.frontier.start),
  // so it must call engine.frontier.track()/untrack() itself for
  // Engine.close() to be able to reach it. Asserted here via
  // trackedCount(): zero before the run, back to zero after — proving both
  // that the session got tracked (real coverage would need close() to be
  // provably reachable) AND that it was untracked again (no leak).
  it("tracks the generation session for close()-reachability and untracks it once generation finishes (no leak)", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts: happyScripts() }));

    expect(engine.frontier.trackedCount()).toBe(0);
    const res = await call("engine.harness.generate", { projectDir: dir });
    expect(res.error).toBeUndefined();
    expect(engine.frontier.trackedCount()).toBe(0);
  }, 30_000);

  it("starts a READ-ONLY session (no toolPolicy) even though the project directory would be writable", async () => {
    dir = makeRepo();
    engine = createEngine();
    const capturedToolPolicy: Array<{ writeScope?: string[] } | undefined> = [];
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts: happyScripts(), capturedToolPolicy }));

    const res = await call("engine.harness.generate", { projectDir: dir });
    expect(res.error).toBeUndefined();
    expect(capturedToolPolicy).toEqual([undefined]);
  }, 30_000);

  it("the overview prompt instructs the model to use wiki_map/wiki_query first", async () => {
    dir = makeRepo();
    engine = createEngine();
    const capturedPrompts: string[] = [];
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts: happyScripts(), capturedPrompts }));

    await call("engine.harness.generate", { projectDir: dir });
    expect(capturedPrompts[0]).toContain("wiki_map");
    expect(capturedPrompts[0]).toContain("wiki_query");
  }, 30_000);

  // Final review Fix 2 (Important): generateHarness's session used to open
  // with no resultLabel at all, so engines/methods.ts's onResult hook
  // defaulted every result to source "frontier-review" — mislabeling an
  // hour-long, one-time harness-generation run as per-task review overhead,
  // which breaks M6's amortization math. Confirmed RED against pre-fix code
  // (capturedResultLabel was [undefined]).
  it("opens the generation session with resultLabel \"frontier-generate\" so its cost is metered separately from per-task review", async () => {
    dir = makeRepo();
    engine = createEngine();
    const capturedResultLabel: Array<string | undefined> = [];
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts: happyScripts(), capturedResultLabel }));

    const res = await call("engine.harness.generate", { projectDir: dir });
    expect(res.error).toBeUndefined();
    expect(capturedResultLabel).toEqual(["frontier-generate"]);
  }, 30_000);

  it("page prompts pass the overview JSON as context instead of re-exploration", async () => {
    dir = makeRepo();
    engine = createEngine();
    const capturedPrompts: string[] = [];
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts: happyScripts(), capturedPrompts }));

    await call("engine.harness.generate", { projectDir: dir });
    // capturedPrompts[1] is the first page prompt (architecture).
    expect(capturedPrompts[1]).toContain(OVERVIEW.summary);
    expect(capturedPrompts[1]!.toLowerCase()).toContain("do not re-explore");
  }, 30_000);
});

describe("engine.harness.generate — validation-retry path", () => {
  it("succeeds when a stage returns bad JSON once, then valid JSON on retry", async () => {
    dir = makeRepo();
    engine = createEngine();
    // Overview fails validation on its first attempt, then succeeds — every
    // subsequent script shifts by one call.
    const scripts = [
      badJsonScript(),
      jsonScript(OVERVIEW),
      ...PROSE_PAGE_SLUGS.map((slug) => jsonScript(pageValue(slug))),
      jsonScript(CARD_CONTENT),
      jsonScript(AGENTS_ROUTING),
    ];
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts }));

    const res = await call("engine.harness.generate", { projectDir: dir });
    expect(res.error).toBeUndefined();
    expect(res.result.pages).toBe(5);
    expect(res.result.agents).toBe(2);

    const bundle = loadHarness(dir);
    expect(bundle).not.toBeNull();
  }, 30_000);
});

describe("engine.harness.generate — hard failure (retry exhaustion)", () => {
  it("returns SERVER_ERROR with data.stage === 'page:architecture' and writes nothing when a page stage is exhausted", async () => {
    dir = makeRepo();
    engine = createEngine();
    const closeSpy = { closed: false, count: 0 };
    // Overview succeeds, then page:architecture (first page slug) fails
    // validation on BOTH of its attempts (default retries: 1 => 2 attempts).
    const scripts = [jsonScript(OVERVIEW), badJsonScript(), badJsonScript()];
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts, closeSpy }));

    const res = await call("engine.harness.generate", { projectDir: dir });
    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error.data.stage).toBe("page:architecture");
    expect(Array.isArray(res.error.data.issues)).toBe(true);
    expect(res.error.data.issues.length).toBeGreaterThan(0);

    // Nothing under .openfusion beyond the wiki cache — no manifest.json,
    // so loadHarness reports "nothing generated yet".
    expect(loadHarness(dir)).toBeNull();

    // Session must still be closed even on a hard failure.
    expect(closeSpy.closed).toBe(true);
    expect(closeSpy.count).toBe(1);
  }, 30_000);

  it("returns SERVER_ERROR for a non-git projectDir", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "of-harness-gen-nogit-"));
    engine = createEngine();
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts: happyScripts() }));

    const res = await call("engine.harness.generate", { projectDir: dir });
    expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
  });

  it("closes the session even when writeHarness's structural gate fails (routing references an unknown agent)", async () => {
    dir = makeRepo();
    engine = createEngine();
    const closeSpy = { closed: false, count: 0 };
    const badRouting = {
      agents: AGENTS_ROUTING.agents,
      routing: {
        ...AGENTS_ROUTING.routing,
        defaults: { agent: "does-not-exist" },
      },
    };
    const scripts = [
      jsonScript(OVERVIEW),
      ...PROSE_PAGE_SLUGS.map((slug) => jsonScript(pageValue(slug))),
      jsonScript(CARD_CONTENT),
      jsonScript(badRouting),
    ];
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts, closeSpy }));

    const res = await call("engine.harness.generate", { projectDir: dir });
    expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error?.data?.stage).toBe("write");
    expect(loadHarness(dir)).toBeNull();
    expect(closeSpy.closed).toBe(true);
  }, 30_000);
});

describe("engine.harness.generate — driver notice passthrough", () => {
  it("surfaces a mid-stage frontier notice (e.g. rate limit) as an extra harness.progress notification", async () => {
    dir = makeRepo();
    const notifications: Array<{ method: string; params: unknown }> = [];
    engine = createEngine({ notify: (method, params) => notifications.push({ method, params }) });
    // Overview's turn includes a mid-stage "notice" event (as a real
    // provider-throttled turn would) before its JSON answer — the driver
    // forwards this as a DriverNotice{kind:"notice"}, which generate.ts must
    // now relay onward as an EXTRA harness.progress notification for the
    // "overview" stage (not a replacement for the stage's own START line).
    const scripts: FrontierEvent[][] = [
      [
        {
          type: "notice",
          kind: "rate_limit",
          message: "rate_limit: Claude API rate limit reported for this turn.",
        },
        textEvent("```json\n" + JSON.stringify(OVERVIEW) + "\n```"),
        resultEvent(),
      ],
      ...PROSE_PAGE_SLUGS.map((slug) => jsonScript(pageValue(slug))),
      jsonScript(CARD_CONTENT),
      jsonScript(AGENTS_ROUTING),
    ];
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts }));

    const res = await call("engine.harness.generate", { projectDir: dir });
    expect(res.error).toBeUndefined();

    const harnessNotices = notifications.filter((n) => n.method === "harness.progress");
    const overviewNotices = harnessNotices.filter((n) => (n.params as { stage: string }).stage === "overview");
    // The stage's own START notification, PLUS the driver-notice-forwarded
    // notification — a rate-limited run must not look identical to a normal
    // one.
    expect(overviewNotices.length).toBeGreaterThanOrEqual(2);
    expect(
      overviewNotices.some((n) => (n.params as { detail: string }).detail.includes("rate_limit")),
    ).toBe(true);
  }, 30_000);
});

describe("engine.harness.status", () => {
  it("reports present:false before generation and the report card after", async () => {
    dir = makeRepo();
    engine = createEngine();
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts: happyScripts() }));

    const before = await call("engine.harness.status", { projectDir: dir });
    expect(before.error).toBeUndefined();
    expect(before.result.present).toBe(false);

    const gen = await call("engine.harness.generate", { projectDir: dir });
    expect(gen.error).toBeUndefined();

    const after = await call("engine.harness.status", { projectDir: dir });
    expect(after.error).toBeUndefined();
    expect(after.result.present).toBe(true);
    expect(after.result.structural).toBe("pass");
    expect(after.result.evals).toBe("pending");
    expect(after.result.headSha).toHaveLength(40);
  }, 30_000);
});

describe("engine.harness.generate — coalescing", () => {
  it("coalesces two concurrent generate calls for the same project into one run", async () => {
    dir = makeRepo();
    engine = createEngine();
    const createSessionSpy = { count: 0 };
    engine.frontier.registerAdapter(makeScriptedAdapter({ scripts: happyScripts(), createSessionSpy }));

    const [a, b] = await Promise.all([
      call("engine.harness.generate", { projectDir: dir }),
      call("engine.harness.generate", { projectDir: dir }),
    ]);

    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(a.result).toEqual(b.result);
    // Only ONE frontier session (and therefore one writeHarness) was ever
    // created — the second RPC call piggybacked on the first's in-flight
    // promise instead of racing a second generation.
    expect(createSessionSpy.count).toBe(1);
  }, 30_000);
});
