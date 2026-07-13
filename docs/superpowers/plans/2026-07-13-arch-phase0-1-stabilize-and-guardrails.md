# Clean Architecture — Phase 0 (Stabilize) + Phase 1 (Guardrails) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the in-flight uncommitted wave as feature-level commits on a green tree, then switch on CI-enforced architecture guardrails (dependency-cruiser boundary rules + file-size ratchet) so erosion stops before any restructuring begins.

**Architecture:** This is phases 0–1 of the six-phase program in
`docs/superpowers/specs/2026-07-13-clean-architecture-design.md`. Phase 0 is
operational (fix 2 tests, commit ~177 files in meaningful groups). Phase 1
adds two ratchets that grandfather every existing violation into a committed
baseline and fail CI only on NEW violations — the burn-down of the baseline
itself happens in Phases 3–4, not here.

**Tech Stack:** pnpm monorepo (Node ≥22), TypeScript, vitest (engine/desktop),
dependency-cruiser (new dev-dependency, repo root), plain Node scripts under
`scripts/` (precedent: `scripts/check-docs.mjs`), GitHub Actions
(`.github/workflows/ci.yml`).

## Global Constraints (from the spec — apply to every task)

- **No behavior changes.** Phase 0/1 are observationally neutral at the RPC
  surface. Any behavior fix discovered along the way lands as its own commit,
  never mixed into a move or a config commit.
- **Exclusive-tree phase.** Phase 0 moves the whole working tree into commits:
  before ANY git write, run the sibling-session check (Task 1). If a sibling
  session is active, STOP and ask the user to coordinate roles.
- **Tree green at every task boundary** (engine + shared + desktop suites,
  typecheck).
- Commit messages follow the repo's conventional style
  (`feat(engine): …`, `fix(engine): …`, `docs: …`, `chore: …`) — see
  `git log --oneline -20` for live examples.
- Ratchet numbers (fixed in the spec §3/§11): new files ≤ 400 lines;
  existing files grandfathered at current size and may not grow.

---

## Phase 0 — Stabilize

### Task 1: Sibling-session check + wave inventory

**Files:**
- Create: none (read-only reconnaissance; output pasted into the task log)

**Interfaces:**
- Produces: a go/no-go decision for Tasks 2–5, and the definitive
  modified/untracked file inventory Task 4's grouping consumes.

- [ ] **Step 1: Check for a live sibling Claude session** (this repo's known
  hazard — concurrent /loop sessions on one checkout):

```bash
ls -lt ~/.claude/projects/-Users-sungmancho-projects-openfusion/*.jsonl | head -5
# A transcript other than the current session modified within ~15 minutes = live sibling.
find packages apps -name '*.ts' -o -name '*.tsx' -newermt '-15 minutes' | grep -v node_modules | head
# Tracked source files changing right now = someone else is editing.
```

Expected: no non-self transcript newer than ~15 minutes, no source churn.
**If either check fails: STOP. Ask the user which session owns the tree.**

- [ ] **Step 2: Capture the definitive inventory**

```bash
git status --short > /tmp/wave-inventory.txt
git diff --stat | tail -5
wc -l /tmp/wave-inventory.txt   # expect ≈ 179 lines (100 M + 2 D + 77 ??)
```

- [ ] **Step 3: Verify the tree still typechecks before touching anything**

```bash
pnpm typecheck
```

Expected: exit 0 for all three packages. If not, STOP — the wave has drifted
since 2026-07-13 baseline; re-diagnose before proceeding.

### Task 2: Diagnose and fix the two `evals-run` failures (one root cause)

**Files:**
- Modify: `packages/engine/test/evals-run.test.ts:1747-1761` (golden-task
  assertions) and/or `packages/engine/src/orchestrate/orchestrate.ts`
  (escalation stage) — which one depends on the diagnosis decision rule below.
- Test: `packages/engine/test/evals-run.test.ts`

**Interfaces:**
- Consumes: the fake adapters in that test file
  (`makeFakeEvalsFrontierAdapter`, `makeCancelEvalsFrontierAdapter`
  `{ blockOnEscalateCallIndex: 1 }`) and the fixture
  `writeFrontierOnlyHarness` (defined at `evals-run.test.ts:131`).
- Produces: a fully green engine suite (baseline: 900 passed / 2 failed /
  5 skipped, measured 2026-07-13).

Both failures are downstream of ONE fact: the harness arm no longer reaches
the **escalation** call for a frontier-only harness. Test 1 asserts
`perTask[0].harnessOutcome === "escalated"` (got something else); test 2
blocks until the escalation call starts (`blockReached.count` never reaches 1
→ 10s deadline throw). Diagnose once, fix both.

- [ ] **Step 1: Reproduce both failures in isolation**

```bash
cd packages/engine && npx vitest run test/evals-run.test.ts
```

Expected: 2 failures — the `harness.passed`/`harnessOutcome` assertion at
~line 1756 and "harness escalation call never started blocking" at ~line 1835.
Record the ACTUAL `harnessOutcome` value from the first failure's diff — it
names the new behavior.

- [ ] **Step 2: Find what the wave changed about escalation.** Use
  superpowers:systematic-debugging. Starting points, in order:

```bash
# What outcomes can the harness arm produce now?
grep -n "harnessOutcome\|escalat" packages/engine/src/evals/run.ts | head -20
grep -n "escalat" packages/engine/src/orchestrate/orchestrate.ts | head -20
# Did routing change who handles a frontier-only harness? (wave added
# family-aware routing + agent chains)
grep -n "escalat\|frontier" packages/engine/src/orchestrate/routing.ts | head -20
# Does the fixture still satisfy harness schema v2? (wave added v1→v2 upgrade)
sed -n '131,190p' packages/engine/test/evals-run.test.ts
```

- [ ] **Step 3: Apply the decision rule.**
  - **If the wave deliberately changed the contract** (e.g. a frontier-only
    harness now routes directly to a frontier attempt and reports
    `harnessOutcome: "frontier"` without an escalation hop — the
    tests-lagging-contract class every wave failure so far has been): update
    the TEST — assert the new outcome value in test 1, and in test 2 point
    `makeCancelEvalsFrontierAdapter` at whichever adapter call now carries the
    in-flight harness work (the blocking hook must target a call that actually
    happens). Do NOT weaken assertions to `toBeDefined()` — assert the new
    exact value.
  - **If escalation silently regressed** (orchestrate should still escalate
    but doesn't): fix `orchestrate.ts`'s escalation stage, leave the tests
    untouched, and record the root cause in the commit message.

- [ ] **Step 4: Run the full engine suite**

```bash
cd packages/engine && npm test
```

Expected: 0 failed (902 passed / 5 skipped, ±the two rewritten tests).

- [ ] **Step 5: Commit** (this fix rides ahead of the wave commits — it's a
  test-contract alignment, not part of any feature group)

```bash
git add packages/engine/test/evals-run.test.ts   # plus src file if Step 3 chose the regression branch
git commit -m "test(engine): align evals-run escalation expectations with routed frontier outcome

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: Classify the ambiguous untracked artifacts

**Files:**
- Inspect (no code changes; output = a commit/exclude decision per path):
  `.openfusion/`, `AGENTS.md`, `native/`,
  `apps/desktop/scripts/stage-sandbox-runner.mjs`, `apps/desktop/src/dev/`

**Interfaces:**
- Produces: the include/exclude list Task 4's commit grouping consumes.

- [ ] **Step 1: Inspect each ambiguous path**

```bash
find .openfusion -type f | head -20 && cat .openfusion/.gitignore 2>/dev/null
head -30 AGENTS.md
find native -type f | head -20
grep -rn "native/" apps/desktop/scripts/*.mjs apps/desktop/src-tauri/tauri.conf.json | head
```

- [ ] **Step 2: Apply the classification defaults** (locked design: harness
  artifacts are committed in-repo under `.openfusion/`, but ONLY after the
  human approval gate):
  - `.openfusion/` — **exclude from the wave.** Its contents came from
    operator smoke runs, not an approved harness generation.
    `cache/` is already self-gitignoring; leave the rest untracked and flag it
    to the user for a deliberate harness commit later.
  - `AGENTS.md` — generated card-led export. **Exclude** unless the user
    confirms the current card was approved; flag it.
  - `native/` + `stage-sandbox-runner.mjs` — **include** if referenced by the
    build (Step 1's grep hits in `tauri.conf.json`/staging scripts prove it);
    otherwise flag.
  - `apps/desktop/src/dev/` — **include** (part of the desktop wave).
- [ ] **Step 3: Record the decision list** as a table in the task log:
  path → include-in-commit-group-N / exclude+flag. No commit in this task.

### Task 4: Land the wave as feature-level commits

**Files:**
- Modify: the entire working tree, via `git add` groups only — zero content
  edits in this task. Any file that needs a content change to be committable
  belongs in Task 2's class and must go back there.

**Interfaces:**
- Consumes: Task 1's inventory, Task 3's include/exclude list.
- Produces: a clean `git status` (empty but for Task 3's flagged exclusions),
  with the wave split into reviewable feature commits.

- [ ] **Step 1: REQUIRED SUB-SKILL — invoke `atomic-commits`** with this
  grouping proposal as the starting point (the skill verifies real file
  relationships and dependency order; expect it to adjust):
  1. `feat(engine): runtime kernel — sessions, supervisor, store, sandbox, policy` — `packages/engine/src/runtime/` (new dir) + its tests
  2. `feat(engine): stage-verification gates and candidate grant/apply` — `packages/engine/src/verification/`, `candidates/`, `tools/`, `harness/{registry,fingerprint,health}.ts`, `wiki/verify.ts` + tests
  3. `feat(engine): learning-spine run events and review policy` — `runs/events.ts`, `orchestrate/review-policy.ts` + tests
  4. `feat(engine): codex frontier adapter and engine selection` — `engines/codex.ts`, `engines/selection.ts` + tests
  5. `feat(desktop): workspace shell redesign — sidebar/toolbar, harness health screen, ui primitives` — all `apps/desktop/` changes incl. deleted `EvalsScreen`, `native/` + staging script if Task 3 included them
  6. `docs: dual human/agent docs system, research and plan docs` — `docs/`, `scripts/check-docs.mjs` companions, README changes
  7. `chore: ci, dev script, package manifests` — `.github/workflows/ci.yml`, `dev.sh`, `package.json`, lockfiles, `tauri.conf.json` if not consumed by group 5
- [ ] **Step 2: Before the first commit, verify the whole tree green**

```bash
pnpm build && pnpm typecheck && pnpm test
```

Expected: all exit 0. Commits only start from a fully green tree — per-commit
buildability is best-effort (engine groups land before the desktop group,
code before docs), but the tree MUST be green after the final commit.

- [ ] **Step 3: After the last commit, verify nothing left behind**

```bash
git status --short
```

Expected: only Task 3's deliberately-excluded paths (`.openfusion/`,
`AGENTS.md` if excluded). Paste this output in the task log.

### Task 5: Post-landing verification + push decision

**Files:** none (verification only)

**Interfaces:**
- Produces: the green, committed baseline Phase 1 ratchets against.

- [ ] **Step 1: Full verification on the committed tree**

```bash
git stash --include-untracked list >/dev/null; pnpm build && pnpm typecheck && pnpm test && pnpm docs:check
```

Expected: all green (engine ~902, desktop ~180+, shared 25).
- [ ] **Step 2: Report to the user**: commit list (`git log --oneline main@{u}..main` if upstream set, else last N), the excluded-path flags from Task 3, and ASK whether to push — pushing main is the user's call, never automatic.

---

## Phase 1 — Guardrails

### Task 6: dependency-cruiser boundary rules with grandfathered baseline

**Files:**
- Create: `.dependency-cruiser.cjs` (repo root)
- Create: `.dependency-cruiser-known-violations.json` (generated baseline)
- Modify: `package.json` (root — devDependency + script)

**Interfaces:**
- Produces: `pnpm arch:dep` — exits 0 today (baseline grandfathers existing
  violations), exits non-zero on any NEW cross-boundary import. Task 8 wires
  it into CI.

- [ ] **Step 1: Install**

```bash
pnpm add -D -w dependency-cruiser
```

- [ ] **Step 2: Write the config** — spec §3 rules 1–2, with the §3
  foundation-tier exception (`util/`, `tools/`, `models/` catalog+pricing,
  `shared/`) and runtime treated as ONE module until Phase 3:

```js
// .dependency-cruiser.cjs
// Architecture boundary rules — spec: docs/superpowers/specs/2026-07-13-clean-architecture-design.md §3.
// Existing violations are grandfathered in .dependency-cruiser-known-violations.json
// (the Phase 3-4 burn-down list); only NEW violations fail.
const APPLICATION = "^packages/engine/src/(orchestrate|evals|candidates)/";
const MODULES = "^packages/engine/src/(worker|harness|wiki|models|engines|runs|verification|runtime)/";
const TRANSPORT = "^packages/engine/src/rpc/";
const FOUNDATION = "^packages/(engine/src/(util|tools)/|shared/)";

module.exports = {
  forbidden: [
    {
      name: "modules-must-not-import-application",
      comment: "Layer rule: transport -> application -> modules, one way only.",
      severity: "error",
      from: { path: MODULES },
      to: { path: APPLICATION },
    },
    {
      name: "modules-must-not-import-transport",
      comment: "methods.ts RPC adapters inside module folders are the known burn-down (Phase 4 transport/domain split).",
      severity: "error",
      from: { path: MODULES, pathNot: "methods\\.ts$" },
      to: { path: TRANSPORT },
    },
    {
      name: "no-cross-module-deep-imports",
      comment: "A module may import foundation code and its own files — not sibling module internals. $1 back-references the from-side capture group (same-module imports allowed).",
      severity: "error",
      from: { path: "^packages/engine/src/([^/]+)/" },
      to: { path: MODULES, pathNot: ["^packages/engine/src/$1/", FOUNDATION] },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true, dependencyTypesNot: ["type-only"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    includeOnly: "^packages/(engine|shared)/(src|test)/",
    tsConfig: { fileName: "packages/engine/tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
```

**Note on `no-cross-module-deep-imports`:** the `$1` back-reference from the
`from` capture group into `to.pathNot` is a documented dependency-cruiser
feature (group matching); verify it works in the installed version during
Step 5's synthetic-violation check. If it doesn't, drop this third rule for
Phase 1 — rules 1, 2, 4 plus the baseline still hold the line — and note the
omission in the commit message so Phase 3 adds it with the index.ts contracts.

- [ ] **Step 3: Generate the grandfather baseline**

```bash
npx depcruise packages/engine/src packages/engine/test packages/shared/src --config .dependency-cruiser.cjs --output-type baseline > .dependency-cruiser-known-violations.json
wc -l .dependency-cruiser-known-violations.json   # non-trivial: today's deep imports + methods.ts transport imports
```

- [ ] **Step 4: Add the script** to root `package.json`:

```json
"arch:dep": "depcruise packages/engine/src packages/engine/test packages/shared/src --config .dependency-cruiser.cjs --ignore-known .dependency-cruiser-known-violations.json --output-type err"
```

- [ ] **Step 5: Verify it passes clean and fails dirty** (this is the test)

```bash
pnpm arch:dep && echo CLEAN-PASS
# Inject a synthetic NEW violation:
echo 'import "../orchestrate/orchestrate.js";' >> packages/engine/src/worker/worktree.ts
pnpm arch:dep; echo "EXIT=$?"   # expect non-zero + modules-must-not-import-application
git checkout packages/engine/src/worker/worktree.ts
pnpm arch:dep && echo CLEAN-AGAIN
```

Expected: CLEAN-PASS, then EXIT≠0 naming the violated rule, then CLEAN-AGAIN.

- [ ] **Step 6: Commit**

```bash
git add .dependency-cruiser.cjs .dependency-cruiser-known-violations.json package.json pnpm-lock.yaml
git commit -m "chore(arch): dependency-cruiser layer rules with grandfathered baseline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 7: File-size ratchet script

**Files:**
- Create: `scripts/check-file-budget.mjs`
- Create: `scripts/file-budget-baseline.json` (generated)
- Create: `scripts/check-file-budget.test.mjs` (node:test — Node 22 built-in)
- Modify: `package.json` (root — scripts)

**Interfaces:**
- Produces: `pnpm arch:budget` — exit 0 unless a baselined file GREW past its
  recorded count or a non-baselined source file exceeds 400 lines. Exports
  `checkBudget(entries, baseline)` (pure) for the test.
  `entries: Array<{path: string, lines: number}>`,
  `baseline: Record<string, number>`,
  returns `Array<{path: string, lines: number, limit: number}>` (violations).

- [ ] **Step 1: Write the failing test**

```js
// scripts/check-file-budget.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBudget, NEW_FILE_LIMIT } from "./check-file-budget.mjs";

test("baselined file at its recorded size passes", () => {
  assert.deepEqual(checkBudget([{ path: "a.ts", lines: 2000 }], { "a.ts": 2000 }), []);
});
test("baselined file that grew fails with its own limit", () => {
  assert.deepEqual(checkBudget([{ path: "a.ts", lines: 2001 }], { "a.ts": 2000 }), [
    { path: "a.ts", lines: 2001, limit: 2000 },
  ]);
});
test("baselined file that shrank passes (ratchet only bites growth)", () => {
  assert.deepEqual(checkBudget([{ path: "a.ts", lines: 1500 }], { "a.ts": 2000 }), []);
});
test("new file under the cap passes, over the cap fails", () => {
  assert.deepEqual(checkBudget([{ path: "b.ts", lines: 400 }], {}), []);
  assert.deepEqual(checkBudget([{ path: "b.ts", lines: 401 }], {}), [
    { path: "b.ts", lines: 401, limit: NEW_FILE_LIMIT },
  ]);
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
node --test scripts/check-file-budget.test.mjs
```

Expected: FAIL — `check-file-budget.mjs` does not exist / exports missing.

- [ ] **Step 3: Write the script**

```js
// scripts/check-file-budget.mjs
// File-size ratchet — spec §3 rule 3. Baselined files may shrink, never grow;
// files not in the baseline are "new" and capped at NEW_FILE_LIMIT lines.
// Regenerate the baseline ONLY when a file legitimately shrinks and you want
// to lock in the gain: pnpm arch:budget:rebase.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export const NEW_FILE_LIMIT = 400;
const BASELINE_PATH = new URL("./file-budget-baseline.json", import.meta.url);
const INCLUDE = /^(packages\/(engine|shared)\/(src|test)|apps\/desktop\/src)\/.*\.(ts|tsx)$/;

export function checkBudget(entries, baseline) {
  const violations = [];
  for (const { path, lines } of entries) {
    const limit = Object.hasOwn(baseline, path) ? baseline[path] : NEW_FILE_LIMIT;
    if (lines > limit) violations.push({ path, lines, limit });
  }
  return violations;
}

function trackedEntries() {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n").filter((f) => INCLUDE.test(f));
  return files.map((path) => ({
    path,
    lines: readFileSync(path, "utf8").split("\n").length,
  }));
}

const mode = process.argv[2];
if (mode === "--rebase") {
  const baseline = Object.fromEntries(
    trackedEntries().filter((e) => e.lines > NEW_FILE_LIMIT).map((e) => [e.path, e.lines]),
  );
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`baseline written: ${Object.keys(baseline).length} grandfathered files`);
} else if (mode === "--check" || mode === undefined) {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const violations = checkBudget(trackedEntries(), baseline);
  for (const v of violations) {
    console.error(`FILE BUDGET: ${v.path} has ${v.lines} lines (limit ${v.limit})`);
  }
  if (violations.length > 0) {
    console.error("\nSplit the file (spec 2026-07-13 §6) — do not raise the limit.");
    process.exit(1);
  }
  console.log("file budget: ok");
}
```

- [ ] **Step 4: Run the tests, expect pass**

```bash
node --test scripts/check-file-budget.test.mjs
```

Expected: 4 pass / 0 fail.

- [ ] **Step 5: Generate the baseline and add scripts**

```bash
node scripts/check-file-budget.mjs --rebase
cat scripts/file-budget-baseline.json | head   # expect the §1 god-files with their current counts
```

Add to root `package.json`:

```json
"arch:budget": "node scripts/check-file-budget.mjs --check",
"arch:budget:rebase": "node scripts/check-file-budget.mjs --rebase",
"arch:check": "pnpm arch:dep && pnpm arch:budget && node --test scripts/check-file-budget.test.mjs"
```

- [ ] **Step 6: End-to-end check on the real tree**

```bash
pnpm arch:check
```

Expected: exit 0 (`file budget: ok`, dep-cruise clean against baseline).

- [ ] **Step 7: Commit**

```bash
git add scripts/check-file-budget.mjs scripts/check-file-budget.test.mjs scripts/file-budget-baseline.json package.json
git commit -m "chore(arch): file-size ratchet — grandfathered baseline, 400-line cap for new files

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 8: Wire guardrails into CI

**Files:**
- Modify: `.github/workflows/ci.yml` (add one step after `docs:check`)
- Modify: `docs/agents/` or `AGENTS.md`-adjacent contributor docs IF the dual
  docs system (landed in Task 4) has a "checks" page; otherwise `README.md`'s
  development section.

**Interfaces:**
- Consumes: `pnpm arch:check` from Tasks 6–7.
- Produces: CI that fails on new boundary violations or file growth.

- [ ] **Step 1: Add the CI step** in `.github/workflows/ci.yml` after
  `- run: pnpm docs:check`:

```yaml
      - run: pnpm arch:check
```

- [ ] **Step 2: Document the ratchet contract** where the Task 4-landed docs
  system keeps contributor checks (fallback: README development section) —
  add exactly this block:

```markdown
### Architecture guardrails

`pnpm arch:check` runs in CI: dependency-cruiser boundary rules
(`.dependency-cruiser.cjs` — layer direction, no cross-module deep imports)
and a file-size ratchet (`scripts/check-file-budget.mjs` — grandfathered
files may shrink but never grow; new files are capped at 400 lines).
Baselines only ever shrink: `pnpm arch:budget:rebase` locks in gains after a
file split — it must never be used to raise a limit. Rules and rationale:
`docs/superpowers/specs/2026-07-13-clean-architecture-design.md` (§3, §11).
```
- [ ] **Step 3: Verify the workflow file parses**

```bash
npx yaml-lint .github/workflows/ci.yml 2>/dev/null || node -e "const y=require('js-yaml');y.load(require('fs').readFileSync('.github/workflows/ci.yml','utf8'));console.log('yaml ok')"
```

Expected: `yaml ok` (or use any available YAML parser; a clean `git diff`
review of the 1-line addition suffices if neither tool is installed).

- [ ] **Step 4: Commit, then confirm CI green on the pushed branch/PR**

```bash
git add .github/workflows/ci.yml README.md docs/
git commit -m "ci: enforce architecture guardrails (arch:check)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Push only with the user's go-ahead (same rule as Task 5 Step 2); once pushed,
verify the CI run is green before calling Phase 1 done.

---

## Out of scope for this plan (later phases, planned at their boundaries)

- Phase 2: shared contract registry + generic desktop client (deletes
  `engineClient.ts`)
- Phase 3: ports (`OrchestrateDeps` etc.), composition-root-only wiring,
  barrel shrink — burns down the Task 6 baseline
- Phase 4: god-file surgery (`store.ts`, `worker/methods.ts`,
  `orchestrate.ts`, `evals/run.ts`) — burns down the Task 7 baseline
- Phase 5: desktop container/presenter screens
