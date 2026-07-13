import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDef, HarnessBundle, Manifest, Routing, WikiPage } from "../src/harness/schema.js";
import { fingerprintHarness } from "../src/harness/fingerprint.js";
import { loadHarnessFingerprint, writeHarness } from "../src/harness/store.js";
import { upgradeHarnessV1ToV2 } from "../src/harness/upgrade.js";

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    generatorVersion: "0.0.1",
    engine: "claude-code",
    headSha: "abc123",
    generatedAt: "2026-07-10T00:00:00.000Z",
    verification: { structural: "pass", evals: "pending", card: "approved" },
    artifacts: [],
    ...overrides,
  };
}

function page(slug: string, overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    slug,
    title: slug === "project-card" ? "Project Card" : "Architecture",
    digest: `${slug} digest`,
    body: `# ${slug}\n\nDetails.`,
    ...overrides,
  };
}

function agent(name: string, overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name,
    role: "worker",
    description: `${name} worker`,
    prompt: `You are ${name}.`,
    taskClasses: [name === "docs-worker" ? "docs" : "codegen"],
    model: { kind: "deepseek", model: "deepseek-chat" },
    escalation: { maxAttempts: 2 },
    ...overrides,
  };
}

function routing(): Routing {
  return {
    version: 1,
    taskClasses: {
      codegen: { agent: "codegen-worker" },
      docs: { agent: "docs-worker" },
    },
    escalation: { failuresBeforeFrontier: 2 },
    defaults: { agent: "codegen-worker" },
  };
}

function bundle(): HarnessBundle {
  return {
    manifest: manifest(),
    pages: [page("project-card"), page("architecture")],
    agents: [agent("codegen-worker"), agent("docs-worker")],
    routing: routing(),
  };
}

function componentMap(bundleFingerprint: ReturnType<typeof fingerprintHarness>): Map<string, string> {
  return new Map(bundleFingerprint.components.map((component) => [component.id, component.digest]));
}

describe("fingerprintHarness", () => {
  it("returns a self-describing aggregate digest and sorted component refs without raw prose", () => {
    const fingerprint = fingerprintHarness(bundle());

    expect(fingerprint.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fingerprint.components.map((component) => component.id)).toEqual(
      [...fingerprint.components.map((component) => component.id)].sort(),
    );
    expect(fingerprint.components.map((component) => component.id)).toEqual(
      expect.arrayContaining([
        "agent.codegen-worker.prompt",
        "agent.docs-worker.prompt",
        "context.project-card",
        "context.wiki.architecture",
        "harness.source",
        "models.family-catalog",
        "models.roster",
        "review.policy",
        "retry.policy",
        "routing.policy",
        "tools.dialect-pack-catalog",
        "tools.registry",
      ]),
    );
    expect(JSON.stringify(fingerprint)).not.toContain("You are codegen-worker.");
    expect(JSON.stringify(fingerprint)).not.toContain("architecture digest");
    expect(JSON.stringify(fingerprint)).not.toContain("You are reviewing a change");
  });

  it("is invariant to page, agent, and routing-key insertion order", () => {
    const original = bundle();
    const reordered: HarnessBundle = {
      ...original,
      pages: [...original.pages].reverse(),
      agents: [...original.agents].reverse(),
      routing: {
        ...original.routing,
        taskClasses: {
          docs: { agent: "docs-worker" },
          codegen: { agent: "codegen-worker" },
        },
      } as Routing,
    };

    expect(fingerprintHarness(reordered)).toEqual(fingerprintHarness(original));
  });

  it("changes only the named prompt component plus the aggregate for one prompt edit", () => {
    const original = bundle();
    const changed: HarnessBundle = {
      ...original,
      agents: original.agents.map((a) =>
        a.name === "codegen-worker" ? { ...a, prompt: `${a.prompt} Keep diffs minimal.` } : a,
      ),
    };

    const before = fingerprintHarness(original);
    const after = fingerprintHarness(changed);
    const beforeComponents = componentMap(before);
    const afterComponents = componentMap(after);
    const changedIds = [...beforeComponents.keys()].filter(
      (id) => beforeComponents.get(id) !== afterComponents.get(id),
    );

    expect(after.digest).not.toBe(before.digest);
    expect(changedIds).toEqual(["agent.codegen-worker.prompt"]);
  });

  it("ignores volatile manifest timestamps, eval verdicts, and artifact ordering", () => {
    const original = bundle();
    const changed: HarnessBundle = {
      ...original,
      manifest: {
        ...original.manifest,
        generatedAt: "2026-07-10T23:59:59.000Z",
        verification: { ...original.manifest.verification, evals: "pass" },
        artifacts: ["agents/docs-worker.yaml", "routing.yaml", "wiki/architecture.md"],
      },
    };

    expect(fingerprintHarness(changed)).toEqual(fingerprintHarness(original));
  });

  it("changes project-card identity when approval state changes", () => {
    const original = bundle();
    const changed: HarnessBundle = {
      ...original,
      manifest: {
        ...original.manifest,
        verification: { ...original.manifest.verification, card: "draft" },
      },
    };

    const before = fingerprintHarness(original);
    const after = fingerprintHarness(changed);
    const changedIds = [...componentMap(before).keys()].filter(
      (id) => componentMap(before).get(id) !== componentMap(after).get(id),
    );

    expect(changedIds).toEqual(["context.project-card"]);
  });

  it("changes source identity when the harness head changes", () => {
    const original = bundle();
    const changed: HarnessBundle = {
      ...original,
      manifest: { ...original.manifest, headSha: "def456" },
    };

    const before = fingerprintHarness(original);
    const after = fingerprintHarness(changed);
    const changedIds = [...componentMap(before).keys()].filter(
      (id) => componentMap(before).get(id) !== componentMap(after).get(id),
    );

    expect(changedIds).toEqual(["harness.source"]);
  });

  it("normalizes an effective v1 bundle before hashing", () => {
    const v1 = bundle();
    const v2 = upgradeHarnessV1ToV2(v1);

    expect(fingerprintHarness(v1)).toEqual(fingerprintHarness(v2));
  });

  it("normalizes CRLF text without trimming meaningful whitespace", () => {
    const lf = bundle();
    const crlf: HarnessBundle = {
      ...lf,
      pages: lf.pages.map((p) => ({
        ...p,
        body: p.body.replaceAll("\n", "\r\n"),
      })),
      agents: lf.agents.map((a) => ({
        ...a,
        prompt: `${a.prompt}\r\nSecond line.`,
      })),
    };
    const normalizedLf: HarnessBundle = {
      ...lf,
      agents: lf.agents.map((a) => ({
        ...a,
        prompt: `${a.prompt}\nSecond line.`,
      })),
    };

    expect(fingerprintHarness(crlf)).toEqual(fingerprintHarness(normalizedLf));

    const whitespaceChanged: HarnessBundle = {
      ...normalizedLf,
      agents: normalizedLf.agents.map((a) =>
        a.name === "codegen-worker" ? { ...a, prompt: `${a.prompt} ` } : a,
      ),
    };
    expect(fingerprintHarness(whitespaceChanged).digest).not.toBe(
      fingerprintHarness(normalizedLf).digest,
    );
  });

  it("loads the fingerprint of the effective on-disk harness", async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), "of-harness-fingerprint-"));
    try {
      const input = bundle();
      await writeHarness(projectDir, input);

      expect(loadHarnessFingerprint(projectDir)).toEqual(fingerprintHarness(input));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("returns null when no harness exists on disk", () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), "of-harness-fingerprint-empty-"));
    try {
      expect(loadHarnessFingerprint(projectDir)).toBeNull();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
