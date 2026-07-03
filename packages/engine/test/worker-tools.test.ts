import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerTools } from "../src/worker/tools.js";

let dir: string;
let outsideDir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
});

// The static `Tool` type's `execute` field is conditionally optional
// depending on which BaseTool union branch TS lands on for a given
// INPUT/OUTPUT/CONTEXT instantiation; every tool this module's
// createWorkerTools() builds always provides one at runtime. This helper
// sidesteps that type friction for tests only -- the strictness that
// matters (the sandbox boundary itself) lives in src/worker/tools.ts.
function getExecute(t: Tool | undefined): (input: unknown, opts: unknown) => Promise<any> {
  const exec = (t as { execute?: unknown } | undefined)?.execute;
  if (typeof exec !== "function") throw new Error("tool has no execute");
  return exec as (input: unknown, opts: unknown) => Promise<any>;
}

// A stand-in for the AI SDK's real ToolExecutionOptions -- irrelevant to
// every tool in this module (none of them read toolCallId/messages/context),
// but required to satisfy the execute function's second parameter.
const FAKE_OPTS = { toolCallId: "test-call", messages: [], context: {} };

function makeRoot(prefix = "of-tools-"): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  // realpath up front: macOS's os.tmpdir() is itself a symlink
  // (/tmp -> /private/tmp), and createWorkerTools() computes its own
  // canonical root internally via fs.realpathSync -- resolving here too
  // keeps test-side path arithmetic (path.join(dir, ...)) agreeing with
  // what the containment gate actually compares against.
  return realpathSync(root);
}

describe("bash", () => {
  it("runs a command and returns stdout with exit code 0", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });
    const result = await getExecute(tools.bash)({ command: "echo hi" }, FAKE_OPTS);
    expect(result.stdout.trim()).toBe("hi");
    expect(result.exitCode).toBe(0);
  });

  it("returns a nonzero exit code as a normal result, not a throw", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });
    const result = await getExecute(tools.bash)({ command: "exit 3" }, FAKE_OPTS);
    expect(result.exitCode).toBe(3);
  });

  it("returns an error result (not a hang) when the command exceeds bashTimeoutMs", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir, bashTimeoutMs: 50 });
    const result = await getExecute(tools.bash)({ command: "sleep 5" }, FAKE_OPTS);
    expect(result.exitCode).not.toBe(0);
    expect(result.error).toBeTruthy();
  }, 10_000);

  it("truncates stdout to ~10KB", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });
    const result = await getExecute(tools.bash)(
      { command: "yes x | head -c 200000" },
      FAKE_OPTS,
    );
    expect(result.stdout.length).toBeLessThan(15 * 1024);
  });

  it("fires onToolEvent with only the (truncated) command, never the command's stdout", async () => {
    dir = makeRoot();
    const events: { tool: string; detail: string }[] = [];
    const tools = createWorkerTools({ root: dir, onToolEvent: (e) => events.push(e) });
    const result = await getExecute(tools.bash)({ command: "pwd" }, FAKE_OPTS);

    expect(result.stdout.trim()).toBe(dir); // sanity: stdout really does contain the marker (the cwd)
    expect(events).toHaveLength(1);
    expect(events[0]?.tool).toBe("bash");
    expect(events[0]?.detail).toBe("pwd");
    expect(events[0]?.detail).not.toContain(dir); // detail must not leak stdout
  });

  // Fix 4: a command/path with an embedded newline (or other control char)
  // must not be able to inject formatting into whatever consumes
  // onToolEvent (e.g. a line-oriented progress log).
  it("strips control characters (e.g. a newline) from the emitted onToolEvent detail", async () => {
    dir = makeRoot();
    const events: { tool: string; detail: string }[] = [];
    const tools = createWorkerTools({ root: dir, onToolEvent: (e) => events.push(e) });

    await getExecute(tools.bash)({ command: "echo hi\necho bye" }, FAKE_OPTS);

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).not.toContain("\n");
  });
});

describe("read_file", () => {
  it("reads a file inside root", async () => {
    dir = makeRoot();
    writeFileSync(path.join(dir, "a.txt"), "hello");
    const tools = createWorkerTools({ root: dir });
    const result = await getExecute(tools.read_file)({ path: "a.txt" }, FAKE_OPTS);
    expect(result.content).toBe("hello");
  });

  it("returns an error (not a throw) for a missing file inside root", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });
    const result = await getExecute(tools.read_file)({ path: "nope.txt" }, FAKE_OPTS);
    expect(result.error).toBe("not found");
  });

  it("denies a path that escapes root via .. and never reads it", async () => {
    dir = makeRoot();
    outsideDir = makeRoot("of-tools-outside-");
    writeFileSync(path.join(outsideDir, "secret.txt"), "TOP_SECRET");
    const tools = createWorkerTools({ root: dir });
    const rel = path.relative(dir, path.join(outsideDir, "secret.txt"));

    const result = await getExecute(tools.read_file)({ path: rel }, FAKE_OPTS);

    expect(result.error).toBeTruthy();
    expect(result.content).toBeUndefined();
  });

  it("truncates large file content to ~50KB", async () => {
    dir = makeRoot();
    const big = "x".repeat(80 * 1024);
    writeFileSync(path.join(dir, "big.txt"), big);
    const tools = createWorkerTools({ root: dir });
    const result = await getExecute(tools.read_file)({ path: "big.txt" }, FAKE_OPTS);
    expect(result.content.length).toBeLessThan(big.length);
    expect(result.content.length).toBeLessThan(60 * 1024);
  });
});

describe("write_file", () => {
  it("creates a file, making parent directories as needed", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });
    const result = await getExecute(tools.write_file)(
      { path: "a/b/c.txt", content: "hi" },
      FAKE_OPTS,
    );
    expect(result.ok).toBe(true);
    expect(result.bytes).toBe(2);
    expect(readFileSync(path.join(dir, "a", "b", "c.txt"), "utf8")).toBe("hi");
  });

  it("denies writing outside root and never creates the file", async () => {
    dir = makeRoot();
    outsideDir = makeRoot("of-tools-outside-");
    const tools = createWorkerTools({ root: dir });
    const rel = path.relative(dir, path.join(outsideDir, "evil.txt"));

    const result = await getExecute(tools.write_file)(
      { path: rel, content: "pwned" },
      FAKE_OPTS,
    );

    expect(result.error).toBeTruthy();
    expect(existsSync(path.join(outsideDir, "evil.txt"))).toBe(false);
  });

  it("fires onToolEvent with only the path, never the file content", async () => {
    dir = makeRoot();
    const events: { tool: string; detail: string }[] = [];
    const tools = createWorkerTools({ root: dir, onToolEvent: (e) => events.push(e) });
    const secret = "SUPER_SECRET_FILE_CONTENT_MARKER";

    await getExecute(tools.write_file)({ path: "note.txt", content: secret }, FAKE_OPTS);

    expect(events).toHaveLength(1);
    expect(events[0]?.tool).toBe("write_file");
    expect(events[0]?.detail).toBe("note.txt");
    expect(events[0]?.detail).not.toContain(secret);
  });
});

describe("symlink escape prevention", () => {
  it("denies write_file through a symlink inside root that points outside root", async () => {
    dir = makeRoot();
    outsideDir = makeRoot("of-tools-outside-");
    symlinkSync(outsideDir, path.join(dir, "escape-link"));
    const tools = createWorkerTools({ root: dir });

    const result = await getExecute(tools.write_file)(
      { path: "escape-link/pwned.txt", content: "pwned" },
      FAKE_OPTS,
    );

    expect(result.error).toBeTruthy();
    expect(existsSync(path.join(outsideDir, "pwned.txt"))).toBe(false);
  });

  it("denies read_file through a symlink inside root that points outside root", async () => {
    dir = makeRoot();
    outsideDir = makeRoot("of-tools-outside-");
    writeFileSync(path.join(outsideDir, "secret.txt"), "TOP_SECRET");
    symlinkSync(outsideDir, path.join(dir, "escape-link"));
    const tools = createWorkerTools({ root: dir });

    const result = await getExecute(tools.read_file)(
      { path: "escape-link/secret.txt" },
      FAKE_OPTS,
    );

    expect(result.error).toBeTruthy();
    expect(result.content).toBeUndefined();
  });

  // Fix 3: the one-level case above (`escape-link/pwned.txt`) exercises a
  // symlink whose OWN parent-join target already doesn't exist. This case
  // is deeper: a multi-level, not-yet-existing tail (`newdir/deeper/...`)
  // hanging off the symlinked ancestor -- canonicalizePath must walk past
  // ALL of the nonexistent tail segments up to `escape-link` itself (the
  // deepest EXISTING ancestor), realpath that, then rejoin the whole tail.
  // If a future edit only checked the immediate parent of the leaf (instead
  // of walking to the deepest existing ancestor), this case would slip
  // through where the one-level case would not.
  it("denies write_file through a symlinked parent for a multi-level not-yet-existing tail", async () => {
    dir = makeRoot();
    outsideDir = makeRoot("of-tools-outside-");
    symlinkSync(outsideDir, path.join(dir, "escape-link"));
    const tools = createWorkerTools({ root: dir });

    const result = await getExecute(tools.write_file)(
      { path: "escape-link/newdir/deeper/newfile.txt", content: "pwned" },
      FAKE_OPTS,
    );

    expect(result.error).toBeTruthy();
    expect(existsSync(path.join(outsideDir, "newdir"))).toBe(false);
    expect(existsSync(path.join(outsideDir, "newdir", "deeper"))).toBe(false);
    expect(existsSync(path.join(outsideDir, "newdir", "deeper", "newfile.txt"))).toBe(false);
  });
});

// Fix 1: `containmentGate` resolves `rawPath` via `path.resolve(root,
// rawPath)`. Node's `path.resolve` semantics DISCARD every earlier argument
// once it hits an absolute path -- so if `rawPath` is itself absolute,
// `root` is silently thrown away and `resolved` becomes `rawPath` as-is.
// The containment check downstream still correctly denies this (the
// resolved path isn't under canonicalRoot), but nothing pins that this
// denial actually happens -- a future switch to `path.join` (which does NOT
// discard `root` the same way) could silently invert this without any test
// failing.
describe("absolute path escape (Fix 1)", () => {
  it("denies read_file for an absolute path outside root and never reads it", async () => {
    dir = makeRoot();
    outsideDir = makeRoot("of-abs-escape-");
    const target = path.join(outsideDir, "passwd");
    writeFileSync(target, "TOP_SECRET_ABS");
    const tools = createWorkerTools({ root: dir });

    const result = await getExecute(tools.read_file)({ path: target }, FAKE_OPTS);

    expect(result.error).toBeTruthy();
    expect(result.content).toBeUndefined();
  });

  it("denies write_file for an absolute path outside root and never creates the file", async () => {
    dir = makeRoot();
    outsideDir = makeRoot("of-abs-escape-");
    const target = path.join(outsideDir, "passwd");
    const tools = createWorkerTools({ root: dir });

    const result = await getExecute(tools.write_file)(
      { path: target, content: "pwned" },
      FAKE_OPTS,
    );

    expect(result.error).toBeTruthy();
    expect(existsSync(target)).toBe(false);
  });

  it("denies edit for an absolute path outside root and never modifies the file", async () => {
    dir = makeRoot();
    outsideDir = makeRoot("of-abs-escape-");
    const target = path.join(outsideDir, "passwd");
    writeFileSync(target, "original content");
    const tools = createWorkerTools({ root: dir });

    const result = await getExecute(tools.edit)(
      { path: target, find: "original", replace: "PWNED" },
      FAKE_OPTS,
    );

    expect(result.error).toBeTruthy();
    expect(readFileSync(target, "utf8")).toBe("original content");
  });
});

describe("edit", () => {
  it("replaces a unique match", async () => {
    dir = makeRoot();
    writeFileSync(path.join(dir, "a.txt"), "foo bar baz");
    const tools = createWorkerTools({ root: dir });
    const result = await getExecute(tools.edit)(
      { path: "a.txt", find: "bar", replace: "QUX" },
      FAKE_OPTS,
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("foo QUX baz");
  });

  it("errors distinctly when find has zero matches", async () => {
    dir = makeRoot();
    writeFileSync(path.join(dir, "a.txt"), "foo bar baz");
    const tools = createWorkerTools({ root: dir });
    const result = await getExecute(tools.edit)(
      { path: "a.txt", find: "nope", replace: "x" },
      FAKE_OPTS,
    );
    expect(result.error).toBe("find not found");
  });

  it("errors distinctly when find matches more than once", async () => {
    dir = makeRoot();
    writeFileSync(path.join(dir, "a.txt"), "foo bar foo");
    const tools = createWorkerTools({ root: dir });
    const result = await getExecute(tools.edit)(
      { path: "a.txt", find: "foo", replace: "x" },
      FAKE_OPTS,
    );
    expect(result.error).toBe("find matched 2 times, must be unique");
  });

  it("denies editing a file outside root", async () => {
    dir = makeRoot();
    outsideDir = makeRoot("of-tools-outside-");
    writeFileSync(path.join(outsideDir, "a.txt"), "foo bar");
    const tools = createWorkerTools({ root: dir });
    const rel = path.relative(dir, path.join(outsideDir, "a.txt"));

    const result = await getExecute(tools.edit)(
      { path: rel, find: "bar", replace: "x" },
      FAKE_OPTS,
    );

    expect(result.error).toBeTruthy();
    expect(readFileSync(path.join(outsideDir, "a.txt"), "utf8")).toBe("foo bar");
  });

  // Fix 4: edit's onToolEvent detail must be built from the path only --
  // never from `find`/`replace`, which can carry arbitrary (possibly
  // sensitive) file content. Distinctive sentinels make an accidental leak
  // unmissable instead of blending into ordinary-looking text.
  it("fires onToolEvent whose detail never contains find or replace text", async () => {
    dir = makeRoot();
    const findSentinel = "FIND_SENTINEL_9f3a";
    const replaceSentinel = "REPLACE_SENTINEL_7c1e";
    writeFileSync(path.join(dir, "a.txt"), `foo ${findSentinel} baz`);
    const events: { tool: string; detail: string }[] = [];
    const tools = createWorkerTools({ root: dir, onToolEvent: (e) => events.push(e) });

    const result = await getExecute(tools.edit)(
      { path: "a.txt", find: findSentinel, replace: replaceSentinel },
      FAKE_OPTS,
    );

    expect(result.ok).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.detail).not.toContain(findSentinel);
      expect(e.detail).not.toContain(replaceSentinel);
    }
  });
});

// Fix 2: a path containing a NUL byte must degrade to a plain error result,
// never an uncaught throw / rejected promise -- a NUL byte makes several
// underlying `fs` calls throw a synchronous TypeError
// (ERR_INVALID_ARG_VALUE), and nothing today pins that these three tools
// catch it rather than let it propagate.
describe("NUL-byte path handling (Fix 2)", () => {
  it("read_file resolves to an error result (not a rejected promise) for a NUL-byte path", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });

    await expect(
      getExecute(tools.read_file)({ path: "a\0b.txt" }, FAKE_OPTS),
    ).resolves.toMatchObject({ error: expect.any(String) });
  });

  it("write_file resolves to an error result (not a rejected promise) for a NUL-byte path", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });

    await expect(
      getExecute(tools.write_file)({ path: "a\0b.txt", content: "hi" }, FAKE_OPTS),
    ).resolves.toMatchObject({ error: expect.any(String) });
  });

  it("edit resolves to an error result (not a rejected promise) for a NUL-byte path", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });

    await expect(
      getExecute(tools.edit)({ path: "a\0b.txt", find: "x", replace: "y" }, FAKE_OPTS),
    ).resolves.toMatchObject({ error: expect.any(String) });
  });
});
