# M4: Harnessgen (Understanding Phase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `engine.harness.generate {projectDir}` drives a frontier session through repo understanding and emits the committable `.openfusion/` harness: manifest, wiki prose pages with token-budgeted digests, specialist agent definitions, and routing.yaml — every artifact zod-validated BEFORE it touches disk, stamped UNVERIFIED until M6 evals, with exporters to AGENTS.md and Claude Code subagents. CI runs entirely on fake adapters; an env-gated real smoke covers the live path.

**Architecture:** New `src/harness/` sibling: `schema.ts` (zod artifact schemas + atomic writer/loader), `driver.ts` (promptForJson: fenced-JSON extraction + validation-feedback retry over a FrontierSession), `generate.ts` (the staged pipeline), `exporters.ts`, `methods.ts` (HarnessService + RPCs + `harness.progress` notifications). Design decision (binding): **generation sessions stay READ-ONLY** — the frontier proposes artifact content as JSON; the engine validates and writes. The per-session write-policy plumbing (M3 inherit #1) is still built in Task 1 — M5 workers and future flows need it — but harnessgen v1 does not depend on model-driven file writes.

**Tech Stack:** Everything already landed (frontier sessions, wiki MCP, models meter). No new dependencies expected; `yaml` (eemeli) may be added for routing.yaml/agents emit — verify at Task 2 install step.

## Global Constraints

- Everything standing (strict TS NodeNext, tsconfig.test coverage, stdout protocol purity, tmp fixtures, conventional commits + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, nothing under `.superpowers/`/`.claude/` of THIS repo committed, auth-agnostic, prompts never logged).
- **Validate-then-write:** no artifact reaches disk without passing its zod schema; writes are atomic (tmp file + rename) and confined to `<projectDir>/.openfusion/` (plus exporter targets `AGENTS.md`, `.claude/agents/` in the TARGET project when explicitly exported).
- **ETH hazard gate (spec §12.1):** `manifest.json` carries `verification: { structural: "pass", evals: "pending" }`; generate's result says so; README/exporter output includes the unverified caveat until M6 flips it.
- **Accounting caveat (M3 inherit #3):** frontier cost records are estimate-class; generate's result reports `estimatedCostUsd` with that caveat; timeout-aborted turns are unmetered (documented in driver comments).
- Generation is sequential: ONE frontier session, prompts one at a time (M3 inherit #4 satisfied by construction — comment it).
- CI: no `claude` binary — all generate-path tests use fake adapters; the real smoke is `OPENFUSION_CLAUDE_SMOKE`-gated.

---

### Task 1: Per-session tool policy + rate-limit events (engines layer)

**Files:**
- Modify: `packages/engine/src/engines/types.ts` (session opts gain policy), `src/engines/claude.ts`, `src/engines/methods.ts` (start schema), tests `frontier-claude.test.ts`, `frontier-methods.test.ts`

**Interfaces:**
- `FrontierAdapter.createSession` opts gain `toolPolicy?: { writeScope?: string[] }` — absent = read-only (today's behavior, unchanged defaults). With `writeScope`, the Claude adapter's `canUseTool` ALLOWS `Write`/`Edit`/`MultiEdit`/`NotebookEdit` tool calls whose target path (input.file_path / input.path — inspect the SDK's tool input shapes via sdk.d.ts and handle both spellings defensively) resolves (path.resolve) INSIDE one of the writeScope directories; everything else still denied. **Write tools are NEVER added to `allowedTools`** (SDK shadowing bypasses canUseTool — the corrected M3 design record governs).
- `engine.frontier.start` schema gains `writeScope?: string[]` (each entry must be a relative path — resolved against projectDir; reject absolute paths with INVALID_PARAMS).
- Rate-limit visibility (M3 inherit #2): the Claude adapter maps assistant-message-level API errors (rate_limit/overloaded shapes per sdk.d.ts — inspect `SDKAssistantMessage` for the error field) to a new `FrontierEvent` variant `{ type: "notice"; kind: "rate_limit" | "overloaded" | "api_error"; message: string }` — added to the FrontierEvent union in types.ts; the RPC layer streams it like any event (no behavior change otherwise).
- [ ] Steps: failing tests (canUseTool closure unit tests: in-scope Write allowed, out-of-scope denied, traversal `../` escape denied, absolute-path writeScope rejected at RPC layer, default still deny-all; notice-event mapping via fake queryFn emitting an error-shaped assistant message) → RED → implement → GREEN (exact totals) → commit `feat(engine): path-scoped session write policy and rate-limit notice events`.

---

### Task 2: Harness artifact schemas + atomic store

**Files:**
- Create: `packages/engine/src/harness/schema.ts`, `packages/engine/src/harness/store.ts`
- Test: `packages/engine/test/harness-schema.test.ts`, `harness-store.test.ts`

**Interfaces (spec §4.3):**
- `schema.ts` zod schemas + inferred types:
  - `ManifestSchema`: `{ schemaVersion: 1, generatorVersion: string, engine: string, headSha: string, generatedAt: string (ISO), verification: { structural: "pass" | "fail", evals: "pending" | "pass" | "fail" } }`
  - `WikiPageSchema`: `{ slug: string (kebab), title: string, digest: string (≤ 1200 chars — the token-budgeted summary agents consume), body: string (markdown) }` — canonical page set constant `WIKI_PAGE_SLUGS = ["architecture", "subsystems", "conventions", "build-and-test"]`.
  - `AgentDefSchema`: `{ name: kebab string, role: string, description: string, prompt: string, taskClasses: string[] (nonempty), model: { kind: string, model: string } | "frontier", escalation: { maxAttempts: int 1..3 } }`
  - `RoutingSchema`: `{ version: 1, taskClasses: Record<string, { agent: string }>, escalation: { failuresBeforeFrontier: int 1..3 }, defaults: { agent: string } }` — cross-validation helper `validateHarness(bundle)`: every routing agent exists in agents; every agent's taskClasses appear in routing; returns typed issues list.
  - `HarnessBundleSchema`: `{ manifest, pages: WikiPage[], agents: AgentDef[], routing }`.
- `store.ts`: `harnessDir(projectDir)`; `writeHarness(projectDir, bundle): Promise<{ files: string[] }>` — atomic per file (tmp+rename), layout: `manifest.json`, `wiki/<slug>.md` (frontmatter title+digest, body below), `agents/<name>.yaml`, `routing.yaml`; ensures `.openfusion/.gitignore` still contains `cache/` (reuse/keep wiki's guard); `loadHarness(projectDir): HarnessBundle | null` (null when absent; throws typed error on invalid); `harnessStatus(projectDir): { present: boolean, structural: "pass"|"fail"|null, evals: string|null, headSha: string|null }`.
- Install `yaml` if needed for agents/routing emit+parse (`pnpm add yaml --filter @openfusion/engine`) — verify import.
- [ ] Steps: failing tests (schema accept/reject per field family; cross-validation catches dangling agent refs; write→load round-trip byte-stable; atomicity: writer leaves no partial file on injected serialize error; gitignore guard) → RED → implement → GREEN → commit `feat(engine): harness artifact schemas and atomic store`.

---

### Task 3: Generation driver — promptForJson + progress notifications

**Files:**
- Create: `packages/engine/src/harness/driver.ts`
- Test: `packages/engine/test/harness-driver.test.ts`

**Interfaces:**
- `promptForJson<S extends z.ZodType>(session: FrontierSession, prompt: string, schema: S, opts: { retries?: number (default 1), notify?: (e: DriverNotice) => void }): Promise<{ value: z.infer<S>, attempts: number, costUsd: number | null }>` — collects the session's text events; extracts the LAST fenced ```json block (or whole-text JSON fallback); zod-parse; on failure and retries remaining, re-prompts with: the validation issues + "Respond with ONLY a corrected JSON code block." Aggregates costUsd across attempts from result events. Throws `HarnessGenError` (typed: stage, attempts, issues) on exhaustion.
- `DriverNotice = { kind: "attempt" | "validation-retry" | "notice", detail: string }` — surfaced by callers as `harness.progress` notifications.
- Uses ONLY the FrontierSession contract (prompt handles/events) — fully testable with fake sessions.
- [ ] Steps: failing tests (happy path fenced JSON; dirty output with prose around the block; invalid-then-corrected retry flow asserts the retry prompt CONTAINS the zod issue text; exhaustion throws HarnessGenError with issues; cost aggregation across attempts; notice callback fired per attempt) → RED → implement → GREEN → commit `feat(engine): frontier JSON elicitation driver with validation-feedback retry`.

---

### Task 4: engine.harness.generate — the pipeline

**Files:**
- Create: `packages/engine/src/harness/generate.ts`, `packages/engine/src/harness/methods.ts`
- Modify: `packages/engine/src/engine.ts` (HarnessService + re-exports)
- Test: `packages/engine/test/harness-generate.test.ts`; env-gated `harness-generate-smoke.test.ts`

**Interfaces:**
- `HarnessService` on Engine (sibling pattern); `engine.harness.generate { projectDir }` → `{ files: string[], reportCard: { structural: "pass", evals: "pending" }, estimatedCostUsd: number | null, pages: number, agents: number }`; `engine.harness.status { projectDir }` → store's harnessStatus; concurrent generate per project coalesces (same pattern as wiki build).
- Pipeline stages (each emits `harness.progress { projectDir, stage, detail }` notifications: `wiki-check`, `overview`, `page:<slug>` ×4, `agents-routing`, `write`, `verify`):
  1. Ensure wiki built (build if stale/absent) + MCP server started; frontier session started READ-ONLY with wiki attached.
  2. `overview`: promptForJson → `OverviewSchema` `{ summary: string, subsystems: [{name, path, purpose}], conventions: string[], buildCommands: string[], testCommands: string[] }` — prompt instructs use of wiki_map/wiki_query first (token thrift).
  3. Per wiki page slug: promptForJson → `{ title, digest, body }` (page prompts receive the overview JSON as context, NOT re-exploration).
  4. `agents-routing`: prompt includes the configured worker models from `engine.models` registry+pricing (id/kind/model + $/Mtok) and instructs: propose 2–5 specialist agents mapped to task classes (codegen/docs/tests/search/refactor at minimum), each assigned the cheapest adequate worker model, plus routing.yaml content with `failuresBeforeFrontier: 2` default → promptForJson against a combined `{ agents, routing }` schema.
  5. Assemble bundle: manifest (generatorVersion = ENGINE_VERSION, headSha via getHeadSha, verification structural per validateHarness result, evals "pending"); `validateHarness` MUST pass (issues → HarnessGenError, nothing written); `writeHarness`; session closed (finally).
  6. Result includes the ETH caveat in a `note` field: "harness is UNVERIFIED until evals run (M6)".
- Failure semantics: any stage's HarnessGenError → SERVER_ERROR with `data: { stage, issues }`; session always closed; nothing partially written (write is the last stage).
- [ ] Steps: failing tests with a SCRIPTED fake adapter (a fake session whose Nth prompt returns the Nth canned response — build the helper): full-pipeline happy path (assert files on disk, manifest fields, notification stage sequence, session closed); validation-retry path (stage 2 returns bad JSON once); hard-failure path (exhaustion at page stage → SERVER_ERROR data.stage === "page:architecture", NO .openfusion writes beyond wiki cache); status RPC; coalescing. Env-gated smoke: real generate on a tmp clone of THIS repo, assert 4 pages + ≥2 agents + validateHarness pass (authored, skipped in CI). → RED → implement → GREEN → commit `feat(engine): frontier-driven harness generation pipeline with structural gate`.

---

### Task 5: Exporters + docs

**Files:**
- Create: `packages/engine/src/harness/exporters.ts`
- Modify: `packages/engine/src/harness/methods.ts` (export RPC), `README.md`
- Test: `packages/engine/test/harness-export.test.ts`

**Interfaces:**
- `engine.harness.export { projectDir, format: "agents-md" | "claude-subagents" }` → `{ files: string[] }`. Requires a loaded valid harness (else SERVER_ERROR).
  - `agents-md`: writes `<projectDir>/AGENTS.md` — project summary (from architecture digest), build/test commands, conventions, agent roster table, and the UNVERIFIED caveat line while `evals: "pending"`.
  - `claude-subagents`: writes `<projectDir>/.claude/agents/<name>.md` per agent — YAML frontmatter (name, description, model: map worker kind/model to a `model:` hint comment since Claude Code models differ — emit as comment line; tools: read-only defaults) + prompt body + digest of the relevant wiki pages. NOTE: this writes into the TARGET project's `.claude/` (that is the point — interop); our own repo's ignore rules are irrelevant to targets, but the export test must use a tmp fixture project, never this repo.
- README: status paragraph update + "Generating a harness" quickstart (generate → status → export) with the unverified caveat.
- [ ] Steps: failing tests (both formats against a fixture harness bundle written via store: file contents contain roster/caveat/frontmatter fields; export without harness → SERVER_ERROR; re-export overwrites cleanly) → RED → implement → GREEN → commit `feat(engine): AGENTS.md and Claude Code subagent exporters`.

---

## Milestone exit checklist

- [ ] Full suite green from clean checkout, no claude binary
- [ ] Operator (authed machine): `OPENFUSION_CLAUDE_SMOKE=1 pnpm --filter @openfusion/engine test -- harness-generate-smoke` — real generation on this repo's clone produces a valid, committable `.openfusion/` harness
- [ ] Manual: `engine.harness.export` both formats on the generated harness; eyeball AGENTS.md quality
- [ ] Next per roadmap: M5 (orchestrator runtime) — worker loop on open models, review gate, escalation; plan-time: worker tool design (bash/edit via our own loop), worktree isolation, messages-schema extension for tool calls (M2 carry)
