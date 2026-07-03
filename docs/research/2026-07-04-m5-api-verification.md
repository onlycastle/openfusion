# M5 API Verification Cheat-Sheet (verified 2026-07-04)

Orchestrator/worker layer. Verified against installed `ai@7.0.11` `dist/index.d.ts`.

## AI SDK v7 multi-step tool loop (the worker engine)

- Tool: `tool({ description, inputSchema: z.object({...}), execute: async (args, { abortSignal, toolCallId, messages }) => result })`.
  **`inputSchema` — NOT `parameters`** (v7 removed `parameters` from the Tool type).
- **Loop control: `stopWhen: isStepCount(n)`** — `maxSteps` is GONE (0 hits in
  the type defs). `stepCountIs` survives only as a deprecated alias → use
  `isStepCount`. Also `hasToolCall(...)`, `isLoopFinished()` (no cap).
  ⚠️ **generateText/streamText default `stopWhen` to `isStepCount(1)`** — a
  tool loop with NO explicit `stopWhen` will NOT continue after one tool call.
  Set `stopWhen: isStepCount(30)` — this IS the runaway cap.
- Loop stops when: finish reason ≠ `tool-calls`, or a called tool has no
  `execute` (sentinel done-tool), or a stopWhen fires.
- Result: `result.steps: StepResult[]` (each: toolCalls, toolResults,
  content incl. `tool-error` parts, text, usage); `result.finalStep`.
  **`result.usage` = SUM across all steps in v7** (inverted from v6 where
  `usage` was final-step; `totalUsage` deprecated → same value). Final-step
  only = `result.finalStep.usage`. Cost metering sums `result.usage`.
- Progress: **`onStepEnd(stepResult)`** (was `onStepFinish`, still aliased);
  per-tool granularity via `onToolExecutionStart`/`End`. Callback throws are
  silently swallowed.
- Tool `execute` throws → SDK converts to a `tool-error` content part fed
  back to the model next step (model can recover) IF stopWhen allows another
  step. `NoSuchToolError`/`InvalidToolInputError` are thrown by generateText
  itself → need try/catch. Per-tool wall-clock: `timeout: { tools: { bashMs } }`.

## Worker toolset — hand-roll ~4 tools; WE own the sandbox

- No official minimal bash/edit toolset for open-weight models in `ai` core
  (the `@ai-sdk/harness-*` family drives frontier runtimes, not applicable).
  Hand-roll bash + read_file + write_file + edit as `tool()` defs.
- **No SDK sandbox enforces the boundary** — the SDK's own sandbox docs say a
  `child_process.exec` + cwd is NOT a security boundary. OUR `execute`
  closures own it: bash `cwd` pinned to the worktree; file tools
  `path.resolve` + containment-check every path. **Reuse
  `packages/engine/src/engines/path-scope.ts`'s `isPathContained` /
  `canonicalizePath`** — the exact helper M4 hardened over 3 review rounds.
  Trust model: worker operates on the user's own repo in an isolated
  worktree; path-checks bound blast radius; real VM isolation is a later
  concern (spec §7 / M7).

## git worktree lifecycle (child_process, execFile not shell)

- `git worktree add <path> -b worker/<taskId> <startPoint>` — shares the
  object store (cheap, no full clone). `git -C <base>` via
  `execFile('git', [...], {cwd: base})`.
- Dirty base is fine (only needs the target ref unclaimed). Omitting `-b`
  detaches HEAD — always pass `-b`.
- `.git` in a linked worktree is a FILE pointing at
  `$GIT_DIR/worktrees/<id>` — don't `mv` a worktree (needs `worktree repair`).
- **Cleanup: `git worktree prune` on engine startup** (idempotent) sweeps
  orphaned admin entries after crashes.
- Concurrent `add` is fine; contention is on concurrent COMMITS (shared
  index.lock) → retry-with-backoff on commit. **NEVER auto-delete a worktree
  on a failed commit** (destroys uncommitted work — real Claude Code bug
  #55724). `git worktree lock` protects an active worktree from prune.
- Review-gate diff: `git -C <worktree> diff` (own index/HEAD). Teardown:
  `git worktree remove --force <path>`; branch deleted separately (`git
  branch -D`) if discarding.

## Versions

`ai@7.0.11` installed; npm latest 7.0.14 (patches only, no breaking, no
ai@8). Providers @ai-sdk/{openai-compatible,deepseek,moonshotai} already deps.
Run `pnpm --filter @openfusion/engine typecheck` to confirm the tool-loop
types before relying on the .d.ts inspection.
