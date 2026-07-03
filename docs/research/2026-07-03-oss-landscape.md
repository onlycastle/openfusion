# Open-Source Landscape Survey — Per-Repo Multi-Model Harness Generator (July 2026)

**Method**: 5 parallel research agents (one per area), 180+ web searches and fetches; GitHub stars/licenses/activity verified via the GitHub API on 2026-07-03; Anthropic pricing verified against the current model catalog; other pricing verified against official pages and OpenRouter where possible. Anything not verifiable as current is flagged.

---

## 1. Model routing / multi-model fusion in coding agents

### Routing infrastructure (picks one model per request; no task decomposition)

| Project | Repo / URL | License | Stars | Status (2026-07) | Notes |
|---|---|---|---|---|---|
| **claude-code-router** | https://github.com/musistudio/claude-code-router | MIT | 35,539 | Very active (v3.0.6, 2026-07-02) | Proxy that intercepts Claude Code's Anthropic-format requests and re-routes by request class: `default`, `background` (cheap models), `think` (reasoning), `longContext`, `webSearch`, `image`; custom JS routing, fallbacks, in-session `/model`. De-facto standard for "Claude Code loop, non-Anthropic models." |
| **LiteLLM** | https://github.com/BerriAI/litellm | MIT (+ commercial `enterprise/`) | 52,487 | Extremely active | 100+-provider gateway; latency/usage/tag-based routing, context-window and content-policy fallbacks, budgets. Capability-agnostic infrastructure. OpenHands V1 SDK builds on it. |
| **OpenRouter** | https://openrouter.ai (closed source) | — | — | Active | Hosted gateway; Auto Router (`openrouter/auto`) powered by NotDiamond with a `cost_quality_tradeoff` knob; provider failover; no routing surcharge. |
| **RouteLLM** | https://github.com/lm-sys/RouteLLM | Apache-2.0 | 5,130 | **Frozen — no commits since 2024-08** | Trained strong/weak binary routers (ICLR 2025, arXiv:2406.18665; 85% cost cut at 95% GPT-4 quality). Library dead; ideas live on. |
| **Plano (ex-archgw)** / Arch-Router | https://github.com/katanemo/plano | Apache-2.0 | 6,609 | Active (v0.4.26, 2026-06-25) | 1.5B preference-aligned router (arXiv:2506.16655) mapping queries to user-defined policies, shipped in a gateway. |
| Commercial routers | NotDiamond, Martian (RouterBench), Unify.ai, Requesty, Azure Foundry "model router" (GA; claims up to 60% savings), IBM watsonx gateway | — | — | Operating mid-2026 | Per-prompt learned routing as a product category. |

### Coding agents with first-class "big model plans / cheap model executes"

| Project | Repo | License | Stars | Status | Mechanism |
|---|---|---|---|---|---|
| **Aider** (architect/editor) | https://github.com/Aider-AI/aider | Apache-2.0 | 46,980 | **Semi-dormant** (last release 2025-08; last commit 2026-05) | The originator (Sept 2024): architect model describes the change, `--editor-model` turns it into edits; launch benchmark had o1-preview + DeepSeek editor at 85%. |
| **goose** | https://github.com/aaif-goose/goose (Linux Foundation AAIF) | Apache-2.0 | 50,596 | Very active (v1.41.0, 2026-07-03) | Most explicit lead/worker implementation: `GOOSE_LEAD_MODEL` drives first N turns, worker executes, auto-fallback to lead on repeated worker failure; separate planner model for `/plan`. |
| **opencode** | https://github.com/anomalyco/opencode (ex sst/opencode) | MIT | 181,876 | Very active | Per-agent `model` in `opencode.json` / agent markdown frontmatter, plus global `small_model` for lightweight tasks. Largest repo in the space. |
| **Kilo Code** | https://github.com/Kilo-Org/kilocode | MIT | 25,450 | Active | "Model per Mode/Agent," subagents inherit per-mode models, June 2026 "Auto Model" picks a model per subtask by task type and budget tier. |
| **Roo Code** | https://github.com/RooCodeInc/Roo-Code | Apache-2.0 | 24,300 | **ARCHIVED 2026-05-15** | Had the richest per-mode model story (Orchestrator/Boomerang tasks + per-mode API profiles); team pivoted to Roomote. |
| **Cline** | https://github.com/cline/cline | Apache-2.0 | 64,235 | Very active | Plan & Act modes with separate models per mode (auto-switch on toggle). Two-mode only. |
| **Crush** | https://github.com/charmbracelet/crush | FSL-1.1-MIT | 26,000 | Active | Fixed two-tier: "large" coder model + "small" model for search/summarization/compaction. |
| **Continue** | https://github.com/continuedev/continue | Apache-2.0 | 34,666 | Active | Role-based models: `chat`/`edit`/`apply`/`autocomplete`/`embed`/`rerank` — "apply" is a cheap model materializing a big model's edit. |
| **OpenHands** | https://github.com/OpenHands/OpenHands | MIT (+ enterprise carve-out) | 79,230 | Very active | Cheap-LLM condenser (history summarization, ~2x cost cut) + LiteLLM-based SDK; no built-in planner/editor split. |
| **Claude Code (first-party)** | code.claude.com/docs/en/model-config | — | — | — | `/model opusplan` (Opus plans, Sonnet executes) and per-subagent `model:` frontmatter — pattern is first-party now, but Anthropic-models-only. |

**Academic line**: FrugalGPT (arXiv:2305.05176, cascades) → RouteLLM (ICLR 2025) → Arch-Router (2025) → 2025-26 cascade/routing theory (arXiv:2410.10347 unified routing+cascading; C3PO; arXiv:2605.06350 "Is Escalation Worth It?"; SeqRoute arXiv:2605.25424; survey arXiv:2502.00409; benchmarks RouterBench/RouterEval/AgentSelect). Industrial: GPT-5's internal real-time router.

**Key takeaway**: every shipping implementation is static config (turn counts, mode bindings, request classes) or per-query classification. Nothing learns or verifies an orchestrator/worker split end-to-end, and nothing generates the split per repo.

---

## 2. Repo knowledge bases / "LLM wikis"

### Wiki generators

| Project | URL | License | Stars | Status | Notes |
|---|---|---|---|---|---|
| **DeepWiki** (Cognition/Devin) | https://deepwiki.com | Closed | — | Active | Canonical implementation; free official MCP server (`mcp.deepwiki.com/mcp`: `ask_question`, `read_wiki_structure`, `read_wiki_contents`); auto-refresh only for badge-bearing repos; private repos require paid Devin. |
| **OpenDeepWiki** | https://github.com/AIDotNet/OpenDeepWiki | MIT | 3,382 | Very active | Self-hosted DeepWiki clone (.NET 10 + Next.js): wiki generation, Mermaid, chat, MCP endpoints, scheduled incremental updates. Closest OSS match, but heavyweight server deployment. |
| **deepwiki-open** | https://github.com/AsyncFuncAI/deepwiki-open | MIT | 17,139 | Moderately active (2026-06) | Most-starred OSS wiki generator; private repos, Ollama-local models, RAG Q&A. **One-shot — no refresh pipeline.** |
| **Google Code Wiki** | https://codewiki.google | Closed | — | Active (launched 2025-11) | Gemini wikis for public repos, auto-regenerated on PR merge; private/local via waitlisted Gemini CLI extension. |
| **CodeWiki** (FSoft-AI4Code) | https://github.com/FSoft-AI4Code/CodeWiki | **No license file** | 1,305 | Active | ACL 2026 paper (arXiv:2510.24428): hierarchical multi-agent doc synthesis + benchmark. |
| deepwiki-rs / "Litho" | https://github.com/sopaco/deepwiki-rs | MIT | 1,323 | Slowing | Rust CLI, C4-model architecture docs "for humans and agents". |

### Indexes / retrieval infrastructure

| Project | URL | License | Stars | Status | Notes |
|---|---|---|---|---|---|
| **Aider repo-map** | https://aider.chat/docs/repomap.html | Apache-2.0 | (in aider) | Low-cadence | Tree-sitter defs/refs graph + personalized PageRank packed into a token budget; disk-cached, incrementally recomputed. Archetype of a cheap auto-maintained index — but session-scoped, aider-only. |
| **repomix** | https://github.com/yamadashy/repomix | MIT | 26,790 | Very active | Repo → single LLM-friendly file (XML/MD/JSON), tree-sitter `--compress`, secretlint, MCP server mode. Snapshot exporter — no persistence or querying. |
| **CocoIndex** | https://github.com/cocoindex-io/cocoindex | Apache-2.0 | 10,583 | Active (v1.0.x) | Rust-core incremental indexing engine (delta recompute → vector DB / knowledge graph); official "self-updating codebase wiki" recipe + AST-aware code MCP server. Best OSS substrate for an auto-refreshed KB; not turnkey. |
| **Serena** | https://github.com/oraios/serena | MIT | 26,041 | Very active | LSP-backed MCP toolkit (40+ languages): `find_symbol`, references, symbolic edits, `serena project index` + per-project onboarding memories in `.serena/memories`. |
| **codebase-memory-mcp** | https://github.com/DeusData/codebase-memory-mcp | MIT | 25,069 | Very active | Tree-sitter knowledge-graph MCP, 158 languages; claims ~99% token reduction vs grep-and-read (arXiv:2603.27277). Breakout 2026 project in the "don't burn tokens re-searching" niche. |
| **claude-context** (Zilliz) | https://github.com/zilliztech/claude-context | MIT | 12,038 | Active | Vector semantic code search MCP. |
| **semble** | https://github.com/MinishLab/semble | MIT | 5,482 | Active daily | Disk-cached index + file watchers for auto-rebuild. |
| **ast-grep** | https://github.com/ast-grep/ast-grep | MIT | 14,903 | Very active | Structural AST search/rewrite CLI (+ experimental MCP, 426 stars). No persistent index. |
| **Sourcebot** | https://github.com/sourcebot-dev/sourcebot | FSL | 3,560 | Active | Self-hosted Zoekt code search + cited NL answers; MCP included. |
| **Zoekt** | https://github.com/sourcegraph/zoekt | Apache-2.0 | 1,747 | Active | Trigram code-search index underlying Sourcegraph. |

### Standards, memory, and commercial context engines

- **AGENTS.md** — https://agents.md (MIT, 22,735 stars; Linux Foundation AAIF since Nov 2025). Read by 28+ tools, in 60k+ repos. Auto-generation exists only as one-shot context files: Claude Code `/init`, opencode `/init`, gemini `/init`; GenerateAgents.md (251 stars, DSPy + git-history anti-pattern mining), @mongez/agent-kit (one canonical AGENTS.md fanned to 9+ agent formats), ruler (2,785 stars, active).
- **llms.txt** — largely a dud outside docs platforms: Ahrefs found 97% of files get zero requests; no major AI crawler officially consumes it; Google's June 2026 guidance says no effect.
- **Sourcegraph Cody** — sunset for Free/Pro 2025-07-23; Enterprise-only. Individuals pivoted to Amp.
- **Commercial per-repo knowledge**: Devin Knowledge + private DeepWiki (most complete realization), Greptile (semantic code graph; "Genius" API $0.45/request; v3 rebuilt on Claude Agent SDK), Unblocked (context MCP GA 2026), Komment, Swimm. mutable.ai Auto Wiki shut down end-2024; nothing open-sourced.
- **Agent memory**: Cline Memory Bank (prompt pattern), ConPort/context-portal (763 stars, stale since 2026-01), Byterover (4,899 stars, license NOASSERTION), mem0 (60,001 stars — conversation memory, orthogonal).

**Key takeaway**: prose wikis are hosted/closed or one-shot/heavyweight OSS; symbol-level indexes are cheap and thriving but carry no architectural narrative. **Auto-refresh (git-diff-incremental) is the rarest property.** An open, local/private, incrementally-refreshed, agent-consumable prose+symbol wiki beside the repo does not exist as a maintained turnkey project.

---

## 3. Harness / agent-config generators

### First-party and static

- Anthropic: `/init` (repo → CLAUDE.md), `/agents` wizard (description → subagent, no repo scan), Skills (anthropics/skills — 157,831 stars), plugins/marketplaces. Primitives, not repo-driven team generation, Claude-only.
- Static collections (no repo analysis): wshobson/agents (37,461 stars, MIT — multi-harness marketplace emitting Claude/gemini/opencode/cursor/codex/copilot artifacts from one source; proves the export layer), VoltAgent/awesome-claude-code-subagents (22,758), hesreallyhim/awesome-claude-code (47,845), davila7/claude-code-templates (28,430 — auto-detects framework but only selects from a catalog), SuperClaude_Framework (23,422), BMAD-METHOD (50,026 — fixed agile team).

### Dynamic generators (the interesting shortlist)

| Project | Repo | License | Stars | Status | What it does |
|---|---|---|---|---|---|
| **revfactory/harness** | https://github.com/revfactory/harness | Apache-2.0 | 8,169 | Active (created 2026-03, pushed 2026-06-10) | **Closest existing project.** Meta-skill: "build a harness for this project" → picks one of six team patterns (Pipeline, Fan-out/Fan-in, Expert Pool, Producer-Reviewer, Supervisor, Hierarchical) → generates `.claude/agents/` + `.claude/skills/` + orchestration templates, 6-phase workflow with validation. **Limits**: driven by domain description more than deep codebase analysis; Claude Code only; no eval loop; a prompt-time skill, not an app. |
| team-configurator | https://github.com/vijaythecoder/awesome-claude-agents | MIT | 4,328 | Stale (2025-10) | Real repo scan (package.json/go.mod) → "AI Team Configuration" mapping into CLAUDE.md — but selects from a static pool. |
| meta-agent | https://github.com/disler/claude-code-hooks-mastery | none | 3,807 | Stale-ish (2026-03) | Subagent that writes subagents from a description. Prompt → agent, not repo → agent. |
| agent-os | https://github.com/buildermethods/agent-os | MIT | 5,002 | Active-ish (2026-05) | Extracts coding standards from your codebase, injects per-task across Claude Code/Cursor. Repo → standards, not agents. |
| Cursor rules generators | built-in `/Generate Cursor Rules`; rulefy (27); vibe-rules (525, stale) | — | — | — | Repo → rules/context files only. |
| opencode | `opencode agent create` | MIT | — | Active | Interactive description → agent markdown; no repo-analysis generation found. |

### Harness optimization and harness science

- **DSPy** (MIT, 35,781 stars) — MIPROv2, `dspy.GEPA`. **GEPA** (MIT, 5,502 stars, ICLR 2026 oral) — reflective prompt evolution; ships a terminal-bench adapter that optimizes the Terminus agent's system prompt (verified in-repo), plus Pydantic AI integration. Claims of Google `adk optimize` and 33-38% SWE-bench lifts are secondary-source only (flagged).
- **AHE** — "Observability-Driven Automatic Evolution of Coding-Agent Harnesses" (arXiv:2604.25850): auto-evolved harnesses took Terminal-Bench 2 from 69.7% → 77.0%, beating hand-built Codex CLI; evolved harnesses transfer across models — they encode general principles, **not per-repo configs**. **HarnessForge** (arXiv:2606.01779): joint harness+policy co-evolution, +12%.
- **Harness matters as much as the model**: "Stop Comparing LLM Agents Without Disclosing the Harness" (arXiv:2605.23950) — up to 15pp scaffold-only swings on SWE-bench Verified (Kimi K2), ~11pp for GPT-5. Counterpoint: minimal beats baroque — Anthropic's SWE-bench post (prompt + bash + edit tool) and **mini-swe-agent** (MIT, 5,552 stars; 100 lines, >74% SWE-bench Verified, adopted by Epoch AI as locked comparison harness). SWE-agent's ACI paper (arXiv:2405.15793). terminal-bench (2,411 stars) frozen; superseded by **harbor** (https://github.com/laude-institute/harbor, 2,892 stars, active).
- **Critical caution**: ETH Zurich/LogicStar, "Evaluating AGENTS.md" (arXiv:2602.11988) — **LLM-generated context files reduced success in 5 of 8 settings** while adding +20-23% inference cost; human-written ones gained ~+4pp. Naive repo → generated config is net negative; generation must be paired with per-repo evals.
- **MCP auto-configuration per repo: fully unclaimed.** No tool analyzes a repo and selects/generates MCP servers.

**Key takeaway**: no OSS tool does deep repo analysis → generated, multi-model, multi-harness agent team. The pieces exist separately: repo analysis (team-configurator, agent-os, `/init`), team generation (revfactory/harness), multi-harness export (wshobson), harness evolution with evals (GEPA/AHE). Nobody has wired them together.

---

## 4. Open-weight coding models and pricing (July 2026)

Verification key: **[V]** verified against official/first-party page this week, **[S]** multiple secondary sources, **[U]** could not verify as current.

### Current strongest open coding models

- **Kimi K2.6** (Moonshot, Apr 2026; Modified MIT): 58.6% SWE-bench Pro (ties GPT-5.5), built for ~12-hour autonomous sessions; official $0.95 in / $0.16 cache-hit / $4.00 out, 262K ctx [V]; **K2.7-Code** (Jun 2026) coding branch on OpenRouter $0.74/$3.50 [V]. No K3 as of mid-June [S].
- **GLM-5.2** (Z.ai, Jun 2026; MIT, weights on HF): ~753B MoE, 1M ctx; self-reported 62.1% SWE-bench Pro (top open) and 81.0 Terminal-Bench 2.1 [S]; API $1.40/$0.26 cached/$4.40 [S], OpenRouter from ~$0.93/$3.00 [V]. The $3/mo GLM Coding Plan died Feb 2026; current tiers ~$18/$72/$160 with promos [S/U].
- **DeepSeek V4** (Apr 2026; MIT, 1M ctx): **V4-Pro** (1.6T/49B active) ~80.6% SWE-bench Verified — frontier-tier — at $0.435/$0.87 with $0.0036 cache hits; **V4-Flash** $0.14/$0.28 with $0.0028 cache hits [V, official]. R2 never shipped; reasoning folded into V4.
- **Qwen3-Coder-Next** (Feb 2026; Apache-2.0): 80B/3B-active, ~71% SWE-bench Verified, OpenRouter ~$0.11/$0.80 [S] — efficiency/local-tier standout. Qwen3-Coder-480B: $0.22/$1.80, 1M ctx [V].
- **MiniMax M2.5** (Feb 2026): 80.2% SWE-bench Verified, OpenRouter $0.12/$0.48 promo (base ~$0.30/$1.20) [V]; M2.7 (Mar 2026) 56.2 SWE-Pro [S]. License caveats reported [U].
- Others: Mistral Devstral 2 (Dec 2025, 72.2% SWE-V, modified MIT) [S]; gpt-oss-120b (Apache-2.0, ~$0.09/$0.45, 2025 price [U]); Grok Code Fast $0.20/$1.50 (closed weights) [V]; Meta effectively out of the open coding race [S/U].

### Frontier comparison (mid-2026)

| Model | $/Mtok in | $/Mtok out | Source |
|---|---|---|---|
| Claude Opus 4.8 | $5.00 ($0.50 cache-hit) | $25.00 | verified |
| Claude Sonnet 5 | $2.00 intro → $3.00 (after 2026-08-31) | $10.00 → $15.00 | verified |
| Claude Haiku 4.5 | $1.00 | $5.00 | verified |
| GPT-5.5 | $5.00 ($0.50 cached) | $30.00 | verified |
| GPT-5.4 / gpt-5.3-codex | $2.50 / $1.75 | $15 / $14 | verified |
| Gemini 3.1 Pro | $2.00 (≤200K) | $12.00 | secondary |

Direction of travel: Anthropic cut Opus to $5/$25; OpenAI raised with GPT-5.5.

### Benchmarks and standings

- SWE-bench Verified is saturated (~80%+ for frontier and top open models) — discriminating benchmarks are now SWE-bench Pro (Scale, standardized harness), Terminal-Bench 2.x, LiveCodeBench, Aider polyglot (aging). Self-reported vs standardized scores differ by 10-15pp — compare within one harness only.
- Net: best open models sit ~3-8 points behind the best frontier model on hard agentic coding and match mid-frontier (GPT-5.5-class) outright.

### Gateways serving open models

OpenRouter (broadest, cheapest blended); Fireworks/Baseten/Together/Cloudflare (day-0 Kimi/GLM/DeepSeek); Cerebras (Kimi K2.6 at ~981 tok/s; Cerebras Code = GLM-4.7 at ~1,000 tok/s); Groq (Kimi line, $1/$3, 200-400 tok/s); DeepInfra (cheapest K2.x); Vercel AI Gateway (failover at list price).

**Cost ratio for the harness thesis**: frontier orchestration runs ~6-8x the cost of top open coders (K2.6/GLM-5.2), ~12-30x DeepSeek V4-Pro, ~35-100x V4-Flash/Qwen3-Coder-Next — call it **10-30x blended**, amplified by caching (DeepSeek cache hits are ~180x cheaper than Anthropic's). Practical worker shortlist: Kimi K2.6/K2.7-Code (quality), GLM-5.2 (quality + 1M ctx), DeepSeek V4 (Pro near-frontier, Flash bulk), Qwen3-Coder-Next (local/edge), MiniMax M2.5 (budget), with frontier reserved for planning and hard-failure escalation.

---

## 5. Desktop apps wrapping coding agents + macOS distribution

### The field (GitHub numbers verified 2026-07-03)

| App | Repo / URL | License | Stars | Stack | Status |
|---|---|---|---|---|---|
| **Conductor** (Melty Labs) | https://www.conductor.build | Proprietary | — | Tauri 2 (CrabNebula distribution, local-first SQLite) | Active; parallel Claude Code/Codex/Cursor/opencode agents, worktree per workspace. The UX benchmark. |
| **AionUi** | https://github.com/iOfficeAI/AionUi | Apache-2.0 | 29,217 | Electron | Very active; 2026 breakout multi-agent "cowork" GUI. |
| **cmux** | https://github.com/manaflow-ai/cmux | custom | 23,483 | Native Swift/AppKit + libghostty, Sparkle | Very active; agent-agnostic terminal-centric manager. |
| **Happy** | https://github.com/slopus/happy | MIT | 22,374 | React Native/Expo | Very active; E2E-encrypted remote control of Claude Code/Codex. |
| **opcode** (ex-Claudia) | https://github.com/winfunc/opcode | AGPL-3.0 | 22,132 | Tauri 2 | Stale since 2025-10. |
| **Gas Town** (Yegge) | https://github.com/gastownhall/gastown | MIT | 16,170 | Go TUI | Very active; multi-agent workspace manager. |
| **CloudCLI** (ex-claudecodeui) | https://github.com/siteboon/claudecodeui | AGPL-3.0 | 12,329 | Web/Node | Active; now multi-agent. |
| **Claude Squad** | https://github.com/smtg-ai/claude-squad | AGPL-3.0 | 8,007 | Go TUI (tmux+worktrees) | Active. |
| **VibeTunnel** | https://github.com/amantus-ai/vibetunnel | MIT | 4,572 | Mac menu-bar + web proxy | Active. |
| **Nimbalyst** (ex-Crystal) | https://github.com/nimbalyst/nimbalyst | MIT | 1,037 (+3,095 crystal) | Electron | Active; worktree-per-session. |
| **Sculptor** (Imbue) | https://github.com/imbue-ai/sculptor | MIT | 192 | Desktop (Python backend) | Active; agents in Docker containers, "Pairing Mode". |
| **opencode desktop** | in-repo `packages/desktop` | MIT | (181,876) | Electron (electron-vite, node-pty, electron-updater) | Official desktop app, macOS/Win/Linux. |

**Churn signal**: Omnara archived 2026-02 ("wrapping the Claude Code CLI became unfeasible"), Terragon shut down 2026-02, Vibe Kanban sunsetting, Crystal deprecated, claude-code-webui archived, opcode stale — squeezed by first-party apps: Anthropic's rebuilt Claude Code desktop (parallel sessions, Apr 2026) + Cowork (Jan 2026); OpenAI's official Codex app. Survivors differentiate by agent-agnosticism, protocol moats, native performance, or sandboxing. **Nothing in the field does repo analysis → generated harness config** — nearest primitives are Sculptor's per-repo containerized environments and Conductor's per-repo setup scripts.

### The integration layer: ACP

**Agent Client Protocol** — https://github.com/agentclientprotocol/agent-client-protocol (Apache-2.0, 3,564 stars, very active; created by Zed). JSON-RPC over stdio; adopted by Zed, the JetBrains suite, Neovim/Emacs plugins, marimo; ~50 agents; official `claude-agent-acp` adapter (2,189 stars) bridges the Claude Agent SDK; Gemini CLI is native. One ACP client implementation gets Claude Code + Gemini CLI + goose + dozens more for free.

### macOS distribution practice (2026)

- Signing/notarization effectively mandatory: Developer ID + `notarytool` ($99/yr). macOS 15 removed the ctrl-click bypass; macOS Tahoe 26 removed `spctl --global-disable`.
- Pipelines: Tauri → `tauri-action` GH Action + Apple cert env vars (+ CrabNebula Cloud for updates, as Conductor does); Electron → `electron-builder` with `notarize: true` + electron-updater; native → Sparkle.
- Homebrew cask is the standard secondary channel (verified live: conductor, cmux, nimbalyst, sculptor, vibetunnel, plus `claude-code` and `codex` CLIs).
- Framework pattern: manager/dashboard apps trend Tauri 2 (5-10MB bundles, Rust sidecars); apps embedding full terminals or reusing web UIs trend Electron; terminal-as-product goes native.

---

## Synthesis

### (a) Reuse as dependencies — don't rebuild

1. **Agent execution + UI plumbing**: ACP as the integration protocol → Claude Code (via `claude-agent-acp`), Gemini CLI, goose et al.; Tauri 2 + tauri-action + notarytool + Homebrew cask for shell and distribution; git-worktree-per-agent pattern.
2. **Model access + routing substrate**: LiteLLM or OpenRouter for multi-provider access; claude-code-router's request-class routing design (MIT); goose lead/worker and Aider architect/editor as reference implementations; DeepSeek/Moonshot/Z.ai via OpenRouter/Fireworks/Cerebras.
3. **Indexing/wiki substrate**: CocoIndex (incremental engine, Apache-2.0), tree-sitter/ast-grep, Serena or codebase-memory-mcp (symbol-level MCP), repomix (export format), Aider's repo-map algorithm (tree-sitter + PageRank), DeepWiki MCP as free bootstrap for public dependencies.
4. **Generation/optimization discipline**: DSPy/GEPA for prompt/harness optimization with eval loops; harbor/mini-swe-agent patterns for per-repo evals guarding the ETH failure mode; AGENTS.md as interop output format.

### (b) What genuinely does not exist (the gap)

1. **Repo analysis → generated, dedicated multi-agent harness.** Everything today is a static collection, a catalog selector, a single context file, or a domain-description-driven Claude-only meta-skill.
2. **Multi-model harness generation.** The frontier-orchestrates/open-weight-executes split exists only as hand-written static config. Nothing generates the model assignment per repo per task type; nothing ships quality-verified escalation.
3. **Local, private, git-incremental, agent-consumable prose+symbol repo wiki.** Auto-refresh is the rarest property; "wiki + symbol graph via MCP, refreshed on commit" is DIY-only today.
4. **Per-repo MCP/tool selection** — fully unclaimed.
5. **Generation paired with per-repo evals.** Harnesses matter enormously (7-15pp) AND naively generated configs hurt (5/8 settings) — so the defensible product is generate → eval → iterate, which nobody ships.

### (c) Three closest competitors and how this differs

1. **revfactory/harness** (8.2k stars, Apache-2.0, active) — only project generating agent teams + skills from architecture patterns. Differs: it's a Claude Code-only prompt-time meta-skill driven by domain description; this app adds deep repo analysis, multi-model assignment, persistent repo wiki, eval loop, signed macOS product.
2. **Conductor** (proprietary, Tauri, macOS) — closest product shape. Differs: runs agents but doesn't configure them — no repo analysis, no harness generation, no knowledge base, no cost routing; closed source.
3. **OpenDeepWiki / deepwiki-open (+ Devin's DeepWiki-plus-Knowledge as commercial ceiling)** — closest on the wiki pillar. Differs: they stop at documentation-for-humans-plus-chat; this project makes the wiki an agent-facing artifact (MCP/files, token-budgeted, git-diff-incrementally refreshed) generated jointly with — and consumed by — the generated harness.

**Strategic caution**: 2025-26 saw heavy die-off of thin Claude Code wrappers as first-party desktop apps shipped. The defensible core is the repo-analysis → multi-model harness + wiki generation engine with an eval loop; the macOS app is the delivery vehicle, and agent-agnosticism via ACP keeps it out of the first-party blast radius.
