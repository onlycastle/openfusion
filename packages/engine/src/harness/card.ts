import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { listMakeTargets, listScriptNames, type MinedCommand } from "./mine.js";

// The Project Card content model an LLM's JSON output must match (spec
// §3.1/§3.2) before validateCardContent or the composers below ever see it.
// Every field's max caps that field's worst-case contribution to
// composeCardDigest's 2500-char injection budget — see that function's own
// comment for why raising a max here isn't free.
export const CardContentSchema = z.object({
  title: z.string().min(1),
  commands: z
    .array(
      z.object({
        command: z.string().min(1).max(120),
        why: z.string().min(1).max(80), // "run unit tests", "typecheck"
      }),
    )
    .min(1)
    .max(8),
  env: z.array(z.string().min(1).max(120)).max(6), // prerequisites/quirks
  boundaries: z.array(z.string().min(1).max(100)).max(6), // do-not-touch (spec §3.2)
  anchors: z
    .array(
      z.object({
        path: z.string().min(1), // repo-relative
        note: z.string().min(1).max(80),
        symbol: z.string().optional(), // optional symbol to cross-check
      }),
    )
    .max(8),
  glossary: z.array(z.object({ term: z.string().min(1).max(40), meaning: z.string().min(1).max(120) })).max(8),
  gotchas: z.array(z.string().min(1).max(160)).max(6),
});
export type CardContent = z.infer<typeof CardContentSchema>;

// Stage 3 of the project-card pipeline (spec §3.3): everything the LLM
// authored gets cross-checked against ground truth the project already has —
// mined commands + manifests on disk, and (from Task 4 on) the tree-sitter
// symbol store — before it's trusted. Nothing here accepts the LLM's own
// claim that a command or symbol is real.
export interface CardValidationCtx {
  mined: MinedCommand[];
  projectDir: string;
  symbolExists?: (name: string) => boolean; // wired to store.symbolsByName().length > 0 in Task 4
}

export interface StrippedItem {
  item: string;
  reason: string;
}

const SCRIPT_RUN_RE = /^(?:pnpm|npm) run (\S+)/;
const YARN_RUN_RE = /^yarn (\S+)/;
const MAKE_RUN_RE = /^(?:make|just) (\S+)/;

function scriptNameOf(command: string): string | undefined {
  return SCRIPT_RUN_RE.exec(command)?.[1] ?? YARN_RUN_RE.exec(command)?.[1];
}

function makeTargetOf(command: string): string | undefined {
  return MAKE_RUN_RE.exec(command)?.[1];
}

// A command is trusted iff it EXACTLY matches a mined command (the
// highest-trust source, see mine.ts) OR its script/target name resolves
// against the project's manifests right now — never on the strength of the
// LLM's own say-so alone.
function commandResolves(
  command: string,
  mined: MinedCommand[],
  scriptNames: Set<string>,
  makeTargets: Set<string>,
): boolean {
  if (mined.some((m) => m.command === command)) return true;

  const scriptName = scriptNameOf(command);
  if (scriptName !== undefined) return scriptNames.has(scriptName);

  const makeTarget = makeTargetOf(command);
  if (makeTarget !== undefined) return makeTargets.has(makeTarget);

  return false;
}

// An anchor is trusted iff its path actually exists in the project and — when
// it also names a symbol and the caller supplied a resolver — that symbol
// resolves too. Returns the strip reason, or undefined when the anchor
// passes.
function anchorFailureReason(anchor: CardContent["anchors"][number], ctx: CardValidationCtx): string | undefined {
  if (!existsSync(path.join(ctx.projectDir, anchor.path))) {
    return `path does not exist in this project: ${anchor.path}`;
  }
  if (anchor.symbol !== undefined && ctx.symbolExists && !ctx.symbolExists(anchor.symbol)) {
    return `symbol does not resolve in this project: ${anchor.symbol}`;
  }
  return undefined;
}

// Strips hallucinated commands/anchors from LLM-authored card content (spec
// §3.3 stage 3). Returns a NEW content object — the input is never mutated —
// plus the list of everything stripped and why, so the generation result and
// the desktop review panel can surface it (spec §3.4). `env`/`boundaries`/
// `glossary`/`gotchas` prose is not machine-validated in v1: there is no
// ground truth to check free-form prose against.
export function validateCardContent(
  content: CardContent,
  ctx: CardValidationCtx,
): { content: CardContent; stripped: StrippedItem[] } {
  const stripped: StrippedItem[] = [];
  const scriptNames = listScriptNames(ctx.projectDir);
  const makeTargets = listMakeTargets(ctx.projectDir);

  const commands = content.commands.filter((c) => {
    if (commandResolves(c.command, ctx.mined, scriptNames, makeTargets)) return true;
    stripped.push({ item: c.command, reason: "unmined command; no matching script/target in any manifest" });
    return false;
  });

  const anchors = content.anchors.filter((a) => {
    const reason = anchorFailureReason(a, ctx);
    if (reason === undefined) return true;
    stripped.push({ item: a.path, reason });
    return false;
  });

  return { content: { ...content, commands, anchors }, stripped };
}

// -- composition ----------------------------------------------------------

const MAX_DIGEST_CHARS = 2500;

function bulletSection(heading: string, lines: string[]): string | null {
  if (lines.length === 0) return null;
  return [`### ${heading}`, ...lines].join("\n");
}

function commandsSection(commands: CardContent["commands"]): string | null {
  return bulletSection(
    "Commands",
    commands.map((c) => `- \`${c.command}\` — ${c.why}`),
  );
}

function envSection(env: CardContent["env"]): string | null {
  return bulletSection(
    "Environment",
    env.map((e) => `- ${e}`),
  );
}

function boundariesSection(boundaries: CardContent["boundaries"]): string | null {
  return bulletSection(
    "Do not touch",
    boundaries.map((b) => `- ${b}`),
  );
}

function anchorsSection(anchors: CardContent["anchors"]): string | null {
  return bulletSection(
    "Key locations",
    anchors.map((a) =>
      a.symbol ? `- \`${a.path}\` — ${a.note} (symbol: ${a.symbol})` : `- \`${a.path}\` — ${a.note}`,
    ),
  );
}

function glossarySection(glossary: CardContent["glossary"]): string | null {
  return bulletSection(
    "Glossary",
    glossary.map((g) => `- **${g.term}**: ${g.meaning}`),
  );
}

function gotchasSection(gotchas: CardContent["gotchas"]): string | null {
  return bulletSection(
    "Gotchas",
    gotchas.map((g) => `- ${g}`),
  );
}

type SectionKey = "commands" | "env" | "boundaries" | "anchors" | "glossary" | "gotchas";

// Composes ONLY the section content (spec §3.2/§3.3) — the caller (the
// generate/orchestrate layer) prepends the "## Project card: <title>"
// heading. Priority order is fixed: Commands, Environment, Do not touch, Key
// locations, Glossary, Gotchas. If the composed text exceeds the 2500-char
// injection budget, whole trailing sections are dropped in soft-priority
// order — glossary, then gotchas, then anchors ("Key locations") — never
// commands/env/boundaries (spec §3.2: those are never truncated). The
// schema's per-field maxes make it very unlikely for commands+env+boundaries
// alone to exceed the budget, but the final slice below is a defensive last
// resort (not a throw) so this function's "≤2500 guaranteed" contract holds
// even for a pathological every-field-maxed input.
export function composeCardDigest(content: CardContent): string {
  const sections: Record<SectionKey, string | null> = {
    commands: commandsSection(content.commands),
    env: envSection(content.env),
    boundaries: boundariesSection(content.boundaries),
    anchors: anchorsSection(content.anchors),
    glossary: glossarySection(content.glossary),
    gotchas: gotchasSection(content.gotchas),
  };

  const order: SectionKey[] = ["commands", "env", "boundaries", "anchors", "glossary", "gotchas"];
  const dropped = new Set<SectionKey>();

  const render = (): string =>
    order
      .filter((key) => !dropped.has(key) && sections[key] !== null)
      .map((key) => sections[key] as string)
      .join("\n\n");

  let digest = render();
  for (const key of ["glossary", "gotchas", "anchors"] as const) {
    if (digest.length <= MAX_DIGEST_CHARS) break;
    dropped.add(key);
    digest = render();
  }

  // Defensive-only (see comment above): guarantees ≤2500 even if
  // commands+env+boundaries alone somehow overflow the budget, rather than
  // throwing out of a content-composition function.
  if (digest.length > MAX_DIGEST_CHARS) {
    digest = digest.slice(0, MAX_DIGEST_CHARS);
  }

  return digest;
}

function provenanceSection(commands: CardContent["commands"], mined: MinedCommand[]): string {
  const lines = commands.map((c) => {
    const match = mined.find((m) => m.command === c.command);
    if (match) return `- \`${c.command}\`: ${match.sources.join(", ")}`;
    const name = scriptNameOf(c.command) ?? makeTargetOf(c.command) ?? c.command;
    return `- \`${c.command}\`: unmined — matched script "${name}"`;
  });
  return ["## Provenance", ...lines].join("\n");
}

function strippedSection(stripped: StrippedItem[]): string {
  const lines = stripped.map((s) => `- ${s.item}: ${s.reason}`);
  return ["## Stripped at generation", ...lines].join("\n");
}

// Full markdown card body: every section untruncated, a Provenance section
// citing each command's mined `sources` (or which script/target an unmined
// command matched), and a Stripped-at-generation section when the validator
// (validateCardContent) actually dropped anything — this is how the desktop
// review panel surfaces stripped items (spec §3.4).
export function composeCardBody(content: CardContent, mined: MinedCommand[], stripped: StrippedItem[]): string {
  const sections = [
    `# ${content.title}`,
    commandsSection(content.commands),
    envSection(content.env),
    boundariesSection(content.boundaries),
    anchorsSection(content.anchors),
    glossarySection(content.glossary),
    gotchasSection(content.gotchas),
    provenanceSection(content.commands, mined),
  ].filter((s): s is string => s !== null);

  if (stripped.length > 0) {
    sections.push(strippedSection(stripped));
  }

  return sections.join("\n\n");
}
