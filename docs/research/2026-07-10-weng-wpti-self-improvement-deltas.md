# Self-Improving Harnesses: Weng + WPTI Research Delta

**Date:** 2026-07-10  
**Scope:** additions to OpenFusion's existing harness-engineering research and
learning-spine plan  
**Primary materials:** [Lilian Weng, "Harness Engineering for
Self-Improvement"](https://lilianweng.github.io/posts/2026-07-04-harness/) and
[WPTI, "Self-Improving Tool Agents"](https://wpti.dev/public-presentation/self-improving-tool-agents.html)

## Executive conclusion

The two materials sharpen the existing OpenFusion direction in complementary
ways:

- Weng supplies the **learning architecture**: durable files, causal weakness
  mining, bounded candidate generation, held-in/held-out validation, structured
  context evolution, and a retained history of failed edits.
- The WPTI deck supplies the **deployment architecture**: one tool-contract
  registry projected into every runtime, separate lanes for safe descriptive
  changes versus new capabilities, and different release controls for code and
  externally managed prompts.

OpenFusion should adopt four ideas now:

1. make the duplicated wiki tool contracts the pilot for a typed ToolSpec
   registry and generated projections;
2. strengthen weakness mining around a deterministic causal signature rather
   than clustering only by surface failure code;
3. split self-improvement into a candidate-diff lane and a human-designed
   capability-gap lane;
4. seal evaluator prompts and prompt sources from the candidate path.

It should **not** add a prompt CMS, a meta-optimizer, or autonomous runtime-code
editing yet. Those mechanisms are useful only after OpenFusion can produce
trusted repeated experiments and protected promotion verdicts.

## Source matrix

| Source | Type | What it supports | Credibility | Important limit |
|---|---|---|---|---|
| [Weng: Harness Engineering for Self-Improvement](https://lilianweng.github.io/posts/2026-07-04-harness/) | Expert literature synthesis, 2026 | Harness layers, file memory, ACE/MCE, workflow and harness optimization, Self-Harness loop | **High** for source synthesis; **Medium** for cross-study generalization | Not a new controlled experiment; predictions and generalizations are the author's synthesis |
| [Self-Harness](https://arxiv.org/abs/2606.09498) | Primary experimental preprint, 2026 | Causal failure signatures, diverse minimal edits, held-in/held-out non-regression, compatible candidate merging | **Medium** | Preprint; bounded Terminal-Bench subset; depends on trace and verifier quality; no independent replication yet |
| [Meta Context Engineering](https://arxiv.org/abs/2601.21557) | Primary experimental preprint, 2026 | Bi-level optimization of context and context-management skills | **Medium** | Recent preprint; the reported cross-domain gains should not be assumed to transfer to coding harnesses |
| [ACE](https://arxiv.org/abs/2510.04618) | Primary experimental preprint, 2025 | Generator/Reflector/Curator loop; itemized context entries and deterministic merging | **Medium** | Optimizes a context playbook, not a complete production harness or safety boundary |
| [WPTI: Self-Improving Tool Agents](https://wpti.dev/public-presentation/self-improving-tool-agents.html) | Practitioner architecture deck | Tool registry projections, change-lane separation, prompt canary/promotion/rollback controls | **Medium** for concrete design patterns; **Low/unknown** for outcome claims | Undated image deck with no methodology, benchmark, citations, or audited performance data |
| [Ouroboros repository](https://github.com/Q00/ouroboros) and [architecture](https://github.com/Q00/ouroboros/blob/main/docs/architecture.md) | Primary implementation repository | Evidence that the deck's architecture has a corresponding codebase | **High** for what the code implements; **Low** for self-reported impact | A repository demonstrates mechanics, not that the mechanics improve task quality |

### Consensus

The sources agree with the earlier research brief on the core control loop:

```text
durable trace
  -> verifier-grounded weakness
  -> bounded candidate
  -> protected comparison
  -> human promotion
  -> rollback + retained result
```

They also agree that the editable surface must be explicit, the evaluator must
remain outside that surface, and negative results are part of the learning
record rather than disposable failed attempts.

### Tensions and unresolved evidence

- Weng surveys systems that optimize prompts, workflows, context operators, and
  harness code. Their results do not establish that one optimizer generalizes
  across these surfaces or across model families.
- Self-Harness accepts and composes compatible candidates. OpenFusion should
  first evaluate one-component edits for causal attribution, then treat any
  composition as a separate candidate with a fresh full regression run.
- The WPTI deck presents a useful production design but offers no controlled
  evidence that its registry or prompt-CMS pattern improves task success.
- There is no strong evidence yet that OpenFusion needs a remote prompt CMS.
  Local Git-backed artifacts already provide versioning, review, and rollback
  with a smaller trust boundary.
- Neither material resolves long-horizon repository health. Short benchmark
  gains can still accumulate architectural debt; deterministic architecture and
  maintainability checks remain necessary.

## Material 1: what Weng adds

### 1. Harness optimization is a progression of editable surfaces

The article usefully separates prompt optimization from context, workflow,
harness-code, and optimizer-code evolution. This prevents OpenFusion from calling
a rewritten prompt a self-improving harness. Every candidate must name its
editable component and be compared only against candidates at the same authority
level.

The practical progression for OpenFusion is:

```text
agent prompt / wiki entry
  -> context selection policy
  -> route / retry workflow
  -> tool contract metadata
  -> runtime implementation (deferred)
  -> optimizer implementation (deferred)
```

Each step expands the blast radius and therefore needs stronger permissions,
evaluation coverage, and human review.

### 2. Self-Harness gives weakness mining a causal schema

The [Self-Harness paper](https://arxiv.org/html/2606.09498) does not merely group
similar error messages. It builds an exact, verifier-grounded failure signature
from three dimensions:

```ts
interface FailureSignature {
  terminalCause: string;
  causalStatus: "causal" | "contributing" | "symptomatic" | "unknown";
  agentMechanism: string;
}
```

This distinction matters. `tool.invalid-args` is a terminal symptom; the editable
cause might be an ambiguous tool description, a schema mismatch, missing context,
or the model ignoring an adequate contract. OpenFusion's existing Phase D
taxonomy should remain the factual base, but aggregation should occur on the
causal signature when the evidence supports one.

An evidence bundle should contain:

- support count and failure rate with an explicit denominator;
- representative run and event IDs;
- deterministic verifier/tool evidence;
- affected component and addressability classification;
- passing behaviors the candidate must preserve;
- prior accepted and rejected edits for the same signature.

Clusters should initially be exact and deterministic. Semantic clustering can be
added later only as a suggestion layer because it is harder to reproduce and can
merge unlike causes.

### 3. Candidate diversity should be structural

Self-Harness generates several distinct minimal candidates for one failure bundle.
For OpenFusion, `K` candidate proposals should differ by primary mechanism or
editable surface—not by cosmetic wording. Each proposal still changes one
component and states its predicted effect before evaluation.

Rejected candidates must be retained and summarized for future proposers. Without
that negative archive, an apparent self-improvement loop repeatedly pays to try
the same failed edit.

### 4. Structured context beats repeated whole-prompt rewrites

ACE's Generator/Reflector/Curator pattern addresses a common optimizer failure:
rewriting an entire prompt tends to collapse detail and overfit the most recent
example. A better OpenFusion representation is an itemized context playbook:

```ts
interface PlaybookEntry {
  id: string;
  componentId: string;
  description: string;
  scope: string[];
  sourceRunIds: string[];
  confidence: number;
  status: "active" | "rejected" | "superseded" | "expired";
  supersedes?: string[];
  invalidatesAt?: string;
}
```

Merges, supersession, deduplication, pruning, and rendering should be
deterministic. The rendered prompt is a derived view; the item ledger is the
durable source. OpenFusion should introduce this only after it can ablate the
playbook against the current wiki/no-memory controls.

### 5. Files and jobs are first-class state

Weng's file-memory pattern reinforces OpenFusion's JSONL/event/artifact direction.
Parallel work should produce inspectable files and status records, not disappear
into subagent chat. Phase F already follows this principle; it should additionally
require cancellation state and independently mergeable outputs for every backend
job.

## Material 2: what the WPTI deck adds

### 1. One tool contract, several projections

The deck calls its projection layer “ACP.” That name is easy to confuse with the
separate Agent Client Protocol ecosystem, so OpenFusion should call it a
**ToolSpec projection contract**.

The registry is data; adapters project it into runtime-specific forms:

```ts
interface ToolSpec {
  id: string;
  version: string;
  summary: string;
  whenToUse: string;
  inputSchema: unknown;
  outputSemantics: string;
  permission: "read" | "write" | "execute" | "network" | "dangerous";
  transports: Array<"worker" | "mcp" | "frontier">;
  allowedAgentScopes: string[];
  implementationRef: string;
}
```

The same spec should generate or validate:

- AI SDK `tool()` descriptions and input schemas;
- MCP registrations;
- frontier tool allowlists and exported harness documentation;
- inventory/fingerprint records used by evaluation.

This solves a concrete OpenFusion problem. Today:

- `packages/engine/src/worker/tools.ts` defines `wiki_query` with `{ query }` and
  a worker-specific description/output;
- `packages/engine/src/wiki/mcp.ts` independently defines `wiki_query` with
  `{ symbol }` and a different description/output;
- `packages/engine/src/engines/claude.ts` independently hardcodes the wiki tool
  allowlist.

That is already contract drift. The first registry migration should cover only
`wiki_query` and `wiki_map`, preserve their intended transport-specific execution,
and add a deterministic projection-drift test. Core file/shell/edit tools can
move only after the pilot proves the abstraction.

### 2. Separate safe diffs from capability decisions

The deck's most important governance idea is the split between two lanes:

| Lane | Examples | Automation may do | Required human action |
|---|---|---|---|
| **Candidate diff** | Description refinement, bounded prompt/playbook entry, compatible schema metadata correction | Propose, regenerate projections, evaluate, open candidate record/PR | Approve promotion/merge |
| **Capability gap** | New tool, new fixed composition, permission expansion, new transport, runtime implementation | Deduplicate evidence and create a proposal only after a recurrence threshold | Architecture, permission, schema, implementation, and release decision |

An optimizer must never invent a new capability through the same path used for a
behavior-preserving description change. Capability-gap records should include
frequency, affected task classes, failed alternatives, expected value, required
permissions, and a human owner.

### 3. Code and managed prompts need different rollout mechanics

The deck proposes label-based prompt canaries, a human-only production label, bot
access limited to candidate labels, and instant label rollback. Those are sound
controls for an external prompt CMS, but adding such a service now would enlarge
OpenFusion's trust and availability surface without solving an observed need.

The near-term abstraction should be local:

```ts
interface PromptSource {
  get(name: string, version: string): Promise<{ text: string; digest: string }>;
}
```

- `StaticPromptSource` reads Git-backed, fingerprinted artifacts.
- A future `ManagedPromptSource` may add candidate labels and file fallback.
- Evaluator/reviewer prompts use a sealed static source and cannot resolve through
  the candidate's prompt source.
- Production label promotion, if a CMS is introduced later, remains human-only.

`packages/engine/src/orchestrate/review.ts` currently embeds the review prompt in
code while the fingerprint records only a manually maintained policy version.
The immediate fix is not external management; it is to make the reviewer prompt's
actual content digest part of the protected evaluator identity.

### 4. Tool-description changes need tool-specific evaluation

Task success alone can hide a worse tool interface. A ToolSpec candidate should
also report:

- correct tool-selection rate on targeted cases;
- input-schema validation failures;
- execution/error rate after a valid selection;
- unnecessary tool calls and loop count;
- permission denials or attempted escalation;
- task success, latency, and cost.

The first wiki-tool experiment should compare the current transport-specific
contracts against one harmonized spec while holding implementation, model,
context, budget, and task set fixed.

## What changes in the OpenFusion plan

### P0 — add before building the optimizer

1. **A4 ToolSpec registry pilot:** migrate `wiki_query` and `wiki_map`; generate or
   validate worker/MCP/frontier projections; fail CI on drift.
2. **D1 causal signature:** extend failure signals with terminal cause, causal
   status, and agent mechanism.
3. **D3 evidence bundle:** include preservation cases, prior rejected edits,
   addressability, support, and representative event IDs.
4. **E lane policy:** reject capability additions from the candidate mutation
   API; create deduplicated capability-gap proposals only after recurrence.
5. **Protected prompt identity:** fingerprint the actual reviewer/evaluator prompt
   and keep its source outside candidate authority.

### P1 — add after repeated experiments work

1. Generate multiple structurally distinct proposals per evidence bundle.
2. Retain a queryable negative archive and pass its summary to the proposer.
3. Add a structured playbook entry store and ablate it against wiki/no-memory.
4. Compose separately accepted, compatible candidates only as a new full
   regression experiment.
5. Add deterministic repository-health gates such as architecture-boundary
   checks, public-API change detection, dependency direction, and diff-size
   budgets.

### P2 — explicitly defer

- remote prompt CMS and traffic labels;
- MCE-style optimization of the context-management algorithm itself;
- automatic mutation of tool implementations or runtime code;
- autonomous capability creation or production promotion;
- semantic/embedding failure clustering before exact causal clusters are useful.

## Recommended first implementation slice

After the current A1–A3 observability work settles, implement the wiki ToolSpec
pilot as one independently reviewable slice:

1. add a registry and transport-neutral schemas for `wiki_query`/`wiki_map`;
2. project or validate both worker and MCP definitions from it;
3. derive the Claude wiki allowlist from permitted projections;
4. fingerprint the registry version/digest;
5. add a CI drift test;
6. run matched tool-selection and task-outcome fixtures.

This slice converts a demonstrated local inconsistency into a measurable harness
improvement. It also establishes the registry/projection boundary needed for
later tool-description optimization without granting the optimizer authority over
tool implementations or permissions.

