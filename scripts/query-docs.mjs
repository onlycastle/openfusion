import { readFileSync } from "node:fs";
import process from "node:process";

const map = JSON.parse(readFileSync("docs/agents/map.json", "utf8"));
const query = process.argv.slice(2).filter((arg) => arg !== "--").join(" ").trim().toLowerCase();

function tokens(value) {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

if (!query) {
  for (const topic of map.topics) {
    process.stdout.write(`${topic.id}\t${topic.doc}\t${topic.summary}\n`);
  }
  process.exit(0);
}

const queryTokens = new Set(tokens(query));
const ranked = map.topics
  .map((topic) => {
    const keywordTokens = new Set(topic.keywords.flatMap(tokens));
    const titleTokens = new Set(tokens(topic.title));
    const summaryTokens = new Set(tokens(topic.summary));
    const sourceTokens = new Set(topic.source_paths.flatMap(tokens));
    let score = 0;
    for (const token of queryTokens) {
      if (keywordTokens.has(token)) score += 5;
      if (titleTokens.has(token)) score += 4;
      if (summaryTokens.has(token)) score += 2;
      if (sourceTokens.has(token)) score += 1;
    }
    if (topic.keywords.some((keyword) => query.includes(keyword.toLowerCase()))) score += 6;
    return { topic, score };
  })
  .filter((item) => item.score > 0)
  .sort((a, b) => b.score - a.score || a.topic.id.localeCompare(b.topic.id));

if (ranked.length === 0) {
  process.stderr.write(`No agent documentation topic matched: ${query}\n`);
  process.exitCode = 1;
} else {
  for (const { topic, score } of ranked.slice(0, 5)) {
    process.stdout.write(`[${score}] ${topic.title}\n${topic.doc}\n${topic.summary}\nSources: ${topic.source_paths.join(", ")}\n\n`);
  }
}
