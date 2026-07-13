import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const failures = [];
const requiredHumanDocs = [
  "docs/human/README.md",
  "docs/human/getting-started.md",
  "docs/human/workflows.md",
  "docs/human/architecture.md",
  "docs/human/development.md",
  "docs/human/documentation.md",
];
const requiredKnowledgeBaseDocs = [
  "docs/knowledge_base/README.md",
  "docs/knowledge_base/index.md",
  "docs/knowledge_base/log.md",
];

function fail(message) {
  failures.push(message);
}

function filesUnder(dir) {
  const result = [];
  for (const name of readdirSync(dir)) {
    const absolute = path.join(dir, name);
    if (statSync(absolute).isDirectory()) result.push(...filesUnder(absolute));
    else result.push(absolute);
  }
  return result;
}

function repoPath(value) {
  return path.join(root, value);
}

for (const relative of [
  "AGENTS.md",
  "docs/README.md",
  "docs/agents/map.json",
  ...requiredHumanDocs,
  ...requiredKnowledgeBaseDocs,
]) {
  if (!existsSync(repoPath(relative))) fail(`missing required documentation file: ${relative}`);
}

const agentDir = repoPath("docs/agents");
const agentFiles = existsSync(agentDir)
  ? filesUnder(agentDir).filter((file) => file.endsWith(".md")).sort()
  : [];

const frontmatterByFile = new Map();
for (const absolute of agentFiles) {
  const relative = path.relative(root, absolute);
  const text = readFileSync(absolute, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) {
    fail(`${relative}: missing YAML frontmatter`);
    continue;
  }
  const metadata = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  for (const key of ["title", "summary", "status", "verified", "source_paths"]) {
    if (!metadata[key]) fail(`${relative}: missing frontmatter field ${key}`);
  }
  if (metadata.verified && !/^\d{4}-\d{2}-\d{2}$/.test(metadata.verified)) {
    fail(`${relative}: verified must use YYYY-MM-DD`);
  }
  let sourcePaths = [];
  try {
    sourcePaths = JSON.parse(metadata.source_paths ?? "[]");
  } catch {
    fail(`${relative}: source_paths must be a JSON array on one line`);
  }
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) {
    fail(`${relative}: source_paths must contain at least one path`);
  } else {
    for (const sourcePath of sourcePaths) {
      if (typeof sourcePath !== "string" || !existsSync(repoPath(sourcePath))) {
        fail(`${relative}: source path does not exist: ${String(sourcePath)}`);
      }
    }
  }
  frontmatterByFile.set(relative, metadata);
}

let map;
try {
  map = JSON.parse(readFileSync(repoPath("docs/agents/map.json"), "utf8"));
} catch (error) {
  fail(`docs/agents/map.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
}

if (map) {
  if (map.schemaVersion !== 1) fail("docs/agents/map.json: unsupported schemaVersion");
  if (!Array.isArray(map.topics) || map.topics.length === 0) {
    fail("docs/agents/map.json: topics must be a non-empty array");
  } else {
    const ids = new Set();
    for (const topic of map.topics) {
      if (typeof topic.id !== "string" || topic.id.length === 0) fail("map topic is missing id");
      else if (ids.has(topic.id)) fail(`duplicate map topic id: ${topic.id}`);
      else ids.add(topic.id);
      if (typeof topic.doc !== "string" || !frontmatterByFile.has(topic.doc)) {
        fail(`map topic ${topic.id ?? "<unknown>"}: doc is missing or is not an agent page: ${String(topic.doc)}`);
      }
      if (!Array.isArray(topic.keywords) || topic.keywords.length === 0) {
        fail(`map topic ${topic.id ?? "<unknown>"}: keywords must be non-empty`);
      }
      for (const sourcePath of topic.source_paths ?? []) {
        if (!existsSync(repoPath(sourcePath))) {
          fail(`map topic ${topic.id ?? "<unknown>"}: source path does not exist: ${sourcePath}`);
        }
      }
    }
  }
}

const curatedMarkdown = [
  repoPath("README.md"),
  repoPath("AGENTS.md"),
  repoPath("docs/README.md"),
  repoPath("apps/desktop/README.md"),
  ...requiredHumanDocs.map(repoPath),
  ...requiredKnowledgeBaseDocs.map(repoPath),
  ...agentFiles,
];
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
for (const absolute of curatedMarkdown) {
  if (!existsSync(absolute)) continue;
  const relative = path.relative(root, absolute);
  const text = readFileSync(absolute, "utf8");
  for (const match of text.matchAll(linkPattern)) {
    const target = match[1].trim();
    if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#") || target.startsWith("mailto:")) continue;
    const withoutFragment = target.split("#", 1)[0];
    if (!withoutFragment) continue;
    const resolved = path.resolve(path.dirname(absolute), withoutFragment);
    if (!existsSync(resolved)) fail(`${relative}: broken local link: ${target}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`docs:check: ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`docs:check: ${requiredHumanDocs.length} human guides, ${requiredKnowledgeBaseDocs.length} knowledge-base files, ${agentFiles.length} agent pages, and ${map.topics.length} topics are valid\n`);
}
