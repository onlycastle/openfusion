# Design: Project-Centric Cockpit — Two-Rail Shell + Harness Setting

**Date:** 2026-07-06
**Status:** Approved design, pre-implementation
**Supersedes for Settings/IA:** the two-flat-list Settings dialog (Orchestrators + Model providers)
**Parent spec:** `docs/superpowers/specs/2026-07-03-harness-fusion-app-design.md`

## 1. Problem

The desktop app surfaces model configuration as **two disconnected flat
lists** in a global Settings modal — an Orchestrators group (frontier CLIs)
and a Model providers group (BYOK workers) — that never show the
*relationship* between them. Meanwhile the thing a user most wants to see and
tune — *which model each member of a project's harness team uses* — has **no
UI at all**: it lives only in per-repo `.openfusion/routing.yaml` +
`agents/<name>.yaml`, editable today only by hand.

Two consequences:

- Model routing is invisible. The app's whole thesis is cost routing (cheap
  worker → frontier review → escalate), but nothing renders the routing map.
- Projects are ephemeral. `projectDir` is screen-local state, chosen through a
  one-shot folder dialog and forgotten; there is no way to keep several
  projects at hand and jump between their harness configs.

## 2. Goal

A **project-centric cockpit**: pick a project from a persistent list, and
directly see and edit its harness team's model assignments — the orchestrator
at the root, its generated agent team as children, each child's model
selectable from the user's BYOK pool.

**Success:** a user can (a) keep multiple projects in a switchable list, and
(b) for the active project, open "Harness setting" and reassign any agent's
model (or the escalation threshold) in one click, with the change persisted to
that repo's `.openfusion/`.

## 3. Locked Decisions (from brainstorming, 2026-07-06)

| Decision | Choice |
|---|---|
| Shape | The tree is a **routing/model control surface**, not a static picture. |
| Scope | **Per-project** harness settings (not a global routing policy), surfaced through project-centric navigation. |
| Navigation | **Two-rail left sidebar** + a main content pane (three-pane shell). |
| Rail 1 (app) | Brand · Studio · **persisted Projects list** (+ Add / Remove) · Settings (gear → existing global modal). |
| Rail 2 (active project) | **Chat** · **Harness setting** · **Evals** (Evals moves here — it is per-project). |
| Editable in v1 | Each agent (child) **model** + the **escalation** threshold. |
| Read-only in v1 | Task-classes (chips), agent prompts/roles, team composition, orchestrator root. |
| Global Settings modal | **Kept** as the home for credentials (orchestrator connect + BYOK keys). |
| Chat history persistence | **Deferred** — Rail 2 "Chat" shows the live session only in v1. |

## 4. Architecture

### 4.1 Information architecture — the three-pane shell

Replace the single `.sidenav` + top-level route switch with a project-centric
three-pane shell:

```
┌───────────┬────────────────────┬──────────────────────────────┐
│ RAIL 1    │ RAIL 2             │ MAIN                          │
│ (app)     │ (active project)   │                              │
│  ◆ Studio │  <project name>    │  (renders the Rail 2          │
│  PROJECTS │  › Chat            │   section for the active      │
│  • openf… │  › Harness setting │   project)                    │
│  • webapp │  › Evals           │                              │
│  + Add    │                    │                              │
│  ⚙ Settings│                   │                              │
└───────────┴────────────────────┴──────────────────────────────┘
```

- **Rail 1 (app):** brand, a `Studio` marker, the **Projects list** (persisted,
  switchable, `+ Add`, right-click Remove), and `Settings` (gear → the
  existing global modal, unchanged).
- **Rail 2 (active project):** header = active project name; sections = **Chat**,
  **Harness setting**, **Evals**. The selected section decides what MAIN renders.
- **MAIN:** renders the selected section for the active project.

### 4.2 Shared project context (the spine)

The load-bearing refactor: lift project selection out of the screens into a
**`ProjectContext`** provided at `App`, holding `activeProjectDir` and the
project list. `OrchestrateScreen` and `EvalsScreen` stop owning `projectDir`
and read it from context; the composer's folder-chip picker is demoted to the
Rail 1 `+ Add` affordance. One source of truth; every pane reacts to the
active project.

This is the only genuinely invasive change — it rewires how the two existing
screens obtain `projectDir`. Everything else in this spec is additive.

### 4.3 Project registry (persistence)

Reuse the host-owned non-secret metadata pattern already proven for BYOK
provider metadata (a JSON store in the app data dir) — no new infrastructure.

- Entry: `{ path, name, addedAt, lastOpenedAt }`. Identity = **absolute path**.
- **Add** via existing `open({ directory: true })`. **Remove** is metadata-only
  — it never touches the repo or its `.openfusion/`.
- On launch, Rail 1 hydrates from the store ordered by `lastOpenedAt`; the most
  recent project is re-selected into `ProjectContext`.

### 4.4 Harness setting panel (the tree)

```
  Claude Code   orchestrator · frontier          (root — read-only)
  │
  ├─ coder          codegen · fix     [ DeepSeek · deepseek-v4-flash ▾ ]
  ├─ test-writer    tests             [ Moonshot · kimi-k2.7-code    ▾ ]
  ├─ doc-writer     docs              [ Z.ai · glm-5.2               ▾ ]
  └─ default        refactor          [ frontier                     ▾ ]

  Escalate to frontier after  [ 2 ▾ ]  failed attempts
```

- **Root** = the connected orchestrator (frontier), read-only (managed in
  Settings).
- **Children** = the project's generated agent team (`loadHarness().agents`).
  Each row: agent name + role, its `taskClasses[]` as read-only chips, and a
  **model dropdown** whose options are `frontier` + every configured BYOK
  model from the global pool.
- **Escalation knob** = `routing.escalation.failuresBeforeFrontier` (1–3).
- **Non-ready states reuse the existing flow:** no harness → "Generate harness"
  (the build action relocates here from Studio's setup view); stale/invalid →
  rebuild; empty pool → "Add a provider in Settings."
- Edits apply optimistically (mirroring the provider pane's optimistic
  Remove), reconciling on RPC failure.

### 4.5 New engine RPCs (+ frontend wrappers)

Three thin methods over primitives that already exist (`loadHarness` /
`validateHarness` / `writeHarness` in `packages/engine/src/harness/store.ts`):

| RPC | Behavior |
|---|---|
| `engine.harness.read(projectDir)` | `loadHarness` → trimmed UI shape: `{ agents: [{ name, role, taskClasses, model }], defaults, escalation }`. Omits wiki bodies and agent prompts. Returns a "no/invalid harness" signal the panel maps to its generate/rebuild states. |
| `engine.harness.updateAgentModel(projectDir, agentName, model)` | load → mutate the one agent's `model` → `validateHarness` → atomic `writeHarness`. Rejects unknown agent, invalid model kind, or a change that would dangle a routing reference. |
| `engine.harness.updateEscalation(projectDir, n)` | load → set `routing.escalation.failuresBeforeFrontier` (clamped 1–3) → `writeHarness`. |

Both writers **preserve manifest provenance** — hand-edits are sanctioned
(parent spec §7.4), so the manifest's `artifacts` list and generation metadata
survive the rewrite. Frontend `engineClient` gets matching wrappers, mirroring
the existing `models.*` methods.

## 5. Data Flow (before → after)

- **Before:** Settings modal reads/writes the global provider registry;
  `OrchestrateScreen` privately picks and holds `projectDir`; harness
  model/routing is write-by-hand only.
- **After:** Rail 1 reads the project registry → sets `activeProjectDir` in
  `ProjectContext`; Rail 2 + MAIN read that context; Harness setting reads via
  `engine.harness.read` and writes via `engine.harness.updateAgentModel` /
  `updateEscalation` → `writeHarness` → `.openfusion/`. Global Settings modal is
  unchanged and still owns credentials.

## 6. Scope Boundaries (v1 non-goals)

- **Chat-history persistence** — live session only; saved/reloadable sessions
  are the fast-follow (needs a session store).
- **Task-class ↔ agent remapping** — read-only chips; changing
  `routing.taskClasses` is out (structurally deeper, can dangle refs).
- **Editing agent prompts / roles / adding-removing agents** — team
  composition is the generator's job; v1 tunes models + escalation only.
- **Multi-orchestrator per project** — root shows the single connected
  orchestrator.

## 7. Testing

- **Engine (`harness/*.test.ts`):** `read` shapes the bundle correctly;
  `updateAgentModel` round-trips load→validate→write and **rejects** unknown
  agent / invalid model kind / dangling ref; `updateEscalation` clamps to 1–3;
  manifest provenance survives a write.
- **Frontend (`*.test.tsx`):** shell renders both rails; switching a project
  updates `ProjectContext` and MAIN; the tree renders agents from a mocked
  `harness.read`; a dropdown change calls `updateAgentModel` and reflects
  optimistically; empty-pool CTA; no-harness → generate flow.

## 8. Implementation Sequencing (risk-ordered)

1. **Shell + `ProjectContext` refactor** (the only invasive step) — land the
   three-pane shell and lift `projectDir` into context with the existing
   Studio/Evals screens still green.
2. **Project registry** — host-owned store + Rail 1 add/remove/hydrate.
3. **Engine RPCs** — `harness.read` / `updateAgentModel` / `updateEscalation`
   + `engineClient` wrappers, with engine tests.
4. **Harness setting panel** — the tree UI on top of the RPCs, incl. non-ready
   states and empty-pool CTA.
5. **Evals relocation** — move Evals into Rail 2 as a per-project section.
