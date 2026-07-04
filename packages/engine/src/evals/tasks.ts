// Eval task model + repo-tests oracle + golden-task-from-commit construction.
//
// This module is the eval MECHANICS layer: given a task (a prompt + a way to
// set up the pre-change worktree + a test command), it can score any
// candidate solution by running the repo's own test suite and checking the
// exit code -- the SWE-bench-style "hand-roll a correctness oracle" approach
// documented as the pragmatic v1 default in
// docs/research/2026-07-04-m6-pricing-eval-verification.md (Q2). Task 4's
// report card runs on top of this: it drives an `EvalTask`'s `setup`, points
// a worker/baseline session at the resulting directory, then calls
// `runOracle` to get a pass/fail verdict.
//
// This module never shells out via `/bin/sh -c` -- every child process here
// is `execFile`d with an explicit argv array (program + args), matching the
// pattern in ../worker/tools.ts's `runBash` (which DOES use a shell, because
// it exists specifically to run arbitrary worker-authored shell commands)
// and ../worker/worktree.ts's `git()` helper (which does not). `runOracle`
// and the git plumbing below are the latter case: the command being run is
// either caller-supplied argv (never a shell string) or a fixed `git`/`tar`
// invocation we construct ourselves.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// A repo's real test suite can print far more than Node's default 1MB
// execFile buffer before exiting -- without a generous cap here, a verbose
// but otherwise-passing test run could throw ERR_CHILD_PROCESS_STDIO_MAXBUFFER
// and get misreported as a failure. The captured buffers are still never
// logged or returned (see runOracle's doc comment) -- this only bounds how
// much memory a single oracle run can hold before we count it as failed.
const MAX_BUFFER = 64 * 1024 * 1024;

// Long enough for a real repo's test suite (build + full run), short enough
// that a hung process doesn't stall an eval sweep indefinitely. Callers
// scoring many golden tasks in a loop should override this per-task if a
// repo's suite is known to run longer.
const DEFAULT_ORACLE_TIMEOUT_MS = 300_000;

export interface EvalTask {
  id: string;
  prompt: string;
  // Mutates a fresh, empty directory into the pre-change state the task
  // should be attempted from. Must be idempotent-safe to call once per fresh
  // directory (not required to be re-runnable against a dirty directory).
  setup: (worktreeRoot: string) => Promise<void>;
  // testCommand[0] is the program, the rest are args -- run with cwd set to
  // the worktree directory. Never a shell string (see module doc comment).
  testCommand: string[];
}

export interface OracleResult {
  passed: boolean;
  exitCode: number;
  durationMs: number;
}

// Runs `testCommand` (argv form: testCommand[0] is the program, the rest are
// args -- NEVER a shell string) with cwd = `dir`, and reports pass/fail by
// exit code alone.
//
// stdout/stderr ARE captured (execFile always buffers them up to
// `maxBuffer`) but are deliberately NOT part of `OracleResult` and are never
// logged anywhere in this function -- test output can contain repo source
// snippets, stack traces, or (in a live-key scenario elsewhere in the
// system) secrets, and the brief for this task is explicit that eval output
// must never be logged. If a future caller needs a truncated tail for
// debugging, capture it at the call site from a modified signature -- do not
// widen this function to return raw output by default.
//
// Failure-mode contract (each documented at its branch below):
//   - clean exit 0                 -> { passed: true,  exitCode: 0 }
//   - clean nonzero exit           -> { passed: false, exitCode: <code> }
//   - killed by our own `timeoutMs`-> { passed: false, exitCode: -1, durationMs: timeoutMs }
//   - ENOENT (bad testCommand[0])  -> THROWS (see rationale below)
export function runOracle(
  dir: string,
  testCommand: string[],
  timeoutMs = DEFAULT_ORACLE_TIMEOUT_MS,
): Promise<OracleResult> {
  const [program, ...args] = testCommand;
  if (!program) {
    throw new Error("runOracle: testCommand must contain at least one element (the program to run)");
  }
  const start = Date.now();
  return new Promise((resolve, reject) => {
    execFile(program, args, { cwd: dir, timeout: timeoutMs, maxBuffer: MAX_BUFFER }, (error) => {
      if (!error) {
        resolve({ passed: true, exitCode: 0, durationMs: Date.now() - start });
        return;
      }
      const e = error as NodeJS.ErrnoException & { killed?: boolean };
      // ENOENT means testCommand[0] itself doesn't exist (a typo'd test
      // runner, or a repo whose test command was never actually detected) --
      // that is a SETUP error, not a failed eval: the task's oracle never
      // even got to run the tests, so reporting `passed: false` here would
      // be indistinguishable from "the tests ran and failed", corrupting any
      // report-card pass-rate that reads this result. Throwing surfaces the
      // distinction to the caller unambiguously (documented per this
      // module's task brief, which asks the implementation to pick one and
      // document it rather than silently returning a `passed: false`).
      if (e.code === "ENOENT") {
        reject(
          new Error(
            `runOracle: test command not found: ${JSON.stringify(testCommand)} (${e.message}). ` +
              "This is a setup error (missing/misconfigured test runner), not a failed eval.",
          ),
        );
        return;
      }
      // `error.killed` is true precisely when EXECFILE's own `timeout` (or
      // `maxBuffer`) option killed the child -- as opposed to the child
      // exiting on its own with a nonzero code, or being killed by some
      // external signal we didn't cause. This is the same distinction
      // ../worker/tools.ts's `runBash` relies on. On our own timeout,
      // `durationMs` is reported as `timeoutMs` itself (not the measured
      // elapsed time) -- deterministic for callers/tests instead of racy
      // wall-clock overhead from process teardown.
      if (e.killed) {
        resolve({ passed: false, exitCode: -1, durationMs: timeoutMs });
        return;
      }
      // Node overloads `error.code` here: a NUMBER means the process ran to
      // completion and exited nonzero -- the normal "tests failed" case.
      if (typeof e.code === "number") {
        resolve({ passed: false, exitCode: e.code, durationMs: Date.now() - start });
        return;
      }
      // Anything else (killed by an external signal, etc.) -- no real exit
      // code to report; normalize to -1 rather than throwing, since the
      // command DID run (unlike ENOENT).
      resolve({ passed: false, exitCode: -1, durationMs: Date.now() - start });
    });
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: MAX_BUFFER });
  return stdout;
}

// Builds ONE golden `EvalTask` from an existing commit in `repoDir`,
// SWE-bench-style: "reproduce this change" against the commit's PARENT
// state, scored by the repo's own pre-existing tests.
//
// History-strip mechanism (the security-relevant part of this function) --
// chosen after reading ../worker/worktree.ts's git usage, which shares the
// BASE REPO'S OBJECT STORE with every worker worktree (`git worktree add`).
// That sharing is exactly wrong for a golden task: any worktree/clone that
// still shares the object store (or is a checkout WITHIN the same repo) can
// trivially reach the target commit and its full future history via
// `git log --all`, `git reflog`, or even guessing the branch tip -- the
// answer would be one `git checkout <sha>` away. So golden-task setup
// deliberately does NOT use WorktreeManager or `git worktree add` at all.
// Instead:
//   1. `git archive --format=tar --output=<tmp>.tar <parentSha>` exports the
//      PARENT commit's tree as a plain tar file -- archived content has NO
//      `.git` directory, no commit objects, no refs. There is no history to
//      leak because there is no git repository yet.
//   2. `tar -xf <tmp>.tar -C <worktreeRoot>` extracts that tree into the
//      fresh eval directory.
//   3. A brand-new `git init` + single `commit` ("baseline") gives the eval
//      directory its OWN from-scratch object graph, so worker/eval tooling
//      that expects a real git repo (e.g. a future `WorktreeManager`-based
//      workflow) still works. This fresh repo shares NOTHING with `repoDir`
//      -- no common ancestor, no remote, no reflog entry -- so the target
//      commit and everything after it are unreachable from it by
//      construction (not merely hidden): `git log --all` in the eval
//      directory can only ever show the single "baseline" commit this
//      function itself created.
//
// v1 SCOPE CONSTRAINT (read before selecting commits for this function):
// the oracle needs `testCommand` to FAIL at the parent state and PASS after
// the real change is applied. That only holds if the test(s) the target
// commit makes pass ALREADY EXIST at the parent -- i.e. the commit is a
// pure fail-to-pass fix against pre-existing tests. If the target commit
// ADDS the test file(s) together with the fix, the parent state (which is
// all `setup()` ever produces) lacks those tests entirely, and `testCommand`
// can't exercise the change at all -- `runOracle` would just run whatever
// (unrelated) tests already existed, or fail to find the test file. This
// function does NOT detect or guard against that case: task SELECTION
// (choosing commits whose tests pre-exist at the parent) and test-command
// detection are both the CALLER's responsibility in v1, per this task's
// brief. A later version could apply the commit's test-only hunks
// separately from its source hunks to lift this constraint; that is
// explicitly out of scope here.
export async function goldenTaskFromCommit(
  repoDir: string,
  commitSha: string,
  testCommand: string[],
): Promise<EvalTask> {
  const parentSha = (await git(repoDir, ["rev-parse", `${commitSha}^`])).trim();
  const subject = (await git(repoDir, ["log", "-1", "--format=%s", commitSha])).trim();

  return {
    id: `golden-${commitSha}`,
    prompt: `Implement the following change: ${subject}`,
    testCommand,
    setup: async (worktreeRoot: string) => {
      mkdirSync(worktreeRoot, { recursive: true });
      const scratch = mkdtempSync(path.join(os.tmpdir(), "of-golden-archive-"));
      try {
        const archivePath = path.join(scratch, "tree.tar");
        // Exports the PARENT tree only -- see the history-strip rationale
        // above. No `.git`, no commit objects, no refs are ever written to
        // `archivePath` or `worktreeRoot` by this step.
        await execFileAsync("git", [
          "-C",
          repoDir,
          "archive",
          "--format=tar",
          "--output",
          archivePath,
          parentSha,
        ]);
        await execFileAsync("tar", ["-xf", archivePath, "-C", worktreeRoot]);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      // Fresh, disconnected object graph: a `git init` here shares no
      // objects, refs, or reflog with `repoDir` -- the target commit and
      // everything after it are unreachable from this repo by construction.
      await git(worktreeRoot, ["init", "-q"]);
      await git(worktreeRoot, ["config", "user.email", "golden-task@openfusion.local"]);
      await git(worktreeRoot, ["config", "user.name", "openfusion-golden-task"]);
      await git(worktreeRoot, ["add", "-A"]);
      await git(worktreeRoot, ["commit", "-q", "-m", "baseline"]);
    },
  };
}

export interface SynthEvalTaskOptions {
  id?: string;
  sourceFile?: string;
  testFile?: string;
  prompt?: string;
}

// Deterministic, no-real-model test fixture used both by this module's own
// tests and by Task 4's report-card tests (exported for that reason). Its
// `setup` writes a tiny CommonJS source file with a deliberately UNFINISHED
// implementation, plus a Node `--test`-free assertion script (plain
// `node <file>`, no test framework dependency) that FAILS against that
// unfinished implementation and PASSES once the described change (finishing
// the implementation) is applied -- a real fail-to-pass fixture, not a
// pre-baked true/false toggle.
export function synthEvalTask(opts: SynthEvalTaskOptions = {}): EvalTask {
  const id = opts.id ?? "synth-add";
  const sourceFile = opts.sourceFile ?? "source.js";
  const testFile = opts.testFile ?? "test.js";
  const prompt =
    opts.prompt ??
    `Implement add(a, b) in ${sourceFile} so it returns the sum of a and b (currently it always returns undefined).`;

  return {
    id,
    prompt,
    testCommand: ["node", testFile],
    setup: async (worktreeRoot: string) => {
      mkdirSync(worktreeRoot, { recursive: true });
      writeFileSync(
        path.join(worktreeRoot, sourceFile),
        [
          "// TODO: implement add(a, b) -- currently a stub that fails the test.",
          "function add(a, b) {",
          "  return undefined;",
          "}",
          "",
          "module.exports = { add };",
          "",
        ].join("\n"),
      );
      writeFileSync(
        path.join(worktreeRoot, testFile),
        [
          "const assert = require('node:assert');",
          `const { add } = require('./${sourceFile.replace(/\.js$/, "")}');`,
          "assert.strictEqual(add(2, 3), 5);",
          "assert.strictEqual(add(-1, 1), 0);",
          "console.log('ok');",
          "",
        ].join("\n"),
      );
    },
  };
}
