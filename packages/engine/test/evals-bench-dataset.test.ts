import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORBIDDEN_RUN_SIDE_FIELDS,
  loadBenchDataset,
  selectInstances,
} from "../src/evals/bench/dataset.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function writeFixture(instances: unknown[]): string {
  tmp = mkdtempSync(path.join(os.tmpdir(), "of-bench-ds-"));
  const file = path.join(tmp, "mini.json");
  writeFileSync(
    file,
    JSON.stringify({
      dataset: "test/mini",
      version: 1,
      instances,
    }),
  );
  return file;
}

describe("bench dataset", () => {
  it("loads and strips forbidden run-side fields", () => {
    const file = writeFixture([
      {
        instance_id: "django__django-1",
        repo: "django/django",
        base_commit: "a".repeat(40),
        problem_statement: "fix the bug",
        patch: "SECRET_GOLD_PATCH",
        test_patch: "SECRET_TEST_PATCH",
        hints_text: "SECRET_HINTS",
      },
      {
        instance_id: "sphinx-doc__sphinx-1",
        repo: "sphinx-doc/sphinx",
        base_commit: "b".repeat(40),
        problem_statement: "another issue",
        patch: "x",
        test_patch: "y",
        hints_text: "z",
      },
    ]);
    const ds = loadBenchDataset(file);
    expect(ds.instances).toHaveLength(2);
    expect(ds.instanceIds).toEqual(["django__django-1", "sphinx-doc__sphinx-1"]);
    for (const inst of ds.instances) {
      for (const key of FORBIDDEN_RUN_SIDE_FIELDS) {
        expect(Object.prototype.hasOwnProperty.call(inst, key)).toBe(false);
        expect((inst as unknown as Record<string, unknown>)[key]).toBeUndefined();
      }
      expect(inst.problem_statement).toBeTruthy();
      expect(JSON.stringify(inst)).not.toContain("SECRET_");
    }
  });

  it("rejects malformed instances", () => {
    const file = writeFixture([{ instance_id: "x" }]);
    expect(() => loadBenchDataset(file)).toThrow();
  });

  it("selectInstances supports limit and instance id", () => {
    const file = writeFixture([
      {
        instance_id: "a",
        repo: "django/django",
        base_commit: "a".repeat(40),
        problem_statement: "one",
      },
      {
        instance_id: "b",
        repo: "django/django",
        base_commit: "b".repeat(40),
        problem_statement: "two",
      },
    ]);
    const ds = loadBenchDataset(file);
    expect(selectInstances(ds, { limit: 1 }).map((i) => i.instance_id)).toEqual(["a"]);
    expect(selectInstances(ds, { instanceId: "b" })[0]!.instance_id).toBe("b");
    expect(() => selectInstances(ds, { instanceId: "nope" })).toThrow(/unknown instance/);
  });

  it("loads vendored mini dataset when present", () => {
    const vendored = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../benchmarks/swe-bench-verified-mini.json",
    );
    // Skip if someone deleted the vendored file in a sparse checkout.
    try {
      const ds = loadBenchDataset(vendored);
      expect(ds.instances.length).toBe(50);
      const repos = new Set(ds.instances.map((i) => i.repo));
      expect(repos.size).toBe(2);
      expect(repos.has("django/django")).toBe(true);
      expect(repos.has("sphinx-doc/sphinx")).toBe(true);
      for (const inst of ds.instances) {
        for (const key of FORBIDDEN_RUN_SIDE_FIELDS) {
          expect(Object.prototype.hasOwnProperty.call(inst, key)).toBe(false);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) return;
      throw err;
    }
  });
});
