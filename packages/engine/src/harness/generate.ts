// engine.harness.generate's pipeline (M4 task 4): wires the wiki index, a
// READ-ONLY frontier session, promptForJson (M4 task 3's driver), the
// harness schemas, and the atomic store (M4 task 2) into the "understanding
// phase" — the frontier proposes structured JSON per stage, THIS module
// assembles and validates it, and only a fully structurally-valid bundle
// ever reaches disk.
//
// SESSION INJECTION (testability): generateHarness never spawns a session
// itself — it looks up the frontier adapter already registered on
// `engine.frontier` for a fixed kind ("claude-code", the same default
// engine.frontier.start uses) via `FrontierService.getAdapter`, exactly the
// way engine.frontier.start does (engines/methods.ts). CI tests register a
// SCRIPTED FAKE adapter via the already-public `engine.frontier.registerAdapter`
// before calling generate — no new injection surface was needed; the
// existing adapter registry IS the injection point. The real (default)
// Claude adapter is registered by registerFrontierMethods and is only ever
// exercised by the env-gated smoke test.
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RpcErrorCodes } from "@openfusion/shared";
import type { Engine } from "../engine.js";
import { resolveFrontierSelection, type FrontierSelection } from "../engines/selection.js";
import { RpcMethodError } from "../rpc/errors.js";
import { requireGitRepo } from "../rpc/guards.js";
import { wikiDbPath } from "../wiki/store.js";
import { ENGINE_VERSION } from "../version.js";
import {
  DIALECT_PACK_CATALOG_VERSION,
  FAMILY_CATALOG_VERSION,
  resolveFamily,
} from "../models/catalog.js";
import { PRICING } from "../models/pricing.js";
import {
  CardContentSchema,
  composeCardBody,
  composeCardDigest,
  validateCardContent,
  type StrippedItem,
} from "./card.js";
import { HarnessGenError, promptForJson } from "./driver.js";
import type { RunSupervisor } from "../runtime/supervisor.js";
import { mineCommands, type MinedCommand } from "./mine.js";
import {
  AgentDefSchema,
  CARD_SLUG,
  HarnessBundleSchema,
  PROSE_PAGE_SLUGS,
  RoutingV2Schema,
  validateHarness,
  type WikiPage,
} from "./schema.js";
import { harnessStatus, writeHarness } from "./store.js";
import { upgradeRouting } from "./upgrade.js";

export interface GenerateHarnessResult {
  files: string[];
  reportCard: { structural: "pass"; operational: "insufficient-evidence" };
  estimatedCostUsd: number | null;
  pages: number;
  agents: number;
  note: string;
  // Commands/anchors the project-card stage's LLM output proposed but that
  // validateCardContent (M4 task 3) stripped as unverifiable — surfaced here
  // so the desktop review panel (spec §3.4) can show exactly what was
  // dropped and why, without re-deriving it itself.
  cardStripped: StrippedItem[];
}

const NOTE =
  "harness structure is verified; operational health accumulates from metadata-only production evidence";
const HARNESS_PROMPT_TIMEOUT_MS = 600_000;

const OverviewSchema = z.object({
  summary: z.string().min(1),
  subsystems: z.array(
    z.object({ name: z.string().min(1), path: z.string().min(1), purpose: z.string().min(1) }),
  ),
  conventions: z.array(z.string().min(1)),
  buildCommands: z.array(z.string().min(1)),
  testCommands: z.array(z.string().min(1)),
});
type Overview = z.infer<typeof OverviewSchema>;

// Matches WikiPageSchema's title/digest/body fields exactly (digest's
// 2500-char ceiling included) — slug is NOT part of this schema because the
// pipeline assigns it itself from PROSE_PAGE_SLUGS, never from model output.
const PageContentSchema = z.object({
  title: z.string().min(1),
  digest: z.string().min(1).max(2500),
  body: z.string(),
});

const AgentsRoutingSchema = z.object({
  agents: z.array(AgentDefSchema).min(2).max(5),
  // Accept v1 or v2 from the model; we normalize to v2 before write.
  routing: z.union([
    RoutingV2Schema,
    z.object({
      version: z.literal(1),
      taskClasses: z.record(z.string().min(1), z.object({ agent: z.string().min(1) })),
      escalation: z.object({ failuresBeforeFrontier: z.number().int().min(1).max(3) }),
      defaults: z.object({ agent: z.string().min(1) }),
    }),
  ]),
});

const PAGE_FOCUS: Record<(typeof PROSE_PAGE_SLUGS)[number], string> = {
  architecture:
    "Focus this page on system architecture: the major components, how they fit together, and how data flows between them.",
  subsystems:
    "Focus this page on a per-subsystem breakdown: what each subsystem named in overview.subsystems does and where it lives.",
  conventions:
    "Focus this page on coding conventions actually observed in this codebase: naming, error handling, testing style, and anything else a new contributor (human or AI worker) must follow.",
  "build-and-test":
    "Focus this page on how to build and test this project: the exact commands, expected outputs, and any prerequisites.",
};

interface WorkerModelOption {
  providerId: string;
  kind: string;
  model: string;
  inputPerMtok: number;
  outputPerMtok: number;
  family: string;
  dialectPack: string;
  costTier: string;
  bestFor: string[];
  avoidFor: string[];
}

// Cross-references configured providers (engine.models.registry.list(): id +
// kind, never an api key) against the pricing table's "<kind>/<model>" keys
// to build the agents-routing stage's model menu — the registry alone
// doesn't carry a specific model id (that's chosen per engine.models.complete
// call), so PRICING's keyspace is what actually enumerates candidate models
// for a configured provider kind. Phase 1: each option is annotated with
// family + default dialect pack from the bundled catalog.
function listWorkerModelOptions(engine: Engine): WorkerModelOption[] {
  const providers = engine.models.registry.list();
  const options: WorkerModelOption[] = [];
  for (const provider of providers) {
    for (const [key, pricing] of Object.entries(PRICING)) {
      const slashIdx = key.indexOf("/");
      if (slashIdx === -1) continue;
      const kind = key.slice(0, slashIdx);
      const model = key.slice(slashIdx + 1);
      if (kind !== provider.kind) continue;
      // Skip reference/* rows — not callable worker presets (pricing-only).
      if (kind.startsWith("reference")) continue;
      const family = resolveFamily(kind, model);
      options.push({
        providerId: provider.id,
        kind,
        model,
        inputPerMtok: pricing.inputPerMtok,
        outputPerMtok: pricing.outputPerMtok,
        family: family.id,
        dialectPack: family.defaultDialectPack,
        costTier: family.costTier,
        bestFor: family.bestFor,
        avoidFor: family.avoidFor,
      });
    }
  }
  return options;
}

function buildOverviewPrompt(): string {
  return [
    "You are generating a structural overview of this repository for an AI coding harness.",
    "Before writing anything, use the wiki_map tool (and wiki_query for specific symbols as needed) to explore the codebase cheaply — do NOT try to read every file by hand; the wiki index exists precisely so you don't have to (token thrift).",
    "Once you understand the repository's shape, respond with ONLY a single JSON code block matching this exact shape:",
    "```json\n" +
      JSON.stringify(
        {
          summary: "one paragraph describing what this project is and does",
          subsystems: [{ name: "string", path: "string", purpose: "string" }],
          conventions: ["string — one convention per entry"],
          buildCommands: ["string — one shell command per entry"],
          testCommands: ["string — one shell command per entry"],
        },
        null,
        2,
      ) +
      "\n```",
    "subsystems should cover the project's major components; conventions should capture conventions actually observed in the codebase (not generic advice); buildCommands/testCommands should be commands a contributor would actually run.",
  ].join("\n\n");
}

function buildPagePrompt(slug: (typeof PROSE_PAGE_SLUGS)[number], overview: Overview): string {
  return [
    `You are writing the "${slug}" wiki page of this repository's AI coding harness.`,
    "Use the repository overview below as context — do NOT re-explore the repository; write directly from this context.",
    "```json\n" + JSON.stringify(overview, null, 2) + "\n```",
    PAGE_FOCUS[slug],
    "Respond with ONLY a single JSON code block matching this exact shape:",
    "```json\n" +
      JSON.stringify(
        {
          title: "string",
          digest:
            "string, at most 1200 characters — the token-budgeted summary a worker agent will actually read",
          body: "string — the full markdown page body",
        },
        null,
        2,
      ) +
      "\n```",
  ].join("\n\n");
}

// Sibling of buildPagePrompt, but for the project card (spec §3.1/§3.2)
// rather than a prose page: lists every deterministically-mined command
// (mineCommands, M4 task 2) with its source(s) as the highest-trust input,
// and states the content rules verbatim from spec §3.2/the task brief —
// what belongs on a card injected into EVERY worker prompt unconditionally,
// and what's explicitly forbidden. validateCardContent (M4 task 3) is the
// actual enforcement point; this prompt is only the first line of defense.
function buildCardPrompt(overview: Overview, mined: MinedCommand[]): string {
  const minedList =
    mined.length > 0
      ? mined.map((m) => `- \`${m.command}\` (source: ${m.sources.join(", ")})`).join("\n")
      : "(no commands could be mined from this project's manifests or CI config)";

  return [
    "You are drafting the Project Card for this repository's AI coding harness — the ONE wiki page that gets injected into EVERY worker prompt unconditionally, unlike the four prose pages above (which a worker consults on demand).",
    "Repository overview:",
    "```json\n" + JSON.stringify(overview, null, 2) + "\n```",
    "Commands mined directly from this project's own manifests and CI config — the highest-trust source available; strongly prefer these over anything you invent:",
    minedList,
    "When a command's `command` field is one of the mined commands above, copy it VERBATIM — the exact string as listed, character for character, with no reformatting, added/removed flags, or reworded quoting — into your response. validateCardContent (the pipeline's next stage) only trusts an EXACT string match against the mined list; a reformatted mined command is indistinguishable from an invented one and will be stripped, even though it started as real, mined, ground-truth data.",
    "Select ONLY commands a contributor actually needs to build, test, lint, or run this project — prefer the mined commands above. If you propose a command that is NOT in the mined list, it MUST name a script or make/just target that genuinely exists in this project (e.g. a package.json script you can see in the overview, or a Makefile/justfile target) — an invented command that resolves to nothing real will be stripped before this card ever reaches a worker or a human reviewer.",
    "Include: the exact commands a contributor runs (each with a short reason), environment prerequisites (required env vars, tool versions, local services), hard invariants and do-not-touch boundaries (secrets, vendor directories, generated files, production configs — anything that must never be hand-edited), factual navigation anchors (bare repo-relative paths to where a worker actually needs to look), a short glossary of project-specific terms, and gotchas that grep or a directory listing cannot reveal on their own. If this card ever runs long, commands/env/boundaries are kept in full and never trimmed — glossary, then gotchas, then anchors are dropped first — so put your highest-value facts in commands/env/boundaries.",
    'FORBIDDEN: prose architecture overviews (that is the "architecture" page\'s job, not this one), anything derivable by simply reading one obvious file, and procedural workflow directives ("always run X before Y", "first do A, then B") — this card is read by four different worker model families with different capabilities and habits, so it must state facts and boundaries, never dictate a workflow.',
    "Respond with ONLY a single JSON code block matching this exact shape:",
    "```json\n" +
      JSON.stringify(
        {
          title: "string",
          commands: [{ command: "string — one exact shell command", why: "string — short reason, max 80 chars" }],
          env: ["string — one environment prerequisite per entry"],
          boundaries: ["string — one do-not-touch boundary per entry"],
          anchors: [{ path: "string — repo-relative path", note: "string", symbol: "string (optional)" }],
          glossary: [{ term: "string", meaning: "string" }],
          gotchas: ["string — one gotcha per entry"],
        },
        null,
        2,
      ) +
      "\n```",
  ].join("\n\n");
}

function buildAgentsRoutingPrompt(overview: Overview, workerModels: WorkerModelOption[]): string {
  const modelMenu =
    workerModels.length > 0
      ? workerModels
          .map(
            (m) =>
              `- providerId: ${m.providerId}, kind: ${m.kind}, model: ${m.model}, family: ${m.family}, dialectPack: ${m.dialectPack}, costTier: ${m.costTier} — $${m.inputPerMtok}/Mtok in, $${m.outputPerMtok}/Mtok out` +
              (m.bestFor.length > 0 ? `; bestFor: ${m.bestFor.join(", ")}` : "") +
              (m.avoidFor.length > 0 ? `; avoidFor: ${m.avoidFor.join(", ")}` : ""),
          )
          .join("\n")
      : '(no worker models are configured — assign "frontier" to every agent)';

  return [
    "You are designing the specialist-agent routing table for this repository's AI coding harness.",
    "Repository overview:",
    "```json\n" + JSON.stringify(overview, null, 2) + "\n```",
    "Configured worker models (cost is per million tokens; family + dialectPack come from the engine catalog — copy them when assigning a model):",
    modelMenu,
    "Propose 2 to 5 specialist agents, each mapped to one or more task classes (cover at minimum: codegen, docs, tests, search, refactor), each assigned the CHEAPEST worker model adequate for its task classes — including that model's providerId, family, and dialectPack from the menu above — or the literal string \"frontier\" if no configured worker model is adequate.",
    "Also produce the routing.yaml content: version 2, every task class maps to exactly one agent (with optional routeId), escalation.failuresBeforeFrontier defaults to 2, and defaults.agent names a sensible fallback agent.",
    "Respond with ONLY a single JSON code block matching this exact shape:",
    "```json\n" +
      JSON.stringify(
        {
          agents: [
            {
              name: "kebab-case-name",
              role: "string",
              description: "string",
              prompt: "string — the system prompt this agent will run with",
              taskClasses: ["codegen"],
              model: {
                kind: "string",
                model: "string",
                providerId: "string",
                family: "string",
                dialectPack: "string",
              },
              escalation: { maxAttempts: 2 },
            },
          ],
          routing: {
            version: 2,
            taskClasses: { codegen: { agent: "kebab-case-name", routeId: "tc:codegen" } },
            escalation: { failuresBeforeFrontier: 2 },
            defaults: { agent: "kebab-case-name", routeId: "tc:default" },
          },
        },
        null,
        2,
      ) +
      "\n```",
    'model may also be the literal string "frontier" instead of an object. providerId/family/dialectPack should be set from the model menu whenever a specific worker model is assigned.',
  ].join("\n\n");
}

/** Fill missing family/dialectPack on agent models from the catalog (post-LLM). */
function pinAgentFamilies(
  agents: z.infer<typeof AgentsRoutingSchema>["agents"],
): z.infer<typeof AgentsRoutingSchema>["agents"] {
  return agents.map((agent) => {
    if (agent.model === "frontier") return agent;
    const family = agent.model.family ?? resolveFamily(agent.model.kind, agent.model.model).id;
    const dialectPack =
      agent.model.dialectPack ?? resolveFamily(agent.model.kind, agent.model.model).defaultDialectPack;
    return {
      ...agent,
      model: { ...agent.model, family, dialectPack },
    };
  });
}

// Mirrors engine.wiki.status's own built/stale gate (wiki/methods.ts):
// existsSync(wikiDbPath) first so asking "does this need a build" never has
// the side effect of creating an empty wiki.db for a project nobody has
// indexed yet.
function wikiNeedsBuild(engine: Engine, projectDir: string, currentSha: string): boolean {
  if (!existsSync(wikiDbPath(path.resolve(projectDir)))) return true;
  const store = engine.wiki.getStore(projectDir);
  const headSha = store.getMeta("head_sha");
  return headSha === null || headSha !== currentSha;
}

// Null-safe running total — same shape as driver.ts's private addCost, kept
// as an intentional local duplicate (three lines, not worth exporting from
// driver.ts for one caller).
function addCost(total: number | null, next: number | null): number | null {
  if (next === null) return total;
  return (total ?? 0) + next;
}

// The pipeline itself. Stateless and re-entrant per call — HarnessService
// (./methods.ts) is what coalesces concurrent calls for the same project;
// this function always runs a full generation from scratch.
export async function generateHarness(
  engine: Engine,
  projectDir: string,
  frontierSelection?: FrontierSelection,
  supervisor?: RunSupervisor,
): Promise<GenerateHarnessResult> {
  const headSha = requireGitRepo(projectDir);
  const frontier = resolveFrontierSelection(frontierSelection);

  const adapter = engine.frontier.getAdapter(frontier.engine);
  if (adapter === undefined) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown frontier engine: ${frontier.engine}`);
  }

  const notify = (stage: string, detail: string): void => {
    engine.notify("harness.progress", { projectDir, stage, detail });
  };

  const needsBuild = wikiNeedsBuild(engine, projectDir, headSha);
  notify("wiki-check", needsBuild ? "wiki index is stale or absent — building" : "wiki index is up to date");
  if (needsBuild) {
    await engine.wiki.build(projectDir);
  }
  const mcpServer = await engine.wiki.startMcpServer(engine, projectDir);

  // READ-ONLY: no toolPolicy — generation sessions only ever propose JSON;
  // this pipeline is the sole writer (see writeHarness below).
  const session = await engine.providerGateway.createFrontierSession(adapter, {
    projectDir,
    wikiMcpUrl: mcpServer.url,
    wikiMcpBearerToken: mcpServer.bearerToken,
    log: engine.log,
    model: frontier.model,
    // Final review Fix 2: an hour-long, ONE-TIME harness-generation run is
    // not per-task review overhead — tag it distinctly so
    // engines/methods.ts's onResult hook meters it under source
    // "frontier-generate" instead of the "frontier-review" default, which
    // otherwise breaks M6's per-task cost amortization math (see
    // models/meter.ts's UsageSource doc comment).
    resultLabel: "frontier-generate",
  });
  // M6 Task 1 (eval-batch safety gate): this session is created DIRECTLY off
  // the registered adapter, bypassing engine.frontier.start entirely — it
  // never gets a sessionId and never touches FrontierService's own
  // #sessions bookkeeping, so Engine.close() had no way to reach (and
  // force-kill) it before this fix. track() registers it for close()-time
  // reachability; the returned untrack fn is called in the same `finally`
  // below where the session is actually closed.
  const untrackSession = engine.frontier.track(session);

  try {
    let costUsd: number | null = null;

    notify("overview", "exploring repository structure via the wiki");
    const overviewResult = await promptForJson(session, buildOverviewPrompt(), OverviewSchema, {
      stage: "overview",
      timeoutMs: HARNESS_PROMPT_TIMEOUT_MS,
      beforePrompt: () => supervisor?.reserveModelCall(),
      onAttemptCost: (cost) => supervisor?.recordCost(cost, cost === null ? "unpriced" : "verified"),
      notify: (n) => notify("overview", `${n.kind}: ${n.detail}`),
    });
    costUsd = addCost(costUsd, overviewResult.costUsd);
    const overview = overviewResult.value;

    const pages: WikiPage[] = [];
    for (const slug of PROSE_PAGE_SLUGS) {
      const stage = `page:${slug}`;
      notify(stage, `generating the "${slug}" wiki page`);
      const pageResult = await promptForJson(session, buildPagePrompt(slug, overview), PageContentSchema, {
        stage,
        timeoutMs: HARNESS_PROMPT_TIMEOUT_MS,
        beforePrompt: () => supervisor?.reserveModelCall(),
        onAttemptCost: (cost) => supervisor?.recordCost(cost, cost === null ? "unpriced" : "verified"),
        notify: (n) => notify(stage, `${n.kind}: ${n.detail}`),
      });
      costUsd = addCost(costUsd, pageResult.costUsd);
      pages.push({ slug, ...pageResult.value });
    }

    notify("mine", "mining build/test commands from manifests and CI");
    const mined = await mineCommands(projectDir);
    notify(`page:${CARD_SLUG}`, "generating the project card (draft)");
    const cardResult = await promptForJson(session, buildCardPrompt(overview, mined), CardContentSchema, {
      stage: `page:${CARD_SLUG}`,
      timeoutMs: HARNESS_PROMPT_TIMEOUT_MS,
      beforePrompt: () => supervisor?.reserveModelCall(),
      onAttemptCost: (cost) => supervisor?.recordCost(cost, cost === null ? "unpriced" : "verified"),
      notify: (n) => notify(`page:${CARD_SLUG}`, `${n.kind}: ${n.detail}`),
    });
    costUsd = addCost(costUsd, cardResult.costUsd);
    const store = engine.wiki.getStore(projectDir);
    const { content: card, stripped } = validateCardContent(cardResult.value, {
      mined,
      projectDir,
      symbolExists: (name) => store.symbolsByName(name).length > 0,
    });
    pages.push({
      slug: CARD_SLUG,
      title: card.title,
      digest: composeCardDigest(card),
      body: composeCardBody(card, mined, stripped),
    });

    notify("agents-routing", "designing specialist agents and routing");
    const workerModels = listWorkerModelOptions(engine);
    const agentsResult = await promptForJson(
      session,
      buildAgentsRoutingPrompt(overview, workerModels),
      AgentsRoutingSchema,
      {
        stage: "agents-routing",
        timeoutMs: HARNESS_PROMPT_TIMEOUT_MS,
        beforePrompt: () => supervisor?.reserveModelCall(),
        onAttemptCost: (cost) => supervisor?.recordCost(cost, cost === null ? "unpriced" : "verified"),
        notify: (n) => notify("agents-routing", `${n.kind}: ${n.detail}`),
      },
    );
    costUsd = addCost(costUsd, agentsResult.costUsd);
    const agents = pinAgentFamilies(agentsResult.value.agents);
    const routing = upgradeRouting(agentsResult.value.routing);

    notify("write", "assembling and structurally validating the harness bundle");
    const candidateBundle = {
      manifest: {
        schemaVersion: 2 as const,
        generatorVersion: ENGINE_VERSION,
        engine: frontier.engine,
        planningFrontier: frontier,
        headSha,
        generatedAt: new Date().toISOString(),
        verification: { structural: "pass" as const, card: "draft" as const },
        artifacts: [],
        harnessProfile: "openfusion-native" as const,
        familyCatalogVersion: FAMILY_CATALOG_VERSION,
        dialectPackVersion: DIALECT_PACK_CATALOG_VERSION,
        routePolicyVersion: "2",
      },
      pages,
      agents,
      routing,
    };

    // Full schema re-validation (not just the cross-artifact check below)
    // before anything is written: a per-stage schema (OverviewSchema,
    // PageContentSchema, AgentsRoutingSchema) already constrains most
    // fields, but this is the single point that validates the ASSEMBLED
    // bundle as a whole and gives writeHarness a value it never needs to
    // reject — issues surface here as HarnessGenError, matching the
    // cross-artifact check below, rather than as a raw ZodError out of
    // writeHarness's own internal parse.
    const parsed = HarnessBundleSchema.safeParse(candidateBundle);
    if (!parsed.success) {
      throw new HarnessGenError(
        "generated harness failed schema validation",
        1,
        parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        "write",
      );
    }

    const issues = validateHarness(parsed.data);
    if (issues.length > 0) {
      throw new HarnessGenError(
        `generated harness failed structural validation (${issues.length} issue(s))`,
        1,
        issues,
        "write",
      );
    }

    supervisor?.throwIfAborted();
    if (supervisor !== undefined && requireGitRepo(projectDir) !== supervisor.taskSnapshot.baseSha) {
      throw new HarnessGenError("project HEAD changed during harness generation", 1, [], "write");
    }
    const { files } = await writeHarness(projectDir, parsed.data);

    notify("verify", "confirming the harness bundle on disk");
    const status = harnessStatus(projectDir);
    if (status.structural !== "pass") {
      // Defensive only — validateHarness above already gated this; a
      // mismatch here would mean writeHarness/harnessStatus disagree with
      // what was just validated, which is itself a bug worth surfacing
      // distinctly from a normal generation failure.
      throw new HarnessGenError("harness failed post-write verification", 1, [], "verify");
    }

    return {
      files,
      reportCard: { structural: "pass", operational: "insufficient-evidence" },
      estimatedCostUsd: costUsd,
      pages: pages.length,
      agents: agents.length,
      note: NOTE,
      cardStripped: stripped,
    };
  } finally {
    await engine.frontier.closeSession(session);
    untrackSession();
  }
}
