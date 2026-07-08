import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcErrorCodes } from "@openfusion/shared";
import { createEngine, type Engine } from "../src/engine.js";
import { CARD_SLUG, type AgentDef, type HarnessBundle, type Manifest, type Routing, type WikiPage } from "../src/harness/schema.js";
import { writeHarness } from "../src/harness/store.js";

let dir: string;
let engine: Engine;

afterEach(async () => {
  if (engine !== undefined) await engine.close();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix = "of-harness-export-"): string {
  dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

async function call(method: string, params: unknown): Promise<any> {
  return engine.dispatcher.dispatch({ jsonrpc: "2.0", id: 1, method, params });
}

function validManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    generatorVersion: "0.0.1",
    engine: "claude-code",
    headSha: "abc123",
    generatedAt: "2026-07-03T12:00:00.000Z",
    verification: { structural: "pass", evals: "pending" },
    artifacts: [],
    ...overrides,
  };
}

function validBundle(overrides: Partial<HarnessBundle> = {}): HarnessBundle {
  const pages: WikiPage[] = [
    {
      slug: "architecture",
      title: "Architecture",
      digest: "A tiny demo repository with a single core module.",
      body: "# Architecture\n\nThe repo has one core module under `src/` that does the one thing it does.\n",
    },
    {
      slug: "build-and-test",
      title: "Build and Test",
      digest: "Build with pnpm build; test with pnpm test.",
      body: "# Build and Test\n\n- `pnpm build`\n- `pnpm test`\n",
    },
    {
      slug: "conventions",
      title: "Conventions",
      digest: "Use TypeScript strict mode; prefer explicit return types.",
      body: "# Conventions\n\n- Use TypeScript strict mode.\n- Prefer explicit return types.\n",
    },
  ];
  const agents: AgentDef[] = [
    {
      name: "codegen-worker",
      role: "worker",
      description: "Writes and edits code for codegen tasks.",
      prompt: "You are a codegen specialist.\nFollow the wiki digest and keep diffs minimal.",
      taskClasses: ["codegen", "refactor"],
      model: { kind: "deepseek", model: "deepseek-chat" },
      escalation: { maxAttempts: 2 },
    },
    {
      name: "docs-worker",
      role: "worker",
      description: "Writes documentation and tests.",
      prompt: "You are a docs and test specialist.",
      taskClasses: ["docs"],
      model: "frontier",
      escalation: { maxAttempts: 1 },
    },
  ];
  const routing: Routing = {
    version: 1,
    taskClasses: { codegen: { agent: "codegen-worker" }, refactor: { agent: "codegen-worker" }, docs: { agent: "docs-worker" } },
    escalation: { failuresBeforeFrontier: 2 },
    defaults: { agent: "codegen-worker" },
  };
  return {
    manifest: validManifest(),
    pages,
    agents,
    routing,
    ...overrides,
  };
}

describe("engine.harness.export — no valid harness", () => {
  it("returns SERVER_ERROR when no harness has been generated", async () => {
    makeDir();
    engine = createEngine();
    const res = await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error?.message).toMatch(/no valid harness/i);
  });

  it("returns SERVER_ERROR when the on-disk harness fails validateHarness (dangling routing reference)", async () => {
    makeDir();
    engine = createEngine();
    await writeHarness(dir, validBundle());
    // Corrupt routing.yaml to reference an agent that doesn't exist —
    // schema-valid YAML (writeHarness/loadHarness both parse it fine) but
    // referentially broken, exactly what validateHarness (not the zod
    // schema) is responsible for catching.
    writeFileSync(
      path.join(dir, ".openfusion/routing.yaml"),
      "version: 1\ntaskClasses:\n  codegen:\n    agent: ghost-worker\nescalation:\n  failuresBeforeFrontier: 2\ndefaults:\n  agent: ghost-worker\n",
    );

    const res = await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    expect(res.error?.code).toBe(RpcErrorCodes.SERVER_ERROR);
    expect(res.error?.message).toMatch(/no valid harness/i);
    // Unlike the loadHarness-null case (nothing on disk to report), THIS
    // failure is a validateHarness cross-check with concrete issues — the
    // error must carry them in data.issues rather than discarding them.
    expect(Array.isArray(res.error?.data?.issues)).toBe(true);
    expect(res.error?.data?.issues.length).toBeGreaterThan(0);
  });
});

describe("engine.harness.export — agents-md", () => {
  it("writes AGENTS.md with project summary, build/test info, conventions, roster table, and the UNVERIFIED caveat", async () => {
    makeDir();
    engine = createEngine();
    await writeHarness(dir, validBundle());

    const res = await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    expect(res.error).toBeUndefined();
    expect(res.result.files).toEqual(["AGENTS.md"]);

    const agentsMdPath = path.join(dir, "AGENTS.md");
    expect(existsSync(agentsMdPath)).toBe(true);
    const content = readFileSync(agentsMdPath, "utf8");

    // Project summary, from the architecture page.
    expect(content).toContain("A tiny demo repository with a single core module.");
    expect(content).toContain("one core module under `src/`");

    // Build/test commands, from the build-and-test page.
    expect(content).toContain("pnpm build");
    expect(content).toContain("pnpm test");

    // Conventions.
    expect(content).toContain("TypeScript strict mode");

    // Agent roster table: name, role, task classes, model.
    expect(content).toContain("codegen-worker");
    expect(content).toContain("codegen, refactor");
    expect(content).toContain("deepseek/deepseek-chat");
    expect(content).toContain("docs-worker");
    expect(content).toContain("frontier");

    // UNVERIFIED caveat — manifest.verification.evals is "pending".
    expect(content).toMatch(/UNVERIFIED/);
  });

  it("omits the UNVERIFIED caveat once manifest.verification.evals is pass", async () => {
    makeDir();
    engine = createEngine();
    await writeHarness(
      dir,
      validBundle({ manifest: validManifest({ verification: { structural: "pass", evals: "pass" } }) }),
    );

    const res = await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    expect(res.error).toBeUndefined();

    const content = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(content).not.toMatch(/UNVERIFIED/);
  });

  it("re-export overwrites AGENTS.md cleanly", async () => {
    makeDir();
    engine = createEngine();
    await writeHarness(dir, validBundle());
    await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    const first = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(first).toContain("codegen-worker");

    // Regenerate with a changed roster and re-export over the same path.
    await writeHarness(
      dir,
      validBundle({
        agents: [
          {
            name: "solo-worker",
            role: "worker",
            description: "The only agent left after regeneration.",
            prompt: "You are the solo worker.",
            taskClasses: ["codegen", "refactor", "docs"],
            model: { kind: "deepseek", model: "deepseek-chat" },
            escalation: { maxAttempts: 1 },
          },
        ],
        routing: {
          version: 1,
          taskClasses: {
            codegen: { agent: "solo-worker" },
            refactor: { agent: "solo-worker" },
            docs: { agent: "solo-worker" },
          },
          escalation: { failuresBeforeFrontier: 2 },
          defaults: { agent: "solo-worker" },
        },
      }),
    );
    await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    const second = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    expect(second).toContain("solo-worker");
    expect(second).not.toContain("codegen-worker");
    expect(second).not.toContain("docs-worker");
  });

  it("escapes pipe characters in roster table cells so a `|` in model output can't break the table", async () => {
    makeDir();
    engine = createEngine();
    await writeHarness(
      dir,
      validBundle({
        agents: [
          {
            name: "codegen-worker",
            role: "a | b",
            description: "Writes and edits code for codegen tasks.",
            prompt: "You are a codegen specialist.",
            taskClasses: ["codegen"],
            model: { kind: "deepseek", model: "deepseek-chat" },
            escalation: { maxAttempts: 2 },
          },
        ],
        routing: {
          version: 1,
          taskClasses: { codegen: { agent: "codegen-worker" } },
          escalation: { failuresBeforeFrontier: 2 },
          defaults: { agent: "codegen-worker" },
        },
      }),
    );

    const res = await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    expect(res.error).toBeUndefined();

    const content = readFileSync(path.join(dir, "AGENTS.md"), "utf8");
    const rosterLines = content.split("\n").filter((l) => l.startsWith("| codegen-worker"));
    // The unescaped "|" in role would otherwise split this into two broken
    // table rows — exactly one row must remain, with the pipe escaped.
    expect(rosterLines).toHaveLength(1);
    expect(rosterLines[0]).toContain("a \\| b");
    // Count of un-escaped "|" delimiters must still be exactly 5 (4 cells):
    // strip every escaped "\|" first so only real column delimiters remain.
    const delimiterCount = (rosterLines[0]!.replace(/\\\|/g, "").match(/\|/g) ?? []).length;
    expect(delimiterCount).toBe(5);
  });
});

const CARD_DIGEST = "Build with `pnpm build`; test with `pnpm test` — extracted straight from package.json scripts.";
const CARD_BODY = "# Project Card\n\nHand-approved summary of how to build, test, and navigate this repo.\n";

function cardPage(): WikiPage {
  return { slug: CARD_SLUG, title: "Project Card", digest: CARD_DIGEST, body: CARD_BODY };
}

describe("engine.harness.export — agents-md project card", () => {
  it("leads with the Project card section, directive, and digest before Project summary when the card is approved", async () => {
    makeDir();
    engine = createEngine();
    const base = validBundle();
    await writeHarness(dir, {
      ...base,
      pages: [...base.pages, cardPage()],
      manifest: validManifest({ verification: { structural: "pass", evals: "pending", card: "approved" } }),
    });

    const res = await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    expect(res.error).toBeUndefined();

    const content = readFileSync(path.join(dir, "AGENTS.md"), "utf8");

    expect(content).toContain("## Project card");
    expect(content).toContain(
      "Commands here are statically extracted, not execution-verified; if one fails, treat `package.json` scripts / CI workflows as ground truth.",
    );
    expect(content).toContain(CARD_DIGEST);
    expect(content).toContain("Hand-approved summary of how to build, test, and navigate this repo.");

    const cardIndex = content.indexOf("## Project card");
    const summaryIndex = content.indexOf("## Project summary");
    expect(cardIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(cardIndex).toBeLessThan(summaryIndex);

    // The card-led branch does not replace the UNVERIFIED caveat gate — it
    // still gates on evals, independently of card approval.
    expect(content).toMatch(/UNVERIFIED/);
  });

  it("still omits the UNVERIFIED caveat once evals pass, even with an approved card", async () => {
    makeDir();
    engine = createEngine();
    const base = validBundle();
    await writeHarness(dir, {
      ...base,
      pages: [...base.pages, cardPage()],
      manifest: validManifest({ verification: { structural: "pass", evals: "pass", card: "approved" } }),
    });

    await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    const content = readFileSync(path.join(dir, "AGENTS.md"), "utf8");

    expect(content).toContain("## Project card");
    expect(content).not.toMatch(/UNVERIFIED/);
  });

  it("emits no Project card section, and leaves output byte-identical to a harness with no card, while the card is still draft", async () => {
    makeDir();
    engine = createEngine();
    const base = validBundle();

    await writeHarness(dir, base);
    await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    const withoutCard = readFileSync(path.join(dir, "AGENTS.md"), "utf8");

    await writeHarness(dir, {
      ...base,
      pages: [...base.pages, cardPage()],
      manifest: validManifest({ verification: { structural: "pass", evals: "pending", card: "draft" } }),
    });
    await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    const withDraftCard = readFileSync(path.join(dir, "AGENTS.md"), "utf8");

    expect(withDraftCard).toEqual(withoutCard);
    expect(withDraftCard).not.toContain("## Project card");
    // Draft card still doesn't touch the UNVERIFIED gate.
    expect(withDraftCard).toMatch(/UNVERIFIED/);
  });

  it("emits no Project card section when verification.card is approved but no card page exists on the bundle", async () => {
    makeDir();
    engine = createEngine();
    const base = validBundle();

    await writeHarness(dir, base);
    await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    const withoutCard = readFileSync(path.join(dir, "AGENTS.md"), "utf8");

    // Manifest claims approved, but no CARD_SLUG page is present — the
    // both-exist discipline must still suppress the section.
    await writeHarness(
      dir,
      validBundle({
        manifest: validManifest({ verification: { structural: "pass", evals: "pending", card: "approved" } }),
      }),
    );
    await call("engine.harness.export", { projectDir: dir, format: "agents-md" });
    const withApprovedFlagNoPage = readFileSync(path.join(dir, "AGENTS.md"), "utf8");

    expect(withApprovedFlagNoPage).toEqual(withoutCard);
    expect(withApprovedFlagNoPage).not.toContain("## Project card");
  });
});

describe("engine.harness.export — claude-subagents", () => {
  it("writes one .md per agent under .claude/agents/ with frontmatter, prompt body, and wiki digests", async () => {
    makeDir();
    engine = createEngine();
    await writeHarness(dir, validBundle());

    const res = await call("engine.harness.export", { projectDir: dir, format: "claude-subagents" });
    expect(res.error).toBeUndefined();
    expect(res.result.files.sort()).toEqual(
      [path.join(".claude", "agents", "codegen-worker.md"), path.join(".claude", "agents", "docs-worker.md")].sort(),
    );

    const codegenPath = path.join(dir, ".claude", "agents", "codegen-worker.md");
    expect(existsSync(codegenPath)).toBe(true);
    const content = readFileSync(codegenPath, "utf8");

    // YAML frontmatter: name, description, read-only tools default.
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("name: codegen-worker");
    expect(content).toContain("description:");
    expect(content).toContain("Writes and edits code for codegen tasks.");
    expect(content).toContain("tools:");
    expect(content.toLowerCase()).toContain("read");

    // Model emitted as a comment, not a real `model:` field (Claude Code's
    // model names differ from our worker models).
    expect(content).toContain("# suggested worker: deepseek/deepseek-chat");
    expect(content).not.toMatch(/^model:/m);

    // Prompt body.
    expect(content).toContain("You are a codegen specialist.");
    expect(content).toContain("Follow the wiki digest and keep diffs minimal.");

    // Digest of relevant wiki pages appended.
    expect(content).toContain("A tiny demo repository with a single core module.");
    expect(content).toContain("Build with pnpm build; test with pnpm test.");
    expect(content).toContain("Use TypeScript strict mode; prefer explicit return types.");

    const docsPath = path.join(dir, ".claude", "agents", "docs-worker.md");
    const docsContent = readFileSync(docsPath, "utf8");
    expect(docsContent).toContain("name: docs-worker");
    expect(docsContent).toContain("# suggested worker: frontier");
    expect(docsContent).toContain("You are a docs and test specialist.");
  });

  it("creates .claude/agents/ parent directories as needed", async () => {
    makeDir();
    engine = createEngine();
    await writeHarness(dir, validBundle());
    expect(existsSync(path.join(dir, ".claude"))).toBe(false);

    await call("engine.harness.export", { projectDir: dir, format: "claude-subagents" });
    expect(existsSync(path.join(dir, ".claude", "agents"))).toBe(true);
    expect(readdirSync(path.join(dir, ".claude", "agents")).sort()).toEqual([
      "codegen-worker.md",
      "docs-worker.md",
    ]);
  });

  it("re-export overwrites each agent file cleanly", async () => {
    makeDir();
    engine = createEngine();
    await writeHarness(dir, validBundle());
    await call("engine.harness.export", { projectDir: dir, format: "claude-subagents" });

    await writeHarness(
      dir,
      validBundle({
        agents: [
          {
            name: "codegen-worker",
            role: "worker",
            description: "Writes and edits code for codegen tasks.",
            prompt: "UPDATED PROMPT BODY after regeneration.",
            taskClasses: ["codegen", "refactor"],
            model: { kind: "deepseek", model: "deepseek-chat" },
            escalation: { maxAttempts: 2 },
          },
          {
            name: "docs-worker",
            role: "worker",
            description: "Writes documentation and tests.",
            prompt: "You are a docs and test specialist.",
            taskClasses: ["docs"],
            model: "frontier",
            escalation: { maxAttempts: 1 },
          },
        ],
      }),
    );
    await call("engine.harness.export", { projectDir: dir, format: "claude-subagents" });

    const content = readFileSync(path.join(dir, ".claude", "agents", "codegen-worker.md"), "utf8");
    expect(content).toContain("UPDATED PROMPT BODY after regeneration.");
    expect(content).not.toContain("Follow the wiki digest and keep diffs minimal.");
  });

  it("adds an UNVERIFIED comment to frontmatter when the harness has not passed evals", async () => {
    makeDir();
    engine = createEngine();
    // validBundle()'s default manifest has verification.evals: "pending".
    await writeHarness(dir, validBundle());

    await call("engine.harness.export", { projectDir: dir, format: "claude-subagents" });

    for (const name of ["codegen-worker", "docs-worker"]) {
      const content = readFileSync(path.join(dir, ".claude", "agents", `${name}.md`), "utf8");
      // A YAML COMMENT inside the frontmatter block, not a real field — an
      // agent exported alone (without AGENTS.md) must still carry the
      // ETH-gate caveat somewhere a reviewer will actually see it.
      expect(content).toMatch(/^# UNVERIFIED:.*evals.*$/m);
      expect(content).not.toMatch(/^unverified:/im);
    }
  });

  it("omits the UNVERIFIED comment once the harness has passed evals", async () => {
    makeDir();
    engine = createEngine();
    await writeHarness(
      dir,
      validBundle({ manifest: validManifest({ verification: { structural: "pass", evals: "pass" } }) }),
    );

    await call("engine.harness.export", { projectDir: dir, format: "claude-subagents" });

    const content = readFileSync(path.join(dir, ".claude", "agents", "codegen-worker.md"), "utf8");
    expect(content).not.toMatch(/UNVERIFIED/);
  });
});
