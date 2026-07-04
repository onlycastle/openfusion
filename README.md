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
  cost, and the sample size (20–50 tasks) supports a credible claim. Manifest flips to
  verified. This is the only report that ships as a savings win.
- **fail**: the harness *degraded* quality below baseline on the clean subset — a genuine
  ETH hazard (generated context can hurt). Flagged and never shipped, regardless of cost.
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

## Development

Requires Node >= 22 and pnpm (via corepack).

    corepack enable
    pnpm install
    pnpm build
    pnpm test

## License

Apache-2.0
