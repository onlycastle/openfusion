# Wiki v1: Project Card + Worker Retrieval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ETH-anti-pattern all-digests worker injection with a human-approved, deterministically-mined Project Card as the only always-on worker context, plus two in-process wiki retrieval tools for workers and a card-led AGENTS.md export.

**Architecture:** The card is a fifth wiki page (`project-card`) produced by a new mine→LLM-select→validate→compose stage inside `generateHarness`, gated by a `manifest.verification.card: "draft"|"approved"` field that only the new `engine.harness.card.approve` RPC flips. `orchestrate` swaps `buildWikiDigestContext` for a card-aware selector (approved card → card digest; else build-and-test digest; else nothing). Workers gain `wiki_query`/`wiki_map` tools backed by the same store helpers the MCP server uses. Desktop adds a card review section to HarnessSettingPanel and a draft nudge to the Chat tab.

**Tech Stack:** all in-codebase (zod schemas, `yaml` dep already present, tree-sitter wiki store, AI-SDK `tool()`, React+RTL). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-08-wiki-project-card-design.md` — §ref'd per task. Research: `docs/research/2026-07-07-harness-composition.md`.

## Global Constraints

- Everything standing: Node ≥22, strict TS NodeNext `.js` imports, tsconfig.test coverage, stdout protocol purity, tmp git-repo fixtures, conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, nothing under `.superpowers/`/`.claude/` of THIS repo, auth-agnostic.
- **No live keys / no claude binary in CI**: generation tests use the scripted fake adapter (`harness-generate.test.ts`'s `makeScriptedAdapter`); worker-tool tests use tmp repos + `engine.wiki.build`.
- **Prompts/model-output/file-content never logged.** New tool telemetry logs tool NAMES and COUNTS only, never arguments or results.
- **Backward compatibility is additive-only**: a legacy harness (no `verification.card`, no card page) must parse, load, orchestrate (via the build-and-test fallback), and export exactly as before. Raising `digest`'s max is widening-only.
- **Verdict/eval logic untouched**: nothing in `evals/` changes. `manifest.verification.evals` semantics unchanged.
- Desktop house patterns: stale-response guard via `activeProjectDirRef`, optimistic edit + reconcile-by-reload on failure, RTL tests colocated.

---

### Task 1: schema + store groundwork (card slug, 2500 digest, manifest field, setCardState)

**Files:**
- Modify: `packages/engine/src/harness/schema.ts`, `packages/engine/src/harness/store.ts`, `packages/engine/src/harness/generate.ts` (typing fallout only)
- Test: extend `packages/engine/test/harness-schema.test.ts`, `packages/engine/test/harness-store.test.ts`

**Interfaces (produces):**
- `schema.ts`: `export const CARD_SLUG = "project-card" as const;` · `export const PROSE_PAGE_SLUGS = ["architecture", "subsystems", "conventions", "build-and-test"] as const;` · `WIKI_PAGE_SLUGS` becomes `[...PROSE_PAGE_SLUGS, CARD_SLUG]` (spec §3.1). `WikiPageSchema.digest`: `.max(1200)` → `.max(2500)` (update the doc comment: single-digest injection, spec §3.1). `ManifestSchema.verification` gains `card: z.enum(["draft", "approved"]).optional()` with a doc comment citing spec §3.4 (missing = legacy, no card semantics).
- `store.ts`: `export async function setCardState(projectDir: string, state: NonNullable<Manifest["verification"]["card"]>): Promise<void>` — mirrors `setEvalsVerdict` exactly (manifest-only atomic rewrite, throws `HarnessValidationError` when no harness). `harnessStatus` return type gains `card: "draft" | "approved" | null` (`manifest.verification.card ?? null`).
- `generate.ts` typing fallout: `PAGE_FOCUS` retypes to `Record<(typeof PROSE_PAGE_SLUGS)[number], string>`; the page loop iterates `PROSE_PAGE_SLUGS` (unchanged behavior — card generation arrives in Task 4); `PageContentSchema.digest` max 1200 → 2500 to match; `buildPagePrompt`'s "at most 1200 characters" wording stays (prose pages should remain small).

- [ ] **Step 1: Failing tests.** harness-schema: `WIKI_PAGE_SLUGS` contains `"project-card"` and `PROSE_PAGE_SLUGS` doesn't; a manifest WITH `verification.card: "draft"` parses and roundtrips; a manifest WITHOUT it parses (card `undefined`); a 2500-char digest parses, 2501 fails. harness-store: `setCardState(dir, "approved")` flips ONLY `verification.card` (evals/structural/artifacts/headSha byte-identical); throws `HarnessValidationError` on a no-harness dir; `harnessStatus` surfaces `card: "draft"` after a manifest written with it and `card: null` on a legacy manifest.
- [ ] **Step 2: RED → implement → GREEN** (`pnpm --filter @openfusion/engine test -- --run` full suite green — pre-existing tests must not break; typecheck clean) → Commit `feat(engine): project-card slug, 2500-char digest cap, manifest card state + setCardState`

---

### Task 2: deterministic command miner

**Files:**
- Create: `packages/engine/src/harness/mine.ts`
- Test: `packages/engine/test/harness-mine.test.ts`

**Interfaces (produces):**
```ts
export interface MinedCommand { command: string; sources: string[] }
export async function mineCommands(projectDir: string): Promise<MinedCommand[]>
export function listScriptNames(projectDir: string): Set<string>   // package.json script names, root + workspaces
export function listMakeTargets(projectDir: string): Set<string>   // Makefile + justfile target names
```
Mining rules (spec §3.3 stage 1):
- **package.json scripts**: root always; when `pnpm-workspace.yaml` exists, also every `<glob-dir>/*/package.json` for each literal dir prefix in its `packages:` list (e.g. `packages/*` → `packages/*/package.json`; only single-level `dir/*` globs supported v1). Runner prefix by lockfile: `pnpm-lock.yaml` → `pnpm run <name>` (workspace scripts: `pnpm --filter <pkg.name> run <name>`), `yarn.lock` → `yarn <name>`, else `npm run <name>`. Source string: `"<relpath>:scripts.<name>"`.
- **Makefile / justfile** (root only): target lines matching `/^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:([^=]|$)/` (excludes `.PHONY`-style dot-targets and `:=` assignments) → `make <target>` / `just <target>`, source `"Makefile:<target>"` / `"justfile:<target>"`.
- **CI workflows**: every `.github/workflows/*.yml`/`.yaml`, `yaml`-parsed; for each `jobs.<job>.steps[].run` string: split lines, trim, drop empties and `#`-comments → each line is a command, source `"ci:.github/workflows/<file>#<job>"`. CI is the highest-trust source (already execution-validated by the project's own CI).
- Dedupe by exact command string, merging `sources` (stable first-seen order). Unreadable/unparsable file → skip that file silently (mining is best-effort), never throw.

- [ ] **Step 1: Failing tests** (tmp fixture dirs, no git needed): a pnpm repo (pnpm-lock + root scripts `{test, build}` + `pnpm-workspace.yaml` with `packages/*` + `packages/a/package.json` name `@x/a` script `lint`) → contains `pnpm run test`, `pnpm run build`, `pnpm --filter @x/a run lint` with correct sources; a Makefile with targets `build`, `test-all:`, a `.PHONY:` line and `VAR := x` → exactly `make build`, `make test-all`; a workflow with a multi-line `run:` (two commands + a comment line) → both commands with `ci:` source; the same command in package.json AND CI → ONE entry, two sources; empty dir → `[]`.
- [ ] **Step 2: RED → implement → GREEN** (full suite + typecheck) → Commit `feat(engine): deterministic command miner (package.json/Makefile/justfile/CI workflows)`

---

### Task 3: card content model — schema, validation, composition

**Files:**
- Create: `packages/engine/src/harness/card.ts`
- Test: `packages/engine/test/harness-card.test.ts`

**Interfaces (produces):**
```ts
export const CardContentSchema = z.object({
  title: z.string().min(1),
  commands: z.array(z.object({
    command: z.string().min(1).max(120),
    why: z.string().min(1).max(80),          // "run unit tests", "typecheck"
  })).min(1).max(8),
  env: z.array(z.string().min(1).max(120)).max(6),         // prerequisites/quirks
  boundaries: z.array(z.string().min(1).max(100)).max(6),  // do-not-touch (spec §3.2)
  anchors: z.array(z.object({
    path: z.string().min(1),                 // repo-relative
    note: z.string().min(1).max(80),
    symbol: z.string().optional(),           // optional symbol to cross-check
  })).max(8),
  glossary: z.array(z.object({ term: z.string().min(1).max(40), meaning: z.string().min(1).max(120) })).max(8),
  gotchas: z.array(z.string().min(1).max(160)).max(6),
});
export type CardContent = z.infer<typeof CardContentSchema>;

export interface CardValidationCtx {
  mined: MinedCommand[];
  projectDir: string;
  symbolExists?: (name: string) => boolean;  // wired to store.symbolsByName().length > 0 in Task 4
}
export interface StrippedItem { item: string; reason: string }
export function validateCardContent(content: CardContent, ctx: CardValidationCtx): { content: CardContent; stripped: StrippedItem[] }
export function composeCardDigest(content: CardContent): string   // ≤2500 guaranteed
export function composeCardBody(content: CardContent, mined: MinedCommand[], stripped: StrippedItem[]): string
```
Validation rules (spec §3.3 stage 3): a `command` passes iff it exactly matches a mined command OR its script/target name resolves — `(pnpm|npm) run <X>` / `yarn <X>` → `X ∈ listScriptNames`, `make <X>`/`just <X>` → `X ∈ listMakeTargets`; otherwise stripped with reason `"unmined command; no matching script/target in any manifest"`. An `anchor` passes iff `existsSync(join(projectDir, path))`; if `symbol` is set and `ctx.symbolExists` is provided, the symbol must also resolve. Stripping REMOVES the item from `content` and records it; `env`/`boundaries`/`glossary`/`gotchas` prose is not machine-validated (v1).

Composition: digest sections in priority order — `Commands` (one `- \`cmd\` — why` line each), `Environment`, `Do not touch`, `Key locations` (anchors), `Glossary`, `Gotchas` — headed `## Project card: <title>` is NOT included (orchestrate adds the heading); if the composed digest exceeds 2500 chars, drop whole trailing sections in the order glossary → gotchas → anchors until it fits (spec §3.2 soft-priority; the schema maxes above make the untrimmable core mathematically ≤ ~2400 chars). Body = full markdown with all sections, a `## Provenance` section listing each command's mined `sources` (or `unmined — matched script "<X>"`), and a `## Stripped at generation` section when `stripped` is non-empty (this is how the desktop review panel surfaces them, spec §3.4).

- [ ] **Step 1: Failing tests.** validate: mined command kept; `pnpm run lint` unmined-but-script-exists kept; `npm run ghost` stripped with the exact reason; anchor to a real fixture file kept, to `no/such/file.ts` stripped; anchor with `symbol: "Nope"` and `symbolExists: () => false` stripped. compose digest: commands+env+boundaries always present; an 8-entry glossary that pushes >2500 → glossary section absent, commands intact, length ≤2500. compose body: contains `## Provenance` with a mined source string and `## Stripped at generation` with the stripped reason.
- [ ] **Step 2: RED → implement → GREEN** (full suite + typecheck) → Commit `feat(engine): project-card content model — schema, manifest-backed validation, priority composition`

---

### Task 4: generation pipeline integration (mine → select → validate → draft card)

**Files:**
- Modify: `packages/engine/src/harness/generate.ts`
- Test: extend `packages/engine/test/harness-generate.test.ts`

**Interfaces:**
- Consumes: Task 1 (`CARD_SLUG`, `PROSE_PAGE_SLUGS`, manifest `card` field), Task 2 (`mineCommands`), Task 3 (`CardContentSchema`, `validateCardContent`, `composeCardDigest`, `composeCardBody`).
- Produces: `GenerateHarnessResult` gains `cardStripped: StrippedItem[]`; pipeline stage order becomes **overview → 4 prose pages → project-card → agents-routing** (scripted-adapter tests key off promptForJson call order — the card script is index 5, agents-routing moves to index 6).

New stage, inserted after the prose-page loop:
```ts
notify("mine", "mining build/test commands from manifests and CI");
const mined = await mineCommands(projectDir);
notify(`page:${CARD_SLUG}`, "generating the project card (draft)");
const cardResult = await promptForJson(session, buildCardPrompt(overview, mined), CardContentSchema, {
  stage: `page:${CARD_SLUG}`,
  notify: (n) => notify(`page:${CARD_SLUG}`, `${n.kind}: ${n.detail}`),
});
costUsd = addCost(costUsd, cardResult.costUsd);
const store = engine.wiki.getStore(projectDir);
const { content: card, stripped } = validateCardContent(cardResult.value, {
  mined,
  projectDir,
  symbolExists: (name) => store.symbolsByName(name).length > 0,
});
pages.push({ slug: CARD_SLUG, title: card.title, digest: composeCardDigest(card), body: composeCardBody(card, mined, stripped) });
```
`buildCardPrompt(overview, mined)` (new, sibling of `buildPagePrompt`): lists every mined command with its sources; instructs — select ONLY commands a contributor actually needs (prefer mined; an unmined command must name a real script/target); content rule per spec §3.2 verbatim: include exact commands, env prerequisites, hard invariants and do-not-touch boundaries (secrets, vendor dirs, generated files, prod configs), factual navigation anchors (bare paths), short glossary, gotchas grep can't reveal; FORBIDDEN: prose architecture overviews, anything derivable by reading one obvious file, and procedural workflow directives ("always X before Y") — this card serves four different worker model families. Respond with ONLY a JSON code block matching `CardContentSchema`'s shape (show the shape like the other prompts do).
Manifest literal gains `card: "draft" as const` inside `verification`. Result: `cardStripped: stripped`, and `NOTE` unchanged.

- [ ] **Step 1: Failing tests** (extend the scripted-adapter suite): insert a card script (valid `CardContentSchema` JSON whose commands include one mined-matching command and one `npm run ghost`) between the 4th page script and the agents-routing script; happy path asserts — `result.pages === 5`, `wiki/project-card.md` in `result.files`, `harnessStatus(dir).card === "draft"`, `result.cardStripped` names `npm run ghost`, the on-disk card digest contains the kept command and NOT `ghost`, progress notifications include a `mine` and a `page:project-card` stage. Existing assertions updated: pages 4→5 wherever counted.
- [ ] **Step 2: RED → implement → GREEN** (full suite — `harness-generate-smoke` untouched/env-gated; typecheck) → Commit `feat(engine): harness generation mines commands and drafts a validated project card`

---

### Task 5: card RPC surface (read / update / approve)

**Files:**
- Modify: `packages/engine/src/harness/methods.ts`
- Test: extend `packages/engine/test/harness-methods-read.test.ts`, `packages/engine/test/harness-methods-update.test.ts`

**Interfaces (produces):**
- `engine.harness.read` result gains `card: { digest: string; body: string; state: "draft" | "approved" } | null` — non-null only when BOTH the `project-card` page and `manifest.verification.card` exist.
- `engine.harness.card.update` — params `{ projectDir: z.string().min(1), digest: z.string().min(1).max(2500) }`; behavior: `serializeWrite` + `mutateHarness`: find the card page (else `SERVER_ERROR` `"no project card; regenerate the harness first"`), set `page.digest = digest`, set `bundle.manifest.verification.card = "draft"` (an edit always invalidates approval, spec §3.4). Returns `{ updated: true }`.
- `engine.harness.card.approve` — params `{ projectDir }`; behavior: inside `serializeWrite`, `loadHarness` (same error mapping as read), require card page + `manifest.verification.card !== undefined` (else `SERVER_ERROR` `"no project card; regenerate the harness first"`), then `await setCardState(projectDir, "approved")`. Returns `{ approved: true }`.

- [ ] **Step 1: Failing tests.** read: a bundle written with a card page + `card: "draft"` → `read.card.state === "draft"` with the page's digest/body; a legacy bundle (no card) → `read.card === null`. update: edits the on-disk digest; on an APPROVED card, update resets state to `"draft"`; unknown-card project → SERVER_ERROR. approve: flips `harnessStatus(dir).card` to `"approved"` and preserves every other manifest field; approve on a legacy harness → SERVER_ERROR with the exact message.
- [ ] **Step 2: RED → implement → GREEN** (full suite + typecheck) → Commit `feat(engine): engine.harness.card.update/.approve RPCs and card in harness.read`

---

### Task 6: worker-context injection swap in orchestrate

**Files:**
- Modify: `packages/engine/src/orchestrate/orchestrate.ts`
- Test: extend `packages/engine/test/orchestrate.test.ts`

**Interfaces:**
- Consumes: Task 1 (`CARD_SLUG`, manifest `card` field).
- Produces: `buildWikiDigestContext` + `MAX_WIKI_DIGEST_CHARS` DELETED, replaced by:
```ts
type WorkerContextBranch = "approved-card" | "build-and-test-fallback" | "none";
function buildWorkerContext(bundle: HarnessBundle): { text: string | undefined; branch: WorkerContextBranch }
```
Branch logic (spec §4, exact): card page present AND `bundle.manifest.verification.card === "approved"` → `text = "## Project card\n\n" + cardPage.digest`, branch `"approved-card"`; else build-and-test page present → `text = "## Project knowledge (from the harness wiki)\n\n### " + page.title + "\n\n" + page.digest`, branch `"build-and-test-fallback"`; else `text = undefined`, branch `"none"`. Call site (currently `const wikiDigest = buildWikiDigestContext(harness.pages)` ~line 630): becomes `const workerContext = buildWorkerContext(harness);` + `progress(engine, "load", \`worker context: ${workerContext.branch}\`, params.runId);` and every `wikiDigest` reference reads `workerContext.text`. Keep the never-logged posture (the branch NAME is logged, digest text never).

- [ ] **Step 1: Failing tests.** Approved-card fixture (harness with card page digest `"CARD-DIGEST-MARKER"`, `verification.card: "approved"`, plus an architecture page digest `"ARCH-MARKER"`) → the fake worker's received task/prompt contains `CARD-DIGEST-MARKER` and NOT `ARCH-MARKER`; draft-card fixture (same but `card: "draft"`, plus a `build-and-test` page `"BT-MARKER"`) → contains `BT-MARKER`, not the card marker; legacy fixture (no card, no build-and-test page) → no `## Project` context section at all; a progress notification carries `worker context: approved-card` / `build-and-test-fallback` / `none` respectively. Flip/replace the existing "worker task contains a wiki page digest" M6-Task-2 test accordingly.
- [ ] **Step 2: RED → implement → GREEN.** Run the FULL engine suite — `evals-run.test.ts` fixtures (architecture-only pages, no card) now take the `"none"` branch; they assert stages, not digest content, and must stay green unmodified. Typecheck. → Commit `feat(engine): worker context = approved project card only, with build-and-test fallback (ETH injection swap)`

---

### Task 7: shared wiki query helpers + worker retrieval tools + telemetry

**Files:**
- Create: `packages/engine/src/wiki/query.ts`
- Modify: `packages/engine/src/wiki/mcp.ts` (delegate to helpers, behavior identical), `packages/engine/src/worker/tools.ts`, `packages/engine/src/worker/methods.ts`
- Test: `packages/engine/test/worker-tools.test.ts` (extend), `packages/engine/test/wiki-mcp.test.ts` (stays green unmodified)

**Interfaces (produces):**
```ts
// wiki/query.ts — extracted verbatim from mcp.ts's two tool bodies:
export function querySymbols(store: WikiStore, symbol: string): { definitions: SymbolRow[]; references: RefRow[] }   // use the store's actual row types
export function renderMap(store: WikiStore, budgetTokens?: number): string  // rankFiles + renderRepoMap, default 1024
// worker/tools.ts — ToolContext gains:
wiki?: { store: WikiStore; pages: ReadonlyArray<Pick<WikiPage, "slug" | "title" | "digest">> }
```
When `ctx.wiki` is present, `createWorkerTools` additionally registers (spec §5):
- `wiki_query` — inputSchema `{ query: z.string().min(1) }`; execute: `querySymbols(store, query)` + page hits (`pages.filter(p => p.title.toLowerCase().includes(q) || p.digest.toLowerCase().includes(q))` mapped to `{ slug, title, excerpt: digest.slice(0, 240) }`); returns `{ definitions, references, pages }`. Description (disjoint-by-question-type, spec §5): `"Look up a SYMBOL (function/class/type name): returns where it is defined and referenced (file:line) in this project's code index, plus matching project wiki pages. For exact strings, regex, or file contents use bash grep / read_file instead."`
- `wiki_map` — inputSchema `{ budgetTokens: z.number().int().min(64).max(32768).optional() }`; execute: `renderMap(store, budgetTokens)`; description `"Get a token-budgeted map of this project's most important files and symbols — use for whole-repo orientation before diving in."`
- Both fire `ctx.onToolEvent` with `{ tool: "wiki_query" | "wiki_map", detail: <query string truncated per detail()> }`.
`worker/methods.ts`: before `createWorkerTools`, build the wiki ctx — if `existsSync(wikiDbPath(resolve(projectDir)))` and the store's `head_sha` meta is non-null: `wiki = { store: engine.wiki.getStore(projectDir), pages: loadHarness(projectDir)?.pages ?? [] }` (a `HarnessValidationError` from loadHarness degrades to `pages: []`, never fails the run). Telemetry (spec §5): wrap the existing `onToolEvent` to tally `counts[tool]++`, and after the loop finishes log `engine.log(\`worker.run tool-calls model=${model} ${JSON.stringify(counts)}\`)` — names and counts only.

- [ ] **Step 1: Failing tests.** worker-tools: fixture = tmp git repo with one TS file `export function alphaBeta() {}`, `engine.wiki.build(dir)`, then `createWorkerTools({ root: dir, wiki: { store, pages: [{ slug: "architecture", title: "Architecture", digest: "mentions alphaBeta here" }] } })` → toolset has `wiki_query`/`wiki_map`; `wiki_query({query: "alphaBeta"})` returns ≥1 definition AND the page hit with a 240-char-capped excerpt; `wiki_map({})` returns a non-empty string mentioning the file; WITHOUT `ctx.wiki` the toolset has exactly the original four tools. worker-methods: a run against a repo with a built wiki logs a `worker.run tool-calls` line (spy `log`), and the line contains no tool arguments.
- [ ] **Step 2: RED → implement → GREEN** — including `wiki-mcp.test.ts` green UNMODIFIED (the mcp refactor is behavior-preserving). Full suite + typecheck. → Commit `feat(engine): worker wiki_query/wiki_map retrieval tools over shared store helpers, with call-count telemetry`

---

### Task 8: card-led AGENTS.md export

**Files:**
- Modify: `packages/engine/src/harness/exporters.ts`
- Test: extend `packages/engine/test/harness-export.test.ts`

**Interfaces:**
- Consumes: Task 1 (`CARD_SLUG`, manifest `card`).
- Produces: in `renderAgentsMd`, when `findPage(bundle, CARD_SLUG)` exists AND `bundle.manifest.verification.card === "approved"`, insert directly after the UNVERIFIED caveat block (before "## Project summary"):
```ts
const CARD_DIRECTIVE =
  "> Commands here are statically extracted, not execution-verified; if one fails, treat `package.json` scripts / CI workflows as ground truth.";
lines.push("## Project card");
lines.push("");
lines.push(CARD_DIRECTIVE);
lines.push("");
lines.push(card.digest);
lines.push("");
lines.push(card.body.trim());
lines.push("");
```
Draft or missing card → output byte-identical to today (spec §6: directive ships only with card-led exports; UNVERIFIED caveat unchanged in both cases). `claude-subagents` export untouched.

- [ ] **Step 1: Failing tests.** Approved-card bundle → AGENTS.md contains `## Project card` before `## Project summary`, the directive line, and the card digest; draft-card bundle → NO `## Project card` section and output equals the pre-change golden expectations; UNVERIFIED caveat still present when evals ≠ pass in both cases.
- [ ] **Step 2: RED → implement → GREEN** (full suite + typecheck) → Commit `feat(engine): AGENTS.md leads with the approved project card and its ground-truth directive`

---

### Task 9: desktop — card state in client + HarnessSettingPanel review section

**Files:**
- Modify: `apps/desktop/src/engineClient.ts`, `apps/desktop/src/components/HarnessSettingPanel.tsx`
- Test: extend `apps/desktop/src/components/HarnessSettingPanel.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`harnessStatus.card`), Task 5 (read `card`, `card.update`, `card.approve`).
- Produces (`engineClient.ts`): `HarnessStatus` gains `card: "draft" | "approved" | null`; `HarnessTeam` gains `card: { digest: string; body: string; state: "draft" | "approved" } | null`; new fns `harnessCardUpdate(projectDir: string, digest: string): Promise<void>` → `engine.harness.card.update`, `harnessCardApprove(projectDir: string): Promise<void>` → `engine.harness.card.approve` (mirror the existing `harnessUpdateAgentModel` wrapper style).

Panel behavior (spec §3.4): when `team.card !== null`, render a `section.harness-card` ABOVE the agent tree — header `Project card` + badge (`Draft` / `Approved`); a `textarea` (aria-label `"Project card digest"`, local state seeded from `team.card.digest`, `disabled` when approved); a collapsed `<details><summary>Full card</summary><pre>{body}</pre></details>` (the body carries the generation-time "Stripped at generation" section, so stripped lines surface here for free); buttons `[Save draft]` (enabled when draft AND textarea differs from saved digest; calls `harnessCardUpdate` then `load(dir)`, `.catch(() => load(dir))` — reconcile-by-reload, house pattern) and `[Approve]` (draft only; DISABLED while the textarea is dirty — save first, spec's approve-after-edit = save then approve; calls `harnessCardApprove().then(() => load(dir))`, error → `friendlyMessage` inline). `team.card === null` → section absent entirely. All handlers stale-guarded via the existing `activeProjectDirRef`.

- [ ] **Step 1: Failing tests** (RTL, mock `engineClient` per the file's existing pattern): draft card → section renders with `Draft` badge, editable textarea, Approve enabled; typing in the textarea disables Approve and enables Save draft; Save draft calls `harnessCardUpdate` with the edited text then reloads; Approve calls `harnessCardApprove` and after reload shows `Approved` badge + disabled textarea; `card: null` team → no `Project card` heading; a failing approve shows an error message and stays draft.
- [ ] **Step 2: RED → implement → GREEN** (`pnpm --filter desktop test -- --run` or the repo's desktop test command — check `apps/desktop/package.json` scripts; plus `tsc` clean) → Commit `feat(desktop): project-card review section — edit draft, approve, badge state`

---

### Task 10: Chat-tab draft nudge + docs

**Files:**
- Modify: `apps/desktop/src/screens/OrchestrateScreen.tsx`, `README.md`, `docs/superpowers/specs/2026-07-08-wiki-project-card-design.md` (status line only)
- Test: extend `apps/desktop/src/screens/OrchestrateScreen.test.tsx`

**Interfaces:**
- Consumes: Task 9's `HarnessStatus.card`.
- Produces: in the harness-status area (near `harnessStatusText`'s rendering), when the harness state is `"ready"` AND `harnessState.harness.card === "draft"`, render `<p className="muted-text">Project Card drafted — review it in Harness setting.</p>` (spec §3.4: a nudge, never a gate — `canRun` logic UNTOUCHED).
- README: update the harness/orchestrate sections — the worker context is now the approved Project Card only (draft/legacy → build-and-test digest fallback), generation mines commands deterministically and validates the card statically, workers have `wiki_query`/`wiki_map`, AGENTS.md leads with the approved card. Spec doc: flip its status line to `implemented by docs/superpowers/plans/2026-07-08-wiki-project-card.md`.

- [ ] **Step 1: Failing test.** Ready harness with `card: "draft"` in the mocked status → nudge text visible; `card: "approved"` or `null` → absent; Run button enablement unchanged by card state.
- [ ] **Step 2: RED → implement → GREEN** (desktop suite + engine suite + typecheck all green from clean checkout) → Commit `feat(desktop): draft-card nudge in chat; docs for the project-card wiki v1`

---

## Milestone exit checklist

- [ ] Full stack green from clean checkout: engine suite + typecheck, desktop suite + tsc — no live keys, no claude binary
- [ ] `engine.harness.generate` on a scripted fake produces 5 pages incl. a validated draft card; `harnessStatus.card === "draft"`
- [ ] `engine.harness.card.approve` flips to approved; orchestrate injects ONLY the card digest; draft/legacy fall back to build-and-test digest; progress names the branch
- [ ] Workers expose `wiki_query`/`wiki_map` when the wiki is built; tool-call counts logged, arguments never
- [ ] AGENTS.md leads with the approved card + directive line; draft export unchanged
- [ ] Desktop: card review section (edit/save/approve) + chat draft nudge; never blocks the run loop
- [ ] Operator smoke (keyed): regenerate this repo's own harness → review the drafted card in the panel → approve → run one orchestrate task and confirm the `worker context: approved-card` progress line

## Self-Review

- **Spec coverage:** §3.1 (slug/cap/regeneration-resets—reset falls out of Task 4 writing `card:"draft"` on every generation) → T1/T4; §3.2 content rules + soft-priority → T3 (schema maxes + trim order) and T4 (prompt); §3.3 mine/select/validate → T2/T3/T4; §3.4 gate + RPC + panel + nudge → T1/T5/T9/T10; §4 injection swap + branch progress → T6; §5 two tools + disjoint descriptions + telemetry → T7; §6 exporter + directive + provenance placement (body-only: T3 puts provenance in body; digest/AGENTS.md carry bare paths only via anchors) → T3/T8; §7 test list → mapped 1:1 across tasks; §8 deferred items appear in no task. Gap check: spec §3.4 "stripped-lines callout" — satisfied via body's "Stripped at generation" section rendered in the panel's Full card view (T3+T9), noted explicitly in both tasks.
- **Placeholder scan:** every step names exact values, messages, schemas, and assertions; no TBD/similar-to; the two prompts are specified by content rules + shape reference (matching the codebase's existing prompt-builder style, which the implementer reads in `generate.ts`).
- **Type consistency:** `CARD_SLUG`/`PROSE_PAGE_SLUGS` (T1) used in T4/T6/T8; `MinedCommand{command,sources}` (T2) consumed by T3's ctx and T4; `CardContent`/`StrippedItem` (T3) → T4's `cardStripped`; `verification.card` optional enum (T1) read by T5/T6/T8/T9; `harnessCardUpdate/Approve` (T9) match T5's RPC names `engine.harness.card.update/.approve`; `buildWorkerContext` returns `{text, branch}` and the progress line format `worker context: <branch>` is identical in T6's code and tests.
