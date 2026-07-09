import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ensureGitignoreGuard } from "../util/gitignore-guard.js";
import {
  AgentDefSchema,
  HarnessBundleSchema,
  ManifestSchema,
  RoutingSchema,
  WikiPageSchema,
  type AgentDef,
  type HarnessBundle,
  type Manifest,
  type Routing,
  type WikiPage,
} from "./schema.js";
import { upgradeHarnessV1ToV2 } from "./upgrade.js";

// Thrown by loadHarness/harnessStatus when on-disk content under
// `.openfusion/` fails to parse (bad JSON/YAML, missing frontmatter fence,
// name/filename mismatch) or fails its zod schema. Never thrown for the
// "nothing generated yet" case — that's a plain `null` return — only for
// content that IS present but is corrupt or hand-edited into an invalid
// shape.
export class HarnessValidationError extends Error {
  constructor(
    message: string,
    readonly issues: unknown[] = [],
  ) {
    super(message);
    this.name = "HarnessValidationError";
  }
}

export function harnessDir(projectDir: string): string {
  return path.join(projectDir, ".openfusion");
}

function manifestPath(projectDir: string): string {
  return path.join(harnessDir(projectDir), "manifest.json");
}

function wikiDir(projectDir: string): string {
  return path.join(harnessDir(projectDir), "wiki");
}

function agentsDir(projectDir: string): string {
  return path.join(harnessDir(projectDir), "agents");
}

function routingPath(projectDir: string): string {
  return path.join(harnessDir(projectDir), "routing.yaml");
}

// Atomic per-file write: the full content is built as a string BEFORE any
// filesystem call, then written to a sibling tmp file and rename()'d into
// place. rename() within the same directory is atomic on POSIX filesystems,
// so a reader can never observe a partially-written target — it either
// doesn't exist yet (old content, or nothing) or is the complete new
// content. If the write or rename fails, the tmp file is removed so no
// `<name>.tmp-*` litter survives a failed writeHarness call, and the target
// path is left exactly as it was before this call (never touched, since
// only rename() would have touched it).
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    await writeFile(tmpPath, content, "utf8");
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

const WIKI_PAGE_EXT = ".md";
const AGENT_DEF_EXT = ".yaml";
const WIKI_SUBDIR = "wiki";
const AGENTS_SUBDIR = "agents";
const ROUTING_RELPATH = "routing.yaml";

// Relative-POSIX-path artifact list this bundle will write, in the same
// order as writeHarness's content writes (routing, then pages, then
// agents). This is the exact list recorded into manifest.artifacts, and is
// also diffed against the PRIOR manifest's artifacts to determine what's
// safe to prune (see pruneRemovedArtifacts).
function computeArtifactPaths(bundle: { pages: WikiPage[]; agents: AgentDef[] }): string[] {
  return [
    ROUTING_RELPATH,
    ...bundle.pages.map((page) => `${WIKI_SUBDIR}/${page.slug}${WIKI_PAGE_EXT}`),
    ...bundle.agents.map((agent) => `${AGENTS_SUBDIR}/${agent.name}${AGENT_DEF_EXT}`),
  ];
}

// Reads the artifacts list off the manifest ALREADY on disk (if any),
// before writeHarness writes anything new — this is "what the PRIOR
// generation is on record as having written", the only set of files a
// regeneration is ever allowed to prune. Never throws: a missing manifest,
// unparseable JSON, or a manifest that fails schema validation all
// conservatively resolve to `[]` (nothing known, so nothing pruned) rather
// than blocking a new write over a problem with the OLD manifest.
function readOldManifestArtifacts(projectDir: string): string[] {
  const mPath = manifestPath(projectDir);
  if (!existsSync(mPath)) return [];
  try {
    const json: unknown = JSON.parse(readFileSync(mPath, "utf8"));
    const result = ManifestSchema.safeParse(json);
    return result.success ? result.data.artifacts : [];
  } catch {
    return [];
  }
}

// Resolves a manifest-recorded relative artifact path to an absolute path,
// but ONLY if it lands inside wiki/ (as a .md file), agents/ (as a .yaml
// file), or is exactly routing.yaml — the sole three locations writeHarness
// itself ever writes content into. Returns null for anything else
// (".." traversal, cache/, .gitignore, manifest.json, or anything outside
// .openfusion entirely), which pruneRemovedArtifacts treats as "skip,
// don't delete". This is an allowlist, not a denylist, specifically so a
// malformed or hand-edited manifest.artifacts entry can never cause
// deletion of something outside the three directories writeHarness owns.
function resolvePrunablePath(projectDir: string, relPath: string): string | null {
  const segments = relPath.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.length === 0 || segments.some((s) => s === "..")) return null;

  const dir = harnessDir(projectDir);
  const abs = path.resolve(dir, ...segments);

  if (abs === routingPath(projectDir)) return abs;

  const wDir = wikiDir(projectDir);
  if ((abs === wDir || abs.startsWith(wDir + path.sep)) && abs.endsWith(WIKI_PAGE_EXT)) return abs;

  const aDir = agentsDir(projectDir);
  if ((abs === aDir || abs.startsWith(aDir + path.sep)) && abs.endsWith(AGENT_DEF_EXT)) return abs;

  return null;
}

// Deletes every path in `oldArtifacts` that isn't in `newArtifacts` — i.e.
// files the PRIOR manifest declared it wrote that THIS generation didn't
// rewrite (an agent dropped from the bundle, a wiki page renamed to a new
// slug). Only ever called AFTER the new manifest.json has been written
// successfully: at that point this generation's own content is fully and
// durably on disk, so pruning can only remove genuinely-stale prior-
// generation files, never anything belonging to the generation that just
// committed. A file never recorded in any manifest (hand-authored via the
// Harness editor, spec §7.4) can never appear in `oldArtifacts` and is
// therefore never a candidate for deletion here.
//
// Deliberately swallows all per-file errors (including a permission
// failure or the file already being gone): a prune failure must never
// throw out of writeHarness once the new manifest is committed — the new
// generation already succeeded, and undoing that success (or leaving
// writeHarness's caller thinking it failed) over a best-effort cleanup step
// would be strictly worse than leaving one stale file behind.
function pruneRemovedArtifacts(projectDir: string, oldArtifacts: string[], newArtifacts: ReadonlySet<string>): void {
  for (const relPath of oldArtifacts) {
    if (newArtifacts.has(relPath)) continue;
    const absPath = resolvePrunablePath(projectDir, relPath);
    if (absPath === null) continue;
    try {
      rmSync(absPath, { force: true });
    } catch {
      // Best-effort — see function header comment.
    }
  }
}

// `---\ntitle: ...\ndigest: ...\n---\n\n<body>` — YAML frontmatter (title +
// digest only; slug is the filename, not duplicated into the frontmatter)
// followed by a blank line and the markdown body. digest is the
// token-budgeted summary agents actually consume; body is the full prose
// page.
function renderWikiPage(page: WikiPage): string {
  const frontmatter = stringifyYaml({ title: page.title, digest: page.digest });
  return `---\n${frontmatter}---\n\n${page.body}`;
}

const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_CLOSE = "\n---\n\n";

function parseWikiPage(slug: string, raw: string): WikiPage {
  if (!raw.startsWith(FRONTMATTER_OPEN)) {
    throw new HarnessValidationError(`wiki page "${slug}" is missing its opening frontmatter fence`);
  }
  const closeIdx = raw.indexOf(FRONTMATTER_CLOSE, FRONTMATTER_OPEN.length);
  if (closeIdx === -1) {
    throw new HarnessValidationError(`wiki page "${slug}" has no closing frontmatter fence`);
  }
  const frontmatterRaw = raw.slice(FRONTMATTER_OPEN.length, closeIdx + 1);
  const body = raw.slice(closeIdx + FRONTMATTER_CLOSE.length);

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(frontmatterRaw);
  } catch (err) {
    throw new HarnessValidationError(
      `wiki page "${slug}" has invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const candidate = {
    slug,
    title: (frontmatter as { title?: unknown } | null)?.title,
    digest: (frontmatter as { digest?: unknown } | null)?.digest,
    body,
  };
  const result = WikiPageSchema.safeParse(candidate);
  if (!result.success) {
    throw new HarnessValidationError(`wiki page "${slug}" failed schema validation`, result.error.issues);
  }
  return result.data;
}

function parseAgentDef(fileBaseName: string, raw: string): AgentDef {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new HarnessValidationError(
      `agent "${fileBaseName}" has invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = AgentDefSchema.safeParse(parsed);
  if (!result.success) {
    throw new HarnessValidationError(`agent "${fileBaseName}" failed schema validation`, result.error.issues);
  }
  if (result.data.name !== fileBaseName) {
    throw new HarnessValidationError(
      `agent file "${fileBaseName}.yaml" declares name "${result.data.name}" (must match its filename)`,
    );
  }
  return result.data;
}

function readRequiredFile(filePath: string, describe: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    throw new HarnessValidationError(`${describe} is missing at ${filePath}`);
  }
}

function readRequiredDir(dirPath: string, describe: string): string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    throw new HarnessValidationError(`${describe} is missing at ${dirPath}`);
  }
}

// Writes every harness artifact for `bundle` under
// `<projectDir>/.openfusion/`: wiki/<slug>.md, agents/<name>.yaml,
// routing.yaml, and — LAST, once everything else has landed — manifest.json.
// `bundle` is validated against HarnessBundleSchema BEFORE any filesystem
// call — an invalid bundle throws synchronously (a rejected zod parse) with
// nothing written. Each artifact file is written atomically (see
// atomicWriteFile); this call does not itself make the whole multi-file
// write transactional (a mid-sequence failure can leave earlier files
// written and later ones absent), only that no individual file is ever left
// partially written.
//
// manifest.json is deliberately written LAST, after every other artifact
// has fully succeeded, because it is the completion marker both readers
// rely on: harnessStatus() reads ONLY manifest.json (cheap, poll-friendly)
// and reports it at face value, and loadHarness() treats manifest.json's
// absence as the sole "nothing generated yet" signal. If manifest.json were
// written first (or anywhere but last) and a later artifact write failed,
// manifest.json would sit on disk claiming `verification.structural: "pass"`
// over a wiki/agents/routing set that's missing or stale — harnessStatus
// would report a broken harness as healthy, and on the next regeneration
// attempt a Frankenstein bundle (new manifest + leftover stale artifact)
// could load without error. With manifest-last, manifest.json's mere
// presence reliably means this generation's other artifacts are fully on
// disk; a failure anywhere before it leaves the previous generation's
// manifest (and bundle) exactly as they were.
//
// manifest.artifacts (schema.ts) records the exact relative-path set this
// call writes (routing.yaml, wiki/<slug>.md per page, agents/<name>.yaml
// per agent — never manifest.json itself, never cache/). Stale-artifact
// pruning is driven entirely off that field rather than a raw directory
// scan: readOldManifestArtifacts reads the manifest ALREADY on disk (i.e.
// the prior generation's declared file set) BEFORE this call writes
// anything, and pruneRemovedArtifacts — invoked only AFTER the NEW
// manifest.json has been written successfully — deletes whatever's in that
// old set but not in this generation's new set. Two consequences of doing
// it this way, both required by review: (1) a file a user hand-added under
// wiki/ or agents/ via the Harness editor (spec §7.4) was never in any
// manifest.artifacts and can therefore never be a prune candidate, however
// many regenerations run after it's added; (2) if the manifest write itself
// fails, pruning — ordered strictly after it — never runs at all, so a
// manifest-write failure can never cost the last known-good generation's
// content (only a failed regeneration attempt, with the old manifest and
// old bundle both left exactly as they were).
//
// Never touches `.openfusion/cache/` (the wiki symbol-index store) — this
// function neither reads nor writes anything under that path.
export async function writeHarness(
  projectDir: string,
  bundle: HarnessBundle,
): Promise<{ files: string[] }> {
  const parsed = HarnessBundleSchema.parse(bundle);
  const dir = harnessDir(projectDir);

  // Must happen before any write below: this is the last chance to see what
  // the PRIOR generation (if any) declared it wrote.
  const oldArtifacts = readOldManifestArtifacts(projectDir);
  const newArtifacts = computeArtifactPaths(parsed);

  ensureGitignoreGuard(dir, ["cache/"]);

  const contentWrites: Array<[absPath: string, content: string]> = [
    [routingPath(projectDir), stringifyYaml(parsed.routing)],
    ...parsed.pages.map(
      (page): [string, string] => [path.join(wikiDir(projectDir), `${page.slug}${WIKI_PAGE_EXT}`), renderWikiPage(page)],
    ),
    ...parsed.agents.map(
      (agent): [string, string] => [
        path.join(agentsDir(projectDir), `${agent.name}${AGENT_DEF_EXT}`),
        stringifyYaml(agent),
      ],
    ),
  ];

  for (const [absPath, content] of contentWrites) {
    await atomicWriteFile(absPath, content);
  }

  const manifestWithArtifacts: Manifest = { ...parsed.manifest, artifacts: newArtifacts };
  const manifestWrite: [absPath: string, content: string] = [
    manifestPath(projectDir),
    `${JSON.stringify(manifestWithArtifacts, null, 2)}\n`,
  ];
  await atomicWriteFile(...manifestWrite);

  // Only now — new manifest safely committed — is it safe to prune what the
  // OLD manifest declared but this generation didn't rewrite.
  pruneRemovedArtifacts(projectDir, oldArtifacts, new Set(newArtifacts));

  const writes = [...contentWrites, manifestWrite];
  return { files: writes.map(([absPath]) => path.relative(projectDir, absPath)) };
}

// Loads the harness bundle back off disk. Returns `null` when no harness has
// been generated yet (manifest.json absent) — this is the ONLY case that
// returns null; any other on-disk problem (corrupt JSON/YAML, a file that
// fails its schema, an agent file/name mismatch) throws
// HarnessValidationError. Synchronous, matching the store's other read-path
// (openWikiStore) — loading a harness is not expected to be a hot path.
export function loadHarness(projectDir: string): HarnessBundle | null {
  const mPath = manifestPath(projectDir);
  if (!existsSync(mPath)) return null;

  const manifest = parseManifestFile(mPath);

  const wikiFiles = readRequiredDir(wikiDir(projectDir), "wiki/ directory")
    .filter((f) => f.endsWith(WIKI_PAGE_EXT))
    .sort();
  const pages: WikiPage[] = wikiFiles.map((file) => {
    const slug = file.slice(0, -WIKI_PAGE_EXT.length);
    const raw = readRequiredFile(path.join(wikiDir(projectDir), file), `wiki page "${slug}"`);
    return parseWikiPage(slug, raw);
  });

  const agentFiles = readRequiredDir(agentsDir(projectDir), "agents/ directory")
    .filter((f) => f.endsWith(AGENT_DEF_EXT))
    .sort();
  const agents: AgentDef[] = agentFiles.map((file) => {
    const baseName = file.slice(0, -AGENT_DEF_EXT.length);
    const raw = readRequiredFile(path.join(agentsDir(projectDir), file), `agent "${baseName}"`);
    return parseAgentDef(baseName, raw);
  });

  const routing = parseRoutingFile(routingPath(projectDir));

  // Phase 1: normalize v1 / partially-v2 on-disk bundles to the v2 shape
  // (family, dialectPack, routeIds, manifest version pins). Pure in-memory
  // upgrade — does not rewrite disk until the next writeHarness/generate.
  return upgradeHarnessV1ToV2({ manifest, pages, agents, routing });
}

function parseManifestFile(mPath: string): Manifest {
  const raw = readRequiredFile(mPath, "manifest.json");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new HarnessValidationError(`manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = ManifestSchema.safeParse(json);
  if (!result.success) {
    throw new HarnessValidationError("manifest.json failed schema validation", result.error.issues);
  }
  return result.data;
}

function parseRoutingFile(rPath: string): Routing {
  const raw = readRequiredFile(rPath, "routing.yaml");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new HarnessValidationError(`routing.yaml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = RoutingSchema.safeParse(parsed);
  if (!result.success) {
    throw new HarnessValidationError("routing.yaml failed schema validation", result.error.issues);
  }
  return result.data;
}

// Cheap status check for UI/CLI polling: reads only manifest.json (not
// wiki/agents/routing), so it stays fast even called frequently. `present:
// false` (manifest.json absent) returns nulls for the rest rather than
// throwing; a manifest that IS present but corrupt still throws
// HarnessValidationError, matching loadHarness's error semantics.
export function harnessStatus(projectDir: string): {
  present: boolean;
  structural: "pass" | "fail" | null;
  evals: string | null;
  headSha: string | null;
  card: "draft" | "approved" | null;
} {
  const mPath = manifestPath(projectDir);
  if (!existsSync(mPath)) {
    return { present: false, structural: null, evals: null, headSha: null, card: null };
  }
  const manifest = parseManifestFile(mPath);
  return {
    present: true,
    structural: manifest.verification.structural,
    evals: manifest.verification.evals,
    headSha: manifest.headSha,
    card: manifest.verification.card ?? null,
  };
}

// M6 Task 4 (the ETH-hazard gate manifest flip): updates ONLY
// manifest.verification.evals, in place — every other manifest field
// (schemaVersion, generatorVersion, engine, headSha, generatedAt,
// verification.structural, and — load-bearing — `artifacts`, the pruning
// bookkeeping writeHarness relies on) is preserved verbatim. Deliberately
// does NOT go through writeHarness/HarnessBundleSchema (which would require
// re-reading and re-validating wiki/agents/routing just to flip one boolean-
// ish field, and would rewrite every artifact file on disk for no content
// change): this reads manifest.json directly and rewrites ONLY that one
// file, reusing atomicWriteFile for the same tmp-then-rename atomicity
// writeHarness itself relies on. Since manifest.json is the ONLY file this
// function touches, "manifest-last atomicity" is trivially satisfied — there
// is nothing else to sequence before it.
//
// Throws HarnessValidationError (not a silent no-op) when no harness has
// been generated yet, or the on-disk manifest is corrupt/invalid — flipping
// an evals verdict for a harness that doesn't exist (or can't be trusted) is
// a caller error, not a case to swallow quietly. engine.evals.run
// (evals/run.ts) calls this only on "pass"/"fail" verdicts; an
// "inconclusive" run deliberately never calls this at all, leaving whatever
// value was already on disk (typically "pending" from generation, but also
// possibly a prior real run's "pass"/"fail" — this function does not force
// it back to "pending").
export async function setEvalsVerdict(
  projectDir: string,
  verdict: Manifest["verification"]["evals"],
): Promise<void> {
  const mPath = manifestPath(projectDir);
  if (!existsSync(mPath)) {
    throw new HarnessValidationError("no harness; run engine.harness.generate first");
  }
  const manifest = parseManifestFile(mPath);
  const updated: Manifest = {
    ...manifest,
    verification: { ...manifest.verification, evals: verdict },
  };
  await atomicWriteFile(mPath, `${JSON.stringify(updated, null, 2)}\n`);
}

// The project-card human-approval gate (spec §3.4, a later task's UI flow):
// updates ONLY manifest.verification.card, in place — every other manifest
// field (schemaVersion, generatorVersion, engine, headSha, generatedAt,
// verification.structural, verification.evals, and artifacts) is preserved
// verbatim. Mirrors setEvalsVerdict exactly, for the same reasons: this
// reads manifest.json directly and rewrites ONLY that one file via
// atomicWriteFile, rather than going through writeHarness/HarnessBundleSchema
// (which would require re-reading and re-validating wiki/agents/routing —
// and rewriting every artifact file on disk — just to flip one field).
//
// Throws HarnessValidationError (not a silent no-op) when no harness has
// been generated yet, or the on-disk manifest is corrupt/invalid — flipping
// a card's approval state for a harness that doesn't exist (or can't be
// trusted) is a caller error, not a case to swallow quietly.
export async function setCardState(
  projectDir: string,
  state: NonNullable<Manifest["verification"]["card"]>,
): Promise<void> {
  const mPath = manifestPath(projectDir);
  if (!existsSync(mPath)) {
    throw new HarnessValidationError("no harness; run engine.harness.generate first");
  }
  const manifest = parseManifestFile(mPath);
  const updated: Manifest = {
    ...manifest,
    verification: { ...manifest.verification, card: state },
  };
  await atomicWriteFile(mPath, `${JSON.stringify(updated, null, 2)}\n`);
}
