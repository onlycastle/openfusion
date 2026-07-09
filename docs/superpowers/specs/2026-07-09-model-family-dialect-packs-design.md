# Model Family + Dialect Packs (Phase 1) — Design

**Date:** 2026-07-09 · **Status:** approved strategy with amendments (this doc is the Phase-1 PR-sized artifact)
**Supersedes / extends:** strategic read on multi-family harness generation (session 2026-07-09); does **not** replace wiki/card, routing v1 runtime, or run-ledger design — it layers family/dialect as first-class objects underneath them.
**Related code today:**
- `packages/engine/src/harness/schema.ts` — `AgentModel` = `{ kind, model, providerId? } | "frontier"`; `RoutingSchema.version` is `literal(1)` only
- `packages/engine/src/harness/generate.ts` — `FRONTIER_KIND = "claude-code"` hardcoded; model menu = pricing ∩ configured providers
- `packages/engine/src/worker/tools.ts` — one shared toolset (`bash`, `read_file`, `write_file`, `edit(path, find, replace)`, optional wiki tools)
- `packages/engine/src/worker/loop.ts` — single `WORKER_INSTRUCTIONS` string for every open model
- `packages/engine/src/orchestrate/routing.ts` — keyword classifier only; `agent.escalation.maxAttempts` informational
- `packages/engine/src/orchestrate/orchestrate.ts`, `evals/run.ts`, `evals/bench/runner.ts` — same Claude-only frontier kind

---

## 1. Problem

Open-weight coding models (Kimi, GLM, DeepSeek, Qwen, …) are good enough that users want “Claude Code / Codex / OpenCode productivity” on those models. The market response so far is mostly **API gateways** (claude-code-router, LiteLLM Anthropic-compat endpoints, Z.ai Anthropic base URL). Those translate **wire formats**. They do **not** retune:

- edit tool shape,
- system-prompt skeleton,
- tool budget,
- retry / recovery text,
- compaction thresholds,
- export identity files.

Public evidence says that gap is first-order, not polish:

| Claim | Source | Use in this doc |
|---|---|---|
| Harness choice moves Pass@1 by **27.4 pp** on Qwen 3.6-flash and **12.5 pp** on GLM 5.1 under a fixed outer protocol; bare vs full adapter is 19.1% → 73.4% on the same GLM 5.1 backbone | Claw-SWE-Bench (arXiv:2606.12344) | Primary quantitative anchor for “adapter/harness is not a wrapper” |
| Evaluations must report **model + harness configuration**, not models alone; harness can dominate model variance on long-horizon tasks | Zhang et al., “Stop Comparing LLM Agents Without Disclosing the Harness” (arXiv:2605.23950) | Eval reproducibility / report-card fields |
| OpenAI-trained models prefer **patch** edit formats; Anthropic-trained models prefer **string replacement**; wrong format costs reasoning tokens and raises mistakes — Cursor provisions each model its training-time tool format | Cursor, “Continually improving our agent harness” (2026-04-30) | Dialect pack owns **edit dialect** |
| LLM-generated bulk context often **hurts** quality and raises cost; keep always-on context minimal and non-inferable | ETH/LogicStar AGENTS.md study (arXiv:2602.11988) — already load-bearing for Project Card | Unchanged; family packs must not dump more always-on prose |

**OpenFusion-specific failure mode today:** agent assignment is a thin `{ kind, model, providerId }` string pair over a **single** worker tool path and a **single** instruction block. A “Kimi family” label without a different runtime is marketing on the same old `edit(find, replace)` path.

---

## 2. Decisions (locked for Phase 1)

### 2.1 Runtime-first, with an honest frontier scope

| Decision | Choice |
|---|---|
| Product shape | **Runtime-first** (already locked in 2026-07-03 design). OpenFusion owns the worker loop. Foreign CLIs are **export surfaces**, not the quality path. |
| Frontier runtime in Phase 1 | **Claude-only.** `FRONTIER_KIND = "claude-code"` remains the generate / review / escalate engine. Codex App Server stays a later engine adapter. |
| What “codex-like / claude-like / opencode-like” means in v1 | **Thin harness profiles** = policy bundles (prompt budget, toolset size, edit-dialect preference for exports, compaction threshold, permission posture, export target). **Not** cloned runtimes. |
| What actually changes worker behavior | **Dialect packs** — code objects that build tools, prompts, limits, retry text, and telemetry labels. |
| Eval unit | `(project, harnessProfile, dialectPack, model, routeId)` must be reconstructable from manifest + run records. |

**Explicit non-promise (Phase 1):** “Codex-like profile” does **not** mean Codex-native runtime behavior (apply_patch training distribution, sandbox isolation, Submission/Event protocol). It means OpenFusion-native worker + policy/export tilt. Full Codex-like runtime requires a first-class frontier engine selection milestone (post–Phase 1).

### 2.2 What ships in Phase 1 vs later

| In Phase 1 | Deferred |
|---|---|
| `ModelFamily` + `DialectPack` schemas | Full routing v2 candidate chains (class+difficulty+capabilities → chain) |
| Bundled catalog with provenance | Learned / DashBench-driven reordering of chains |
| Harness schema v2 + **v1→v2 upgrader** | Multi-frontier engine selection UI |
| `createWorkerRuntime(dialectPack)` | Parallel multi-writer collaboration / blackboard |
| Tool-error + edit-fail telemetry on every worker run | Provider health / quota plane |
| Catalog-driven generation model menu | Rich “claude-like” hook/skill cloning |
| Thin `harnessProfile` enum on manifest | Deep profile matrices |

**Gate to unlock richer profiles:** dialect packs must produce **measurable** differences (edit_fail_rate and/or harness eval quality) before we expand the profile matrix.

---

## 3. Design at a glance

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Bundled catalog (engine-shipped, versioned)                             │
│    families.yaml / packs.ts  + provenance                                │
│    ModelFamily ──defaultDialect──▶ DialectPack                           │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
         generateHarness        │         worker.run / orchestrate
                │               │                │
                ▼               │                ▼
   agents[].model = {           │     createWorkerRuntime(pack)
     family, model,             │       ├─ tools (schemas + execute)
     providerId, dialectPack?   │       ├─ system / task prompt skeleton
   } | "frontier"               │       ├─ maxSteps, tool budget
   routing stays v1-compatible  │       ├─ retry / recovery text
   OR v2-shaped after upgrade   │       └─ telemetry counters
                │               │                │
                ▼               │                ▼
   manifest v2:                 │     run record (orchestrate):
     harnessProfile             │       family, dialectPack, routeId,
     familyCatalogVersion       │       toolCallCounts, toolErrorCounts,
     dialectPackVersion         │       editFailCount, attempts
     routePolicyVersion         │
```

---

## 4. Schemas

### 4.1 ModelFamily (catalog object — not written per-agent)

```ts
// packages/engine/src/models/catalog.ts (new)
const ModelFamilySchema = z.object({
  id: kebabString(),                    // "kimi" | "glm" | "deepseek" | "qwen" | "minimax" | "claude-frontier" | "openai-codex"
  displayName: z.string().min(1),
  providerKinds: z.array(z.string().min(1)).min(1), // matches ProviderRegistry kinds
  // Optional model id globs / exact ids this family claims when resolving
  // a bare pricing key → family. Exact match wins over prefix.
  modelMatchers: z.array(z.string().min(1)).min(1),
  contextWindow: z.number().int().positive(),
  capabilities: z.array(z.enum([
    "coding", "tools", "long-ctx", "reasoning", "cheap-bulk", "frontier-plan",
  ])).min(1),
  costTier: z.enum(["frontier", "mid", "cheap"]),
  latencyTier: z.enum(["fast", "mid", "slow"]),
  cacheBehavior: z.enum(["strong", "weak", "unknown"]).default("unknown"),
  bestFor: z.array(z.string()).default([]),
  avoidFor: z.array(z.string()).default([]),
  defaultDialectPack: kebabString(),    // must exist in DialectPack catalog
  // Provenance for reproducibility — never silent folklore
  provenance: z.object({
    source: z.string().min(1),          // URL or "openfusion-bundled"
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().optional(),
  }),
  // Optional static scores (not runtime-learned in Phase 1)
  evalScores: z.record(z.string(), z.number()).optional(),
});
```

**Resolution rule:** given `(provider.kind, modelId)`, pick the family whose `providerKinds` contains `kind` and whose `modelMatchers` matches `modelId` (exact > prefix > `*`). If none match → family `"generic-openai"` with dialect pack `"string-edit-default"`.

### 4.2 DialectPack (runtime-owning object)

A pack is **not** YAML metadata alone. The on-disk/catalog *description* is serializable; the **implementation** is TypeScript that builds a runtime.

```ts
const DialectPackMetaSchema = z.object({
  id: kebabString(),                    // "string-edit-default" | "string-edit-strict" | "whole-file-prefer" | "apply-patch-v1"
  version: z.string().min(1),           // semver string, e.g. "1.0.0"
  editDialect: z.enum([
    "string-replace",                   // current edit(find, replace)
    "whole-file",                       // prefer write_file; edit optional/disabled
    "apply-patch",                      // Phase 1 may stub; full impl can ship later if tests ready
  ]),
  // Policy knobs the runtime consumes
  toolset: z.enum(["minimal", "standard", "standard+wiki"]),
  maxSteps: z.number().int().min(1).max(80).default(30),
  // Soft token budget for system/instruction text (chars, not tokens — cheap proxy)
  promptBudgetChars: z.number().int().positive().default(2000),
  // Compaction: worker loop is single-shot multi-step today; this is a
  // future hook + export of intent. Phase 1 stores it and applies only if
  // loop supports mid-run compression (else no-op with test documenting that).
  compactionThresholdSteps: z.number().int().min(0).default(0), // 0 = off
  permissionPosture: z.enum(["permissive-worker", "read-prefer", "no-bash"]).default("permissive-worker"),
  // Provenance
  provenance: z.object({
    source: z.string().min(1),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    notes: z.string().optional(),
  }),
});
```

**Runtime interface (code, not zod):**

```ts
export interface WorkerRuntime {
  dialectPackId: string;
  dialectPackVersion: string;
  editDialect: DialectPackMeta["editDialect"];
  /** AI SDK tools record — path-scoped, same containment as today */
  tools: Record<string, Tool>;
  /** Full system/instruction block (replaces hardcoded WORKER_INSTRUCTIONS) */
  instructions: string;
  maxSteps: number;
  /** Optional text appended after a tool error before the next model step */
  retryHintFor(tool: string, errorKind: ToolErrorKind): string | undefined;
  /** Labels every counter must carry */
  telemetryBase: {
    dialectPack: string;
    dialectPackVersion: string;
    editDialect: string;
  };
}

export type ToolErrorKind =
  | "not_found"
  | "not_unique"          // edit find matched 0 or >1
  | "containment"
  | "invalid_args"
  | "io"
  | "timeout"
  | "aborted"
  | "unknown";

export function createWorkerRuntime(
  pack: DialectPackMeta,
  ctx: ToolContext,
  opts?: { includeWikiTools?: boolean },
): WorkerRuntime;
```

**Pack must own (review High — non-negotiable):**

| Surface | Today | Phase 1 |
|---|---|---|
| Tool schemas | shared `createWorkerTools` | pack selects which tools + edit schema variant |
| Prompt skeleton | `WORKER_INSTRUCTIONS` constant | pack-built `instructions` (+ optional specialist agent.prompt still appended by orchestrator) |
| Tool budget | `maxSteps` only at call site | pack default `maxSteps`; caller may still override with explicit RPC param |
| Retry text | none | `retryHintFor` for edit/not_unique, not_found |
| Compaction policy | none | field present; apply when loop supports it |
| Telemetry counters | `toolCallCounts` only | calls **and** errors by kind; edit fails first-class |

**Phase 1 shipped packs (minimal viable set):**

| Pack id | Edit dialect | Intent |
|---|---|---|
| `string-edit-default` | string-replace | Current behavior, explicit pack id for reproducibility |
| `string-edit-strict` | string-replace | Tighter edit description + stronger uniqueness/retry hints (for families that over-edit) |
| `whole-file-prefer` | whole-file | `write_file` primary; `edit` removed or demoted — for models that botch find/replace |
| `apply-patch-v1` | apply-patch | **Optional** if implementable in same PR; otherwise meta-only + “not wired” until Phase 1.1 — must not claim runtime support without tests |

Default mapping (catalog, adjustable):

- kimi, glm, qwen, deepseek, minimax → `string-edit-default` (or `string-edit-strict` after first smoke data)
- generic-openai → `string-edit-default`
- claude-frontier / openai-codex → not used for open workers; frontier path unchanged

### 4.3 Harness profile (thin enum)

```ts
const HarnessProfileSchema = z.enum([
  "openfusion-native",  // default — standard tools, ETH-minimal card, AGENTS.md export
  "claude-like",        // larger prompt budget, standard+wiki bias, claude-subagents export tilt
  "codex-like",         // prefer apply-patch pack when available, AGENTS.md export tilt
  "opencode-like",      // multi-model menu emphasis, opencode export when added
  "pi-like",            // minimal toolset, smallest prompt budget
]);
```

Profiles **do not** fork the orchestrator. They resolve to:

```ts
interface ProfilePolicy {
  promptBudgetChars: number;
  toolset: "minimal" | "standard" | "standard+wiki";
  preferredEditDialect: DialectPackMeta["editDialect"];
  compactionThresholdSteps: number;
  permissionPosture: DialectPackMeta["permissionPosture"];
  exportFormatDefault: "agents-md" | "claude-subagents"; // opencode later
}
```

Resolution order for a worker run:

1. Agent’s explicit `dialectPack` (if set)  
2. Family’s `defaultDialectPack`  
3. Profile’s `preferredEditDialect` only as a **soft preference** when generating a new harness (not as a silent runtime override of an explicit pack)  
4. Fallback `string-edit-default`

### 4.4 Agent model assignment (v2)

```ts
// Replaces / extends AgentModelSchema
const AgentModelObjectSchema = z.object({
  kind: z.string().min(1),
  model: z.string().min(1),
  providerId: z.string().optional(),
  // NEW — optional on disk for upgraded bundles; required after generate v2
  family: kebabString().optional(),
  dialectPack: kebabString().optional(),
});
const AgentModelSchema = z.union([AgentModelObjectSchema, z.literal("frontier")]);
```

`routeTask` resolution after upgrade:

```ts
resolution:
  | { providerId: string; model: string; family: string; dialectPack: string }
  | "frontier"
```

### 4.5 Routing: compatibility without full v2 chains

**Phase 1 does not require full candidate-chain routing.** It does require a version field that can grow.

```ts
// Accept v1 and a forward-compatible v2 shell
const RoutingV1Schema = z.object({
  version: z.literal(1),
  taskClasses: z.record(z.string(), z.object({ agent: z.string() })),
  escalation: z.object({ failuresBeforeFrontier: z.number().int().min(1).max(3) }),
  defaults: z.object({ agent: z.string() }),
});

// v2 Phase-1 shape: same routing power as v1, plus optional route ids for telemetry
const RoutingV2Schema = z.object({
  version: z.literal(2),
  taskClasses: z.record(z.string(), z.object({
    agent: z.string(),
    // Stable id for telemetry; defaulted by upgrader to `tc:<taskClass>`
    routeId: z.string().min(1).optional(),
  })),
  escalation: z.object({ failuresBeforeFrontier: z.number().int().min(1).max(3) }),
  defaults: z.object({ agent: z.string(), routeId: z.string().optional() }),
  // Reserved empty for Phase 2 chains — must parse if present as empty object
  chains: z.record(z.string(), z.unknown()).optional(),
});

const RoutingSchema = z.union([RoutingV1Schema, RoutingV2Schema]);
```

Runtime always normalizes to an **internal RoutingV2** via `upgradeRouting(r)`.

### 4.6 Manifest v2 fields

```ts
// Additive fields on ManifestSchema — all optional on read for v1 manifests,
// required on write after Phase-1 generate.
const ManifestV2Extras = {
  // Bump when this design ships: schemaVersion stays 1 OR we introduce
  // schemaVersion: 2. Decision: **schemaVersion: 2** for any bundle that
  // includes family/dialect fields, so evals can refuse ambiguous mixes.
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  harnessProfile: HarnessProfileSchema.optional(),       // default openfusion-native on upgrade
  familyCatalogVersion: z.string().optional(),           // e.g. "2026.07.09"
  dialectPackVersion: z.string().optional(),             // catalog snapshot id OR max pack semver set
  routePolicyVersion: z.string().optional(),             // "1" | "2" matching routing.version string
};
```

**Reproducibility rule:** an eval report card must echo:

- `manifest.schemaVersion`
- `manifest.harnessProfile`
- `manifest.familyCatalogVersion`
- `manifest.dialectPackVersion`
- `manifest.routePolicyVersion`
- per-task: `family`, `dialectPack`, `routeId`, `workerModel`

Without those, a “pass” is not comparable across generator versions.

---

## 5. Schema migration story

### 5.1 Load path (always)

```
loadHarness(projectDir)
  → parse JSON/YAML artifacts
  → if manifest.schemaVersion === 1 OR routing.version === 1 OR agent.model lacks family:
        bundle = upgradeHarnessV1ToV2(bundle, catalog)
  → validateHarness(bundle)  // v2 cross-refs including dialect pack ids
  → return bundle
```

Upgrader is **pure** and **deterministic**: same catalog version → same upgraded bytes (except we do **not** rewrite disk until the next `writeHarness` / explicit migrate).

### 5.2 `upgradeHarnessV1ToV2` rules

| Input | Output |
|---|---|
| `manifest.schemaVersion: 1` | `2` |
| missing `harnessProfile` | `"openfusion-native"` |
| missing catalog versions | fill from engine-bundled catalog constants |
| `routing.version: 1` | `version: 2`, each taskClass gets `routeId: "tc:<name>"`, defaults get `routeId: "tc:default"` |
| agent `model: "frontier"` | unchanged |
| agent `model: { kind, model, providerId? }` | add `family` via catalog resolve; add `dialectPack` from family’s default |
| unknown model | `family: "generic-openai"`, `dialectPack: "string-edit-default"` |
| agent has unknown explicit `dialectPack` | validation **error** after upgrade (do not invent) |

### 5.3 Write path

- New `generateHarness` always writes **schemaVersion 2**.
- Hand-edited v1 on disk continues to load via upgrade.
- Optional later RPC `engine.harness.migrate` rewrites on disk (not required for Phase 1 if load-time upgrade is enough for runtime; **evals that snapshot harness should call upgrade and record versions**).

### 5.4 Tests (migration)

1. Fixture: real v1 bundle (agents + routing v1 + manifest without new fields) → upgrades → structural pass.  
2. Round-trip: upgrade(v1) twice is idempotent on normalized form.  
3. Unknown dialectPack after hand-edit → structural fail with path `agents[i].model.dialectPack`.  
4. Eval fixture asserts report includes catalog versions.

---

## 6. Runtime changes

### 6.1 `createWorkerRuntime` (replace bare `createWorkerTools` as the orchestration entry)

`worker/methods.ts` today:

```ts
const tools = createWorkerTools({ ... onToolEvent counts calls only ... });
// loop uses hardcoded WORKER_INSTRUCTIONS
```

Phase 1:

```ts
const pack = resolveDialectPack(params.dialectPack ?? agent.model.dialectPack ?? default);
const runtime = createWorkerRuntime(pack, toolCtx, { includeWikiTools });
const result = await runWorkerLoop({
  model,
  task,
  wikiDigest,
  tools: runtime.tools,
  instructions: runtime.instructions,  // NEW on WorkerRunInput
  maxSteps: params.maxSteps ?? runtime.maxSteps,
  onToolEvent: (e) => { /* calls + errors */ },
});
```

`createWorkerTools` remains as a **building block** used by packs (shared path containment, bash, read). Packs compose; they do not fork containment logic.

### 6.2 Tool error taxonomy

Extend `onToolEvent` (or parallel `onToolResult`):

```ts
onToolEvent?: (e: {
  tool: string;
  detail: string;
  ok: boolean;
  errorKind?: ToolErrorKind;
}) => void;
```

Edit tool maps:

- find not in file → `not_found`  
- find matches >1 → `not_unique`  
- path escape → `containment`  

Aggregates returned from `worker.run` / orchestrate attempt:

```ts
toolCallCounts: Record<string, number>;
toolErrorCounts: Record<string, number>;      // key `${tool}:${errorKind}` or nested
editFailCount: number;                        // convenience for edit dialect packs
```

### 6.3 Frontier remains Claude-only

No change to `FRONTIER_KIND` in generate/orchestrate/evals in Phase 1. Document in code comments and this spec:

> Frontier seat is Claude Code. Profiles and dialect packs apply to **open workers** and **exports**. Claiming Codex-like *runtime* requires a separate frontier-engine milestone.

### 6.4 Generation uses catalog

`listWorkerModelOptions` today: pricing keys ∩ provider kinds.

Phase 1:

```ts
for (const option of pricing ∩ providers) {
  const family = resolveFamily(option.kind, option.model);
  options.push({
    ...option,
    family: family.id,
    dialectPack: family.defaultDialectPack,
    capabilities: family.capabilities,
    costTier: family.costTier,
    bestFor: family.bestFor,
  });
}
```

Agents-routing prompt includes family + dialect + bestFor/avoidFor so the frontier does not invent free-floating model ids. Generated agents must set `family` + `dialectPack` (validated).

---

## 7. Telemetry / run ledger (bring forward)

Do **not** wait for full routing v2 to record family/pack outcomes.

### 7.1 Orchestrate record extensions (compatible with run-ledger design)

Add optional fields to `kind: "orchestrate"` (and worker-level if recorded nested):

```ts
{
  // existing fields...
  family?: string;              // open worker family id; omit if frontier-only
  dialectPack?: string;
  dialectPackVersion?: string;
  routeId?: string;             // from routing v2 taskClasses[class].routeId
  harnessProfile?: string;
  toolCallCounts?: Record<string, number>;
  toolErrorCounts?: Record<string, number>;
  editFailCount?: number;
  // attempts already present
}
```

Content line unchanged: still no task text / diffs / prompts.

### 7.2 Why this is Phase 1

- Dialect pack A/B without counters is faith-based.  
- Phase 2 chain routing needs `edit_fail_rate` and `tool_error_rate` by `(family, dialectPack, taskClass)`.  
- Matches Cursor’s operational stance: tool-error rate is a first-class harness health signal ([Cursor harness post](https://cursor.com/blog/continually-improving-agent-harness)).

If run-ledger module is not landed yet, Phase 1 must still:

1. Return the counters on RPC results (`OrchestrateResult`, `worker.run` result), and  
2. Log one metadata-only `engine.log` line per run (already partially done for toolCallCounts).

Ledger append is preferred when the ledger ships in the same window.

---

## 8. Eval reproducibility

### 8.1 Report card must include a “harness configuration” block

```ts
harnessConfig: {
  schemaVersion: 2,
  harnessProfile: "openfusion-native",
  familyCatalogVersion: "2026.07.09",
  dialectPackVersion: "1.0.0",      // or catalog snapshot id
  routePolicyVersion: "2",
  frontierEngine: "claude-code",    // honesty field
}
```

Aligned with Zhang et al. (arXiv:2605.23950): publish the configuration, not just the model name.

### 8.2 Micro-eval success criterion for Phase 1 itself

Phase 1 is not done when schemas merge. Done when:

1. **Structural:** v1 fixtures upgrade; v2 generate writes complete manifest fields.  
2. **Behavioral smoke:** same model + same task, `string-edit-default` vs `whole-file-prefer` (or strict) shows **different** `editFailCount` or toolError distribution on a fixture repo that stresses find/replace.  
3. **No silent frontier change:** generate/review still `claude-code`.

If (2) is flat, packs are still labels — fail the milestone.

---

## 9. Exporters (secondary)

Phase 1 exporters stay:

- `agents-md`  
- `claude-subagents`

Profile only changes **default export choice** and how much card/prompt budget is recommended in the export header comment. No OpenCode/Codex full export required for Phase 1 merge.

---

## 10. File / module map (implementation sketch)

| Module | Action |
|---|---|
| `packages/engine/src/models/catalog.ts` | NEW — families + pack meta + resolveFamily + catalog versions |
| `packages/engine/src/models/catalog/data.ts` (or JSON) | NEW — bundled entries + provenance |
| `packages/engine/src/worker/runtime.ts` | NEW — `createWorkerRuntime`, packs compose tools |
| `packages/engine/src/worker/tools.ts` | REFACTOR — export primitive tool builders; keep containment |
| `packages/engine/src/worker/loop.ts` | `instructions` param; stop hardcoding single constant as only path |
| `packages/engine/src/worker/methods.ts` | resolve pack; error counters |
| `packages/engine/src/harness/schema.ts` | AgentModel v2 fields; Routing union; Manifest v2 fields; validate dialect refs |
| `packages/engine/src/harness/upgrade.ts` | NEW — `upgradeHarnessV1ToV2` |
| `packages/engine/src/harness/store.ts` | load via upgrade |
| `packages/engine/src/harness/generate.ts` | catalog menu; write schemaVersion 2 + versions; still Claude frontier |
| `packages/engine/src/orchestrate/routing.ts` | normalize routing; surface routeId + family/pack on RoutedAgent |
| `packages/engine/src/orchestrate/orchestrate.ts` | pass dialect into worker; telemetry on result (frontier kind unchanged) |
| `packages/engine/src/evals/*` | echo harnessConfig on report card |
| `packages/engine/src/runs/ledger.ts` | if present — extend orchestrate record (else result-only + log) |
| tests | upgrade fixtures, runtime pack differences, generate validation, telemetry shape |

---

## 11. Phase 1 task breakdown (PR-sized sequence)

Suggested atomic sequence (can be one PR stack):

1. **Catalog + schemas (no behavior change)**  
   ModelFamily, DialectPack meta, manifest optional fields, AgentModel optional family/pack, Routing union, validateHarness dialect refs, catalog unit tests.

2. **Upgrader**  
   `upgradeHarnessV1ToV2`, loadHarness integration, idempotence tests, v1 fixtures.

3. **`createWorkerRuntime` + tool error counters**  
   Refactor tools, wire worker.methods, loop instructions injection, behavioral smoke for two packs.

4. **Routing/orchestrate plumbing**  
   RoutedAgent carries family/dialectPack/routeId; orchestrate result exposes counters; frontier still Claude.

5. **Generate catalog-driven menu**  
   Write schemaVersion 2 + version pins; agents include family+pack; generation tests.

6. **Eval report harnessConfig**  
   Pin reproducibility fields; update eval tests.

Stop. Do **not** expand profile matrix or routing chains until step 3’s behavioral smoke is green.

---

## 12. Explicit anti-goals (Phase 1)

1. Reimplement Claude Code / Codex / OpenCode runtimes.  
2. Imply multi-frontier runtime via profile names.  
3. Dialect packs as YAML labels without tool/prompt differences.  
4. Full routing v2 capability chains.  
5. Mid-chat model switching across dialects (Cursor documents this as out-of-distribution; we avoid it).  
6. Uncited marketing numbers. All quantitative claims in §1 stay tied to arXiv:2606.12344, arXiv:2605.23950, Cursor 2026-04-30 post, arXiv:2602.11988.

---

## 13. Open questions (do not block Phase 1)

1. Should `apply-patch-v1` ship in the first merge or as 1.1 once string/whole-file packs prove the machinery? **Recommendation:** machinery first; patch pack only if tests land in the same stack.  
2. Catalog distribution: pure TS constants vs JSON under `packages/engine/catalog/` for non-code edits. **Recommendation:** TS constants in Phase 1 (typed, tested); JSON if users must override without rebuild (Phase 2).  
3. Whether `schemaVersion` jumps to 2 or stays 1 with additive optional fields only. **This doc locks schemaVersion 2** for any newly generated bundle so evals can hard-require version pins.

---

## 14. Success definition (one paragraph)

Phase 1 is successful when a regenerated harness on disk is **schemaVersion 2**, every open worker agent names a **family** and **dialectPack**, worker execution builds tools/instructions from that pack (not a global constant alone), every orchestrate/worker result exposes **tool and edit error counters** labeled by pack, v1 harnesses **load via a deterministic upgrader**, frontier generate/review remains **claude-code**, and a minimal A/B smoke shows packs are not cosmetic. Profiles exist only as a thin enum influencing generation defaults and export tilt—not as promised alternate agent runtimes.
