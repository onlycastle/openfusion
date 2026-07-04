# OpenFusion (working name)

Open-source macOS app that analyzes your repo with a frontier model and
generates a dedicated multi-model harness: an LLM wiki, specialist agents,
and a cost-optimizing routing policy — frontier orchestration, open-model
workers.

- Design spec: `docs/superpowers/specs/2026-07-03-harness-fusion-app-design.md`
- Roadmap: `docs/superpowers/plans/2026-07-03-roadmap.md`
- Landscape research: `docs/research/2026-07-03-oss-landscape.md`

Status: the engine indexes TypeScript/JavaScript/Python/Go/Rust/Java git
repositories into a per-project symbol store, serves a token-budgeted
PageRank repo map, and exposes `wiki_query`/`wiki_map` to MCP clients over
loopback HTTP (M1b complete). Frontier sessions now exist (M3) over a
concurrency-bounded RPC protocol; the engine is auth-agnostic. OpenFusion
never handles frontier credentials — the embedded official CLI uses whatever
login you have configured; review your provider's terms for subscription use.
Harness generation (M4) drives a frontier session over the indexed repo to
produce a committable `.openfusion/` harness — an LLM wiki, a specialist
agent roster, and a routing policy — gated by structural validation at
generation time; the eval loop that flips `verification.evals` from
`"pending"` to `"pass"` lands in M6. Two exporters turn that harness into
interop artifacts other tools can read: an `AGENTS.md` project brief and
per-agent Claude Code subagents under `.claude/agents/`. Orchestration (M5b)
now composes that harness into the full harness-fusion loop end to end:
`engine.orchestrate` classifies a task, routes it to a specialist agent,
runs an open model worker inside an isolated git worktree, and gates the
resulting diff behind a frontier review — retrying once before escalating to
a write-scoped frontier session — and `engine.orchestrate.apply` lands an
approved diff into the base tree. See "How the loop works" below for the
full flow and its caveats (cost estimates are directional, the harness
driving it is unverified until M6, and nothing ever auto-merges).

## Generating a harness

    engine.harness.generate  { "projectDir": "/path/to/repo" }
    engine.harness.status    { "projectDir": "/path/to/repo" }
    engine.harness.export    { "projectDir": "/path/to/repo", "format": "agents-md" }
    engine.harness.export    { "projectDir": "/path/to/repo", "format": "claude-subagents" }

`generate` requires a git repository and a registered frontier adapter; it
writes `.openfusion/` (wiki pages, agent defs, `routing.yaml`, `manifest.json`)
and is safe to re-run — regeneration prunes only the artifacts the prior
generation itself wrote, never hand-edited additions. `status` is a cheap,
poll-friendly read of `manifest.json` alone. `export` requires a harness that
is both present and structurally valid (else `SERVER_ERROR`); `agents-md`
writes `<projectDir>/AGENTS.md`, `claude-subagents` writes one file per agent
under `<projectDir>/.claude/agents/`. **Unverified until the eval gate
passes**: every exported harness is marked `UNVERIFIED` in `AGENTS.md` (and
the eval status is visible via `engine.harness.status`) until
`manifest.verification.evals` reads `"pass"` — treat agent prompts and
routing as unproven against your project until then.

## How the loop works

    engine.orchestrate       { "projectDir": "/path/to/repo", "task": "add input validation to the signup form" }
    engine.orchestrate.apply { "projectDir": "/path/to/repo", "diff": "<diff from the orchestrate result>" }
    engine.worker.list       { "projectDir": "/path/to/repo" }
    engine.worker.gc         { "projectDir": "/path/to/repo", "keep": ["/path/to/repo/.openfusion/worktrees/<id>"] }

## Measuring the harness

    engine.evals.run { "projectDir": "/path/to/repo", "tasks": [/* ... */] }

`engine.evals.run` produces a baseline-vs-harness report card: a direct frontier session
(no harness, no wiki) solves each task alongside the full orchestrate loop, both scored
by the same oracle (the repo's own test suite). The report card carries three verdicts:

- **pass**: the harness held quality on all clean tasks (no measurement failures), saved
  cost, and the sample size is ≥5 tasks (a credible claim wants 20–50). Manifest flips to
  verified. This is the only report that ships as a savings win.
- **fail**: the harness *degraded* quality below baseline on the clean subset — a genuine
  ETH hazard (generated context can hurt). Flagged and never shipped, regardless of cost.
  This check deliberately ignores the sample-size minimum below: a quality regression is
  worth flagging even on a small run, since it only ever blocks a claim, never inflates one.
- **inconclusive**: one of: (1) too few tasks (<5 is a demo, not a claim); (2) unpriced
  cost figures (an unknown model or no cost data → no savings number → no claim);
  (3) baseline solved zero tasks (nothing to hold quality against);
  (4) ≥20% of tasks hit measurement failures (infra hiccups, apply mismatches — the run
  is too corrupted to ground a verdict in either direction).

**Cost figures are estimate-class** — computed from the pricing table and reported token
usage, not a billed amount. Treat as directional. They carry a `pricingConfidence` field
(worst across the run; see `packages/engine/src/models/meter.ts`): `verified` (from the
provider's API), `provider-reported` (official docs), `secondary` (research), `unverified`
(guess), or `unpriced` (unknown model). A single unpriced call taints the savings claim
to `inconclusive`.

**Sample size guidance** (Anthropic evaluation practice): 20–50 paired tasks make a
credible claim. A v1 CI smoke run uses synthetic fixture tasks (mechanics verification);
a real claim requires the operator smoke (`OPENFUSION_EVALS_SMOKE=1 pnpm test`) over
repo-mined golden tasks (commits adding code without tests, or tests verifying a bug fix).

**Two documented residual biases** (both directions, so numbers are read honestly):

1. **Against the harness**: eval harness runs execute WITHOUT the wiki MCP server
   attached — the symbol-index SQLite db isn't copied into the eval directory. So the
   measured harness is a conservatively degraded variant; it lacks a tool that deployed
   instances would have. This biases against.
2. **Toward the harness** (golden tasks only): golden-task wiki bundles are generated at
   the real project's current HEAD, which for a golden task is at or after the fix commit.
   The bundle can already describe the post-fix world — answer-adjacent context the
   baseline never sees. This biases toward on golden tasks specifically.

Net: treat v1 savings numbers as directional, not precise. A "pass" run
(quality held, savings > 0, 20+ tasks) understates what a deployment with the wiki MCP
server would measure; a synthetic-task run is a mechanics proof, not a credibility claim.

**Eval integrity** against an adversarial worker (one that could `git fetch` the parent
repo for the answer) relies on the worker sandbox, whose full process isolation is
deferred to M7. v1 assumes non-adversarial workers; both baseline and harness scratch
directories are placed under `os.tmpdir()`, isolated from the project directory.

`engine.orchestrate` requires a generated harness (`engine.harness.generate`
first) and drives one task through the full pipeline:

1. **Classify** — a keyword heuristic (no model call) maps the free-text task
   onto one of the harness's `routing.yaml` task classes (tests, docs,
   refactor, fix, codegen, …), falling back to `routing.defaults.agent` when
   nothing matches.
2. **Route** — the classified task resolves to a specialist agent and either
   a concrete `(providerId, model)` pair or the sentinel `"frontier"`,
   per that agent's `routing.yaml` entry.
3. **Worker** — for a model resolution, `engine.worker.run` creates a fresh,
   isolated git worktree (`WorktreeManager`, under
   `.openfusion/worktrees/`), runs the open model through a minimal
   bash/read/write/edit tool loop scoped to that worktree, and returns a
   diff plus a summary.
4. **Frontier review** — a read-only frontier session (no write access) is
   handed the task, the worker's summary, and the diff, and returns a
   structured verdict: `approve`, or `request-changes` with specific reasons
   and a severity.
5. **Retry once, then escalate** — a rejected or empty-diff worker attempt
   has its worktree cleaned up and gets one more try (up to
   `routing.escalation.failuresBeforeFrontier`, default 2 attempts total).
   If every worker attempt fails, or routing resolved straight to
   `"frontier"`, the task is escalated: a write-scoped frontier session
   (tool access limited to a fresh worktree) does the task directly.
6. **Apply** — `engine.orchestrate` never touches the base repo's working
   tree itself; it only returns a diff (worker-approved or escalated) for
   the caller to inspect. `engine.orchestrate.apply` is the only method that
   writes to the base tree, and it does so via `git apply --3way` against a
   diff the caller has already reviewed — **it never commits and never
   merges**; the applied change is left staged/working for a human (or the
   shell's approval gate) to commit.

Caveats:

- **Cost is estimate-class.** `engine.orchestrate`'s `cost.workerUsd` /
  `frontierUsd` / `totalUsd` (tagged `note: "estimate-class"`) are computed
  from the pricing table (`packages/engine/src/models/pricing.ts`) applied to
  reported token usage — not a billed amount. Treat them as directional
  savings signal, not an invoice.
- **The harness is UNVERIFIED until M6.** Orchestration routes and prompts
  using whatever harness `engine.harness.generate` produced; until the eval
  gate (`manifest.verification.evals === "pass"`) lands, treat routing
  decisions and specialist prompts as unproven, same as the harness itself
  (see above).
- **Diff-apply, never merge.** No method in this loop runs `git commit` or
  `git merge`/`git checkout` against the base repo on the caller's behalf —
  `engine.orchestrate.apply`'s `git apply --3way` is the only base-tree
  write, and it's inert until a caller explicitly calls it with a diff
  they've reviewed.

### Worktree lifecycle

Worker and escalation worktrees are not always cleaned up automatically:
`engine.worker.run` deliberately leaves BOTH successful and failed worktrees
on disk (so partial work is never silently destroyed — see
`packages/engine/src/worker/worktree.ts`); `engine.orchestrate` cleans up
only the worktrees for its OWN rejected or empty-diff attempts as it goes,
and deliberately leaves the surviving approved/escalated worktree in place
for `engine.orchestrate.apply` to read the diff from. That leaves one gap: a
worktree abandoned by a crash (the engine process killed mid-run, before any
of the above cleanup logic runs) is never swept automatically.
`engine.worker.list` (discovery) and `engine.worker.gc` (sweep, with an
optional `keep` list of paths still legitimately in flight) exist to close
that gap — call `gc` after a session ends, or periodically, to remove
everything this manager knows about except what you explicitly keep. `gc` on
a project with no worker worktrees is a no-op.

## Engine Protocol

The engine exposes its capabilities over stdio via ndjson-encoded JSON-RPC 2.0.
Responses are written in completion order (correlate by request `id`). The
server issues notifications to the client (`frontier.event {sessionId, seq, event}`)
for async events. **Concurrency ownership:** the client is responsible for
bounding in-flight expensive calls (`engine.models.complete`, `engine.frontier.prompt`);
the pipeline itself intentionally carries no cap.

## Desktop app (M7)

`apps/desktop` is a Tauri 2 shell (Rust + system webview) that runs the
engine as a supervised sidecar process and speaks the same stdio JSON-RPC
protocol described above to it — Rust owns the sidecar's lifecycle (spawn on
launch, explicit bounded shutdown on app exit so no engine process is ever
orphaned) and bridges it to the webview via `invoke`/`Channel`. The shell is
deliberately dumb: all intelligence stays in the engine, unchanged.

### The Cockpit UI (M7c)

The shell exposes four cockpit screens:

1. **Project** — discover and index a repo: open a project directory and
   build its wiki (`wiki.build`) with live progress. The eval report card
   (pass/fail/inconclusive, savings %, per-task results) lives on its own
   Evals screen, below — not here.
2. **Keys** — configure frontier engine (Claude Code/Codex) and open-model
   providers (BYOK: Moonshot, Z.ai, DeepSeek, generic OpenAI-compatible);
   all secrets stored in macOS Keychain.
3. **Orchestrate** — the "route → cheap-worker diff → frontier review →
   escalate → apply" loop live. Streams progress, shows routed model, worker
   diff, review verdict, cost breakdown (estimate-class, tagged with
   `pricingConfidence`). Apply button stages the diff (never commits). Cancel
   button calls `engine.cancel({runId})`, rendering "Cancelled" (distinct from
   "Failed") once settled.
4. **Evals** — baseline-vs-harness report card. Runs real evals, displays
   honest verdict (pass green / **fail = ETH-HAZARD: harness degraded quality,
   flagged and never shipped as a win** / inconclusive amber), savings % with
   pricing caveat or "not computable" (never a fake number), per-task results,
   and clean-subset counts. Cancel button with the same runId-based semantics.

**Honesty notes:**
- Displayed savings are **estimate-class** (computed from pricing table +
  reported token usage, not a billed amount) and carry a `pricingConfidence`
  caveat (verified/provider-reported/secondary/unverified/unpriced). An unpriced
  model taints the entire run to "inconclusive," never inflating a savings claim.
- An **ETH-HAZARD "fail" verdict** means the harness produced WORSE quality than
  the baseline on the clean subset — a genuine risk, flagged in the UI and never
  shipped as a savings win, regardless of cost.
- **Cancel semantics:** every long-running call mints a UUID `runId` and cancels
  via `engine.cancel({runId})` — the true stop mechanism on the engine side.
  The app never uses a per-call timeout on long runs (a timeout would abandon
  the promise while the run continues on the engine). Cancelled is a distinct
  state from Failed.

**CSP:** The app runs under a strict, local-only Content-Security-Policy
(production mode). It permits scripts and styles only from the bundled code
(no inline scripts/styles, no external CDNs), and network connections only to
`ipc:` (Tauri's IPC) and `http://ipc.localhost` (the engine sidecar). A dev-only
relaxation allows `ws://localhost:*` for the dev server. CSP correctness is
verified as an operator smoke: a running `tauri build` app with no console
CSP violation logs confirms the policy is live.

See `apps/desktop/README.md` for the architecture, how to build/stage the
sidecar and run `tauri dev`, the four cockpit screens in detail, and the
day-to-day (unsigned) operator smoke checklist. Packaging a distributable,
signed and notarized `.dmg` is M8 scope — see the next section.

## Distribution: building a signed DMG (M8)

OpenFusion is signed-DMG-buildable: `apps/desktop/BUILDING.md` is the
complete operator runbook for producing a `.dmg` that installs on a clean
Mac with no Gatekeeper right-click dance. That document covers prerequisites
(an Apple Developer account, a Developer ID Application certificate,
notarization credentials), the exact environment variables, the build
sequence (`build:sidecar` → `stage-sidecar` → `tauri build`, which
auto-signs the sidecar's native addon via a `beforeBundleCommand` and
notarizes the `.app` inline → `notarize-staple-dmg.mjs` to staple the
`.dmg` itself), verification steps, the JIT-entitlement empirical check,
and notarization troubleshooting.

**This step requires the operator's own Apple Developer credentials** —
nothing in this repository holds or can supply a signing certificate or
notarization credentials, so a signed artifact has never been produced in
this development environment or in CI. The signing pipeline itself
(sidecar asset resolution, packaged-path dispatch, the presign/notarize
scripts) is fully built and tested; running it against a real certificate
is the one remaining, credential-gated step before a public release.

### Before you trust / ship this: the consolidated operator smoke checklist

Everything below requires a display, live credentials, or both — none of it
runs in CI. Work through it in order before trusting a build enough to ship:

**1. The five engine operator smokes** (each env-gated, skipped in CI;
run from the repo root):

| # | Milestone | Command | Proves |
|---|---|---|---|
| 1 | M3 — frontier session | `OPENFUSION_CLAUDE_SMOKE=1 pnpm --filter @openfusion/engine test -- frontier-claude-smoke` | A real embedded `claude` session answers a repo question via the wiki MCP tools (needs `claude` logged in). |
| 2 | M4 — harness generation | `OPENFUSION_CLAUDE_SMOKE=1 pnpm --filter @openfusion/engine test -- harness-generate-smoke` | A real frontier session generates a valid, committable `.openfusion/` harness for this repo (needs `claude` logged in). |
| 3 | M5a — worker run | `OPENFUSION_WORKER_SMOKE=1 pnpm --filter @openfusion/engine test -- worker-run-smoke` | A real open model writes a file inside an isolated git worktree (needs a real open-model provider key). |
| 4 | M5b — orchestrate | `OPENFUSION_ORCHESTRATE_SMOKE=1 pnpm --filter @openfusion/engine test -- orchestrate-smoke` | The full route → worker → frontier-review loop end to end, both backends real (needs an open-model key + `claude` logged in). |
| 5 | M6 — evals | `OPENFUSION_EVALS_SMOKE=1 pnpm --filter @openfusion/engine test -- evals-run-smoke` | **The first real savings number**: a baseline-vs-harness report card over golden tasks mined from this repo's own commits (needs an open-model key + `claude` logged in). |

**2. The desktop cockpit batch** (see `apps/desktop/README.md`'s "OPERATOR
SMOKES" section for full detail):

- `tauri dev` (or a built app) launches: window titled "OpenFusion",
  1024×720, no console errors.
- Project screen: build the wiki for a real repo, live progress renders.
- Keys screen: enter a BYOK provider key, relaunch the app, confirm it
  persisted (Keychain-backed, not re-entered).
- Orchestrate screen: route → worker diff → frontier review → apply,
  **and** mid-run Cancel renders "Cancelled" (not "Failed").
- Evals screen: a real eval run renders an honest verdict, a savings % with
  its `pricingConfidence` caveat (or "not computable"), and per-task rows.
- CSP: DevTools console shows **no** CSP violation messages while the app
  runs normally.
- Quit the app; confirm no orphaned engine process
  (`ps aux | grep openfusion-engine`).

**3. The signed-DMG verification** (`apps/desktop/BUILDING.md` §5, after
running the build sequence there):

- `spctl -a -vvv -t install <App>.app` → accepted, notarized.
- `codesign -dvvv --entitlements - <App>.app` → hardened runtime on,
  entitlements match `Entitlements.plist`.
- `stapler validate <App>.dmg` → validates.
- Install on a **clean Mac / fresh user account** → launches directly, no
  right-click-to-open dance.
- A real orchestration + a real eval run inside that signed, notarized
  build (not just a dev build).
- No console CSP violations; no orphaned engine process on quit.
- **JIT empirical check:** if (and only if) the app crashes on launch post-
  notarization, uncomment `allow-jit`/`allow-unsigned-executable-memory` in
  `Entitlements.plist` and rebuild from scratch.

## Development

Requires Node >= 22 and pnpm (via corepack).

    corepack enable
    pnpm install
    pnpm build
    pnpm test

## License

Apache-2.0
