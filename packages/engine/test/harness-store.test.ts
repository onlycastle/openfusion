import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDef, HarnessBundle, Manifest, Routing, WikiPage } from "../src/harness/schema.js";

// Toggled per-test to inject a failure into a single node:fs/promises
// writeFile call (matched by substring against the tmp path being written)
// while every other call passes through to the real implementation. This
// lets the atomicity tests fail exactly one artifact's write without
// disturbing the other artifacts writeHarness also writes in the same call,
// and without needing a hand-rolled fs double for the whole module.
const fsFailure = { matchSubstring: null as string | null };

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (filePath: unknown, ...rest: unknown[]) => {
      if (fsFailure.matchSubstring !== null && String(filePath).includes(fsFailure.matchSubstring)) {
        throw new Error("injected write failure");
      }
      return (actual.writeFile as (...args: unknown[]) => Promise<void>)(filePath, ...rest);
    },
  };
});

const { harnessDir, harnessStatus, loadHarness, writeHarness, HarnessValidationError } = await import(
  "../src/harness/store.js"
);

let dir: string;
afterEach(() => {
  fsFailure.matchSubstring = null;
  rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix = "of-harness-"): string {
  dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

function validManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    generatorVersion: "0.0.1",
    engine: "claude-code",
    headSha: "abc123",
    generatedAt: "2026-07-03T12:00:00.000Z",
    verification: { structural: "pass", evals: "pending" },
    // writeHarness always overwrites this with the actual set of files it
    // wrote (see expectedArtifacts below) — the value here is just a
    // schema-satisfying placeholder for whatever bundle input a test
    // constructs.
    artifacts: [],
    ...overrides,
  };
}

function validBundle(overrides: Partial<HarnessBundle> = {}): HarnessBundle {
  const pages: WikiPage[] = [
    {
      slug: "architecture",
      title: "Architecture",
      digest: "A short digest of the architecture page.",
      body: "# Architecture\n\nSome *markdown* body.\n",
    },
    {
      slug: "build-and-test",
      title: "Build and Test",
      digest: "How to build and test: pnpm build, pnpm test.",
      body: "# Build and Test\n\n- pnpm build\n- pnpm test\n",
    },
  ];
  const agents: AgentDef[] = [
    {
      name: "codegen-worker",
      role: "worker",
      description: "Writes and edits code for codegen tasks.",
      prompt: "You are a codegen specialist.\nFollow the wiki digest.",
      taskClasses: ["codegen"],
      model: { kind: "deepseek", model: "deepseek-chat" },
      escalation: { maxAttempts: 2 },
    },
  ];
  const routing: Routing = {
    version: 1,
    taskClasses: { codegen: { agent: "codegen-worker" } },
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

// writeHarness overwrites manifest.artifacts with the relative-path set it
// actually wrote (schema.ts's `Manifest.artifacts`), in routing → pages →
// agents order — this mirrors that computation so round-trip assertions can
// state what a freshly-written-and-reloaded bundle's manifest looks like,
// independent of whatever (irrelevant, always overwritten) `artifacts`
// value the input bundle happened to carry.
function expectedArtifacts(bundle: Pick<HarnessBundle, "pages" | "agents">): string[] {
  return [
    "routing.yaml",
    ...bundle.pages.map((p) => `wiki/${p.slug}.md`),
    ...bundle.agents.map((a) => `agents/${a.name}.yaml`),
  ];
}

describe("harnessDir", () => {
  it("joins projectDir with .openfusion", () => {
    makeDir();
    expect(harnessDir("/repo")).toBe(path.join("/repo", ".openfusion"));
  });
});

describe("writeHarness", () => {
  it("writes manifest.json, wiki pages, agent defs, and routing.yaml", async () => {
    makeDir();
    const bundle = validBundle();
    const { files } = await writeHarness(dir, bundle);

    expect(existsSync(path.join(dir, ".openfusion/manifest.json"))).toBe(true);
    expect(existsSync(path.join(dir, ".openfusion/wiki/architecture.md"))).toBe(true);
    expect(existsSync(path.join(dir, ".openfusion/wiki/build-and-test.md"))).toBe(true);
    expect(existsSync(path.join(dir, ".openfusion/agents/codegen-worker.yaml"))).toBe(true);
    expect(existsSync(path.join(dir, ".openfusion/routing.yaml"))).toBe(true);

    expect(files.sort()).toEqual(
      [
        path.join(".openfusion", "manifest.json"),
        path.join(".openfusion", "routing.yaml"),
        path.join(".openfusion", "wiki", "architecture.md"),
        path.join(".openfusion", "wiki", "build-and-test.md"),
        path.join(".openfusion", "agents", "codegen-worker.yaml"),
      ].sort(),
    );
  });

  it("writes wiki pages as frontmatter (title + digest) followed by the body", async () => {
    makeDir();
    await writeHarness(dir, validBundle());
    const raw = readFileSync(path.join(dir, ".openfusion/wiki/architecture.md"), "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain("title: Architecture");
    expect(raw).toContain("digest:");
    expect(raw).toContain("# Architecture");
    expect(raw.indexOf("---\n\n# Architecture")).toBeGreaterThan(-1);
  });

  it("rejects an invalid bundle before touching disk", async () => {
    makeDir();
    const bundle = validBundle();
    // @ts-expect-error deliberately invalid for the test
    bundle.manifest.schemaVersion = 2;
    await expect(writeHarness(dir, bundle)).rejects.toThrow();
    expect(existsSync(path.join(dir, ".openfusion"))).toBe(false);
  });

  it("creates .openfusion/.gitignore guarding cache/", async () => {
    makeDir();
    await writeHarness(dir, validBundle());
    const gitignore = readFileSync(path.join(dir, ".openfusion/.gitignore"), "utf8");
    expect(gitignore).toContain("cache/");
  });

  it("appends the cache/ guard to a pre-existing .gitignore that lacks it", async () => {
    makeDir();
    mkdirSync(path.join(dir, ".openfusion"), { recursive: true });
    writeFileSync(path.join(dir, ".openfusion/.gitignore"), "*.log\n");
    await writeHarness(dir, validBundle());
    const gitignore = readFileSync(path.join(dir, ".openfusion/.gitignore"), "utf8");
    expect(gitignore).toContain("*.log");
    expect(gitignore.split("\n").map((l) => l.trim())).toContain("cache/");
  });

  it("never touches .openfusion/cache/", async () => {
    makeDir();
    mkdirSync(path.join(dir, ".openfusion/cache"), { recursive: true });
    writeFileSync(path.join(dir, ".openfusion/cache/marker.txt"), "untouched");
    await writeHarness(dir, validBundle());
    expect(readFileSync(path.join(dir, ".openfusion/cache/marker.txt"), "utf8")).toBe("untouched");
    expect(readdirSync(path.join(dir, ".openfusion/cache"))).toEqual(["marker.txt"]);
  });
});

describe("writeHarness atomicity", () => {
  it("leaves no partial manifest.json and no leftover tmp file when its write fails", async () => {
    makeDir();
    fsFailure.matchSubstring = ".manifest.json.tmp-";
    await expect(writeHarness(dir, validBundle())).rejects.toThrow("injected write failure");

    expect(existsSync(path.join(dir, ".openfusion/manifest.json"))).toBe(false);
    const leftovers = existsSync(path.join(dir, ".openfusion"))
      ? readdirSync(path.join(dir, ".openfusion")).filter((f) => f.includes("manifest.json.tmp-"))
      : [];
    expect(leftovers).toEqual([]);
  });

  it("leaves no partial agent yaml and no leftover tmp file when its write fails", async () => {
    makeDir();
    fsFailure.matchSubstring = ".codegen-worker.yaml.tmp-";
    await expect(writeHarness(dir, validBundle())).rejects.toThrow("injected write failure");

    expect(existsSync(path.join(dir, ".openfusion/agents/codegen-worker.yaml"))).toBe(false);
    const leftovers = existsSync(path.join(dir, ".openfusion/agents"))
      ? readdirSync(path.join(dir, ".openfusion/agents")).filter((f) => f.includes("codegen-worker.yaml.tmp-"))
      : [];
    expect(leftovers).toEqual([]);
  });

  it("does not corrupt a pre-existing file when a re-write of it fails", async () => {
    makeDir();
    await writeHarness(dir, validBundle());
    const before = readFileSync(path.join(dir, ".openfusion/routing.yaml"), "utf8");

    fsFailure.matchSubstring = ".routing.yaml.tmp-";
    const nextBundle = validBundle({
      routing: {
        version: 1,
        taskClasses: { docs: { agent: "codegen-worker" } },
        escalation: { failuresBeforeFrontier: 3 },
        defaults: { agent: "codegen-worker" },
      },
    });
    await expect(writeHarness(dir, nextBundle)).rejects.toThrow("injected write failure");

    const after = readFileSync(path.join(dir, ".openfusion/routing.yaml"), "utf8");
    expect(after).toBe(before);
  });
});

describe("writeHarness manifest-last ordering", () => {
  it("does not create manifest.json when a non-manifest write fails on a fresh projectDir", async () => {
    makeDir();
    fsFailure.matchSubstring = ".codegen-worker.yaml.tmp-";
    await expect(writeHarness(dir, validBundle())).rejects.toThrow("injected write failure");

    expect(existsSync(path.join(dir, ".openfusion/manifest.json"))).toBe(false);
    expect(loadHarness(dir)).toBeNull();
  });

  it("leaves the OLD manifest and bundle untouched when a regeneration's non-manifest write fails", async () => {
    makeDir();
    const bundle = validBundle();
    await writeHarness(dir, bundle);

    fsFailure.matchSubstring = ".codegen-worker.yaml.tmp-";
    // Only the manifest (headSha) and the agent (whose write is about to
    // fail) differ from `bundle` — pages/routing are byte-identical to the
    // first generation's — so a coherent-old-bundle assertion holds
    // regardless of internal write ordering: nothing that already matches
    // is a "mix", and the one thing that doesn't match fails to write.
    const nextBundle = validBundle({
      manifest: validManifest({ headSha: "new-sha-999" }),
      agents: [{ ...bundle.agents[0]!, description: "Updated description for regeneration test." }],
    });
    await expect(writeHarness(dir, nextBundle)).rejects.toThrow("injected write failure");

    const manifestRaw = readFileSync(path.join(dir, ".openfusion/manifest.json"), "utf8");
    expect(JSON.parse(manifestRaw).headSha).toBe("abc123");
    expect(loadHarness(dir)).toEqual({
      ...bundle,
      manifest: { ...bundle.manifest, artifacts: expectedArtifacts(bundle) },
    });
  });

  it("never prunes prior-generation content when the manifest write itself fails", async () => {
    makeDir();
    const agentA: AgentDef = {
      name: "agent-a",
      role: "worker",
      description: "Agent A.",
      prompt: "You are agent A.",
      taskClasses: ["codegen"],
      model: { kind: "deepseek", model: "deepseek-chat" },
      escalation: { maxAttempts: 1 },
    };
    const agentB: AgentDef = {
      name: "agent-b",
      role: "worker",
      description: "Agent B.",
      prompt: "You are agent B.",
      taskClasses: ["docs"],
      model: { kind: "deepseek", model: "deepseek-chat" },
      escalation: { maxAttempts: 1 },
    };
    const bundleA = validBundle({ agents: [agentA, agentB] });
    await writeHarness(dir, bundleA);
    expect(existsSync(path.join(dir, ".openfusion/agents/agent-b.yaml"))).toBe(true);

    fsFailure.matchSubstring = ".manifest.json.tmp-";
    // bundle B drops agent-b — if prune ran before the (failing) manifest
    // write, agent-b.yaml would already be gone by the time the manifest
    // write throws. It must not be: prune only runs AFTER the new manifest
    // is safely committed, and this manifest write never commits.
    const bundleB = validBundle({
      manifest: validManifest({ headSha: "new-sha-999" }),
      agents: [agentA],
    });
    await expect(writeHarness(dir, bundleB)).rejects.toThrow("injected write failure");

    expect(existsSync(path.join(dir, ".openfusion/agents/agent-b.yaml"))).toBe(true);
    expect(existsSync(path.join(dir, ".openfusion/agents/agent-a.yaml"))).toBe(true);

    const manifestRaw = readFileSync(path.join(dir, ".openfusion/manifest.json"), "utf8");
    expect(JSON.parse(manifestRaw).headSha).toBe("abc123");

    const loaded = loadHarness(dir);
    expect(loaded?.agents.map((a) => a.name).sort()).toEqual(["agent-a", "agent-b"]);
  });
});

describe("writeHarness stale artifact pruning", () => {
  it("removes an agent file for an agent no longer in the bundle on regeneration", async () => {
    makeDir();
    const agentA: AgentDef = {
      name: "agent-a",
      role: "worker",
      description: "Agent A.",
      prompt: "You are agent A.",
      taskClasses: ["codegen"],
      model: { kind: "deepseek", model: "deepseek-chat" },
      escalation: { maxAttempts: 1 },
    };
    const agentB: AgentDef = {
      name: "agent-b",
      role: "worker",
      description: "Agent B.",
      prompt: "You are agent B.",
      taskClasses: ["docs"],
      model: { kind: "deepseek", model: "deepseek-chat" },
      escalation: { maxAttempts: 1 },
    };
    await writeHarness(dir, validBundle({ agents: [agentA, agentB] }));
    expect(existsSync(path.join(dir, ".openfusion/agents/agent-a.yaml"))).toBe(true);
    expect(existsSync(path.join(dir, ".openfusion/agents/agent-b.yaml"))).toBe(true);

    // The manifest this generation just wrote must record agent-b.yaml as
    // one of its artifacts — that's what makes it legitimately prunable on
    // the NEXT regeneration (as opposed to a hand-authored file, which is
    // never in any manifest.artifacts and must never be pruned).
    const manifestAfterFirstWrite = JSON.parse(readFileSync(path.join(dir, ".openfusion/manifest.json"), "utf8"));
    expect(manifestAfterFirstWrite.artifacts).toContain("agents/agent-b.yaml");

    await writeHarness(dir, validBundle({ agents: [agentA] }));

    expect(existsSync(path.join(dir, ".openfusion/agents/agent-b.yaml"))).toBe(false);
    expect(existsSync(path.join(dir, ".openfusion/agents/agent-a.yaml"))).toBe(true);
    const loaded = loadHarness(dir);
    expect(loaded?.agents.map((a) => a.name)).toEqual(["agent-a"]);

    // Pruning must stay scoped to wiki/ + agents/ — the cache/ guard is
    // untouched.
    const gitignore = readFileSync(path.join(dir, ".openfusion/.gitignore"), "utf8");
    expect(gitignore).toContain("cache/");
  });

  it("removes the old file for a renamed wiki page on regeneration", async () => {
    makeDir();
    const bundle = validBundle();
    await writeHarness(dir, bundle);
    expect(existsSync(path.join(dir, ".openfusion/wiki/architecture.md"))).toBe(true);

    const renamedPage: WikiPage = { ...bundle.pages[0]!, slug: "architecture-renamed" };
    await writeHarness(dir, validBundle({ pages: [renamedPage, bundle.pages[1]!] }));

    expect(existsSync(path.join(dir, ".openfusion/wiki/architecture.md"))).toBe(false);
    expect(existsSync(path.join(dir, ".openfusion/wiki/architecture-renamed.md"))).toBe(true);
    expect(existsSync(path.join(dir, ".openfusion/wiki/build-and-test.md"))).toBe(true);
    const loaded = loadHarness(dir);
    expect(loaded?.pages.map((p) => p.slug).sort()).toEqual(["architecture-renamed", "build-and-test"]);
  });

  it("never prunes hand-authored wiki/agent files that were never recorded in any manifest", async () => {
    makeDir();
    const bundle = validBundle();
    await writeHarness(dir, bundle);

    // A user (via the Harness editor, spec §7.4) drops these directly into
    // wiki/ and agents/ WITHOUT going through writeHarness — they were
    // never part of ANY generation's manifest.artifacts.
    writeFileSync(
      path.join(dir, ".openfusion/agents/handmade.yaml"),
      "name: handmade\nrole: worker\ndescription: Hand-authored via the Harness editor.\nprompt: You are a hand-authored agent.\ntaskClasses:\n  - custom\nmodel: frontier\nescalation:\n  maxAttempts: 1\n",
    );
    writeFileSync(
      path.join(dir, ".openfusion/wiki/notes.md"),
      "---\ntitle: Notes\ndigest: Hand-authored notes page.\n---\n\n# Notes\n\nHand-authored content.\n",
    );

    // Regenerate the SAME bundle again — neither hand-authored file is (or
    // ever was) in bundle.pages/bundle.agents, so a manifest-driven prune
    // must leave both alone.
    await writeHarness(dir, bundle);

    expect(existsSync(path.join(dir, ".openfusion/agents/handmade.yaml"))).toBe(true);
    expect(existsSync(path.join(dir, ".openfusion/wiki/notes.md"))).toBe(true);
  });
});

describe("loadHarness", () => {
  it("returns null when no harness has been generated", () => {
    makeDir();
    expect(loadHarness(dir)).toBeNull();
  });

  it("round-trips a written bundle", async () => {
    makeDir();
    const bundle = validBundle();
    await writeHarness(dir, bundle);
    const loaded = loadHarness(dir);
    expect(loaded).toEqual({
      ...bundle,
      manifest: { ...bundle.manifest, artifacts: expectedArtifacts(bundle) },
    });
  });

  it("round-trips a digest at the 1200-char ceiling and a multi-line prompt/body", async () => {
    makeDir();
    const bundle = validBundle();
    bundle.pages[0]!.digest = "x".repeat(1200);
    bundle.pages[0]!.body = "line one\nline two\n\n- bullet\n- bullet 2\n";
    bundle.agents[0]!.prompt = "Line 1.\nLine 2.\n\nLine 4 after a blank line.";
    await writeHarness(dir, bundle);
    expect(loadHarness(dir)).toEqual({
      ...bundle,
      manifest: { ...bundle.manifest, artifacts: expectedArtifacts(bundle) },
    });
  });

  it("throws HarnessValidationError when manifest.json is corrupt JSON", async () => {
    makeDir();
    await writeHarness(dir, validBundle());
    writeFileSync(path.join(dir, ".openfusion/manifest.json"), "{ not json");
    expect(() => loadHarness(dir)).toThrow(HarnessValidationError);
  });

  it("throws HarnessValidationError when manifest.json fails schema validation", async () => {
    makeDir();
    await writeHarness(dir, validBundle());
    writeFileSync(
      path.join(dir, ".openfusion/manifest.json"),
      JSON.stringify({ ...validManifest(), schemaVersion: 99 }),
    );
    expect(() => loadHarness(dir)).toThrow(HarnessValidationError);
  });

  it("throws HarnessValidationError when routing.yaml is invalid YAML", async () => {
    makeDir();
    await writeHarness(dir, validBundle());
    writeFileSync(path.join(dir, ".openfusion/routing.yaml"), "not: valid: yaml: [");
    expect(() => loadHarness(dir)).toThrow(HarnessValidationError);
  });

  it("throws HarnessValidationError when an agent file's name does not match its filename", async () => {
    makeDir();
    await writeHarness(dir, validBundle());
    rmSync(path.join(dir, ".openfusion/agents/codegen-worker.yaml"));
    writeFileSync(
      path.join(dir, ".openfusion/agents/codegen-worker.yaml"),
      "name: some-other-name\nrole: worker\ndescription: d\nprompt: p\ntaskClasses:\n  - codegen\nmodel: frontier\nescalation:\n  maxAttempts: 1\n",
    );
    expect(() => loadHarness(dir)).toThrow(HarnessValidationError);
  });

  it("throws HarnessValidationError when the wiki directory is missing", async () => {
    makeDir();
    await writeHarness(dir, validBundle());
    rmSync(path.join(dir, ".openfusion/wiki"), { recursive: true, force: true });
    expect(() => loadHarness(dir)).toThrow(HarnessValidationError);
  });

  it("throws HarnessValidationError when a wiki page is missing its frontmatter fence", async () => {
    makeDir();
    await writeHarness(dir, validBundle());
    writeFileSync(path.join(dir, ".openfusion/wiki/architecture.md"), "# no frontmatter here\n");
    expect(() => loadHarness(dir)).toThrow(HarnessValidationError);
  });
});

describe("harnessStatus", () => {
  it("reports present: false with null fields when absent", () => {
    makeDir();
    expect(harnessStatus(dir)).toEqual({ present: false, structural: null, evals: null, headSha: null });
  });

  it("reports manifest fields without requiring wiki/agents/routing to be readable", async () => {
    makeDir();
    await writeHarness(dir, validBundle());
    rmSync(path.join(dir, ".openfusion/wiki"), { recursive: true, force: true });
    rmSync(path.join(dir, ".openfusion/agents"), { recursive: true, force: true });
    rmSync(path.join(dir, ".openfusion/routing.yaml"), { force: true });

    expect(harnessStatus(dir)).toEqual({
      present: true,
      structural: "pass",
      evals: "pending",
      headSha: "abc123",
    });
  });

  it("reflects verification.structural: fail and evals: fail from the manifest", async () => {
    makeDir();
    await writeHarness(
      dir,
      validBundle({ manifest: validManifest({ verification: { structural: "fail", evals: "fail" } }) }),
    );
    expect(harnessStatus(dir)).toEqual({
      present: true,
      structural: "fail",
      evals: "fail",
      headSha: "abc123",
    });
  });
});
