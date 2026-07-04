import { describe, expect, it } from "vitest";
import { WikiBuildProgressSchema } from "../src/index.js";

describe("WikiBuildProgressSchema", () => {
  it("accepts a valid {projectDir, detail} payload", () => {
    const parsed = WikiBuildProgressSchema.parse({
      projectDir: "/tmp/some-project",
      detail: "indexed 42/120 files",
    });
    expect(parsed.projectDir).toBe("/tmp/some-project");
    expect(parsed.detail).toBe("indexed 42/120 files");
  });

  it("rejects a missing projectDir", () => {
    expect(WikiBuildProgressSchema.safeParse({ detail: "indexed 1/1 files" }).success).toBe(false);
  });

  it("rejects an empty detail", () => {
    expect(
      WikiBuildProgressSchema.safeParse({ projectDir: "/tmp/x", detail: "" }).success,
    ).toBe(false);
  });
});
