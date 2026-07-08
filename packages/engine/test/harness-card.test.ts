import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeCardBody,
  composeCardDigest,
  validateCardContent,
  type CardContent,
  type StrippedItem,
} from "../src/harness/card.js";
import type { MinedCommand } from "../src/harness/mine.js";

let dir: string;
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix = "of-card-"): string {
  dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

function writeFixtureFile(relPath: string, content: string): void {
  const abs = path.join(dir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function baseContent(overrides: Partial<CardContent> = {}): CardContent {
  return {
    title: "Test Project",
    commands: [{ command: "pnpm run test", why: "run unit tests" }],
    env: [],
    boundaries: [],
    anchors: [],
    glossary: [],
    gotchas: [],
    ...overrides,
  };
}

function maxCommand(i: number): { command: string; why: string } {
  return {
    command: `pnpm run cmd-${i}-${"x".repeat(200)}`.slice(0, 120),
    why: "why-".repeat(30).slice(0, 80),
  };
}

function maxGlossaryEntry(i: number): { term: string; meaning: string } {
  return {
    term: `term-${i}-${"t".repeat(40)}`.slice(0, 40),
    meaning: "meaning-".repeat(30).slice(0, 120),
  };
}

function maxBoundary(i: number): string {
  return `boundary-${i}-${"b".repeat(100)}`.slice(0, 100);
}

// 80 chars, not the schema's full 120-char max. With 8 max-length commands
// (~1676 chars) and 6 max-length (100-char) boundaries (~634 chars) already
// in the mix, a full 6-item run of 120-char env strings leaves so little
// headroom (~69 chars) that even a single 100-char boundary item can't
// survive item-wise trimming — the fixture would degenerate to "every
// boundary dropped" instead of exercising "some dropped, some kept intact".
// 80 chars leaves enough room for a couple of boundaries to survive, which
// is the behavior this test exists to verify.
function wideEnv(i: number): string {
  return `env-${i}-${"e".repeat(80)}`.slice(0, 80);
}

describe("validateCardContent", () => {
  it("keeps a command that exactly matches a mined command", () => {
    makeDir();
    const mined: MinedCommand[] = [{ command: "pnpm run test", sources: ["package.json:scripts.test"] }];
    const content = baseContent({ commands: [{ command: "pnpm run test", why: "run unit tests" }] });

    const { content: result, stripped } = validateCardContent(content, { mined, projectDir: dir });

    expect(result.commands).toEqual([{ command: "pnpm run test", why: "run unit tests" }]);
    expect(stripped).toEqual([]);
  });

  it("keeps an unmined `pnpm run <script>` command whose script exists in package.json", () => {
    makeDir();
    writeFixtureFile("package.json", JSON.stringify({ name: "root", scripts: { lint: "eslint ." } }));
    const content = baseContent({ commands: [{ command: "pnpm run lint", why: "lint" }] });

    const { content: result, stripped } = validateCardContent(content, { mined: [], projectDir: dir });

    expect(result.commands).toEqual([{ command: "pnpm run lint", why: "lint" }]);
    expect(stripped).toEqual([]);
  });

  // Final review Fix 2 (fail-safe recall): pnpm's own idiomatic shorthand
  // drops "run" entirely (`pnpm test`, `pnpm build`) — mirrors YARN_RUN_RE's
  // existing `(?:run )?` tolerance so a genuinely correct, idiomatic command
  // doesn't get stripped for a purely cosmetic reason.
  it("keeps an unmined bare `pnpm <script>` command (no `run`) whose script exists in package.json", () => {
    makeDir();
    writeFixtureFile("package.json", JSON.stringify({ name: "root", scripts: { test: "vitest run" } }));
    const content = baseContent({ commands: [{ command: "pnpm test", why: "run unit tests" }] });

    const { content: result, stripped } = validateCardContent(content, { mined: [], projectDir: dir });

    expect(result.commands).toEqual([{ command: "pnpm test", why: "run unit tests" }]);
    expect(stripped).toEqual([]);
  });

  // npm bare-script shorthand (`npm test`, `npm start`) IS a real lifecycle
  // convention, but per the reviewer's explicit call, npm stays strict
  // (`npm run X` only) — the fail-safe choice: unlike pnpm/yarn, a bare `npm
  // <word>` collides with npm's OWN built-in subcommands (npm install, npm
  // ci, ...), so widening npm the same way pnpm/yarn were risks treating a
  // non-script npm invocation as if it resolved a project script. Strictness
  // here costs nothing but a slightly awkward round-trip through `npm run
  // test`, and buys unambiguous trust.
  it("still strips a bare `npm test` command (no `run`) even though the script exists — npm bare-script shorthand stays unsupported by design", () => {
    makeDir();
    writeFixtureFile("package.json", JSON.stringify({ name: "root", scripts: { test: "vitest run" } }));
    const content = baseContent({ commands: [{ command: "npm test", why: "run unit tests" }] });

    const { content: result, stripped } = validateCardContent(content, { mined: [], projectDir: dir });

    expect(result.commands).toEqual([]);
    expect(stripped).toEqual([
      { item: "npm test", reason: "unmined command; no matching script/target in any manifest" },
    ]);
  });

  it("keeps an unmined `yarn run <script>` command whose script exists in package.json (yarn.lock present)", () => {
    makeDir();
    writeFixtureFile("package.json", JSON.stringify({ name: "root", scripts: { lint: "eslint ." } }));
    writeFixtureFile("yarn.lock", "");
    const content = baseContent({ commands: [{ command: "yarn run lint", why: "lint" }] });

    const { content: result, stripped } = validateCardContent(content, { mined: [], projectDir: dir });

    expect(result.commands).toEqual([{ command: "yarn run lint", why: "lint" }]);
    expect(stripped).toEqual([]);
  });

  it("keeps an unmined plain `yarn <script>` command (no `run`) whose script exists in package.json", () => {
    makeDir();
    writeFixtureFile("package.json", JSON.stringify({ name: "root", scripts: { lint: "eslint ." } }));
    writeFixtureFile("yarn.lock", "");
    const content = baseContent({ commands: [{ command: "yarn lint", why: "lint" }] });

    const { content: result, stripped } = validateCardContent(content, { mined: [], projectDir: dir });

    expect(result.commands).toEqual([{ command: "yarn lint", why: "lint" }]);
    expect(stripped).toEqual([]);
  });

  it("keeps a `make <target>` command whose target exists in the Makefile", () => {
    makeDir();
    writeFixtureFile("Makefile", ["build:", "\techo building", ""].join("\n"));
    const content = baseContent({ commands: [{ command: "make build", why: "build" }] });

    const { content: result, stripped } = validateCardContent(content, { mined: [], projectDir: dir });

    expect(result.commands).toEqual([{ command: "make build", why: "build" }]);
    expect(stripped).toEqual([]);
  });

  it('strips "npm run ghost" with the exact reason when no manifest declares it', () => {
    makeDir();
    writeFixtureFile("package.json", JSON.stringify({ name: "root", scripts: { test: "vitest run" } }));
    const content = baseContent({ commands: [{ command: "npm run ghost", why: "??" }] });

    const { content: result, stripped } = validateCardContent(content, { mined: [], projectDir: dir });

    expect(result.commands).toEqual([]);
    expect(stripped).toEqual([
      { item: "npm run ghost", reason: "unmined command; no matching script/target in any manifest" },
    ]);
  });

  // These anchor-focused tests keep the default `pnpm run test` command
  // (from baseContent) passing by mining it explicitly, so the only thing
  // that can show up in `stripped` is the anchor under test.
  const passingDefaultCommand: MinedCommand[] = [{ command: "pnpm run test", sources: ["package.json:scripts.test"] }];

  it("keeps an anchor pointing at a real fixture file", () => {
    makeDir();
    writeFixtureFile("src/index.ts", "export {}\n");
    const content = baseContent({ anchors: [{ path: "src/index.ts", note: "entry point" }] });

    const { content: result, stripped } = validateCardContent(content, {
      mined: passingDefaultCommand,
      projectDir: dir,
    });

    expect(result.anchors).toEqual([{ path: "src/index.ts", note: "entry point" }]);
    expect(stripped).toEqual([]);
  });

  it("strips an anchor pointing at a nonexistent path", () => {
    makeDir();
    const content = baseContent({ anchors: [{ path: "no/such/file.ts", note: "missing" }] });

    const { content: result, stripped } = validateCardContent(content, {
      mined: passingDefaultCommand,
      projectDir: dir,
    });

    expect(result.anchors).toEqual([]);
    expect(stripped).toHaveLength(1);
    expect(stripped[0]?.item).toBe("no/such/file.ts");
  });

  it("strips an anchor whose symbol does not resolve, even when the path exists", () => {
    makeDir();
    writeFixtureFile("src/index.ts", "export {}\n");
    const content = baseContent({
      anchors: [{ path: "src/index.ts", note: "entry point", symbol: "Nope" }],
    });

    const { content: result, stripped } = validateCardContent(content, {
      mined: passingDefaultCommand,
      projectDir: dir,
      symbolExists: () => false,
    });

    expect(result.anchors).toEqual([]);
    expect(stripped).toHaveLength(1);
    expect(stripped[0]?.item).toBe("src/index.ts");
  });

  it("does not mutate the input content object", () => {
    makeDir();
    const content = baseContent({
      commands: [{ command: "npm run ghost", why: "??" }],
      anchors: [{ path: "no/such/file.ts", note: "missing" }],
    });
    const snapshot = JSON.parse(JSON.stringify(content)) as CardContent;

    validateCardContent(content, { mined: [], projectDir: dir });

    expect(content).toEqual(snapshot);
  });
});

describe("composeCardDigest", () => {
  it("always includes commands, environment, and do-not-touch sections", () => {
    const content = baseContent({
      commands: [{ command: "pnpm run test", why: "run unit tests" }],
      env: ["Node >= 22"],
      boundaries: ["never edit generated/*"],
    });

    const digest = composeCardDigest(content);

    expect(digest).toContain("Commands");
    expect(digest).toContain("Environment");
    expect(digest).toContain("Do not touch");
    expect(digest.length).toBeLessThanOrEqual(2500);
  });

  it("drops the glossary section (but keeps commands intact) when an 8-entry glossary pushes the digest over 2500 chars", () => {
    const commands = Array.from({ length: 8 }, (_, i) => maxCommand(i));
    const glossary = Array.from({ length: 8 }, (_, i) => maxGlossaryEntry(i));
    const content = baseContent({ commands, glossary });

    // Sanity check on the fixture itself: this input must actually overflow
    // the budget for the test to mean anything.
    const withoutTrimming = [
      "### Commands",
      ...commands.map((c) => `- \`${c.command}\` — ${c.why}`),
      "### Glossary",
      ...glossary.map((g) => `- **${g.term}**: ${g.meaning}`),
    ].join("\n");
    expect(withoutTrimming.length).toBeGreaterThan(2500);

    const digest = composeCardDigest(content);

    expect(digest).not.toContain("Glossary");
    expect(digest).toContain("Commands");
    for (const c of commands) {
      expect(digest).toContain(c.command);
    }
    expect(digest.length).toBeLessThanOrEqual(2500);
  });

  it("drops boundaries items last-first, never mid-string, when maxed commands+env+boundaries alone push the digest over 2500 chars", () => {
    const commands = Array.from({ length: 8 }, (_, i) => maxCommand(i));
    const env = Array.from({ length: 6 }, (_, i) => wideEnv(i));
    const boundaries = Array.from({ length: 6 }, (_, i) => maxBoundary(i));
    const content = baseContent({ commands, env, boundaries });

    // Sanity check on the fixture itself: this input must actually overflow
    // the budget for the test to mean anything, and it must overflow from
    // commands+env+boundaries ALONE (no glossary/gotchas/anchors present, so
    // the whole-section trim loop has nothing to drop).
    const withoutTrimming = [
      "### Commands",
      ...commands.map((c) => `- \`${c.command}\` — ${c.why}`),
      "### Environment",
      ...env.map((e) => `- ${e}`),
      "### Do not touch",
      ...boundaries.map((b) => `- ${b}`),
    ].join("\n");
    expect(withoutTrimming.length).toBeGreaterThan(2500);

    const digest = composeCardDigest(content);

    expect(digest.length).toBeLessThanOrEqual(2500);

    // Commands: never touched by item-wise dropping — every command string
    // present verbatim.
    expect(digest).toContain("Commands");
    for (const c of commands) {
      expect(digest).toContain(c.command);
    }

    // Environment: dropping only reaches env "if needed after boundaries" —
    // in this fixture, dropping boundaries items alone is enough, so env is
    // untouched. Every env string present verbatim.
    expect(digest).toContain("Environment");
    for (const e of env) {
      expect(digest).toContain(e);
    }

    // Boundaries: section present with FEWER items than the input, but
    // every REMAINING item intact verbatim — no mid-string cut. Extract the
    // rendered "Do not touch" block (the last section in this fixture) and
    // check each rendered line is an exact, complete input boundary string.
    expect(digest).toContain("Do not touch");
    const boundariesBlock = digest.split("### Do not touch\n")[1] ?? "";
    const renderedBoundaryLines = boundariesBlock.split("\n").filter((l) => l.length > 0);
    expect(renderedBoundaryLines.length).toBeGreaterThan(0);
    expect(renderedBoundaryLines.length).toBeLessThan(boundaries.length);
    for (const line of renderedBoundaryLines) {
      expect(line.startsWith("- ")).toBe(true);
      expect(boundaries).toContain(line.slice(2));
    }
  });
});

describe("composeCardBody", () => {
  it("includes a Provenance section citing a mined command's sources", () => {
    const mined: MinedCommand[] = [{ command: "pnpm run test", sources: ["package.json:scripts.test"] }];
    const content = baseContent({ commands: [{ command: "pnpm run test", why: "run unit tests" }] });

    const body = composeCardBody(content, mined, []);

    expect(body).toContain("## Provenance");
    expect(body).toContain("package.json:scripts.test");
  });

  it("includes a Stripped at generation section when stripped is non-empty", () => {
    const content = baseContent();
    const stripped: StrippedItem[] = [
      { item: "npm run ghost", reason: "unmined command; no matching script/target in any manifest" },
    ];

    const body = composeCardBody(content, [], stripped);

    expect(body).toContain("## Stripped at generation");
    expect(body).toContain("unmined command; no matching script/target in any manifest");
  });

  it("omits the Stripped at generation section when nothing was stripped", () => {
    const content = baseContent();

    const body = composeCardBody(content, [], []);

    expect(body).not.toContain("## Stripped at generation");
  });
});
