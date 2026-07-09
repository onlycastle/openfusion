import { describe, expect, it } from "vitest";
import {
  AgentDefSchema,
  CARD_SLUG,
  HarnessBundleSchema,
  ManifestSchema,
  PROSE_PAGE_SLUGS,
  RoutingSchema,
  WIKI_PAGE_SLUGS,
  WikiPageSchema,
  validateHarness,
  type AgentDef,
  type HarnessBundle,
  type Manifest,
  type Routing,
  type WikiPage,
} from "../src/harness/schema.js";

function validManifest(): Manifest {
  return {
    schemaVersion: 1,
    generatorVersion: "0.0.1",
    engine: "claude-code",
    headSha: "abc123",
    generatedAt: "2026-07-03T12:00:00.000Z",
    verification: { structural: "pass", evals: "pending" },
    artifacts: [],
  };
}

function validPage(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    slug: "architecture",
    title: "Architecture",
    digest: "A short digest.",
    body: "# Architecture\n\nDetails.",
    ...overrides,
  };
}

function validAgent(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    name: "codegen-worker",
    role: "worker",
    description: "Writes and edits code for codegen tasks.",
    prompt: "You are a codegen specialist.",
    taskClasses: ["codegen"],
    model: { kind: "deepseek", model: "deepseek-chat" },
    escalation: { maxAttempts: 2 },
    ...overrides,
  };
}

function validRouting(overrides: Partial<Routing> = {}): Routing {
  return {
    version: 1,
    taskClasses: { codegen: { agent: "codegen-worker" } },
    escalation: { failuresBeforeFrontier: 2 },
    defaults: { agent: "codegen-worker" },
    ...overrides,
  };
}

function validBundle(): HarnessBundle {
  return {
    manifest: validManifest(),
    pages: [validPage()],
    agents: [validAgent()],
    routing: validRouting(),
  };
}

describe("WIKI_PAGE_SLUGS / PROSE_PAGE_SLUGS / CARD_SLUG", () => {
  it("WIKI_PAGE_SLUGS contains the project card slug; PROSE_PAGE_SLUGS does not", () => {
    expect(WIKI_PAGE_SLUGS).toContain(CARD_SLUG);
    expect(PROSE_PAGE_SLUGS).not.toContain(CARD_SLUG);
  });

  it("WIKI_PAGE_SLUGS is exactly the four prose pages plus the card, in that order", () => {
    expect(WIKI_PAGE_SLUGS).toEqual([...PROSE_PAGE_SLUGS, CARD_SLUG]);
  });

  it('CARD_SLUG is "project-card"', () => {
    expect(CARD_SLUG).toBe("project-card");
  });
});

describe("ManifestSchema", () => {
  it("accepts a well-formed manifest", () => {
    expect(ManifestSchema.safeParse(validManifest()).success).toBe(true);
  });

  it("accepts schemaVersion 1 and 2", () => {
    expect(ManifestSchema.safeParse({ ...validManifest(), schemaVersion: 1 }).success).toBe(true);
    expect(ManifestSchema.safeParse({ ...validManifest(), schemaVersion: 2 }).success).toBe(true);
  });

  it("rejects schemaVersion other than 1 or 2", () => {
    const result = ManifestSchema.safeParse({ ...validManifest(), schemaVersion: 3 });
    expect(result.success).toBe(false);
  });

  it("rejects an empty generatorVersion", () => {
    expect(ManifestSchema.safeParse({ ...validManifest(), generatorVersion: "" }).success).toBe(false);
  });

  it("rejects an empty engine", () => {
    expect(ManifestSchema.safeParse({ ...validManifest(), engine: "" }).success).toBe(false);
  });

  it("rejects an empty headSha", () => {
    expect(ManifestSchema.safeParse({ ...validManifest(), headSha: "" }).success).toBe(false);
  });

  it("rejects a non-ISO generatedAt", () => {
    expect(ManifestSchema.safeParse({ ...validManifest(), generatedAt: "not-a-date" }).success).toBe(false);
    expect(ManifestSchema.safeParse({ ...validManifest(), generatedAt: "2026-07-03" }).success).toBe(false);
  });

  it("rejects an invalid verification.structural value", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest(),
      verification: { structural: "maybe", evals: "pending" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid verification.evals value", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest(),
      verification: { structural: "pass", evals: "unknown" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts every documented verification combination", () => {
    for (const structural of ["pass", "fail"] as const) {
      for (const evals of ["pending", "pass", "fail"] as const) {
        expect(
          ManifestSchema.safeParse({ ...validManifest(), verification: { structural, evals } }).success,
        ).toBe(true);
      }
    }
  });

  it("accepts an explicit artifacts list of relative POSIX paths", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest(),
      artifacts: ["routing.yaml", "wiki/architecture.md", "agents/codegen-worker.yaml"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.artifacts).toEqual(["routing.yaml", "wiki/architecture.md", "agents/codegen-worker.yaml"]);
    }
  });

  it("defaults artifacts to [] when the field is omitted (older-shaped manifest)", () => {
    // Simulates a manifest written before this field existed: strip
    // `artifacts` from an otherwise-valid manifest before parsing.
    const { artifacts: _omitted, ...olderShapedManifest } = validManifest();
    const result = ManifestSchema.safeParse(olderShapedManifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.artifacts).toEqual([]);
    }
  });

  it("accepts and round-trips verification.card: \"draft\"", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest(),
      verification: { ...validManifest().verification, card: "draft" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verification.card).toBe("draft");
    }
  });

  it('accepts and round-trips verification.card: "approved"', () => {
    const result = ManifestSchema.safeParse({
      ...validManifest(),
      verification: { ...validManifest().verification, card: "approved" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verification.card).toBe("approved");
    }
  });

  it("parses a manifest WITHOUT verification.card (legacy — card stays undefined, not defaulted)", () => {
    const result = ManifestSchema.safeParse(validManifest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verification.card).toBeUndefined();
    }
  });

  it("rejects an invalid verification.card value", () => {
    const result = ManifestSchema.safeParse({
      ...validManifest(),
      verification: { ...validManifest().verification, card: "maybe" },
    });
    expect(result.success).toBe(false);
  });
});

describe("WikiPageSchema", () => {
  it("accepts a well-formed page", () => {
    expect(WikiPageSchema.safeParse(validPage()).success).toBe(true);
  });

  it("accepts every canonical WIKI_PAGE_SLUGS entry, including multi-hyphen kebab", () => {
    for (const slug of WIKI_PAGE_SLUGS) {
      expect(WikiPageSchema.safeParse(validPage({ slug })).success).toBe(true);
    }
  });

  it("rejects a non-kebab slug (uppercase)", () => {
    expect(WikiPageSchema.safeParse(validPage({ slug: "Architecture" })).success).toBe(false);
  });

  it("rejects a non-kebab slug (underscore)", () => {
    expect(WikiPageSchema.safeParse(validPage({ slug: "build_and_test" })).success).toBe(false);
  });

  it("rejects a non-kebab slug (leading hyphen)", () => {
    expect(WikiPageSchema.safeParse(validPage({ slug: "-architecture" })).success).toBe(false);
  });

  it("rejects a non-kebab slug (doubled hyphen)", () => {
    expect(WikiPageSchema.safeParse(validPage({ slug: "build--and-test" })).success).toBe(false);
  });

  it("rejects an empty title", () => {
    expect(WikiPageSchema.safeParse(validPage({ title: "" })).success).toBe(false);
  });

  it("accepts a digest at exactly the 2500-char ceiling", () => {
    expect(WikiPageSchema.safeParse(validPage({ digest: "x".repeat(2500) })).success).toBe(true);
  });

  it("rejects a digest over the 2500-char ceiling", () => {
    expect(WikiPageSchema.safeParse(validPage({ digest: "x".repeat(2501) })).success).toBe(false);
  });

  it("rejects an empty digest", () => {
    expect(WikiPageSchema.safeParse(validPage({ digest: "" })).success).toBe(false);
  });

  it("accepts an empty body (markdown body has no minimum length)", () => {
    expect(WikiPageSchema.safeParse(validPage({ body: "" })).success).toBe(true);
  });
});

describe("AgentDefSchema", () => {
  it("accepts a well-formed agent with a concrete model", () => {
    expect(AgentDefSchema.safeParse(validAgent()).success).toBe(true);
  });

  it('accepts model: "frontier"', () => {
    expect(AgentDefSchema.safeParse(validAgent({ model: "frontier" })).success).toBe(true);
  });

  it("accepts a concrete model without providerId (backward compatible)", () => {
    const result = AgentDefSchema.safeParse(
      validAgent({ model: { kind: "deepseek", model: "deepseek-chat" } }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.data.model !== "frontier") {
      expect(result.data.model.providerId).toBeUndefined();
    }
  });

  it("accepts a concrete model with providerId (M5b routing)", () => {
    const result = AgentDefSchema.safeParse(
      validAgent({ model: { kind: "deepseek", model: "deepseek-chat", providerId: "deepseek-prod" } }),
    );
    expect(result.success).toBe(true);
    if (result.success && result.data.model !== "frontier") {
      expect(result.data.model.providerId).toBe("deepseek-prod");
    }
  });

  it("rejects an unrecognized model literal", () => {
    expect(AgentDefSchema.safeParse(validAgent({ model: "cheap" as never })).success).toBe(false);
  });

  it("rejects a non-kebab name", () => {
    expect(AgentDefSchema.safeParse(validAgent({ name: "CodegenWorker" })).success).toBe(false);
  });

  it("rejects an empty role/description/prompt", () => {
    expect(AgentDefSchema.safeParse(validAgent({ role: "" })).success).toBe(false);
    expect(AgentDefSchema.safeParse(validAgent({ description: "" })).success).toBe(false);
    expect(AgentDefSchema.safeParse(validAgent({ prompt: "" })).success).toBe(false);
  });

  it("rejects empty taskClasses", () => {
    expect(AgentDefSchema.safeParse(validAgent({ taskClasses: [] })).success).toBe(false);
  });

  it("accepts escalation.maxAttempts at the 1..3 bounds", () => {
    expect(AgentDefSchema.safeParse(validAgent({ escalation: { maxAttempts: 1 } })).success).toBe(true);
    expect(AgentDefSchema.safeParse(validAgent({ escalation: { maxAttempts: 3 } })).success).toBe(true);
  });

  it("rejects escalation.maxAttempts outside 1..3", () => {
    expect(AgentDefSchema.safeParse(validAgent({ escalation: { maxAttempts: 0 } })).success).toBe(false);
    expect(AgentDefSchema.safeParse(validAgent({ escalation: { maxAttempts: 4 } })).success).toBe(false);
  });

  it("rejects a non-integer maxAttempts", () => {
    expect(AgentDefSchema.safeParse(validAgent({ escalation: { maxAttempts: 1.5 } })).success).toBe(false);
  });
});

describe("RoutingSchema", () => {
  it("accepts a well-formed routing table", () => {
    expect(RoutingSchema.safeParse(validRouting()).success).toBe(true);
  });

  it("accepts version 1 and 2", () => {
    expect(RoutingSchema.safeParse({ ...validRouting(), version: 1 }).success).toBe(true);
    expect(
      RoutingSchema.safeParse({
        version: 2,
        taskClasses: { codegen: { agent: "codegen-worker", routeId: "tc:codegen" } },
        escalation: { failuresBeforeFrontier: 2 },
        defaults: { agent: "codegen-worker", routeId: "tc:default" },
      }).success,
    ).toBe(true);
  });

  it("rejects version other than 1 or 2", () => {
    expect(RoutingSchema.safeParse({ ...validRouting(), version: 3 }).success).toBe(false);
  });

  it("accepts failuresBeforeFrontier at the 1..3 bounds", () => {
    expect(RoutingSchema.safeParse({ ...validRouting(), escalation: { failuresBeforeFrontier: 1 } }).success).toBe(
      true,
    );
    expect(RoutingSchema.safeParse({ ...validRouting(), escalation: { failuresBeforeFrontier: 3 } }).success).toBe(
      true,
    );
  });

  it("rejects failuresBeforeFrontier outside 1..3", () => {
    expect(RoutingSchema.safeParse({ ...validRouting(), escalation: { failuresBeforeFrontier: 0 } }).success).toBe(
      false,
    );
    expect(RoutingSchema.safeParse({ ...validRouting(), escalation: { failuresBeforeFrontier: 4 } }).success).toBe(
      false,
    );
  });

  it("rejects an empty defaults.agent", () => {
    expect(RoutingSchema.safeParse({ ...validRouting(), defaults: { agent: "" } }).success).toBe(false);
  });

  it("accepts an empty taskClasses map", () => {
    expect(RoutingSchema.safeParse({ ...validRouting(), taskClasses: {} }).success).toBe(true);
  });

  it("rejects a taskClasses entry missing agent", () => {
    const result = RoutingSchema.safeParse({
      ...validRouting(),
      taskClasses: { codegen: {} },
    });
    expect(result.success).toBe(false);
  });
});

describe("HarnessBundleSchema", () => {
  it("accepts a well-formed bundle", () => {
    expect(HarnessBundleSchema.safeParse(validBundle()).success).toBe(true);
  });

  it("rejects duplicate wiki page slugs", () => {
    const bundle = validBundle();
    bundle.pages = [validPage({ slug: "architecture" }), validPage({ slug: "architecture" })];
    const result = HarnessBundleSchema.safeParse(bundle);
    expect(result.success).toBe(false);
  });

  it("accepts an empty pages/agents set (structurally, cross-validation is separate)", () => {
    const bundle = validBundle();
    bundle.pages = [];
    bundle.agents = [];
    bundle.routing = { ...validRouting(), taskClasses: {}, defaults: { agent: "codegen-worker" } };
    expect(HarnessBundleSchema.safeParse(bundle).success).toBe(true);
  });
});

describe("validateHarness", () => {
  it("returns no issues for a fully cross-consistent bundle", () => {
    expect(validateHarness(validBundle())).toEqual([]);
  });

  it("catches a routing.taskClasses entry referencing an unknown agent", () => {
    const bundle = validBundle();
    bundle.routing = validRouting({ taskClasses: { codegen: { agent: "ghost-agent" } } });
    const issues = validateHarness(bundle);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      path: "routing.taskClasses.codegen.agent",
      message: 'references unknown agent "ghost-agent"',
    });
  });

  it("catches routing.defaults.agent referencing an unknown agent", () => {
    const bundle = validBundle();
    bundle.routing = validRouting({ defaults: { agent: "ghost-agent" } });
    const issues = validateHarness(bundle);
    expect(issues).toContainEqual({
      path: "routing.defaults.agent",
      message: 'references unknown agent "ghost-agent"',
    });
  });

  it("catches an agent task class with no routing.taskClasses entry", () => {
    const bundle = validBundle();
    bundle.agents = [validAgent({ taskClasses: ["codegen", "docs"] })];
    // routing only maps "codegen" — "docs" is unreachable.
    const issues = validateHarness(bundle);
    expect(issues).toContainEqual({
      path: "agents[0].taskClasses[1]",
      message: 'task class "docs" (agent "codegen-worker") has no routing.taskClasses entry',
    });
  });

  it("reports every issue, not just the first", () => {
    const bundle = validBundle();
    bundle.routing = validRouting({
      taskClasses: { codegen: { agent: "ghost-agent" } },
      defaults: { agent: "another-ghost" },
    });
    const issues = validateHarness(bundle);
    expect(issues).toHaveLength(2);
  });
});
