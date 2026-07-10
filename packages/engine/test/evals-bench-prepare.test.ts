import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareBench } from "../src/evals/bench/prepare.js";

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function makeDir(): string {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-bench-prepare-"));
  return dir;
}

function writeDataset(root: string): string {
  const file = path.join(root, "mini.json");
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        dataset: "test/mini",
        version: 1,
        instances: [
          {
            instance_id: "django__django-1",
            repo: "django/django",
            base_commit: "a".repeat(40),
            problem_statement: "fix django",
          },
          {
            instance_id: "sphinx-doc__sphinx-1",
            repo: "sphinx-doc/sphinx",
            base_commit: "b".repeat(40),
            problem_statement: "fix sphinx",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

describe("prepareBench", () => {
  it("rejects one approve-from harness for a multi-repo dataset", async () => {
    const root = makeDir();
    const datasetPath = writeDataset(root);
    const approveFrom = path.join(root, "approved-harness");
    mkdirSync(approveFrom, { recursive: true });
    writeFileSync(path.join(approveFrom, "manifest.json"), "{}\n");

    await expect(
      prepareBench(null, {
        benchRoot: path.join(root, "bench"),
        datasetPath,
        approveFrom,
        log: () => {},
      }),
    ).rejects.toThrow(/dataset spans multiple repos/);
  });
});
