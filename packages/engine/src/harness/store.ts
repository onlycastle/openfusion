import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { ensureGitignoreGuard } from "../util/gitignore-guard.js";
import {
  AgentDefSchema,
  HarnessBundleSchema,
  ManifestSchema,
  RoutingSchema,
  WikiPageSchema,
  validateHarness,
  type AgentDef,
  type HarnessBundle,
  type Manifest,
  type Routing,
  type WikiPage,
} from "./schema.js";
import { upgradeHarnessV1ToV2 } from "./upgrade.js";
import { fingerprintHarness, type HarnessFingerprint } from "./fingerprint.js";

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

const CurrentPointerSchema = z.object({
  schemaVersion: z.literal(1),
  generationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
}).strict();
export type HarnessGenerationPointer = z.infer<typeof CurrentPointerSchema>;

function currentPointerPath(projectDir: string): string {
  return path.join(harnessDir(projectDir), "current.json");
}

function generationsDir(projectDir: string): string {
  return path.join(harnessDir(projectDir), "generations");
}

function legacyHarnessRoot(projectDir: string): string {
  return harnessDir(projectDir);
}

function manifestPath(rootDir: string): string {
  return path.join(rootDir, "manifest.json");
}

function wikiDir(rootDir: string): string {
  return path.join(rootDir, "wiki");
}

function agentsDir(rootDir: string): string {
  return path.join(rootDir, "agents");
}

function routingPath(rootDir: string): string {
  return path.join(rootDir, "routing.yaml");
}

function parseCurrentPointer(projectDir: string): HarnessGenerationPointer | null {
  const pointerPath = currentPointerPath(projectDir);
  if (!existsSync(pointerPath)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(pointerPath, "utf8"));
  } catch {
    throw new HarnessValidationError("current.json is not valid JSON");
  }
  const result = CurrentPointerSchema.safeParse(value);
  if (!result.success) {
    throw new HarnessValidationError("current.json failed schema validation", result.error.issues);
  }
  return result.data;
}

export function activeHarnessDir(projectDir: string): string | null {
  const pointer = parseCurrentPointer(projectDir);
  if (pointer !== null) return path.join(generationsDir(projectDir), pointer.generationId);
  const legacyRoot = legacyHarnessRoot(projectDir);
  return existsSync(manifestPath(legacyRoot)) ? legacyRoot : null;
}

export function loadHarnessGenerationId(projectDir: string): string | null {
  return parseCurrentPointer(projectDir)?.generationId ?? null;
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
    const fd = openSync(tmpPath, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    await rename(tmpPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
}

function fsyncDirectory(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const WIKI_PAGE_EXT = ".md";
const AGENT_DEF_EXT = ".yaml";
const WIKI_SUBDIR = "wiki";
const AGENTS_SUBDIR = "agents";
const ROUTING_RELPATH = "routing.yaml";

// Relative POSIX paths owned by one immutable generation. The manifest
// records this list so readers can validate the complete generation without
// scanning unrelated `.openfusion` state.
function computeArtifactPaths(bundle: { pages: WikiPage[]; agents: AgentDef[] }): string[] {
  return [
    ROUTING_RELPATH,
    ...bundle.pages.map((page) => `${WIKI_SUBDIR}/${page.slug}${WIKI_PAGE_EXT}`),
    ...bundle.agents.map((agent) => `${AGENTS_SUBDIR}/${agent.name}${AGENT_DEF_EXT}`),
  ];
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

// Build a complete immutable generation in a temporary sibling directory,
// validate it through the normal reader, then atomically publish current.json.
// A failure before the pointer swap cannot change the active generation.
// Legacy flat harnesses remain readable and are superseded on the first
// successful generation write. `.openfusion/cache/` is never touched here.
export async function writeHarness(
  projectDir: string,
  bundle: HarnessBundle,
): Promise<{ files: string[]; generationId: string; fingerprint: string }> {
  const parsed = HarnessBundleSchema.parse(bundle);
  const dir = harnessDir(projectDir);
  const newArtifacts = computeArtifactPaths(parsed);
  ensureGitignoreGuard(dir, ["cache/"]);
  const manifestWithArtifacts: Manifest = { ...parsed.manifest, artifacts: newArtifacts };
  const candidate: HarnessBundle = { ...parsed, manifest: manifestWithArtifacts };
  const issues = validateHarness(candidate);
  if (issues.length > 0) {
    throw new HarnessValidationError("harness failed cross-artifact validation", issues);
  }
  const fingerprint = fingerprintHarness(candidate).digest;
  const generationId = `${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
  const generationRoot = path.join(generationsDir(projectDir), generationId);
  const temporaryRoot = path.join(
    generationsDir(projectDir),
    `.tmp-${generationId}-${process.pid}-${randomBytes(4).toString("hex")}`,
  );

  await mkdir(temporaryRoot, { recursive: true });
  const contentWrites: Array<[absPath: string, content: string]> = [
    [routingPath(temporaryRoot), stringifyYaml(parsed.routing)],
    ...parsed.pages.map(
      (page): [string, string] => [path.join(wikiDir(temporaryRoot), `${page.slug}${WIKI_PAGE_EXT}`), renderWikiPage(page)],
    ),
    ...parsed.agents.map(
      (agent): [string, string] => [
        path.join(agentsDir(temporaryRoot), `${agent.name}${AGENT_DEF_EXT}`),
        stringifyYaml(agent),
      ],
    ),
    [manifestPath(temporaryRoot), `${JSON.stringify(manifestWithArtifacts, null, 2)}\n`],
  ];
  try {
    for (const [absPath, content] of contentWrites) await atomicWriteFile(absPath, content);

    // Read the completed candidate through the same parser used by normal
    // readers before publishing it. A failed parse leaves current.json
    // untouched, so the previous generation remains authoritative.
    const reloaded = loadHarnessAtRoot(temporaryRoot);
    const reloadFingerprint = fingerprintHarness(reloaded).digest;
    if (reloadFingerprint !== fingerprint) {
      throw new HarnessValidationError("harness generation reload fingerprint mismatch");
    }

    await mkdir(generationsDir(projectDir), { recursive: true });
    await rename(temporaryRoot, generationRoot);
    fsyncDirectory(generationsDir(projectDir));
    const pointer = CurrentPointerSchema.parse({
      schemaVersion: 1,
      generationId,
      fingerprint,
      createdAt: new Date().toISOString(),
    });
    await atomicWriteFile(currentPointerPath(projectDir), `${JSON.stringify(pointer, null, 2)}\n`);
    fsyncDirectory(dir);

    return {
      files: [
        ...contentWrites.map(([absPath]) =>
          path.relative(projectDir, path.join(generationRoot, path.relative(temporaryRoot, absPath))),
        ),
        path.relative(projectDir, currentPointerPath(projectDir)),
      ],
      generationId,
      fingerprint,
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

// Loads the harness bundle back off disk. Returns `null` when no harness has
// been generated yet (manifest.json absent) — this is the ONLY case that
// returns null; any other on-disk problem (corrupt JSON/YAML, a file that
// fails its schema, an agent file/name mismatch) throws
// HarnessValidationError. Synchronous, matching the store's other read-path
// (openWikiStore) — loading a harness is not expected to be a hot path.
function loadHarnessAtRoot(rootDir: string): HarnessBundle {
  const manifest = parseManifestFile(manifestPath(rootDir));

  const wikiFiles = readRequiredDir(wikiDir(rootDir), "wiki/ directory")
    .filter((f) => f.endsWith(WIKI_PAGE_EXT))
    .sort();
  const pages: WikiPage[] = wikiFiles.map((file) => {
    const slug = file.slice(0, -WIKI_PAGE_EXT.length);
    const raw = readRequiredFile(path.join(wikiDir(rootDir), file), `wiki page "${slug}"`);
    return parseWikiPage(slug, raw);
  });

  const agentFiles = readRequiredDir(agentsDir(rootDir), "agents/ directory")
    .filter((f) => f.endsWith(AGENT_DEF_EXT))
    .sort();
  const agents: AgentDef[] = agentFiles.map((file) => {
    const baseName = file.slice(0, -AGENT_DEF_EXT.length);
    const raw = readRequiredFile(path.join(agentsDir(rootDir), file), `agent "${baseName}"`);
    return parseAgentDef(baseName, raw);
  });

  const routing = parseRoutingFile(routingPath(rootDir));

  // Phase 1: normalize v1 / partially-v2 on-disk bundles to the v2 shape
  // (family, dialectPack, routeIds, manifest version pins). Pure in-memory
  // upgrade — does not rewrite disk until the next writeHarness/generate.
  return upgradeHarnessV1ToV2({ manifest, pages, agents, routing });
}

export interface LoadedHarnessSnapshot {
  bundle: HarnessBundle;
  generationId: string | null;
  fingerprint: HarnessFingerprint;
}

/** Pins one pointer read so bundle, generation, and fingerprint cannot mix. */
export function loadHarnessSnapshot(projectDir: string): LoadedHarnessSnapshot | null {
  const pointer = parseCurrentPointer(projectDir);
  const rootDir = pointer === null
    ? (existsSync(manifestPath(harnessDir(projectDir))) ? harnessDir(projectDir) : null)
    : path.join(generationsDir(projectDir), pointer.generationId);
  if (rootDir === null) return null;
  if (!existsSync(rootDir)) throw new HarnessValidationError("active harness generation is missing");
  const bundle = loadHarnessAtRoot(rootDir);
  const fingerprint = fingerprintHarness(bundle);
  if (pointer !== null) {
    if (fingerprint.digest !== pointer.fingerprint) {
      throw new HarnessValidationError(
        "active immutable harness generation was modified outside an approved write",
      );
    }
  }
  return { bundle, generationId: pointer?.generationId ?? null, fingerprint };
}

export function loadHarness(projectDir: string): HarnessBundle | null {
  return loadHarnessSnapshot(projectDir)?.bundle ?? null;
}

/**
 * Load and fingerprint the effective on-disk harness. The same validation
 * and v1-to-v2 normalization as loadHarness() applies; a missing harness is
 * the only case that returns null.
 */
export function loadHarnessFingerprint(projectDir: string): HarnessFingerprint | null {
  return loadHarnessSnapshot(projectDir)?.fingerprint ?? null;
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
  headSha: string | null;
  card: "draft" | "approved" | null;
} {
  const rootDir = activeHarnessDir(projectDir);
  if (rootDir === null) {
    return { present: false, structural: null, headSha: null, card: null };
  }
  const manifest = parseManifestFile(manifestPath(rootDir));
  const pointer = parseCurrentPointer(projectDir);
  if (pointer !== null) {
    // The cheap status path still validates the pointer and manifest. Full
    // generation fingerprint validation remains in loadHarness().
    if (!existsSync(rootDir)) throw new HarnessValidationError("active harness generation is missing");
  }
  return {
    present: true,
    structural: manifest.verification.structural,
    headSha: manifest.headSha,
    card: manifest.verification.card ?? null,
  };
}

// The project-card human-approval gate (spec §3.4, a later task's UI flow):
// updates ONLY manifest.verification.card, in place — every other manifest
// field (schemaVersion, generatorVersion, engine, headSha, generatedAt,
// verification.structural and artifacts) is preserved verbatim. This
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
  const bundle = loadHarness(projectDir);
  if (bundle === null) {
    throw new HarnessValidationError("no harness; run engine.harness.generate first");
  }
  await writeHarness(projectDir, {
    ...bundle,
    manifest: {
      ...bundle.manifest,
      verification: { ...bundle.manifest.verification, card: state },
    },
  });
}
