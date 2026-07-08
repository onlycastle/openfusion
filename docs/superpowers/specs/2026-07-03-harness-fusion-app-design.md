# Design: OpenFusion (working name) — Per-Project Harness Fusion Desktop App

**Date:** 2026-07-03
**Status:** Approved design, pre-implementation
**License:** Apache-2.0
**Distribution:** macOS .dmg (signed + notarized), Homebrew cask secondary

## 1. Problem & Thesis

Frontier-model coding agents are excellent but expensive; open-weight models
(Kimi K2.6/K2.7, GLM-5.2, DeepSeek V4, Qwen3-Coder-Next) now match
mid-frontier quality at 10–30× lower blended cost. Raw APIs ship no harness —
the system prompt, tools, context strategy, and routing that make a model
productive on a *specific* project. Today, multi-model splits exist only as
hand-written static config, and no tool generates a project-dedicated harness
from deep repo analysis (see research appendix / docs/research/).

**Thesis (Harness Fusion):** analyze a project once with a frontier model,
generate a dedicated harness — an LLM wiki, specialist agents, and a routing
policy — then run day-to-day work with frontier orchestration (flat-rate
subscription) and open-model workers (cheap API tokens), verified by per-repo
evals.

## 2. Goals & Success Criteria

- **Primary metric: cost at held quality.** Target ≥50–70% token-cost
  reduction vs frontier-only, with task success within a few percent.
  Frontier review of worker output is the quality backstop.
- A user can: open a project folder → get a generated harness with an eval
  report card → chat with the orchestrator → watch workers execute → review
  diffs → see live cost savings vs an all-frontier counterfactual.
- Open source (Apache-2.0), shipped as a signed macOS DMG.

## 3. Locked Decisions (from brainstorming, 2026-07-03)

| Decision | Choice |
|---|---|
| Product shape | Standalone runtime (app owns the agent loop), not a config generator for other runtimes |
| UX model | Project workspace app ("cockpit"): open folder → understand → chat/monitor/review. Not an IDE. |
| Frontier access | Embed official engines — Claude Code via Agent SDK, Codex CLI via app-server protocol — under the user's subscription OAuth. No third-party consumer-OAuth client (ToS). |
| Open-model access | BYOK: first-class presets for Moonshot, Z.ai, DeepSeek, Qwen + generic OpenAI-compatible endpoint (covers OpenRouter, LiteLLM, Ollama/local). |
| Routing default | Aggressive offload to open models; frontier review gate; escalate to frontier after 2 failed attempts. |
| Shell architecture | Tauri 2 (Rust shell) + Node/TypeScript engine sidecar over local JSON-RPC. |
| Harness storage | In-repo `.openfusion/` directory — committable, diffable, portable. |
| Eval stance | Generation must be verified by repo-derived micro-evals before trust (defense against the ETH "generated context hurts" result). v1 verifies; it does not auto-optimize. |

## 4. Architecture

### 4.1 Processes

```
┌────────────────────────────┐        ┌─────────────────────────────────┐
│ Shell — Tauri 2            │  JSON- │ Engine — Node/TypeScript sidecar│
│ (Rust + React/TS webview)  │  RPC   │  engines/  models/  wiki/       │
│ windows, cockpit UI,       │◄──────►│  harnessgen/  orchestrator/     │
│ Keychain, dialogs,         │        │  evals/  store(SQLite)          │
│ auto-update, sidecar       │        │  + in-engine MCP server (wiki)  │
│ supervision                │        └───────┬─────────────┬───────────┘
└────────────────────────────┘                │             │
                                     frontier engines   open-model APIs
                                     (Claude Code SDK,  (AI SDK: Moonshot,
                                      Codex app-server)  Z.ai, DeepSeek,
                                                          OpenAI-compatible)
```

The shell is deliberately dumb. The engine holds all intelligence and is
designed to run standalone (future CLI distribution falls out for free).

### 4.2 Engine modules

- **`engines/`** — frontier adapters behind one `FrontierEngine` interface
  shaped like ACP (Agent Client Protocol). v1 adapters: Claude Code (Agent
  SDK, TS, in-process; SDK owns subscription OAuth) and Codex CLI
  (app-server protocol). Later: Gemini CLI, goose, any ACP agent.
- **`models/`** — open-model worker access via the Vercel AI SDK (distinct
  from the Claude Agent SDK used in `engines/`). Provider presets +
  generic OpenAI-compatible endpoints. Owns the pricing table and per-call
  cost metering.
- **`wiki/`** — LLM wiki builder and server. Symbol layer: tree-sitter
  defs/refs graph + Aider-style repo map (personalized PageRank, token-
  budgeted). Prose layer: frontier-written pages (architecture, subsystems,
  conventions, build/test how-to) each with a token-budgeted agent digest.
  Incremental refresh keyed on git SHA watermark. Served to all agents via
  in-engine MCP server.
- **`harnessgen/`** — the understanding phase. Drives the frontier engine
  through repo exploration; emits `.openfusion/` artifacts; triggers eval
  smoke pass; produces the report card.
- **`orchestrator/`** — session runtime. Decomposition, task classification,
  worker dispatch per routing policy, review gates, escalation, worktree
  management for parallel workers.
- **`evals/`** — repo-derived micro-evals: build passes, existing test
  subsets, golden tasks reconstructed from recent commits. Baseline-vs-
  harness comparison; report card; re-run on demand and after major
  refreshes.
- **`store/`** — SQLite for sessions, tasks, costs, eval history. Secrets
  live only in macOS Keychain (via shell), never in SQLite, config, or logs.

### 4.3 Harness artifacts (in-repo)

```
.openfusion/
  manifest.json      # schema version, generator version, git SHA watermark
  wiki/              # prose pages + agent digests; symbol index sidecar
  agents/            # specialist defs: role, prompt, tools, model, escalation
  routing.yaml       # task-class → model map, cost policy, thresholds
  evals/             # micro-eval tasks + baseline results
```

Agent definitions use a neutral YAML/MD format. **Exporters** emit Claude
Code subagents, AGENTS.md, and opencode configs so a generated harness is
useful even without the app (OSS adoption lever).

## 5. Runtime Data Flow

1. User chats with the orchestrator (frontier engine session, wiki MCP
   attached — planning starts from pre-digested knowledge).
2. Orchestrator produces a task plan; each task carries a task class
   (codegen, docs, tests, search, refactor…). Engine assigns models per
   `routing.yaml` — open models by default.
3. Workers execute with a deliberately minimal loop (mini-swe-agent
   precedent: minimal beats baroque): specialist prompt + wiki digest +
   bash/edit tools on an open model. Parallel workers get isolated git
   worktrees.
4. Review gate: worker diffs go to the frontier orchestrator for review.
   Fail review or tests twice → escalate the task to the frontier model.
5. User approval gate: diffs presented in UI; nothing lands in the working
   tree without approval (per-project auto-apply configurable later).
6. Cost meter logs every call against the pricing table; UI shows running
   savings vs an all-frontier counterfactual.

**Realized in the engine (M5b):** `engine.orchestrate` implements steps 2–4
headlessly — classify (keyword heuristic over `routing.yaml`) → route (agent
+ model resolution) → open-model worker (isolated git worktree) → read-only
frontier review (structured approve/request-changes verdict) → retry once →
escalate to a write-scoped frontier session. `engine.orchestrate.apply`
implements step 5's mechanics (`git apply --3way`, no commit/merge); the
actual UI approval gate itself is still a shell concern (M7). Step 6's cost
meter exists (`engine.models.usage`, `bySource`) and `engine.orchestrate`
reports its own worker/frontier split, tagged `estimate-class` — see
README's "How the loop works" for the full flow and its caveats.
`engine.worker.list`/`engine.worker.gc` close the worktree-lifecycle gap step
4's isolation implies but doesn't fully resolve: orchestrate cleans up its
own rejected attempts and leaves the surviving worktree for apply, but a
crash mid-run needs an explicit sweep.

**Realized in the shell (M7a):** the §4.1 process diagram's "shell ↔ engine
JSON-RPC" link is now a real, tested Rust backbone, not just a design —
`apps/desktop/src-tauri/src/engine_bridge.rs` owns the engine sidecar's
`tokio::process::Child` directly (a bare `PathBuf` in, so it's unit-testable
against mock sidecars with zero Tauri runtime bootstrap), speaking
ndjson-encoded JSON-RPC 2.0 over its piped stdio exactly as §9 below
describes; `commands.rs` exposes `engine_call` (generic passthrough) and
`engine_events` (notification pump onto a webview `Channel`) as the two
Tauri commands the webview talks to; `lib.rs` spawns the bridge in
`.setup()` and drives its clean, bounded shutdown from `RunEvent::ExitRequested`
so the sidecar is never orphaned on app exit (see §9 and
`apps/desktop/README.md`'s "Lifecycle" section for why that specific hook,
not `kill_on_drop` or a window-close handler, is the one that's load-bearing).
This is still backbone only: the actual cockpit UI (chat, task tree, worker
cards, diff review, cost meter) is M7b; today's webview is a single proof
screen that calls `engine.models.list` end to end.

**Realized in the shell (M7c):** the four cockpit screens are now live, each
with its own responsibility: **Project** (repo discovery and wiki
construction only — `wiki.build` live progress streamed via
`wiki.build.progress` notifications; no eval references); **Keys** (frontier
+ open-model provider configuration, secrets Keychain-backed); **Orchestrate**
(the "route → cheap-worker diff → frontier review → escalate → apply" loop
end to end, streaming `orchestrate.progress` notifications with runId);
**Evals** (the eval report card lives here, and only here: baseline-vs-harness
comparison, streaming `evals.progress`, displaying honest verdict—pass/ETH-HAZARD
fail/inconclusive, savings % with pricingConfidence caveat or "not computable,"
per-task results, clean-subset counts). Both Orchestrate and Evals screens
support **cancellation:** the app mints a UUID `runId` for every long-running
call and cancels via `engine.cancel({runId})` (no per-call timeout;
cancellation is a distinct state from failure). The engine now emits
`orchestrate.progress` and `evals.progress` carrying runId + detail;
`wiki.build` was updated to emit progress notifications. Eval report card
gained structured clean-subset fields (cleanTaskCount, cleanBaselinePassed,
cleanHarnessPassed, cleanSavingsPct, measurementFailureCount). `CancelRegistry`
rejects duplicate active runIds. CSP is tightened (strict local-only for
production, dev-only relaxation for HMR); CSP correctness is an operator
smoke (verified on a running app built with `tauri build`).

## 6. Eval Loop

After generation (and after major refreshes), run micro-evals baseline-vs-harness.
The loop (realized in M6; the verdict math hardened by M6.1 — see
`docs/research/2026-07-07-harness-composition.md` §4 for the corrections below) works
as follows:

1. Per task, create two isolated scratch directories seeded via the task's own
   setup() method (at the pre-change state — golden tasks mined from repo history,
   or synthetic fixtures for CI smoke).
2. **Baseline:** open a direct frontier session with no wiki and no harness routing,
   write-scoped to one directory. Let it solve the task directly. Oracle-score the result.
3. **Harness:** run the full `engine.orchestrate` loop (classify → route → worker attempts →
   review → escalate) against the second directory, which has the harness bundle copied
   in but otherwise starts from the same pre-change state. Apply the returned diff and
   oracle-score the result.
4. Compare pass/fail counts and costs (both routes work each task from identical base
   state, scored by identical oracle). The verdict is **two-dimensional** — quality AND
   cost (research §0/§4.3): a harness that holds quality but costs materially more than
   baseline is an ETH failure, not a neutral result — and **significance-aware**: a
   within-noise quality gap is not treated as a regression (research §3.3, single-run
   pass@1 std >1.5pp even at temperature 0).
   - **pass** if quality held on the clean subset (or the gap is within a 5-percentage-
     point single-run noise band), savings > 0, priced, and sample size ≥ 20 tasks
     (credible: 20–50) — the savings-PASS floor; manifest flips to verified.
   - **fail** on either of two ETH hazards: (a) *quality hazard* — harness *degraded*
     quality on the clean subset beyond the noise band (no measurement failures); this
     check deliberately ignores any sample-size floor — a quality regression is worth
     flagging even on a small run, since it only ever blocks a claim, never inflates one;
     (b) *cost hazard* — quality held (or within noise) but the harness cost ≥10% MORE
     than baseline on the clean subset, at ≥5 tasks — the hazard-flag floor (research
     §4.2), deliberately lower than the savings-PASS floor since a harm signal should be
     flagged readily.
   - **inconclusive** if too few tasks for a pass (<20 — a hazard can still fire below
     that), unpriced, baseline solved zero, or ≥20% measurement failures (infra hiccups,
     apply mismatches — run too corrupted for "pass" or "fail").
5. Cost figures are estimate-class (directional) and carry `pricingConfidence` (worst
   across the run); an unpriced model taints to inconclusive.

Known residual biases (documented, not corrected in v1): eval harness runs lack the wiki
MCP server (biases against), and golden-task bundles are generated at HEAD (biases toward
on those tasks only). Eval integrity assumes non-adversarial workers; full process
sandboxing deferred to M7.

A harness that degrades quality is flagged, not silently deployed. The Harness editor
exists because human-corrected context demonstrably outperforms purely generated context.
GEPA-style automated harness optimization is explicitly deferred past v1.

## 7. UX Surfaces (five screens)

1. **Onboarding** — connect Claude Code / Codex logins (their own OAuth
   flows), paste open-model keys (→ Keychain).
2. **Understanding** — live progress of harness generation; ends in the eval
   report card.
3. **Cockpit** — chat + task tree + live worker cards + diff review + cost
   meter.
4. **Harness editor** — browse/edit wiki pages, agents, routing.
5. **Settings** — providers, routing defaults, approval policy.

## 8. Error Handling

- Engine crash → shell restarts sidecar; sessions resume from SQLite.
- Provider outage → per-model fallback chain (e.g., Moonshot direct →
  OpenRouter).
- Worker failure → retry once, then escalate to frontier.
- Stale wiki → SHA watermark mismatch triggers incremental refresh; never
  silent staleness.
- Secrets: Keychain only; never logged.

## 9. Testing

- Engine: vitest unit tests; integration tests against recorded model-API
  fixtures (no live keys in CI).
- E2E smoke in CI: generate a harness for a small sample repo with a cheap
  model; assert artifacts validate against schema.
- Shell: minimal tests (dumb by design), but the one boundary it does own —
  the sidecar stdio protocol — is tested for real. `apps/desktop/src-tauri`'s
  `EngineBridge` is exercised against genuine child processes (scripted mock
  sidecar binaries under `src/bin/mock_*.rs`, not fakes/mocks-in-process):
  request/response correlation under concurrency, malformed-line resilience,
  notification routing, and child death mid-call all resolve to errors
  rather than hangs. **No-orphan shutdown** is a headless-testable property,
  not just an operator smoke: `tests/lifecycle.rs` spawns a bridge (including
  against a mock that deliberately ignores stdin EOF and never exits on its
  own), drives the same bounded shutdown path the real
  `RunEvent::ExitRequested` handler calls, and asserts — via an external
  `ps -p <pid>` check, not just internal bookkeeping — that the child is
  actually gone from the OS process table afterward, within a bound.
  `kill_on_drop(true)` is a backstop for abnormal termination, not the
  primary mechanism (Tauri's own event loop exits the process via
  `std::process::exit`, which skips Rust destructors, so an *explicit*
  `shutdown()` call is what actually reaps the child on a normal quit — see
  `apps/desktop/README.md`'s "Lifecycle" section).

## 10. Repo & Distribution

- Monorepo: `apps/desktop` (Tauri), `packages/engine`, `packages/shared`;
  pnpm workspaces + cargo.
- CI/CD: GitHub Actions; tauri-action builds; Developer ID signing +
  notarytool (requires Apple Developer account, $99/yr — the only mandatory
  paid dependency); DMG artifacts on GitHub Releases; auto-update; Homebrew
  cask as second channel.
- **Realized (M8): a signed, notarized `.dmg` is buildable today** via the
  operator runbook at `apps/desktop/BUILDING.md` — code-signs the sidecar's
  native addon (the one thing Tauri's bundler never signs itself),
  notarizes + staples both the `.app` and the `.dmg`, and documents the
  clean-Mac verification smokes. This is a **manual, operator-run** build
  requiring the operator's own Developer ID Application certificate and
  notarization credentials (App Store Connect API key or Apple ID +
  app-specific password) — neither this repo nor CI holds or can supply
  them, so no signed artifact has been produced in CI or in development.
  The CI/CD-automated form described above (tauri-action, GitHub Releases,
  auto-update, Homebrew cask) remains future work — see §11.
- Naming: "openfusion" collides with an existing well-known GitHub project
  (FusionFall server emulator). Working name stays; public name chosen at
  repo-publication time.

## 11. v1 Scope Cuts (explicitly OUT)

Windows/Linux; Gemini/goose engine adapters (interface ready, adapters
later); GEPA-style harness auto-optimization; team/cloud sync; local-model
presets beyond generic OpenAI-compatible; harness marketplace/sharing; any
built-in editor. **CI-automated signing/release** is also cut from v1: M8
delivers a manual operator-run signed-DMG build (`apps/desktop/BUILDING.md`)
only — tauri-action CI builds, GitHub Releases artifacts, auto-update, and
a Homebrew cask (§10) all remain future work, deferred until the project is
ready to hold Apple signing credentials in CI.

## 12. Key Risks

1. **Generated context can hurt** — **ETH Zurich + DeepMind**, "Evaluating
   AGENTS.md: Are Repository-Level Context Files Helpful for Coding Agents?"
   (arXiv:2602.11988; corrects an earlier "ETH Zurich/LogicStar" attribution —
   see `docs/research/2026-07-07-harness-composition.md` §4.1): LLM-generated
   context reduced success ~0.5–2% on average, worse in 5 of 8 settings, while
   raising inference cost 20–23%. Mitigation: eval gate before trust +
   human-editable harness.
2. **First-party blast radius** — thin wrapper apps died in 2025–26.
   Mitigation: the IP is the generation engine + eval loop, not the shell;
   engine-agnostic frontier interface (ACP-shaped).
3. **Engine protocol churn** (Claude Agent SDK / Codex app-server are moving
   targets). Mitigation: adapters isolated in `engines/`; version-pinned;
   integration tests per adapter.
4. **Routing quality** — bad routing erases savings via rework. Mitigation:
   conservative default classes, escalation after 2 failures, cost meter
   makes regressions visible immediately.
5. **Subscription-auth ToS** — engine is auth-agnostic by design (M3); distributing
   any claude.ai login flow is prohibited by provider terms. Mitigation:
   revisit before public DMG release (M8) to confirm terms permit embedded
   official CLI usage under user subscription.
6. **v1 orchestrate is single-worker-per-task** — `engine.orchestrate` (M5b)
   runs exactly one worker attempt at a time per task, with no parallel
   decomposition into sub-tasks/sub-worktrees; a task that would benefit from
   fan-out gets none of that benefit in v1. Mitigation: deferred by design —
   the routing/review/escalation plumbing this milestone built is the
   prerequisite for a later fan-out layer, not a replacement for it.
7. **Review-gate quality bounds the cost-savings claim** — the whole
   cost-at-held-quality thesis depends on the frontier review gate actually
   catching worker mistakes; a review gate that rubber-stamps bad diffs
   converts "cheaper" into "cheaper AND worse," which the cost meter alone
   cannot detect (it prices calls, not correctness). Mitigation: the M6 eval
   loop (baseline-vs-harness report card) is the first point this gets
   measured rather than assumed; until then, review-gate quality — and by
   extension the savings claim — is UNVERIFIED, same status as the harness
   itself.
8. **v1 savings numbers are estimate-class and bounded by pricing confidence.**
   Cost figures are computed from the pricing table and reported token usage,
   not a billed amount; they are directional, not precise. The `pricingConfidence`
   field (verified/provider-reported/secondary/unverified/unpriced — worst across
   the run) taints the savings claim: an unpriced model → no savings number → inconclusive
   verdict. **The gate is two-dimensional** (M6.1 —
   `docs/research/2026-07-07-harness-composition.md` §0/§4.3): a harness that holds
   quality but costs ≥10% more than baseline on the clean subset is flagged as a fail,
   not reported as neutral. **Task-count floors are split** (§4.2): the quality hazard
   has no floor at all and the cost hazard fires at ≥5 tasks (a harm signal is flagged
   readily), while a savings *pass* needs ≥20 paired tasks (credible: 20–50) — v1 CI uses
   synthetic fixtures for mechanics; an operator smoke over ≥20 golden tasks verifies a
   real project.
   Documented residual biases (both directions): eval harness runs lack wiki MCP
   server (biases against), and golden-task bundles generated at HEAD (biases toward
   on those tasks). Treat v1 savings as directional; a measured "pass" understates
   what a deployment with full wiki access would measure.
9. **v1 golden-task construction requires fail-to-pass on a pre-existing test.**
   Golden tasks are commits mined from repo history (a bugfix or feature that added
   code); the task is "make the tests pass" — oracle is the pre-existing test that
   was failing before the commit, now passing after. Commits that added both code
   and tests together are explicitly out of v1 scope (would require synthesizing a
   new oracle after the fact, not reusing a pre-existing one); such commits
   contribute only synthetic fixture tasks, not golden ones.
10. **Eval integrity against an adversarial worker is deferred to M7.**
    Full process-level sandbox (preventing raw filesystem reads or git-fetching the
    parent repo) is required to defend against a worker deliberately trying to reach
    outside its scratch directory. v1 assumes a non-adversarial worker and places eval
    scratch directories under `os.tmpdir()`, isolated from the project being evaluated
    but not defended against deliberate escape.

## Appendix: Research Summary

Full landscape survey: `docs/research/2026-07-03-oss-landscape.md`.
Headlines: the repo-analysis→generated-multi-model-harness combination does
not exist in OSS today; closest projects are revfactory/harness (team
generation from domain description, Claude-only), Conductor (closest product
shape, proprietary, no generation), and deepwiki-open/OpenDeepWiki (wiki
pillar only, one-shot or heavyweight). Reusable substrate: ACP, Claude Agent
SDK, Vercel AI SDK, tree-sitter, CocoIndex patterns, tauri-action pipeline. Open-model
economics support the 50–70% savings target (frontier ≈ 10–30× blended cost
of top open coders).
