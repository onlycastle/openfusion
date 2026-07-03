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

## 6. Eval Loop

After generation (and after major refreshes), run micro-evals
baseline-vs-harness. A harness that degrades quality is flagged, not
silently deployed. The Harness editor exists because human-corrected context
demonstrably outperforms purely generated context. GEPA-style automated
harness optimization is explicitly deferred past v1.

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
- Shell: minimal tests (dumb by design).

## 10. Repo & Distribution

- Monorepo: `apps/desktop` (Tauri), `packages/engine`, `packages/shared`;
  pnpm workspaces + cargo.
- CI/CD: GitHub Actions; tauri-action builds; Developer ID signing +
  notarytool (requires Apple Developer account, $99/yr — the only mandatory
  paid dependency); DMG artifacts on GitHub Releases; auto-update; Homebrew
  cask as second channel.
- Naming: "openfusion" collides with an existing well-known GitHub project
  (FusionFall server emulator). Working name stays; public name chosen at
  repo-publication time.

## 11. v1 Scope Cuts (explicitly OUT)

Windows/Linux; Gemini/goose engine adapters (interface ready, adapters
later); GEPA-style harness auto-optimization; team/cloud sync; local-model
presets beyond generic OpenAI-compatible; harness marketplace/sharing; any
built-in editor.

## 12. Key Risks

1. **Generated context can hurt** (ETH result: worse in 5/8 settings).
   Mitigation: eval gate before trust + human-editable harness.
2. **First-party blast radius** — thin wrapper apps died in 2025–26.
   Mitigation: the IP is the generation engine + eval loop, not the shell;
   engine-agnostic frontier interface (ACP-shaped).
3. **Engine protocol churn** (Claude Agent SDK / Codex app-server are moving
   targets). Mitigation: adapters isolated in `engines/`; version-pinned;
   integration tests per adapter.
4. **Routing quality** — bad routing erases savings via rework. Mitigation:
   conservative default classes, escalation after 2 failures, cost meter
   makes regressions visible immediately.

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
