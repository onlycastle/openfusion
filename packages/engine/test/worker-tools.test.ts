import { execFileSync } from "node:child_process";
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
import { createEngine, type Engine } from "../src/engine.js";
import { MacOsSandboxBackend } from "../src/runtime/sandbox.js";
import { RuntimeStore } from "../src/runtime/store.js";
import { createPassthroughSandboxRunner } from "./native-sandbox-fixture.js";
import {
  createWorkerTools,
  type ToolContext,
  type ToolLifecycleEvent,
} from "../src/worker/tools.js";

let dir: string;
let outsideDir: string;
let engine: Engine | undefined;
const runtimeStores: RuntimeStore[] = [];
afterEach(async () => {
  if (engine !== undefined) await engine.close();
  engine = undefined;
  for (const runtimeStore of runtimeStores.splice(0)) runtimeStore.close();
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

function createSandboxedTools(ctx: ToolContext): Record<string, Tool> {
  const runner = createPassthroughSandboxRunner(
    ctx.root,
    `.sandbox-test-${runtimeStores.length}.mjs`,
  );
  const runtimeStore = new RuntimeStore({
    projectDir: ctx.root,
    key: Buffer.alloc(32, runtimeStores.length + 1),
  });
  runtimeStores.push(runtimeStore);
  const session = runtimeStore.createSession({ kind: "worker" });
  const backend = new MacOsSandboxBackend({
    platform: "darwin",
    runnerExecutable: runner,
    probe: async () => ({ ok: true }),
  });
  return createWorkerTools({
    ...ctx,
    includeBash: true,
    sandboxCertified: true,
    sandbox: { backend, store: runtimeStore, sessionId: session.id },
  });
}

describe("bash", () => {
  it("runs a command and returns stdout with exit code 0", async () => {
    dir = makeRoot();
    const tools = createSandboxedTools({ root: dir });
    const result = await getExecute(tools.bash)({ command: "echo hi" }, FAKE_OPTS);
    expect(result.stdout).toContain("hi");
    expect(result.exitCode).toBe(0);
  });

  it("returns a nonzero exit code as a normal result, not a throw", async () => {
    dir = makeRoot();
    const tools = createSandboxedTools({ root: dir });
    const result = await getExecute(tools.bash)({ command: "exit 3" }, FAKE_OPTS);
    expect(result.exitCode).toBe(3);
  });

  it("returns an error result (not a hang) when the command exceeds bashTimeoutMs", async () => {
    dir = makeRoot();
    const tools = createSandboxedTools({ root: dir, bashTimeoutMs: 50 });
    const result = await getExecute(tools.bash)({ command: "sleep 5" }, FAKE_OPTS);
    expect(result.exitCode).not.toBe(0);
    expect(result.error).toBeTruthy();
  }, 10_000);

  it("truncates stdout to ~10KB", async () => {
    dir = makeRoot();
    const tools = createSandboxedTools({ root: dir });
    const result = await getExecute(tools.bash)(
      { command: "yes x | head -c 200000" },
      FAKE_OPTS,
    );
    expect(result.stdout.length).toBeLessThan(15 * 1024);
  });

  it("preserves both the beginning and end when stdout is truncated", async () => {
    dir = makeRoot();
    const tools = createSandboxedTools({ root: dir });
    const result = await getExecute(tools.bash)(
      {
        command:
          "printf 'BEGIN\\n'; yes middle | head -c 30000; printf '\\nEND_FAILURE_SUMMARY\\n'",
      },
      FAKE_OPTS,
    );

    expect(result.stdout).toContain("BEGIN");
    expect(result.stdout).toContain("use read_tool_output");
    expect(result.stdout).toContain("END_FAILURE_SUMMARY");
  });

  it("fires onToolEvent with only the (truncated) command, never the command's stdout", async () => {
    dir = makeRoot();
    const events: { tool: string; detail: string }[] = [];
    const tools = createSandboxedTools({ root: dir, onToolEvent: (e) => events.push(e) });
    const result = await getExecute(tools.bash)({ command: "pwd" }, FAKE_OPTS);

    expect(result.stdout).toContain(dir); // sanity: stdout really does contain the marker (the cwd)
    expect(events).toHaveLength(1);
    expect(events[0]?.tool).toBe("bash");
    expect(events[0]?.detail).toBe("pwd");
    expect(events[0]?.detail).not.toContain(dir); // detail must not leak stdout
  });

  it("ignores a lifecycle observer failure", async () => {
    dir = makeRoot();
    const tools = createSandboxedTools({
      root: dir,
      onToolLifecycleEvent: () => {
        throw new Error("observer failed");
      },
    });

    const result = await getExecute(tools.bash)({ command: "echo still-runs" }, FAKE_OPTS);
    expect(result.stdout).toContain("still-runs");
    expect(result.exitCode).toBe(0);
  });

  // Fix 4: a command/path with an embedded newline (or other control char)
  // must not be able to inject formatting into whatever consumes
  // onToolEvent (e.g. a line-oriented progress log).
  it("strips control characters (e.g. a newline) from the emitted onToolEvent detail", async () => {
    dir = makeRoot();
    const events: { tool: string; detail: string }[] = [];
    const tools = createSandboxedTools({ root: dir, onToolEvent: (e) => events.push(e) });

    await getExecute(tools.bash)({ command: "echo hi\necho bye" }, FAKE_OPTS);

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).not.toContain("\n");
  });
});

// Fix 1 (review round 1): the AI SDK passes a MERGED abortSignal (the run's
// own abortSignal combined with any per-tool timeout) as `options.abortSignal`
// on every `execute` call -- confirmed by reading ai@7.0.11's
// executeToolCall, which builds `toolAbortSignal = mergeAbortSignals(...)`
// and passes it as `options.abortSignal`. A worker deadline (timeoutMs) is
// plumbed into `generateText({ abortSignal })` upstream, so THIS is the only
// channel through which that deadline can interrupt an in-flight `bash`
// call -- bash's own `bashTimeoutMs` is a much larger, independent ceiling.
describe("abortSignal propagation (Fix 1, review round 1)", () => {
  it("bash resolves promptly when options.abortSignal aborts mid-sleep, well under bashTimeoutMs", async () => {
    dir = makeRoot();
    // bashTimeoutMs is deliberately large (30s) so a prompt resolution here
    // can ONLY be explained by the abortSignal killing the child -- not by
    // bash's own timeout coincidentally firing first.
    const tools = createSandboxedTools({ root: dir, bashTimeoutMs: 30_000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    const start = Date.now();
    const result = await getExecute(tools.bash)(
      { command: "sleep 5" },
      { ...FAKE_OPTS, abortSignal: ac.signal },
    );
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(result).toBeDefined();
  }, 10_000);

  it("read_file returns {error: 'aborted'} for an already-aborted signal, without reading", async () => {
    dir = makeRoot();
    writeFileSync(path.join(dir, "a.txt"), "hello");
    const tools = createWorkerTools({ root: dir });
    const ac = new AbortController();
    ac.abort();

    const result = await getExecute(tools.read_file)(
      { path: "a.txt" },
      { ...FAKE_OPTS, abortSignal: ac.signal },
    );

    expect(result.error).toBe("aborted");
    expect(result.content).toBeUndefined();
  });

  it("write_file returns {error: 'aborted'} for an already-aborted signal, without writing", async () => {
    dir = makeRoot();
    const tools = createWorkerTools({ root: dir });
    const ac = new AbortController();
    ac.abort();

    const result = await getExecute(tools.write_file)(
      { path: "new.txt", content: "hi" },
      { ...FAKE_OPTS, abortSignal: ac.signal },
    );

    expect(result.error).toBe("aborted");
    expect(existsSync(path.join(dir, "new.txt"))).toBe(false);
  });

  it("edit returns {error: 'aborted'} for an already-aborted signal, without editing", async () => {
    dir = makeRoot();
    writeFileSync(path.join(dir, "a.txt"), "foo bar baz");
    const tools = createWorkerTools({ root: dir });
    const ac = new AbortController();
    ac.abort();

    const result = await getExecute(tools.edit)(
      { path: "a.txt", find: "bar", replace: "QUX" },
      { ...FAKE_OPTS, abortSignal: ac.signal },
    );

    expect(result.error).toBe("aborted");
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("foo bar baz");
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

  it("supports paged line reads and reports how to continue", async () => {
    dir = makeRoot();
    writeFileSync(path.join(dir, "paged.txt"), "one\ntwo\nthree\nfour\nfive");
    const tools = createWorkerTools({ root: dir });
    const result = await getExecute(tools.read_file)(
      { path: "paged.txt", offset: 2, limit: 2 },
      FAKE_OPTS,
    );

    expect(result).toEqual({
      content: "two\nthree",
      startLine: 2,
      endLine: 3,
      totalLines: 5,
      truncated: true,
      nextOffset: 4,
    });
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
    const lifecycle: ToolLifecycleEvent[] = [];
    const tools = createWorkerTools({
      root: dir,
      onToolLifecycleEvent: (event) => lifecycle.push(event),
    });
    const result = await getExecute(tools.edit)(
      { path: "a.txt", find: "nope", replace: "x" },
      FAKE_OPTS,
    );
    expect(result.error).toBe("find not found");
    expect(result.errorKind).toBe("not_found");
    expect(lifecycle[0]).toEqual({ phase: "started", tool: "edit" });
    expect(lifecycle[1]).toMatchObject({
      phase: "failed",
      tool: "edit",
      errorKind: "not_found",
      truncated: false,
    });
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

// Task 7: on-demand wiki retrieval tools, registered only when ctx.wiki is
// present — the replacement for Task 6's removed all-digests prompt
// injection. Uses a real built wiki (via engine.wiki.build) rather than a
// hand-rolled store double, so this also pins that worker/tools.ts's
// wiki_query/wiki_map bodies agree with the store's real row shapes.
describe("wiki tools (Task 7)", () => {
  function makeWikiRepo(): string {
    const root = makeRoot("of-tools-wiki-");
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", root, "config", "user.name", "t"]);
    writeFileSync(path.join(root, "a.ts"), "export function alphaBeta() {}\n");
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "init"]);
    return root;
  }

  it("registers wiki_query/wiki_map only when ctx.wiki is present, with working execute bodies", async () => {
    dir = makeWikiRepo();
    engine = createEngine();
    await engine.wiki.build(dir);
    const store = engine.wiki.getStore(dir);

    const withWiki = createWorkerTools({
      root: dir,
      wiki: {
        store,
        pages: [{ slug: "architecture", title: "Architecture", digest: "mentions alphaBeta here" }],
      },
    });
    expect(Object.keys(withWiki).sort()).toEqual(
      ["edit", "read_file", "wiki_map", "wiki_query", "write_file"].sort(),
    );

    const queryResult = await getExecute(withWiki.wiki_query)({ symbol: "alphaBeta" }, FAKE_OPTS);
    expect(queryResult.definitions.length).toBeGreaterThanOrEqual(1);
    expect(queryResult.definitions[0].file).toBe("a.ts");
    expect(queryResult.pages).toHaveLength(1);
    expect(queryResult.pages[0]).toMatchObject({ slug: "architecture", title: "Architecture" });
    expect(queryResult.pages[0].excerpt.length).toBeLessThanOrEqual(240);

    const mapResult = await getExecute(withWiki.wiki_map)({}, FAKE_OPTS);
    expect(typeof mapResult).toBe("string");
    expect(mapResult.length).toBeGreaterThan(0);
    expect(mapResult).toContain("a.ts");

    const withoutWiki = createWorkerTools({ root: dir });
    expect(Object.keys(withoutWiki).sort()).toEqual(["edit", "read_file", "write_file"].sort());
  });

  it("fires onToolEvent for wiki_query/wiki_map without leaking page/store content in the detail", async () => {
    dir = makeWikiRepo();
    engine = createEngine();
    await engine.wiki.build(dir);
    const store = engine.wiki.getStore(dir);
    const secretDigest = "SUPER_SECRET_DIGEST_MARKER";

    const events: { tool: string; detail: string }[] = [];
    const tools = createWorkerTools({
      root: dir,
      wiki: { store, pages: [{ slug: "architecture", title: "Architecture", digest: secretDigest }] },
      onToolEvent: (e) => events.push(e),
    });

    await getExecute(tools.wiki_query)({ symbol: "alphaBeta" }, FAKE_OPTS);
    await getExecute(tools.wiki_map)({}, FAKE_OPTS);

    expect(events.map((e) => e.tool)).toEqual(["wiki_query", "wiki_map"]);
    for (const e of events) {
      expect(e.detail).not.toContain(secretDigest);
    }
  });
});
