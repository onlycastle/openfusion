# M5a: Worker Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An open-weight model can execute a small coding task inside an isolated git worktree via our own AI SDK v7 tool loop (bash + path-scoped file edits), producing a reviewable diff and a metered cost — `engine.worker.run {projectDir, task, providerId, model, ...}` → `{ diff, summary, steps, costUsd, worktree }`. This is the mechanical substrate; M5b adds routing, the review gate, and escalation on top.

**Architecture:** New `src/worker/`: `worktree.ts` (git worktree manager — create/list/remove/prune, diff), `tools.ts` (bash + read_file + write_file + edit as AI SDK `tool()` defs, each `execute` closure enforcing the worktree boundary via the existing `path-scope.ts`), `loop.ts` (the `generateText`-with-tools multi-step loop; `stopWhen: isStepCount(N)`; cumulative-usage metering), `methods.ts` (WorkerService on Engine + `engine.worker.run` RPC + `worker.progress` notifications). Plus a **prerequisite fix** (Task 1) to the M4-deferred writeScope fail-safe-drop bug, which becomes day-one critical the moment worker worktrees (under the macOS `/var → /private/var` symlink) create not-yet-existing scope dirs.

**Tech Stack (verified 2026-07-04, docs/research/2026-07-04-m5-api-verification.md):** `ai@^7` tool loop (`tool({inputSchema, execute})`, `stopWhen: isStepCount(n)`, `result.usage` cumulative, `onStepEnd`), providers already deps, `git worktree` via execFile, `path-scope.ts` for sandboxing.

## Global Constraints

- Everything standing: Node ≥22, strict TS NodeNext `.js` imports, tsconfig.test coverage, stdout protocol purity, tmp fixtures (real git repos in `mkdtempSync`), conventional commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, nothing under `.superpowers/`/`.claude/` of THIS repo, no live keys in CI, prompts/model-output never logged (progress notifications carry structured metadata only).
- **Worker sandbox boundary:** every tool `execute` confines filesystem effects to the worktree root — bash `cwd` pinned; file tools resolve+containment-check via `path-scope.ts`'s `isPathContained`/`canonicalizePath`. A path escape → the tool returns an error result (fed back to the model), never performs the op.
- **No auto-delete on failure:** a worker run that fails/errors must NOT auto-remove its worktree (uncommitted work loss — git#55724). Teardown is explicit (M5b/user decision); M5a's `engine.worker.run` leaves the worktree in place and returns its path.
- **CI has no live model keys:** the worker loop is tested with the AI SDK's `MockLanguageModelV4` (from `ai/test`) emitting scripted tool-call/tool-result/text sequences. A real end-to-end worker run is an env-gated smoke.
- **Cost metering:** worker runs record to the existing `engine.models` CostMeter (kind `"worker/<providerId>"`, usage from `result.usage` cumulative, priced via `lookupPricing(kind, model)` — the kind for pricing is the provider kind, not "worker/...").

---

### Task 1: writeScope fail-safe-drop fix (M4 carry — day-one critical)

**Files:**
- Modify: `packages/engine/src/engines/claude.ts`
- Test: `packages/engine/test/frontier-claude.test.ts`

**Problem (from M4 T1 deferred + M4 final review):** in `claude.ts`, a `writeScope` entry that does NOT yet exist on disk gets its realpath fallback built from the RAW `projectDir` string, while the containment baseline (`canonicalProjectDir`) is realpath'd. When `projectDir` sits under a symlinked path component (macOS `os.tmpdir()` → `/var/folders/...` which is really `/private/var/folders/...`), a legitimate not-yet-existing scope dir is compared apples-to-oranges and silently DROPPED → the worker's writes to it are all denied. Worker worktrees live under `os.tmpdir()`, so this fires immediately.

**Interfaces:** no signature change. Fix: when a scope dir doesn't exist yet (realpath throws), build its lexical fallback from `canonicalProjectDir` (the already-realpath'd project root) rather than the raw `projectDir`, so the containment comparison is canonical-vs-canonical. Existing scope dirs (realpath succeeds) are unchanged.

- [ ] **Step 1: Failing test** — in a tmp dir obtained via `fs.realpathSync(mkdtempSync(...))`'s PARENT symlink scenario: the cleanest reproduction is to create the projectDir under `os.tmpdir()` (which on macOS is the `/var` symlink) and pass a writeScope entry naming a subdir that does NOT exist yet (e.g. `.openfusion/work` before generation created it, or just `scratch`). Assert a `canUseTool` Write to `<scope>/file.txt` is ALLOWED. On the CI Linux runner os.tmpdir() may not be symlinked, so ALSO construct the symlink explicitly: create `realBase`, `symlink realBase → linkBase`, use `linkBase/proj` as projectDir, writeScope `["scratch"]` (nonexistent) → Write to `linkBase/proj/scratch/x.txt` must be ALLOWED (pre-fix it's DENIED because the nonexistent-dir lexical fallback uses the un-canonical `linkBase` path while the baseline is `realBase`). Confirm RED.
- [ ] **Step 2: Implement** the canonical-fallback fix. Keep the existing symlink-scope-dir escape guard (realpath'd existing scope dirs still re-checked for containment).
- [ ] **Step 3: GREEN** — the new test passes; ALL existing writeScope tests (traversal/symlink escapes) still pass unchanged. `pnpm build && pnpm typecheck && pnpm test` — exact totals.
- [ ] **Step 4: Commit** — `fix(engine): writeScope allows not-yet-existing dirs under symlinked project roots`

---

### Task 2: git worktree manager

**Files:**
- Create: `packages/engine/src/worker/worktree.ts`
- Test: `packages/engine/test/worker-worktree.test.ts`

**Interfaces:**
- `interface Worktree { id: string; path: string; branch: string; base: string }`
- `class WorktreeManager { constructor(baseRepo: string); create(taskId: string): Promise<Worktree>; list(): Promise<Worktree[]>; diff(worktree: Worktree): Promise<string>; diffStat(worktree: Worktree): Promise<string>; remove(worktree: Worktree, opts?: { deleteBranch?: boolean }): Promise<void>; prune(): Promise<void> }`
- `create`: `git -C <base> worktree add <base>/.openfusion/worktrees/<taskId> -b worker/<taskId> HEAD` (worktrees dir under .openfusion/, which is gitignored via cache/ sibling — ensure `.openfusion/worktrees/` is added to the `.openfusion/.gitignore` guard, alongside `cache/`, so worker worktrees are never committed). taskId sanitized to `[a-zA-Z0-9._-]` (reject others → Error). Returns the Worktree.
- `diff`/`diffStat`: `git -C <worktree.path> diff` (unstaged+working changes; the worker edits files without committing, so a plain `git diff` shows nothing until staged — use `git -C <path> add -A --intent-to-add` then `git diff`, OR `git diff HEAD` after staging; simplest robust approach: `git -C <path> add -A` then `git -C <path> diff --cached`, then leave staged — document the staging choice). Return the unified diff string.
- `remove`: `git -C <base> worktree remove --force <path>`; if `deleteBranch`, then `git -C <base> branch -D worker/<taskId>`. NEVER called automatically on worker failure (caller decides).
- `prune`: `git -C <base> worktree prune`.
- All git via `execFile('git', args, {cwd, maxBuffer})` — never shell.

- [ ] **Step 1: Failing tests** (real git repo in tmp): create a base repo with a committed file; `create("t1")` → worktree dir exists, is a git worktree (`git -C <path> rev-parse --is-inside-work-tree` true), branch `worker/t1`; write+edit a file in the worktree, `diff` returns a unified diff containing the change; `list` includes it; `.openfusion/.gitignore` contains `worktrees/`; sanitize rejects `../evil`; `remove` deletes the dir and (with deleteBranch) the branch; `prune` runs clean. Two concurrent `create` (Promise.all, different taskIds) both succeed.
- [ ] **Step 2: RED → implement → GREEN** (exact totals).
- [ ] **Step 3: Commit** — `feat(engine): git worktree manager for isolated worker workspaces`

---

### Task 3: path-scoped worker toolset

**Files:**
- Create: `packages/engine/src/worker/tools.ts`
- Test: `packages/engine/test/worker-tools.test.ts`

**Interfaces:**
- `interface ToolContext { root: string; bashTimeoutMs?: number; onToolEvent?: (e: { tool: string; detail: string }) => void }`
- `createWorkerTools(ctx: ToolContext): Record<string, Tool>` returning `bash`, `read_file`, `write_file`, `edit`:
  - `bash({ command })`: `execFile("/bin/sh", ["-c", command], { cwd: ctx.root, timeout: ctx.bashTimeoutMs ?? 30000, maxBuffer })` → `{ stdout, stderr, exitCode }` (truncate each to ~10KB). A nonzero exit is a NORMAL result (returned, not thrown — the model reads it). NOTE: bash can still `cd` out / touch absolute paths — document that bash's boundary is cwd-pinning only (real isolation is M7); file TOOLS enforce path containment, bash does not fully. This is the accepted v1 trust model (worker on user's own repo, isolated worktree).
  - `read_file({ path })`: resolve `path` against `ctx.root`, containment-check via `isPathContained(canonicalizePath(resolved), realpath(root))`; escape → return `{ error: "path outside worktree" }` (a tool-error result, model recovers); else read (truncate large) → `{ content }`.
  - `write_file({ path, content })`: same containment gate; mkdir -p parent; write; → `{ ok: true, bytes }` or `{ error }`.
  - `edit({ path, find, replace })`: containment gate; read, require `find` occurs exactly once (else `{ error: "find matched N times" }`), replace, write → `{ ok: true }` or `{ error }`.
  - Each tool calls `ctx.onToolEvent?.({ tool, detail })` with a SHORT metadata string (e.g. `bash: npm test` — the command is arguably not secret, but truncate; NEVER the file content or model text).
- Uses `tool({ description, inputSchema: z.object(...), execute })` from `ai`; reuse `path-scope.ts` for containment.

- [ ] **Step 1: Failing tests** (call each tool's `execute` directly with a tmp root): bash runs `echo hi` → stdout "hi", exit 0; bash nonzero exit returned not thrown; read_file inside root works, outside (`../etc`) → error result; write_file creates + mkdir parent, outside → error; edit single-match replaces, zero/multi-match → error; a symlink inside root pointing out → write via it denied (canonicalizePath); onToolEvent fired with truncated detail, never file content.
- [ ] **Step 2: RED → implement → GREEN** (exact totals).
- [ ] **Step 3: Commit** — `feat(engine): path-scoped bash/read/write/edit worker toolset`

---

### Task 4: the worker loop

**Files:**
- Create: `packages/engine/src/worker/loop.ts`
- Test: `packages/engine/test/worker-loop.test.ts`

**Interfaces:**
- `interface WorkerRunInput { model: LanguageModel; task: string; wikiDigest?: string; tools: Record<string, Tool>; maxSteps?: number (default 30); onStep?: (s: { step: number; toolCalls: number; text?: string }) => void }`
- `interface WorkerRunResult { summary: string; steps: number; usage: NormalizedUsage; finishReason: string; toolCallCount: number }`
- `runWorkerLoop(input): Promise<WorkerRunResult>` — builds the worker system+task prompt (specialist instruction + optional wikiDigest + the task; instructs: use the tools to make the change, keep going until done, end with a short summary of what you changed), calls `generateText({ model, tools, stopWhen: isStepCount(maxSteps), prompt/messages, onStepEnd })`, maps `result.usage` (cumulative) → NormalizedUsage via the existing `normalizeUsage`, counts tool calls across `result.steps`, returns the final `result.text` as summary. `onStep` relays each `onStepEnd` (step number, tool-call count, truncated text) — NEVER raw tool args/results or full model text beyond a short truncation.
- Takes `model` and `tools` as INPUTS (dependency-injected) so CI uses `MockLanguageModelV4` from `ai/test` scripting a tool-call → tool-result → final-text sequence; the WorkerService (Task 5) wires the real provider model + createWorkerTools.

- [ ] **Step 1: Failing tests** (MockLanguageModelV4): a scripted mock that on step 1 emits a `write_file` tool call, on step 2 (seeing the tool result) emits final text "Added greet()" → runWorkerLoop returns summary "Added greet()", steps 2, toolCallCount 1, usage summed across both steps; the mock's tool call actually invokes the real `createWorkerTools` execute against a tmp worktree so the file is written (proves the loop wires tools→execute→model). A single-step mock (final text immediately, no tool call) → steps 1, toolCallCount 0. maxSteps cap: a mock that ALWAYS emits a tool call → loop stops at maxSteps (assert steps === maxSteps, doesn't hang). onStep fired per step.
  - NOTE on MockLanguageModelV4 tool-call shape: study `ai/test`'s doGenerate return for tool calls (the provider-spec shape — content parts of type "tool-call" with toolName/input); the M2 fixture tests used the usage nested shape — follow the same discipline. If the exact mock tool-call shape is unclear from the installed types, this is the one place to spend care (read node_modules/ai/dist for the ToolCallPart shape).
- [ ] **Step 2: RED → implement → GREEN** (exact totals).
- [ ] **Step 3: Commit** — `feat(engine): open-model worker tool loop with cumulative usage`

---

### Task 5: engine.worker.run RPC + WorkerService + metering

**Files:**
- Create: `packages/engine/src/worker/methods.ts`
- Modify: `packages/engine/src/engine.ts` (WorkerService + re-exports; startup `WorktreeManager.prune`-on-first-use is fine)
- Test: `packages/engine/test/worker-methods.test.ts`; env-gated `worker-run-smoke.test.ts`

**Interfaces:**
- `WorkerService` on Engine (sibling pattern). Holds a WorktreeManager per baseRepo (cached by realpath), and the models registry (from `engine.models`).
- `engine.worker.run` params (zod): `{ projectDir, task: string(min1), providerId: string, model: string, wikiDigest?: string, maxSteps?: int 1..100, bashTimeoutMs?: int 1000..600000 }` → `{ diff, diffStat, summary, steps, toolCallCount, usage, costUsd, worktree: { path, branch } }`. Flow: require git repo (SERVER_ERROR else); resolve the model via `engine.models` registry.resolve(providerId, model) (SERVER_ERROR if provider unconfigured); create a worktree; `createWorkerTools({ root: worktree.path, bashTimeoutMs, onToolEvent → engine.notify("worker.progress", {tool,detail}) })`; `runWorkerLoop({ model, task, wikiDigest, tools, maxSteps, onStep → engine.notify("worker.progress", ...) })`; `worktree.diff()`; record to CostMeter (kind = provider kind via registry lookup, model, usage, costUsd = estimateCost via lookupPricing); return. The worktree is LEFT IN PLACE (no auto-remove) — its path is returned for M5b/user teardown.
- `engine.worker.cleanup { projectDir, worktreePath, deleteBranch? }` → `{ removed: boolean }` — explicit teardown (so tests and M5b can remove worktrees; never automatic).
- Concurrency: worker runs do NOT coalesce (each is a distinct task); but cap concurrent runs per project — actually, leave uncapped at the engine (client owns bounding per the M2 decision) but DOCUMENT it; M5b's orchestrator will bound fan-out.
- Failure: model/tool loop throw → SERVER_ERROR with the worktree path in `data` (so the user can inspect/clean up the partial work) — do NOT auto-remove.

- [ ] **Step 1: Failing tests** (register a fake provider model via the existing ProviderRegistry.setTestModel hook — study how M2/M3 tests inject models; the WorkerService resolves through registry.resolve so setTestModel is the injection point): configure a provider, setTestModel a MockLanguageModelV4 that writes a file then summarizes; `engine.worker.run` on a tmp git repo → result has a non-empty diff containing the file change, summary, usage, costUsd (priced or null), worktree.path exists on disk; `engine.models.usage` shows the worker record; `worker.progress` notifications emitted; the worktree is NOT auto-removed (exists after the call); `engine.worker.cleanup` removes it; non-git dir → SERVER_ERROR; unconfigured provider → SERVER_ERROR. Env-gated real smoke (authored, skipped): real open-model run on a tmp clone with a trivial task ("create hello.txt containing HELLO"), assert the diff shows the file — requires a real provider key, so `it.skipIf(!process.env.OPENFUSION_WORKER_SMOKE)`.
- [ ] **Step 2: RED → implement → GREEN** (exact totals).
- [ ] **Step 3: Commit** — `feat(engine): engine.worker.run — isolated metered worker runs with reviewable diffs`

---

## Milestone exit checklist

- [ ] Full suite green from clean checkout, no live keys / no claude binary
- [ ] `engine.worker.run` with an injected mock model produces a real diff in an isolated worktree, metered, worktree left for review
- [ ] `git worktree list` on the base shows worker worktrees under `.openfusion/worktrees/`; none committed (gitignored)
- [ ] Operator (with an open-model key): `OPENFUSION_WORKER_SMOKE=1 pnpm --filter @openfusion/engine test -- worker-run-smoke` — a real open model creates a file in a worktree
- [ ] Next: write M5b plan (routing + review gate + escalation) — providerId schema addition, routing.yaml consumption, frontier review of worker diff, retry-once-then-escalate, engine.orchestrate
