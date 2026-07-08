import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

// Deterministic build/test command miner (spec §3.3 stage 1). Every command
// this module surfaces is read straight off a manifest or CI config the
// project already maintains — nothing here is LLM-invented or guessed. A
// later task (the project-card generator) treats this as its highest-trust
// input, above anything an LLM proposes.
export interface MinedCommand {
  command: string;
  sources: string[];
}

type PackageManager = "pnpm" | "yarn" | "npm";

// Lockfile presence is the sole signal for which runner prefix a root
// script gets (`pnpm run <name>` / `yarn <name>` / `npm run <name>`) — no
// package.json field is trusted for this, since `packageManager` fields are
// often stale or absent. Defaults to npm when no lockfile is present at all.
function detectPackageManager(projectDir: string): PackageManager {
  if (existsSync(path.join(projectDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(projectDir, "yarn.lock"))) return "yarn";
  return "npm";
}

interface PackageJsonEntry {
  // POSIX-style relative path (e.g. "package.json" or "packages/a/package.json"),
  // used verbatim as the source-string prefix — never an OS-native path.
  relPath: string;
  pkgName: string | null;
  scripts: Record<string, string>;
}

// Only single-level `<dir>/*` glob entries in pnpm-workspace.yaml's
// `packages:` list are supported (v1) — anything else (`**`, negated `!...`
// entries, multi-segment globs) is silently ignored rather than
// approximated. Returns the literal directory prefix for each matching
// entry (e.g. "packages/*" -> "packages"), to be scanned one level deep for
// `<dir>/<subdir>/package.json`. Missing or unparsable pnpm-workspace.yaml
// resolves to `[]` rather than throwing (mining is best-effort).
function workspaceDirPrefixes(projectDir: string): string[] {
  const wsPath = path.join(projectDir, "pnpm-workspace.yaml");
  if (!existsSync(wsPath)) return [];

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(wsPath, "utf8"));
  } catch {
    return [];
  }

  const packages = (parsed as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(packages)) return [];

  const prefixes: string[] = [];
  for (const entry of packages) {
    if (typeof entry !== "string") continue;
    const match = /^([^*!]+)\/\*$/.exec(entry);
    const dir = match?.[1];
    if (dir) prefixes.push(dir);
  }
  return prefixes;
}

function readPackageJson(absPath: string): { name?: unknown; scripts?: unknown } | null {
  try {
    const json: unknown = JSON.parse(readFileSync(absPath, "utf8"));
    if (typeof json !== "object" || json === null) return null;
    return json as { name?: unknown; scripts?: unknown };
  } catch {
    return null;
  }
}

function scriptsOf(pkg: { scripts?: unknown } | null): Record<string, string> {
  if (!pkg || typeof pkg.scripts !== "object" || pkg.scripts === null) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(pkg.scripts as Record<string, unknown>)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

// Root package.json (always, if present and parsable) plus, when
// pnpm-workspace.yaml declares single-level `<dir>/*` globs (see
// workspaceDirPrefixes), every `<dir>/<subdir>/package.json` one level under
// each matching directory. A malformed/unreadable individual file is
// skipped silently, never aborting the scan. Workspace *discovery* here does
// NOT depend on which lockfile is present — that gating only applies to
// mineCommands' command emission for workspace packages (v1: pnpm-only),
// not to which script names exist in the repo.
function collectPackageJsonFiles(projectDir: string): PackageJsonEntry[] {
  const entries: PackageJsonEntry[] = [];

  const rootAbs = path.join(projectDir, "package.json");
  if (existsSync(rootAbs)) {
    const pkg = readPackageJson(rootAbs);
    if (pkg) {
      entries.push({ relPath: "package.json", pkgName: typeof pkg.name === "string" ? pkg.name : null, scripts: scriptsOf(pkg) });
    }
  }

  for (const dirPrefix of workspaceDirPrefixes(projectDir)) {
    const dirAbs = path.join(projectDir, dirPrefix);
    let subdirs: string[];
    try {
      subdirs = readdirSync(dirAbs, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      continue;
    }
    for (const subdir of subdirs) {
      const pkgAbs = path.join(dirAbs, subdir, "package.json");
      if (!existsSync(pkgAbs)) continue;
      const pkg = readPackageJson(pkgAbs);
      if (!pkg) continue;
      entries.push({
        relPath: `${dirPrefix}/${subdir}/package.json`,
        pkgName: typeof pkg.name === "string" ? pkg.name : null,
        scripts: scriptsOf(pkg),
      });
    }
  }

  return entries;
}

// package.json script names across root + workspace packages. Exported so
// Task 3's command validator can check "does this script name actually
// exist somewhere in the repo" without duplicating the file-walk logic
// here. Kept pure/sync (existsSync + readFileSync only, no subprocess, no
// network) so it's cheap to call from a validation hot path.
export function listScriptNames(projectDir: string): Set<string> {
  const names = new Set<string>();
  for (const entry of collectPackageJsonFiles(projectDir)) {
    for (const name of Object.keys(entry.scripts)) names.add(name);
  }
  return names;
}

// Matches a Makefile/justfile target-defining line: a name starting with
// [A-Za-z0-9_] (so a leading `.` — as in `.PHONY:`, `.DEFAULT:`, etc. — never
// matches), followed by optional whitespace, a `:`, and then anything OTHER
// than `=` (or end of line) — which is what excludes `VAR := x` assignments,
// since the character right after `:` there is `=`.
const MAKE_TARGET_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:([^=]|$)/;

function parseTargetLines(content: string): string[] {
  const targets: string[] = [];
  for (const line of content.split("\n")) {
    const name = MAKE_TARGET_RE.exec(line)?.[1];
    if (name) targets.push(name);
  }
  return targets;
}

interface TargetFile {
  relPath: "Makefile" | "justfile";
  runner: "make" | "just";
  targets: string[];
}

// Root-only (no recursive search): a Makefile/justfile nested in a
// subdirectory is not a repo-level build entry point in the way root
// package.json scripts or CI workflows are. A file that exists but can't be
// read is skipped silently.
function collectTargetFiles(projectDir: string): TargetFile[] {
  const files: TargetFile[] = [];
  for (const [relPath, runner] of [
    ["Makefile", "make"],
    ["justfile", "just"],
  ] as const) {
    const abs = path.join(projectDir, relPath);
    if (!existsSync(abs)) continue;
    try {
      files.push({ relPath, runner, targets: parseTargetLines(readFileSync(abs, "utf8")) });
    } catch {
      // Unreadable despite existsSync (e.g. permissions) — skip silently.
    }
  }
  return files;
}

// Makefile + justfile target names at the project root. Exported for the
// same reason as listScriptNames — Task 3's validator reuses it — and kept
// to the same pure/sync contract.
export function listMakeTargets(projectDir: string): Set<string> {
  const targets = new Set<string>();
  for (const file of collectTargetFiles(projectDir)) {
    for (const target of file.targets) targets.add(target);
  }
  return targets;
}

interface StagedCommand {
  command: string;
  source: string;
}

function packageJsonCommands(projectDir: string): StagedCommand[] {
  const pm = detectPackageManager(projectDir);
  const out: StagedCommand[] = [];

  for (const entry of collectPackageJsonFiles(projectDir)) {
    const isRoot = entry.relPath === "package.json";
    // v1: workspace-package commands are only emitted for pnpm repos (the
    // `pnpm --filter <name> run <script>` form has no npm/yarn equivalent
    // this miner is willing to guess at) and only when the workspace
    // package actually declares a `name` field to filter on.
    if (!isRoot && (pm !== "pnpm" || !entry.pkgName)) continue;

    for (const name of Object.keys(entry.scripts)) {
      const command = isRoot
        ? pm === "pnpm"
          ? `pnpm run ${name}`
          : pm === "yarn"
            ? `yarn ${name}`
            : `npm run ${name}`
        : `pnpm --filter ${entry.pkgName} run ${name}`;
      out.push({ command, source: `${entry.relPath}:scripts.${name}` });
    }
  }
  return out;
}

function makeAndJustCommands(projectDir: string): StagedCommand[] {
  const out: StagedCommand[] = [];
  for (const file of collectTargetFiles(projectDir)) {
    for (const target of file.targets) {
      out.push({ command: `${file.runner} ${target}`, source: `${file.relPath}:${target}` });
    }
  }
  return out;
}

// Every `.github/workflows/*.yml`|`*.yaml`, yaml-parsed; walks
// `jobs.<job>.steps[].run` where `run` is a string, splitting multi-line
// blocks on newlines and dropping blank lines and `#`-comment lines — each
// remaining line becomes its own command. CI is the highest-trust source
// (already execution-validated by the project's own CI), which is why
// mineCommands merges it in last (see mineCommands). A workflow file that
// fails to parse, or whose shape doesn't match jobs/steps/run, is skipped —
// per file, and per step — never throwing.
function ciRunCommands(projectDir: string): StagedCommand[] {
  const workflowsDir = path.join(projectDir, ".github", "workflows");
  if (!existsSync(workflowsDir)) return [];

  let files: string[];
  try {
    files = readdirSync(workflowsDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .sort();
  } catch {
    return [];
  }

  const out: StagedCommand[] = [];
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(path.join(workflowsDir, file), "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;

    const jobs = (parsed as { jobs?: unknown }).jobs;
    if (typeof jobs !== "object" || jobs === null) continue;

    for (const [jobName, job] of Object.entries(jobs as Record<string, unknown>)) {
      if (typeof job !== "object" || job === null) continue;
      const steps = (job as { steps?: unknown }).steps;
      if (!Array.isArray(steps)) continue;

      const source = `ci:.github/workflows/${file}#${jobName}`;
      for (const step of steps) {
        if (typeof step !== "object" || step === null) continue;
        const run = (step as { run?: unknown }).run;
        if (typeof run !== "string") continue;

        for (const line of run.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
          out.push({ command: trimmed, source });
        }
      }
    }
  }
  return out;
}

// Mines deterministic build/test/lint commands straight off manifests and
// CI config — no LLM involvement. Stages run in trust order: package.json
// scripts (root + pnpm-workspace), then Makefile/justfile targets, then CI
// workflow `run:` steps last — CI is the highest-trust source (already
// execution-validated by the project's own CI), so when the exact same
// command string was already mined from an earlier stage, the CI source is
// merged onto that existing entry (stable first-seen order for both the
// entries and each entry's `sources`) rather than creating a duplicate.
//
// Every individual file this reads is best-effort: unreadable or
// unparsable JSON/YAML is skipped silently rather than aborting the whole
// scan, so this function never throws. An entirely empty (or nonexistent)
// projectDir resolves to `[]`.
export async function mineCommands(projectDir: string): Promise<MinedCommand[]> {
  const staged: StagedCommand[] = [
    ...packageJsonCommands(projectDir),
    ...makeAndJustCommands(projectDir),
    ...ciRunCommands(projectDir),
  ];

  const byCommand = new Map<string, MinedCommand>();
  for (const { command, source } of staged) {
    const existing = byCommand.get(command);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else {
      byCommand.set(command, { command, sources: [source] });
    }
  }
  return [...byCommand.values()];
}
