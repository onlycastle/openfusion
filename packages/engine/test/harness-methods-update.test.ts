import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { createEngine, type Engine } from "../src/engine.js";
import type {
  FrontierAdapter,
  FrontierEvent,
  FrontierPromptHandle,
  FrontierSession,
} from "../src/engines/types.js";
import { harnessStatus, loadHarness, writeHarness } from "../src/harness/store.js";
import { CARD_SLUG, type HarnessBundle } from "../src/harness/schema.js";
import { readRuns } from "../src/runs/ledger.js";

let dir: string;
let engine: Engine;

afterEach(async () => {
  await engine.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

function bundle(): HarnessBundle {
  return {
    manifest: {
      schemaVersion: 1, generatorVersion: "test", engine: "test", headSha: "abc",
      generatedAt: "2026-07-06T00:00:00.000Z",
      verification: { structural: "pass", evals: "pending" }, artifacts: [],
    },
    pages: [{ slug: "architecture", title: "A", digest: "d", body: "b" }],
    agents: [
      { name: "coder", role: "writes code", description: "d", prompt: "p", taskClasses: ["codegen"],
        model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" },
        escalation: { maxAttempts: 2 } },
      { name: "reviewer", role: "reviews code", description: "d", prompt: "p", taskClasses: ["review"],
        model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" },
        escalation: { maxAttempts: 2 } },
    ],
    routing: {
      version: 1, taskClasses: { codegen: { agent: "coder" }, review: { agent: "reviewer" } },
      escalation: { failuresBeforeFrontier: 2 }, defaults: { agent: "coder" },
    },
  };
}

async function setup(): Promise<void> {
  engine = createEngine();
  dir = mkdtempSync(path.join(os.tmpdir(), "of-upd-"));
  await writeHarness(dir, bundle());
}

// bundle() plus a project-card page and the manifest's card verification
// field — the fixture card.update/card.approve exercise. Everything else
// about the base bundle is untouched.
function bundleWithCard(cardState: "draft" | "approved" = "draft"): HarnessBundle {
  const base = bundle();
  return {
    ...base,
    manifest: { ...base.manifest, verification: { ...base.manifest.verification, card: cardState } },
    pages: [...base.pages, { slug: CARD_SLUG, title: "Project Card", digest: "card digest", body: "card body" }],
  };
}

async function setupWithCard(cardState: "draft" | "approved" = "draft"): Promise<void> {
  engine = createEngine();
  dir = mkdtempSync(path.join(os.tmpdir(), "of-upd-card-"));
  await writeHarness(dir, bundleWithCard(cardState));
}

// Final review Fix 1 (approval-gate-bypass race): engine.harness.generate
// requires a real git repo (requireGitRepo) — this setup's own `dir` isn't
// one, so the approval-gate-race tests below need their own tiny git
// fixture instead.
function makeGitRepo(prefix = "of-upd-gen-"): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", d]);
  execFileSync("git", ["-C", d, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", d, "config", "user.name", "t"]);
  writeFileSync(path.join(d, "README.md"), "hello\n");
  execFileSync("git", ["-C", d, "add", "-A"]);
  execFileSync("git", ["-C", d, "commit", "-qm", "init"]);
  return d;
}

// A scripted FrontierAdapter whose single session's FIRST prompt (the
// generation pipeline's "overview" stage) hangs on an externally-controlled
// gate until release() is called — this is what makes
// engine.harness.generate genuinely IN FLIGHT (not merely "not yet awaited")
// for the whole window the race tests below probe, mirroring
// harness-generate.test.ts's own makeScriptedAdapter pattern but blocking
// instead of scripting a full happy path. Once released, every prompt call
// (including retries) resolves with NO events at all — no text means no
// parseable JSON, so promptForJson exhausts its attempts and generateHarness
// fails fast. That failure is expected and irrelevant to what these tests
// assert: they only need generation BLOCKED during the race window, never
// successful, so letting it fail after release keeps cleanup simple (no
// need to script every remaining pipeline stage).
function makeBlockingAdapter(): { adapter: FrontierAdapter; release: () => void } {
  let releaseFn: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  const adapter: FrontierAdapter = {
    kind: "claude-code",
    async createSession({ projectDir }): Promise<FrontierSession> {
      return {
        id: "blocking-session",
        projectDir,
        prompt(): FrontierPromptHandle {
          async function* gen(): AsyncGenerator<FrontierEvent> {
            await gate;
          }
          return { events: gen(), abort: () => {} };
        },
        async close(): Promise<void> {},
      };
    },
  };
  return { adapter, release: () => releaseFn() };
}

describe("engine.harness.updateAgentModel", () => {
  it("reassigns an agent's model and persists it", async () => {
    await setup();
    const res = await call("engine.harness.updateAgentModel", {
      projectDir: dir, agentName: "coder",
      model: { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" },
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ updated: true });
    expect(loadHarness(dir)!.agents[0]!.model).toEqual({ kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" });
  });

  it("accepts the frontier sentinel", async () => {
    await setup();
    await call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "coder", model: "frontier" });
    expect(loadHarness(dir)!.agents[0]!.model).toBe("frontier");
  });

  it("errors on an unknown agent", async () => {
    await setup();
    const res = await call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "nope", model: "frontier" });
    expect(res.error.message).toMatch(/unknown agent/i);
  });

  it("errors on a malformed model", async () => {
    await setup();
    const res = await call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "coder", model: { kind: "moonshot" } });
    expect(res.error.message).toMatch(/invalid params/i);
  });

  it("preserves manifest provenance after a write", async () => {
    await setup();
    await call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "coder", model: "frontier" });
    const reloaded = loadHarness(dir)!;
    expect(reloaded.manifest.generatorVersion).toBe("test");
    expect(reloaded.manifest.artifacts.length).toBeGreaterThan(0);
  });

  // Regression for the lost-update race: mutateHarness does an unlocked
  // loadHarness -> mutate -> validate -> writeHarness. Without serializing
  // writes per project, two concurrent updateAgentModel calls targeting
  // DIFFERENT agents can both loadHarness() the pre-mutation bundle before
  // either writeHarness() lands, so whichever call's writeHarness finishes
  // LAST wins outright and silently clobbers the other call's change — the
  // reloaded bundle would show only one of the two models updated, never
  // both. Firing both calls via Promise.all (no artificial delay) is exactly
  // the shape the stdio pipeline produces when a user reassigns two agents
  // in quick succession, and is the reproduction this test asserts against.
  it("reassigns two different agents concurrently without losing either update", async () => {
    await setup();
    const [resA, resB] = await Promise.all([
      call("engine.harness.updateAgentModel", {
        projectDir: dir, agentName: "coder",
        model: { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" },
      }),
      call("engine.harness.updateAgentModel", {
        projectDir: dir, agentName: "reviewer",
        model: { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" },
      }),
    ]);
    expect(resA.error).toBeUndefined();
    expect(resB.error).toBeUndefined();

    const reloaded = loadHarness(dir)!;
    const coder = reloaded.agents.find((a) => a.name === "coder")!;
    const reviewer = reloaded.agents.find((a) => a.name === "reviewer")!;
    expect(coder.model).toEqual({ kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" });
    expect(reviewer.model).toEqual({ kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" });
  });
});

describe("engine.harness.updateEscalation", () => {
  it("sets failuresBeforeFrontier", async () => {
    await setup();
    const res = await call("engine.harness.updateEscalation", { projectDir: dir, failuresBeforeFrontier: 3 });
    expect(res.result).toEqual({ updated: true });
    expect(loadHarness(dir)!.routing.escalation.failuresBeforeFrontier).toBe(3);
  });

  it("errors on out-of-range values", async () => {
    await setup();
    const res = await call("engine.harness.updateEscalation", { projectDir: dir, failuresBeforeFrontier: 9 });
    expect(res.error.message).toMatch(/invalid params/i);
  });
});

describe("engine.harness.card.update", () => {
  it("edits the on-disk digest", async () => {
    await setupWithCard("draft");
    const res = await call("engine.harness.card.update", { projectDir: dir, digest: "new digest" });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ updated: true });
    const reloaded = loadHarness(dir)!;
    const page = reloaded.pages.find((p) => p.slug === CARD_SLUG)!;
    expect(page.digest).toBe("new digest");
    expect(reloaded.manifest.verification.card).toBe("draft");
  });

  it("resets an approved card back to draft on edit", async () => {
    await setupWithCard("approved");
    const res = await call("engine.harness.card.update", { projectDir: dir, digest: "edited digest" });
    expect(res.error).toBeUndefined();
    const reloaded = loadHarness(dir)!;
    expect(reloaded.manifest.verification.card).toBe("draft");
    const page = reloaded.pages.find((p) => p.slug === CARD_SLUG)!;
    expect(page.digest).toBe("edited digest");
  });

  it("errors when the project has no card", async () => {
    await setup();
    const res = await call("engine.harness.card.update", { projectDir: dir, digest: "x" });
    expect(res.result).toBeUndefined();
    expect(res.error.message).toMatch(/no project card; regenerate the harness first/i);
  });
});

describe("engine.harness.card.approve", () => {
  it("flips harnessStatus(dir).card to approved and preserves every other manifest field", async () => {
    await setupWithCard("draft");
    const before = loadHarness(dir)!.manifest;
    const res = await call("engine.harness.card.approve", { projectDir: dir });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ approved: true });
    expect(harnessStatus(dir).card).toBe("approved");
    const after = loadHarness(dir)!.manifest;
    expect(after).toEqual({ ...before, verification: { ...before.verification, card: "approved" } });
  });

  it("errors on a legacy harness with no card", async () => {
    await setup();
    const res = await call("engine.harness.card.approve", { projectDir: dir });
    expect(res.result).toBeUndefined();
    expect(res.error.message).toMatch(/no project card; regenerate the harness first/i);
  });
});

// Task 4 (run ledger write point): card.update/card.approve each record a
// "card" action ONLY after their own serialized write has actually
// succeeded -- see harness/methods.ts's own doc comment on these two write
// points.
describe("engine.harness card actions — run ledger write point (Task 4)", () => {
  it("records a card 'update' action after a successful digest edit, then a card 'approve' action after approval, newest-first", async () => {
    await setupWithCard("draft");

    const updateRes = await call("engine.harness.card.update", { projectDir: dir, digest: "new digest" });
    expect(updateRes.error).toBeUndefined();

    const approveRes = await call("engine.harness.card.approve", { projectDir: dir });
    expect(approveRes.error).toBeUndefined();

    // readRuns returns newest-first (runs/ledger.ts's own doc comment) --
    // approve (written second) precedes update (written first).
    const { records } = readRuns(dir, { kind: "card" });
    expect(records).toHaveLength(2);
    expect(records.map((r) => (r.kind === "card" ? r.action : undefined))).toEqual(["approve", "update"]);
  });

  it("does not record a card action when the mutating write itself fails", async () => {
    await setup(); // no card page written -- card.update has nothing to edit
    const res = await call("engine.harness.card.update", { projectDir: dir, digest: "x" });
    expect(res.error).toBeDefined();
    expect(readRuns(dir, { kind: "card" }).records).toHaveLength(0);
  });
});

// Final review Fix 1 (Important — approval-gate bypass): HarnessService's
// #generating (coalesces engine.harness.generate calls) and #writeChain
// (serializes mutate calls) were NEVER cross-serialized, only each
// self-serialized. Generation's writeHarness call REPLACES THE WHOLE BUNDLE
// (every wiki page — including the project card — every agent, all of
// routing.yaml), so a mutate racing an in-flight regenerate was always
// unsafe: worst case, a user clicks Approve on a draft they are looking at
// in the desktop review panel at the exact moment a background regenerate
// has already replaced it on disk with an entirely different, never-
// reviewed draft — the approval they think they're granting to the card
// they read is silently granted to content they never saw at all. These
// tests pin engine.harness.isGenerating's guard on all four mutate RPC
// handlers (card.update, card.approve, updateAgentModel, updateEscalation)
// against a genuinely IN-FLIGHT generate (a blocking scripted adapter, not
// just an un-awaited promise), and that the gate reopens once generation
// settles.
describe("harness mutation RPCs vs. an in-flight regenerate (approval-gate-bypass race, final review Fix 1)", () => {
  it("engine.harness.card.approve is rejected with SERVER_ERROR while a regenerate is in flight, and the gate reopens once it settles", async () => {
    dir = makeGitRepo();
    engine = createEngine();
    const { adapter, release } = makeBlockingAdapter();
    engine.frontier.registerAdapter(adapter);

    // Deliberately NOT awaited: HarnessService.generate is a plain
    // (non-async) method, so calling it synchronously runs resolveProjectKey
    // -> the #generating map lookup -> generateHarness(...) -> .finally() ->
    // this.#generating.set(key, promise) to completion BEFORE generateHarness
    // itself ever reaches its own first `await` (requireGitRepo/wiki-build/
    // session-creation) — and every layer between here and there (the RPC
    // dispatcher, registerMethod's schema-parse wrapper, the RPC handler's
    // own try block) is equally synchronous up to that same point. So
    // #generating is already populated by the time this statement finishes,
    // with no polling or extra await needed — asserted directly below.
    const genPromise = call("engine.harness.generate", { projectDir: dir });
    expect(engine.harness.isGenerating(dir)).toBe(true);

    const res = await call("engine.harness.card.approve", { projectDir: dir });
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error.message).toBe("harness generation in progress; retry after it completes");

    // Release the hung generation and drain it — it is EXPECTED to fail
    // (the fake adapter emits no parseable JSON once released; see
    // makeBlockingAdapter's own doc comment) and that failure is irrelevant
    // here. What matters: the map entry clears, so...
    release();
    const genRes = await genPromise;
    expect(genRes.error).toBeDefined();
    expect(engine.harness.isGenerating(dir)).toBe(false);

    // ...a mutate call issued AFTER generation settles is no longer blocked
    // by THIS gate specifically (it still fails, but on the unrelated "no
    // valid harness" guard — this dir never had a bundle written to it —
    // proving the approval-gate check itself reopened rather than wedging
    // shut forever).
    const afterRes = await call("engine.harness.card.approve", { projectDir: dir });
    expect(afterRes.error.message).not.toMatch(/harness generation in progress/i);
  }, 15_000);

  it("updateAgentModel, updateEscalation, and card.update are ALSO rejected while a regenerate is in flight", async () => {
    dir = makeGitRepo();
    engine = createEngine();
    const { adapter, release } = makeBlockingAdapter();
    engine.frontier.registerAdapter(adapter);

    const genPromise = call("engine.harness.generate", { projectDir: dir });
    expect(engine.harness.isGenerating(dir)).toBe(true);

    const results = await Promise.all([
      call("engine.harness.updateAgentModel", { projectDir: dir, agentName: "coder", model: "frontier" }),
      call("engine.harness.updateEscalation", { projectDir: dir, failuresBeforeFrontier: 3 }),
      call("engine.harness.card.update", { projectDir: dir, digest: "x" }),
    ]);
    for (const res of results) {
      expect(res.error.code).toBe(RpcErrorCodes.SERVER_ERROR);
      expect(res.error.message).toBe("harness generation in progress; retry after it completes");
    }

    release();
    await genPromise;
  }, 15_000);
});
