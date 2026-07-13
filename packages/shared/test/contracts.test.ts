import { describe, expect, it } from "vitest";
import { DelegationRequestSchema } from "../src/contracts.js";

describe("shared runtime contracts", () => {
  it("validates a content-bounded delegation request without credentials", () => {
    const request = DelegationRequestSchema.parse({
      schemaVersion: 1,
      requestId: "delegation-1",
      parentSessionId: "parent-1",
      task: "Inspect the failing module and return a patch artifact.",
      target: { providerId: "worker-provider", model: "worker-model", dialectPack: "codex-like" },
      budget: { maxSteps: 12, deadlineAt: "2026-07-12T13:00:00.000Z" },
      baseSha: "a".repeat(40),
      authorityDigest: `sha256:${"b".repeat(64)}`,
    });
    expect(request.target.providerId).toBe("worker-provider");
    expect(JSON.stringify(request)).not.toMatch(/api.?key|credential|secret/i);
  });

  it("rejects unbounded or malformed delegation authority", () => {
    expect(DelegationRequestSchema.safeParse({
      schemaVersion: 1,
      requestId: "delegation-1",
      parentSessionId: "parent-1",
      task: "task",
      target: { providerId: "p1", model: "m1" },
      budget: { maxSteps: 101, deadlineAt: "not-a-date" },
      baseSha: "HEAD",
      authorityDigest: "sha256:nope",
    }).success).toBe(false);
  });
});
