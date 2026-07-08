import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listMakeTargets, listScriptNames, mineCommands, type MinedCommand } from "../src/harness/mine.js";

let dir: string;
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix = "of-mine-"): string {
  dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

function writeFixtureFile(relPath: string, content: string): void {
  const abs = path.join(dir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commandsOf(entries: MinedCommand[]): string[] {
  return entries.map((e) => e.command).sort();
}

function findEntry(entries: MinedCommand[], command: string): MinedCommand | undefined {
  return entries.find((e) => e.command === command);
}

describe("mineCommands", () => {
  it("returns [] for an entirely empty dir", async () => {
    makeDir();
    expect(await mineCommands(dir)).toEqual([]);
  });

  it("mines root + pnpm-workspace package.json scripts with pnpm-aware commands and sources", async () => {
    makeDir();
    writeFixtureFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeFixtureFile("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    writeFixtureFile(
      "package.json",
      JSON.stringify({ name: "root", scripts: { test: "vitest run", build: "tsc -p ." } }),
    );
    writeFixtureFile("packages/a/package.json", JSON.stringify({ name: "@x/a", scripts: { lint: "eslint ." } }));

    const entries = await mineCommands(dir);

    expect(findEntry(entries, "pnpm run test")).toEqual({
      command: "pnpm run test",
      sources: ["package.json:scripts.test"],
    });
    expect(findEntry(entries, "pnpm run build")).toEqual({
      command: "pnpm run build",
      sources: ["package.json:scripts.build"],
    });
    expect(findEntry(entries, "pnpm --filter @x/a run lint")).toEqual({
      command: "pnpm --filter @x/a run lint",
      sources: ["packages/a/package.json:scripts.lint"],
    });
  });

  it("mines exactly the Makefile targets that aren't .PHONY-style or := assignments", async () => {
    makeDir();
    writeFixtureFile(
      "Makefile",
      ["build:", "\techo building", "", "test-all:", "\techo testing", "", ".PHONY: build test-all", "VAR := x", ""].join(
        "\n",
      ),
    );

    const entries = await mineCommands(dir);

    expect(commandsOf(entries)).toEqual(["make build", "make test-all"].sort());
    expect(findEntry(entries, "make build")?.sources).toEqual(["Makefile:build"]);
    expect(findEntry(entries, "make test-all")?.sources).toEqual(["Makefile:test-all"]);
  });

  it("mines both commands from a multi-line CI run: block, dropping the comment line", async () => {
    makeDir();
    writeFixtureFile(
      ".github/workflows/ci.yml",
      [
        "name: CI",
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: |",
        "          echo one",
        "          # a comment, dropped",
        "          echo two",
        "",
      ].join("\n"),
    );

    const entries = await mineCommands(dir);

    expect(commandsOf(entries)).toEqual(["echo one", "echo two"].sort());
    expect(findEntry(entries, "echo one")?.sources).toEqual(["ci:.github/workflows/ci.yml#build"]);
    expect(findEntry(entries, "echo two")?.sources).toEqual(["ci:.github/workflows/ci.yml#build"]);
  });

  it("dedupes a command that appears in both package.json and CI into one entry with two sources", async () => {
    makeDir();
    writeFixtureFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeFixtureFile("package.json", JSON.stringify({ name: "root", scripts: { build: "tsc -p ." } }));
    writeFixtureFile(
      ".github/workflows/ci.yml",
      ["jobs:", "  ci:", "    steps:", "      - run: pnpm run build", ""].join("\n"),
    );

    const entries = await mineCommands(dir);

    expect(entries.filter((e) => e.command === "pnpm run build")).toHaveLength(1);
    expect(findEntry(entries, "pnpm run build")?.sources).toEqual([
      "package.json:scripts.build",
      "ci:.github/workflows/ci.yml#ci",
    ]);
  });

  it("never throws on malformed JSON/YAML input files and skips them silently", async () => {
    makeDir();
    writeFixtureFile("package.json", "{ not valid json");
    writeFixtureFile("pnpm-workspace.yaml", "packages: [this, is: not, - valid");
    writeFixtureFile(".github/workflows/broken.yml", "not: valid: yaml: [");

    await expect(mineCommands(dir)).resolves.toEqual([]);
  });

  it("ignores unsupported workspace glob patterns (multi-segment ** and negations)", async () => {
    makeDir();
    writeFixtureFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    writeFixtureFile("pnpm-workspace.yaml", "packages:\n  - packages/*\n  - apps/**\n  - '!packages/excluded'\n");
    writeFixtureFile("package.json", JSON.stringify({ name: "root", scripts: {} }));
    writeFixtureFile("packages/a/package.json", JSON.stringify({ name: "@x/a", scripts: { lint: "eslint ." } }));
    writeFixtureFile("apps/b/package.json", JSON.stringify({ name: "@x/b", scripts: { lint: "eslint ." } }));

    const entries = await mineCommands(dir);

    expect(findEntry(entries, "pnpm --filter @x/a run lint")).toBeDefined();
    expect(findEntry(entries, "pnpm --filter @x/b run lint")).toBeUndefined();
  });

  it("skips non-root package.json scripts for yarn/npm repos even when pnpm-workspace.yaml exists (v1)", async () => {
    makeDir();
    writeFixtureFile("yarn.lock", "");
    writeFixtureFile("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    writeFixtureFile("package.json", JSON.stringify({ name: "root", scripts: { test: "jest" } }));
    writeFixtureFile("packages/a/package.json", JSON.stringify({ name: "@x/a", scripts: { lint: "eslint ." } }));

    const entries = await mineCommands(dir);

    expect(findEntry(entries, "yarn test")).toEqual({ command: "yarn test", sources: ["package.json:scripts.test"] });
    expect(entries.some((e) => e.command.includes("@x/a"))).toBe(false);
  });

  it("uses npm as the default runner when no lockfile is present", async () => {
    makeDir();
    writeFixtureFile("package.json", JSON.stringify({ name: "root", scripts: { test: "jest" } }));

    const entries = await mineCommands(dir);

    expect(findEntry(entries, "npm run test")).toEqual({
      command: "npm run test",
      sources: ["package.json:scripts.test"],
    });
  });
});

describe("listScriptNames", () => {
  it("returns [] for an empty dir", () => {
    makeDir();
    expect(listScriptNames(dir)).toEqual(new Set());
  });

  it("collects script names across root and pnpm-workspace packages", () => {
    makeDir();
    writeFixtureFile("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    writeFixtureFile("package.json", JSON.stringify({ name: "root", scripts: { test: "vitest run" } }));
    writeFixtureFile("packages/a/package.json", JSON.stringify({ name: "@x/a", scripts: { lint: "eslint ." } }));

    expect(listScriptNames(dir)).toEqual(new Set(["test", "lint"]));
  });

  it("never throws on a malformed root package.json", () => {
    makeDir();
    writeFixtureFile("package.json", "{ not valid json");
    expect(() => listScriptNames(dir)).not.toThrow();
    expect(listScriptNames(dir)).toEqual(new Set());
  });
});

describe("listMakeTargets", () => {
  it("returns [] when neither Makefile nor justfile exist", () => {
    makeDir();
    expect(listMakeTargets(dir)).toEqual(new Set());
  });

  it("excludes .PHONY-style and := lines from both Makefile and justfile", () => {
    makeDir();
    writeFixtureFile("Makefile", ["build:", "\techo build", ".PHONY: build", "VAR := x", ""].join("\n"));
    writeFixtureFile("justfile", ["test:", "    echo test", ""].join("\n"));

    expect(listMakeTargets(dir)).toEqual(new Set(["build", "test"]));
  });
});
