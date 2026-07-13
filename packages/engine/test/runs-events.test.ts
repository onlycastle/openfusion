import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendRunEvent,
  readRunEvents,
  RunEventRecorder,
  runEventsPath,
  type RunEvent,
} from "../src/runs/events.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  dir = mkdtempSync(path.join(os.tmpdir(), "of-run-events-"));
  return dir;
}

function event(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    v: 1,
    runId: "run-123",
    seq: 1,
    at: "2026-07-10T00:00:00.000Z",
    elapsedMs: 0,
    type: "run.started",
    kind: "worker",
    ...overrides,
  } as RunEvent;
}

describe("run metadata events", () => {
  it("stores events under the run-specific cache directory", () => {
    makeDir();
    expect(runEventsPath(dir, "run-123")).toBe(
      path.join(dir, ".openfusion", "cache", "runs", "run-123", "events.jsonl"),
    );
  });

  it("rejects run IDs that could escape the cache directory", () => {
    makeDir();
    expect(() => runEventsPath(dir, "../outside")).toThrow();
    expect(() => runEventsPath(dir, "/absolute")).toThrow();
  });

  it("appends ordered events and tolerates corrupt lines", () => {
    makeDir();
    appendRunEvent(dir, event());
    appendRunEvent(
      dir,
      {
        v: 1,
        runId: "run-123",
        seq: 2,
        at: "2026-07-10T00:00:00.012Z",
        elapsedMs: 12,
        type: "tool.started",
        tool: "read_file",
      },
    );
    const filePath = runEventsPath(dir, "run-123");
    writeFileSync(filePath, `${readFileSync(filePath, "utf8")}not-json\n`, "utf8");

    const result = readRunEvents(dir, "run-123");
    expect(result.events.map((item) => item.seq)).toEqual([1, 2]);
    expect(result.skipped).toBe(1);
    expect(readFileSync(path.join(dir, ".openfusion", ".gitignore"), "utf8")).toContain(
      "cache/",
    );
  });

  it("assigns monotonic sequence and elapsed time", () => {
    makeDir();
    let now = Date.parse("2026-07-10T00:00:00.000Z");
    const recorder = new RunEventRecorder({ log: () => {} }, dir, "run-123", {
      now: () => now,
    });

    const first = recorder.record({ type: "run.started", kind: "worker" });
    now += 25;
    const second = recorder.record({ type: "attempt.started", attempt: 1 });

    expect(first).toMatchObject({ seq: 1, elapsedMs: 0 });
    expect(second).toMatchObject({ seq: 2, elapsedMs: 25 });
  });

  it("continues sequence and elapsed time when a later observer joins the same run", () => {
    makeDir();
    let now = Date.parse("2026-07-10T00:00:00.000Z");
    const first = new RunEventRecorder({ log: () => {} }, dir, "run-123", {
      now: () => now,
    });
    first.record({ type: "run.started", kind: "worker" });

    now += 40;
    const resumed = new RunEventRecorder({ log: () => {} }, dir, "run-123", {
      now: () => now,
    });
    const event = resumed.record({ type: "attempt.started", attempt: 1 });

    expect(event).toMatchObject({ seq: 2, elapsedMs: 40 });
  });

  it("fails closed on extra content fields without leaking them", () => {
    makeDir();
    const logs: string[] = [];
    const recorder = new RunEventRecorder({ log: (message) => logs.push(message) }, dir, "run-123");
    const contentMarker = "UNIQUE-TASK-PROMPT-DIFF-COMMAND-OUTPUT-MARKER";

    expect(() =>
      appendRunEvent(dir, {
        ...event(),
        task: contentMarker,
      } as unknown as RunEvent),
    ).toThrow();
    recorder.record({ type: "run.started", kind: "worker", prompt: contentMarker } as never);
    recorder.record({ type: "run.finished", outcome: "succeeded" });

    const filePath = runEventsPath(dir, "run-123");
    expect(existsSync(filePath)).toBe(false);
    expect(logs).toEqual(["run-events: recorder disabled after observer failure"]);
  });

  it("observer write failure never throws and logs only once", () => {
    makeDir();
    const broken = path.join(dir, "broken");
    mkdirSync(broken);
    writeFileSync(path.join(broken, ".openfusion"), "not-a-directory", "utf8");
    const logs: string[] = [];
    const recorder = new RunEventRecorder({ log: (message) => logs.push(message) }, broken, "run-123");

    expect(() => recorder.record({ type: "run.started", kind: "worker" })).not.toThrow();
    expect(() => recorder.record({ type: "run.finished", outcome: "error" })).not.toThrow();
    expect(logs).toEqual(["run-events: recorder disabled after observer failure"]);
  });

  it("a throwing diagnostic logger cannot make recorder failure load-bearing", () => {
    makeDir();
    const broken = path.join(dir, "broken-logger");
    mkdirSync(broken);
    writeFileSync(path.join(broken, ".openfusion"), "not-a-directory", "utf8");
    const recorder = new RunEventRecorder(
      {
        log: () => {
          throw new Error("logger unavailable");
        },
      },
      broken,
      "run-123",
    );

    expect(() => recorder.record({ type: "run.started", kind: "worker" })).not.toThrow();
  });
});
