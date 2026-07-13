import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activateSkills, discoverSkills, loadSkill } from "../src/runtime/skills.js";

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function root(): string {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-skills-"));
  return dir;
}

describe("skill adapters", () => {
  it("normalizes pure common instructions and activates them without approval", () => {
    const project = root();
    const skillRoot = path.join(project, ".agents", "skills", "explain");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(path.join(skillRoot, "SKILL.md"), "---\nname: explain\ndescription: Explain code\n---\nBe concise.\n");
    const [skill] = discoverSkills(project);
    expect(skill).toMatchObject({ dialect: "common", requiresApproval: false, id: "explain" });
    expect(activateSkills([skill!], new Set()).active).toHaveLength(1);
  });

  it("parses Claude fields and requires the exact changed fingerprint for scripts", () => {
    const project = root();
    const skillRoot = path.join(project, ".claude", "skills", "build");
    mkdirSync(path.join(skillRoot, "scripts"), { recursive: true });
    const skillFile = path.join(skillRoot, "SKILL.md");
    writeFileSync(skillFile, "---\nname: build\ndescription: Build safely\nhooks: {pre: check}\nshell: scripts/run.sh\nallowed-tools: Bash Read\n---\nRun checks.\n");
    writeFileSync(path.join(skillRoot, "scripts", "run.sh"), "#!/bin/sh\nexit 0\n");
    const skill = loadSkill(skillFile);
    expect(skill.dialect).toBe("claude-code");
    expect(skill.requiresApproval).toBe(true);
    expect(skill.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unsupported-field", field: "hooks" }),
      expect.objectContaining({ code: "approval-required" }),
    ]));
    expect(activateSkills([skill], new Set()).active).toHaveLength(0);
    expect(activateSkills([skill], new Set([skill.fingerprint])).active).toHaveLength(1);
    writeFileSync(path.join(skillRoot, "scripts", "run.sh"), "#!/bin/sh\nexit 1\n");
    expect(loadSkill(skillFile).fingerprint).not.toBe(skill.fingerprint);
  });

  it("normalizes Codex .agents/openai.yaml and reports unavailable MCP fields", () => {
    const project = root();
    const skillRoot = path.join(project, ".agents", "skills", "research");
    mkdirSync(path.join(skillRoot, ".agents"), { recursive: true });
    const skillFile = path.join(skillRoot, "SKILL.md");
    writeFileSync(skillFile, "---\nname: research\ndescription: Research project\n---\nInspect sources.\n");
    writeFileSync(path.join(skillRoot, ".agents", "openai.yaml"), [
      "interface:",
      "  display_name: Researcher",
      "  short_description: Inspect evidence",
      "dependencies:",
      "  tools: [read_file]",
      "mcp:",
      "  servers: [wiki]",
      "invocation_policy:",
      "  allow_implicit_invocation: false",
      "",
    ].join("\n"));
    const skill = loadSkill(skillFile);
    expect(skill).toMatchObject({
      dialect: "codex",
      name: "Researcher",
      invocation: { implicit: false, userInvocable: true },
      requiresApproval: true,
    });
    expect(skill.diagnostics).toContainEqual(expect.objectContaining({ code: "unsupported-field", field: "mcp" }));
  });
});
