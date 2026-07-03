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
import { RpcMethodError } from "../rpc/errors.js";
import { requireGitRepo } from "../rpc/guards.js";
import { wikiDbPath } from "../wiki/store.js";
import { ENGINE_VERSION } from "../version.js";
import { PRICING } from "../models/pricing.js";
import { HarnessGenError, promptForJson } from "./driver.js";
import {
  AgentDefSchema,
  HarnessBundleSchema,
  RoutingSchema,
  WIKI_PAGE_SLUGS,
  validateHarness,
  type WikiPage,
} from "./schema.js";
import { harnessStatus, writeHarness } from "./store.js";

// The only frontier engine kind generation drives today — mirrors
// engines/methods.ts's own `params.engine ?? "claude-code"` default. Not
// exposed as an engine.harness.generate RPC param (out of scope per the
// task brief's interface: `{ projectDir }` only).
const FRONTIER_KIND = "claude-code";

export interface GenerateHarnessResult {
  files: string[];
  reportCard: { structural: "pass"; evals: "pending" };
  estimatedCostUsd: number | null;
  pages: number;
  agents: number;
  note: string;
}

const NOTE =
  "harness is UNVERIFIED until evals run (M6)";

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
// 1200-char ceiling included) — slug is NOT part of this schema because the
// pipeline assigns it itself from WIKI_PAGE_SLUGS, never from model output.
const PageContentSchema = z.object({
  title: z.string().min(1),
  digest: z.string().min(1).max(1200),
  body: z.string(),
});

const AgentsRoutingSchema = z.object({
  agents: z.array(AgentDefSchema).min(2).max(5),
  routing: RoutingSchema,
});

const PAGE_FOCUS: Record<(typeof WIKI_PAGE_SLUGS)[number], string> = {
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
}

// Cross-references configured providers (engine.models.registry.list(): id +
// kind, never an api key) against the pricing table's "<kind>/<model>" keys
// to build the agents-routing stage's model menu — the registry alone
// doesn't carry a specific model id (that's chosen per engine.models.complete
// call), so PRICING's keyspace is what actually enumerates candidate models
// for a configured provider kind.
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
      options.push({
        providerId: provider.id,
        kind,
        model,
        inputPerMtok: pricing.inputPerMtok,
        outputPerMtok: pricing.outputPerMtok,
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

function buildPagePrompt(slug: (typeof WIKI_PAGE_SLUGS)[number], overview: Overview): string {
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

function buildAgentsRoutingPrompt(overview: Overview, workerModels: WorkerModelOption[]): string {
  const modelMenu =
    workerModels.length > 0
      ? workerModels
          .map(
            (m) =>
              `- providerId: ${m.providerId}, kind: ${m.kind}, model: ${m.model} — $${m.inputPerMtok}/Mtok in, $${m.outputPerMtok}/Mtok out`,
          )
          .join("\n")
      : '(no worker models are configured — assign "frontier" to every agent)';

  return [
    "You are designing the specialist-agent routing table for this repository's AI coding harness.",
    "Repository overview:",
    "```json\n" + JSON.stringify(overview, null, 2) + "\n```",
    "Configured worker models (cost is per million tokens):",
    modelMenu,
    "Propose 2 to 5 specialist agents, each mapped to one or more task classes (cover at minimum: codegen, docs, tests, search, refactor), each assigned the CHEAPEST worker model adequate for its task classes — including that model's providerId from the menu above — or the literal string \"frontier\" if no configured worker model is adequate.",
    "Also produce the routing.yaml content: every task class maps to exactly one agent, escalation.failuresBeforeFrontier defaults to 2, and defaults.agent names a sensible fallback agent.",
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
              model: { kind: "string", model: "string", providerId: "string" },
              escalation: { maxAttempts: 2 },
            },
          ],
          routing: {
            version: 1,
            taskClasses: { codegen: { agent: "kebab-case-name" } },
            escalation: { failuresBeforeFrontier: 2 },
            defaults: { agent: "kebab-case-name" },
          },
        },
        null,
        2,
      ) +
      "\n```",
    'model may also be the literal string "frontier" instead of an object. providerId is optional but should be set to the providerId from the model menu above whenever a specific worker model is assigned.',
  ].join("\n\n");
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
export async function generateHarness(engine: Engine, projectDir: string): Promise<GenerateHarnessResult> {
  const headSha = requireGitRepo(projectDir);

  const adapter = engine.frontier.getAdapter(FRONTIER_KIND);
  if (adapter === undefined) {
    throw new RpcMethodError(RpcErrorCodes.SERVER_ERROR, `unknown frontier engine: ${FRONTIER_KIND}`);
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
  const session = await adapter.createSession({
    projectDir,
    wikiMcpUrl: mcpServer.url,
    log: engine.log,
  });

  try {
    let costUsd: number | null = null;

    notify("overview", "exploring repository structure via the wiki");
    const overviewResult = await promptForJson(session, buildOverviewPrompt(), OverviewSchema, {
      stage: "overview",
      notify: (n) => notify("overview", `${n.kind}: ${n.detail}`),
    });
    costUsd = addCost(costUsd, overviewResult.costUsd);
    const overview = overviewResult.value;

    const pages: WikiPage[] = [];
    for (const slug of WIKI_PAGE_SLUGS) {
      const stage = `page:${slug}`;
      notify(stage, `generating the "${slug}" wiki page`);
      const pageResult = await promptForJson(session, buildPagePrompt(slug, overview), PageContentSchema, {
        stage,
        notify: (n) => notify(stage, `${n.kind}: ${n.detail}`),
      });
      costUsd = addCost(costUsd, pageResult.costUsd);
      pages.push({ slug, ...pageResult.value });
    }

    notify("agents-routing", "designing specialist agents and routing");
    const workerModels = listWorkerModelOptions(engine);
    const agentsResult = await promptForJson(
      session,
      buildAgentsRoutingPrompt(overview, workerModels),
      AgentsRoutingSchema,
      {
        stage: "agents-routing",
        notify: (n) => notify("agents-routing", `${n.kind}: ${n.detail}`),
      },
    );
    costUsd = addCost(costUsd, agentsResult.costUsd);
    const { agents, routing } = agentsResult.value;

    notify("write", "assembling and structurally validating the harness bundle");
    const candidateBundle = {
      manifest: {
        schemaVersion: 1 as const,
        generatorVersion: ENGINE_VERSION,
        engine: FRONTIER_KIND,
        headSha,
        generatedAt: new Date().toISOString(),
        verification: { structural: "pass" as const, evals: "pending" as const },
        artifacts: [],
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
      reportCard: { structural: "pass", evals: "pending" },
      estimatedCostUsd: costUsd,
      pages: pages.length,
      agents: agents.length,
      note: NOTE,
    };
  } finally {
    await session.close().catch(() => {
      // Best-effort — mirrors FrontierService's own per-session close()
      // isolation (engines/methods.ts): a throwing adapter close() must
      // never mask the pipeline's actual success/failure outcome.
    });
  }
}
