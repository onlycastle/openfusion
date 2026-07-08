# Wiki v1: Project Card + Worker Retrieval — Design

**Date:** 2026-07-08 · **Status:** approved design, pre-implementation
**Research basis:** `docs/research/2026-07-07-harness-composition.md` (Pillar 1) + a
three-agent adversarial validation pass (2026-07-08) whose amendments are folded in
below and marked **[AMENDED]** where they changed the original proposal.

## 1. Problem

Today every worker prompt gets ALL four wiki-page digests injected
(`orchestrate.ts` → `buildWikiDigestContext` → `engine.worker.run`'s `wikiDigest`).
This is the exact anti-pattern the ETH Zurich + DeepMind study measured
(arXiv:2602.11988, v2 Jun 2026): LLM-generated context files that restate what an
agent can read cost −0.5–2% success and +20–23% inference. The wiki must become a
tiny, high-trust always-on layer plus on-demand retrieval — while respecting the
June-2026 counter-evidence (Probe-and-Refine, arXiv:2606.20512) that cheap open
workers are the one model class that *gains* from good repo guidance (+7.5pp),
so "minimal" must not mean "starved."

## 2. Design at a glance

```
engine.harness.generate
  ├─ 1. deterministic mining (no LLM): package.json scripts, Makefile
  │     targets, .github/workflows/*.yml → candidate commands (CI-validated)
  ├─ 2. frontier LLM SELECTS + ANNOTATES → "project-card" wiki page (DRAFT)
  ├─ 3. static validation of LLM-authored residue (paths/symbols/scripts);
  │     failing lines stripped AND surfaced, never silently dropped
  ▼
Harness setting panel: card review (view / edit digest / [Approve])
  ▼
orchestrate worker prompt:
  approved card        → inject ONLY its digest (≤2500 chars)
  draft / no card      → inject the build-and-test page digest only  [AMENDED]
  no pages at all      → inject nothing
other pages            → on-demand: worker wiki tools + frontier MCP
```

Workers additionally gain two in-process retrieval tools (`wiki_query`,
`wiki_map`); the AGENTS.md exporter leads with the approved card.

## 3. The Project Card

### 3.1 Shape: a fifth wiki page
- `WIKI_PAGE_SLUGS` gains `"project-card"`. The card reuses `WikiPageSchema`
  unchanged in structure: `digest` = the always-injected content; `body` = the
  extended card with provenance notes.
- **[AMENDED]** `WikiPageSchema.digest` max rises **1200 → 2500 chars** (~650
  tokens), globally. The 1200 cap's rationale (4 digests × 1200 injected
  together) no longer applies — only one digest is ever injected now. Raising a
  `max` is backward compatible with every existing page on disk.
- Regeneration treats the card like any page: rewritten, and **approval resets
  to draft** (new content needs a new human look).

### 3.2 Content rule
**[AMENDED]** Include facts that are *non-inferable OR expensive to rediscover
per task*:
- exact build / test / run commands (with flags and cwd),
- environment prerequisites and quirks,
- hard invariants and **do-not-touch boundaries** (secrets, vendor dirs,
  generated files, prod configs) — the highest-value section per GitHub's
  2,500-repo AGENTS.md analysis,
- domain glossary,
- gotchas grep can't reveal,
- **factual navigation anchors**: entry points, canonical test paths, key
  module locations (bare paths, no prose tour).

Forbidden:
- prose architecture overviews (the measured ETH failure mode),
- anything trivially derivable by reading one obvious file,
- **procedural directives** ("always reproduce the bug before fixing"-style
  workflow rules) — the one cross-model experiment on record showed guidance
  tuned for one model collapsing another (27%→13.2%); this card is consumed by
  four worker families (DeepSeek/GLM/Kimi/Qwen).

Truncation is **soft-priority**: if the digest exceeds 2500 chars, trim
glossary → gotchas → anchors first; commands, env facts, and boundaries are
never truncated. (The generator prompt states the priority; the writer enforces
it before schema validation.)

### 3.3 Generation pipeline: deterministic-first  **[AMENDED — inverted]**
1. **Mine (code, no LLM):** collect candidate commands from `package.json`
   scripts (all workspaces), `Makefile`/`justfile` targets, and CI workflow
   steps (`.github/workflows/*.yml`). CI-mined commands are highest-trust —
   the project's own CI already execution-validates them. Each candidate keeps
   its source (`package.json:scripts.test`, `ci:.github/workflows/test.yml`).
2. **Select + annotate (frontier LLM):** the generation session receives the
   mined candidates and the wiki MCP tools it already has; it *selects* which
   commands matter (which of 40 scripts is *the* test command), and *authors*
   the prose residue (env quirks, invariants, boundaries, glossary, anchors).
   It may propose a command NOT in the mined set only with an explicit
   `unmined:` marker.
3. **Validate (code):** for LLM-authored content only — every referenced path
   must exist; every referenced symbol must resolve in the tree-sitter store;
   every `unmined:` or modified command must name a script/target that exists
   in a manifest (`command -v` alone is NOT used — right-binary/wrong-script is
   the dominant real failure). Failing lines are stripped from the card and
   **surfaced in the generation result + the card review panel** for the human
   to reinstate or fix.

### 3.4 Approval gate  **[AMENDED — new, mandatory]**
- Manifest gains an optional field: `verification.card?: "draft" | "approved"`.
  Missing (legacy harness) ⇒ no card semantics apply. Generation writes
  `"draft"`.
- New engine surface (thin, following the existing harness-update writer
  pattern, serialized by `HarnessService`'s write chain):
  - `engine.harness.card.update { projectDir, digest }` — edit the draft,
  - `engine.harness.card.approve { projectDir }` — flip `"draft"→"approved"`.
- Desktop (`HarnessSettingPanel`): a Card section above the agent list —
  draft/approved badge, digest in an editable textarea (draft only), collapsed
  read-only body, stripped-lines callout, **[Save draft]** / **[Approve]**.
  Approving after an edit saves then approves.
- Chat tab: when a draft card exists, the existing status line adds one nudge:
  "Project Card drafted — review it in Harness setting." Never blocks the loop.

Rationale: generated-unreviewed context is the configuration measured at −3%;
human-curated at +4%. The card is one screen of text — the cheapest human
touch with the largest evidenced payoff.

## 4. Injection swap (`orchestrate.ts`)

`buildWikiDigestContext(pages)` is replaced by a card-aware selector:
1. card page present AND `verification.card === "approved"` → return the card
   digest (headed "Project card");
2. **[AMENDED]** otherwise, if a `build-and-test` page exists → return that
   digest only (the one legacy digest class with positive evidence — commands);
3. otherwise → `undefined` (inject nothing).

`MAX_WIKI_DIGEST_CHARS` collapses to the single-digest bound (2500). The
`wikiDigest` plumbing through `engine.worker.run` is unchanged. Emit one
progress note naming which branch fired, so eval runs and the cockpit can see
what context the worker actually got.

## 5. Worker retrieval tools  **[AMENDED — 2 tools, not 3]**

`createWorkerTools` gains, when the project has a built wiki:
- **`wiki_query`** — symbol/name query → defs/refs/`file:line` from the symbol
  store, **plus** matching harness wiki-page hits (title + digest excerpt)
  folded into the same result. Folding page search in here (instead of a third
  `wiki_page` tool) avoids the documented same-prefix tool-confusion hazard
  while keeping prose reachable.
- **`wiki_map`** — the token-budgeted PageRank repo map.

Implementation: extract the store-query/map helpers `wiki/mcp.ts` already uses
into shared functions; both the MCP server and the worker tools call them. No
MCP in the worker path — direct in-process store access. Tools are registered
only when the wiki is built; page hits only when a harness is present.

Tool descriptions are disjoint **by question type**, steering per the
agentic-search evidence: "exact string/regex or file content → use bash grep /
read_file; symbol definitions, references, callers, or 'where does X live' →
wiki_query; whole-repo orientation → wiki_map."

**Telemetry [AMENDED — new]:** each worker run logs tool-call counts by tool
name and worker model (`engine.log`, no schema change). Qwen3-Coder's measured
77% tool-call success makes it the likeliest model to falsify this design —
adoption/misuse must be observable before we trust the tools fleet-wide.
Per-model tool disablement is deferred (config knob, not v1).

## 6. Exporter (`AGENTS.md`)

- With an **approved** card: AGENTS.md leads with the card content (digest
  first, then the body's sections). Draft/no card: current behavior.
- **[AMENDED]** The card section carries a directive line, not a status label:
  *"Commands here are statically extracted, not execution-verified; if one
  fails, treat `package.json` scripts / CI workflows as ground truth."* This
  line ships only with card-led exports (draft/no card exports are unchanged).
  The existing UNVERIFIED-until-evals marker stays as-is in both cases (it
  gates trust in the harness, not the card).
- Provenance: `file:line` citations stay in the card **body** (human-checkable,
  drift-detectable); the digest and AGENTS.md carry bare file paths only where
  load-bearing, never line numbers.
- `claude-subagents` export: unchanged in v1.

## 7. Testing

All CI tests use fake models / tmp git fixtures (house rules: no live keys).
- **Miner:** fixture repos with `package.json` workspaces, `Makefile`, and a CI
  workflow → expected candidate set with sources; a repo with none → empty set.
- **Validator:** LLM-authored residue referencing a nonexistent path / symbol /
  script → line stripped AND surfaced in the result; mined commands pass
  untouched; `unmined:` command naming a real script survives.
- **Generation:** fake frontier returns a card with one bogus line → written
  card lacks it, manifest says `card: "draft"`, stripped line in result.
- **Injection:** approved card → worker task contains card digest and NO other
  page digest (flips the existing "digest appears in worker task" test); draft
  card → build-and-test digest only; no pages → no context section.
- **Card RPC:** update edits the draft digest (serialized with other harness
  writes); approve flips the manifest; approve-on-legacy-harness errors cleanly.
- **Worker tools:** tmp-repo store fixture → `wiki_query` returns defs/refs and
  page hits; `wiki_map` returns a bounded map; tools absent when no wiki.
- **Exporter:** approved card leads AGENTS.md with the directive line; draft
  card → current output.
- **Desktop:** HarnessSettingPanel card section — draft badge + textarea +
  approve flow, stale-response guard per house pattern (RTL).
- **Eval:** no new arm in v1; the existing M6/M6.1 gate measures the redesigned
  harness baseline-vs-harness as-is.

## 8. Out of scope (deferred, unchanged from the research doc)

Hierarchical summary index · embeddings tier · wiki-on/off eval arm ·
per-worker-model tool config · per-worker-family card smoke evals ·
GEPA self-evolution · post-generation drift re-check hook (staleness remains
headSha-based regeneration).

## 9. Risks

- **One card, four worker families.** The single cross-model guidance
  experiment on record failed badly. Mitigations: factual-only content rule (no
  procedural directives), the human gate, and eval-gate measurement. Residual
  risk accepted for v1; per-family smoke evals are the deferred follow-up.
- **Deterministic mining misses exotic build systems** (Bazel, sbt, nix…). The
  LLM `unmined:` escape hatch + manifest cross-check covers the gap; worst case
  the card ships fewer commands, never wrong ones.
- **Approval friction.** A user who never visits Harness setting stays on the
  build-and-test fallback indefinitely — strictly better-evidenced than today's
  all-digests injection, so the failure mode is "less upside," not harm.
