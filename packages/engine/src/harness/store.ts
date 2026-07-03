import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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

// Reused (not duplicated) from wiki/store.ts's `openWikiStore` guard:
// harness artifacts (manifest.json, wiki/, agents/, routing.yaml) live
// BESIDE cache/ inside `.openfusion/` and are meant to be committed by the
// user, while cache/ (the wiki symbol-index sqlite db) must stay
// gitignored. Idempotent and defensive about pre-existing content — if a
// `.gitignore` already exists (most commonly because the wiki cache was
// built first) but somehow doesn't list `cache/`, this appends it rather
// than assuming the file is already correct.
function ensureGitignoreGuard(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const gitignorePath = path.join(dir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "cache/\n");
    return;
  }
  const current = readFileSync(gitignorePath, "utf8");
  const hasGuard = current.split("\n").some((line) => line.trim() === "cache/");
  if (!hasGuard) {
    const withTrailingNewline = current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
    writeFileSync(gitignorePath, `${withTrailingNewline}cache/\n`);
  }
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
// `<projectDir>/.openfusion/`: manifest.json, wiki/<slug>.md,
// agents/<name>.yaml, routing.yaml. `bundle` is validated against
// HarnessBundleSchema BEFORE any filesystem call — an invalid bundle throws
// synchronously (a rejected zod parse) with nothing written. Each artifact
// file is then written atomically (see atomicWriteFile); this call does not
// itself make the whole multi-file write transactional (a mid-sequence
// failure can leave earlier files written and later ones absent), only that
// no individual file is ever left partially written. Never touches
// `.openfusion/cache/` (the wiki symbol-index store) — this function
// neither reads nor writes anything under that path.
export async function writeHarness(
  projectDir: string,
  bundle: HarnessBundle,
): Promise<{ files: string[] }> {
  const parsed = HarnessBundleSchema.parse(bundle);
  const dir = harnessDir(projectDir);

  ensureGitignoreGuard(dir);

  const writes: Array<[absPath: string, content: string]> = [
    [manifestPath(projectDir), `${JSON.stringify(parsed.manifest, null, 2)}\n`],
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

  for (const [absPath, content] of writes) {
    await atomicWriteFile(absPath, content);
  }

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

  return { manifest, pages, agents, routing };
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
} {
  const mPath = manifestPath(projectDir);
  if (!existsSync(mPath)) {
    return { present: false, structural: null, evals: null, headSha: null };
  }
  const manifest = parseManifestFile(mPath);
  return {
    present: true,
    structural: manifest.verification.structural,
    evals: manifest.verification.evals,
    headSha: manifest.headSha,
  };
}
