# Harness Learning Spine — Implementation Plan

**Date:** 2026-07-10  
**Status:** in progress  
**Research basis:** `docs/research/2026-07-10-harness-engineering-deep-research.md`
and `docs/research/2026-07-10-weng-wpti-self-improvement-deltas.md`  
**Goal:** turn OpenFusion from a harness generator/orchestrator with a paired eval
into a controlled learning system that can attribute failures, compare harness
components, propose one bounded change, prove it against protected evaluations,
and promote or roll it back safely.

## Outcome

At the end of this plan, OpenFusion can answer five questions with durable
evidence:

1. Exactly which model, harness components, tools, context, sandbox, environment,
   and budgets produced a run?
2. Which harness component caused or plausibly contributed to a failure?
3. Does a component beat its simpler ablation under matched conditions?
4. Does a proposed mutation improve quality, consistency, cost, or latency without
   causing a protected regression?
5. Can the candidate be promoted atomically and rolled back without allowing the
   proposer to alter its grader?

The end state is deliberately **not** a free-running agent that rewrites OpenFusion.
It is an eval-gated candidate system with human promotion. Runtime-code evolution
and autonomous promotion remain future work.

## Current-state audit

The research recommendations do not start from zero. The following are already
implemented and should be extended rather than rebuilt:

| Capability | Current implementation | Reuse decision |
|---|---|---|
| Metadata run ledger | `packages/engine/src/runs/ledger.ts`; RPC write points in orchestrate/evals/harness methods | Upgrade compatibly to v2; preserve v1 reads and the content-exclusion rule |
| Component-adjacent pins | harness schema v2, model family, dialect pack, route ID, catalog versions | Generalize into one computed component fingerprint |
| Tool telemetry | call/error counts and edit-failure count returned by worker/orchestrate | Feed deterministic failure classification and per-component metrics |
| Paired eval | `evals/run.ts`, pure `evals/verdict.ts` | Keep the two-arm API working while introducing a generic experiment layer |
| Public benchmark | `evals/bench/*`, SWE-bench Verified Mini | Make it the first durable multi-variant experiment backend |
| Isolated code state | history-stripped eval repos and per-worker git worktrees | Retain, then add an OS process boundary and evaluator-owned oracle |
| Selective context | approved Project Card plus on-demand wiki tools | Add explicit context variants and ensure eval runs actually attach the wiki |
| Sequential orchestrator | route → worker → frontier review → retry/escalate | Treat as the single-agent control; do not replace with a team by default |

Known gaps visible in current code:

- `RunRecord` is metadata-rich but cannot reconstruct the full configuration or
  environment of a result.
- eval harness sessions currently run without the wiki MCP attachment documented
  by `evals/run.ts` and `evals/bench/runner.ts`; the central context artifact is not
  being tested faithfully.
- the worker Bash tool is cwd-pinned but explicitly not a security boundary; it can
  read or write outside the worktree and use the network.
- paired arms run once and in fixed order; the report does not measure `pass^k`,
  confidence intervals, or order effects.
- there is no shared vocabulary for failure causes, component-level ablation, or a
  versioned candidate lifecycle.
- tool contracts are duplicated across worker, MCP, and frontier surfaces. The
  clearest current drift is `wiki_query`: the worker contract accepts `{ query }`
  while the MCP contract accepts `{ symbol }`, with independently maintained
  descriptions and output semantics.
- the frontier review prompt is embedded in runtime code while its harness
  fingerprint is represented by a manual policy version rather than the digest of
  the actual protected prompt.

## Non-negotiable constraints

1. **Keep the run-ledger content line.** No task text, prompts, diffs, source, or
   test output in `runs.jsonl`. New records may contain IDs, hashes, counters,
   categories, versions, policies, and bounded reviewer reasons.
2. **The evaluator is outside the candidate's authority.** Candidate agents cannot
   edit hidden tests, graders, protected results, sandbox policy, promotion rules,
   or the evidence store.
3. **One candidate changes one registered component.** Multi-component changes are
   rejected until single-component attribution is proven insufficient.
4. **No automatic promotion.** A human must approve every harness mutation in this
   plan. Promotion uses optimistic concurrency and creates a rollback snapshot.
5. **Single-agent remains the control.** A multi-agent mode cannot ship because it
   is interesting; it must win a matched quality/cost/latency experiment on a
   decomposable task slice.
6. **Engine first, UI later.** The current desktop redesign has overlapping dirty
   files. Phases A–D stay headless. Desktop surfaces begin only after that redesign
   lands and the engine contracts stabilize.
7. **Backward compatibility.** Existing `engine.orchestrate`, `engine.evals.run`,
   `engine.runs.list`, and bench CLI defaults retain their current behavior.
8. **Capability changes use a different lane.** A candidate may refine an existing
   registered prompt, context item, or tool contract within its declared authority.
   A new tool, composition, permission, transport, or implementation becomes a
   deduplicated capability-gap proposal for human design; it cannot enter through
   the mutation API.
9. **Protected prompts have protected sources.** Reviewer and evaluator prompts are
   content-fingerprinted and resolved from an evaluator-owned static source. A
   candidate prompt source cannot change, shadow, or label-switch its grader.

## Target architecture

```text
HarnessComponentFingerprint
        |
RunEnvelope v2 + metadata event stream
        |
ToolSpec registry ── deterministic worker / MCP / frontier projections
        |
Trusted experiment runner ── variants / trials / matched budgets
        |                         |
protected oracle             immutable environment manifest
        |
FailureSignal[] ── deterministic classifier ── WeaknessReport
        |
CandidateProposal (one component, predicted effect)
        |
targeted -> regression -> held-out -> safety/cost gates
        |
human review -> atomic promote -> monitor -> rollback
```

## Phase A — Make every result comparable

**Purpose:** establish the component and environment identity needed for causal
comparison. No optimizer should be built before this phase exits.

### A1. Computed harness component fingerprint

**Create:**

- `packages/engine/src/harness/fingerprint.ts`
- `packages/engine/test/harness-fingerprint.test.ts`

**Modify:**

- `packages/engine/src/harness/store.ts`
- `packages/engine/src/engine.ts` exports

Define a canonical, deterministic fingerprint:

```ts
interface HarnessComponentRef {
  id: string;
  digest: string;       // sha256 of canonical JSON/text
  version?: string;     // semantic/catalog version when one exists
}

interface HarnessFingerprint {
  digest: string;       // sha256 of sorted component refs
  components: HarnessComponentRef[];
}
```

Required component IDs:

- `context.project-card`
- `context.wiki.<slug>` for each retrievable page
- `routing.policy`
- `agent.<name>.prompt`
- `models.roster`
- `tools.dialect-pack-catalog`
- `review.policy`
- `retry.policy`

The sandbox profile is a runtime component, not part of the harness bundle. Record
its version beside the harness fingerprint in the run envelope so two runs with the
same harness but different isolation remain distinguishable.

Canonicalization sorts object keys, component IDs, agents, pages, and route keys.
Changing file order without changing semantics must not change the digest. Changing
one agent prompt must alter that component and the aggregate digest only.

**Tests:** deterministic ordering, one-component sensitivity, legacy v1-upgraded
bundle equivalence, no raw prose returned outside the per-component hashing input.

### A2. Run ledger v2 with v1-compatible reads

**Modify:**

- `packages/engine/src/runs/ledger.ts`
- `packages/engine/src/runs/methods.ts`
- `packages/engine/src/orchestrate/methods.ts`
- `packages/engine/src/evals/methods.ts`
- `packages/engine/src/harness/methods.ts`
- `packages/engine/test/runs-ledger.test.ts`

Add a v2 record family while continuing to parse all existing v1 lines. Every new
user-initiated run gets an engine-generated `runId` when the caller omits one.

Common v2 metadata:

```ts
interface RunEnvelopeV2 {
  v: 2;
  runId: string;
  parentRunId?: string;
  kind: "orchestrate" | "evals" | "generate" | "card" | "experiment";
  startedAt: string;
  finishedAt: string;
  projectHeadSha?: string;
  harness: HarnessFingerprint | null;
  environment: {
    engineVersion: string;
    platform: string;
    arch: string;
    nodeVersion: string;
    sandboxProfile: string;
  };
  budget?: { maxSteps?: number; timeoutMs?: number; maxUsd?: number };
}
```

Kind-specific records retain current fields and add model IDs, provider IDs,
dialect-pack versions, context policy, wiki head SHA, verifier identity, and failure
signal IDs where available. Do not add task or patch hashes: low-entropy task text
can be attacked through unsalted hashes. Random IDs provide correlation without
content fingerprints.

`engine.runs.list` gains optional `v` and `runId` filters. Default behavior stays
newest-first and includes both versions.

**Tests:** mixed v1/v2 file, generated ID, caller ID preservation, environment and
fingerprint capture, corrupt-line tolerance, and serialized-content exclusion using
distinctive task/prompt/diff markers.

### A3. Metadata event stream per run

**Create:**

- `packages/engine/src/runs/events.ts`
- `packages/engine/test/runs-events.test.ts`

Store `.openfusion/cache/runs/<runId>/events.jsonl`. Events are metadata-only:

- `run.started`, `run.finished`, `run.cancelled`
- `context.selected`, `context.compacted`
- `route.selected`
- `tool.started`, `tool.finished`, `tool.failed`
- `attempt.started`, `attempt.finished`
- `review.finished`
- `verifier.finished`

Each event has a sequence number and elapsed milliseconds. Tool events contain tool
name, duration, result byte count, truncation flag, and error kind—not command, path,
arguments, stdout, or file content. The existing summary ledger remains the fast
index; the event stream is for diagnosis.

Instrumentation must be observer-only. A write failure logs one metadata line and
never fails the underlying run.

### A4. ToolSpec registry pilot

**Implementation status (2026-07-10): complete.** The wiki registry, worker/MCP
projections, Claude read-only allowlist projection, content fingerprint, contract
tests, and documentation are implemented. The canonical `wiki_query` input is the
existing public MCP `{ symbol }` contract; the internal worker surface now matches
it. Shell/file/edit tools remain intentionally unmigrated pending pilot evidence.

**Create:**

- `packages/engine/src/tools/spec.ts`
- `packages/engine/src/tools/registry.ts`
- `packages/engine/src/tools/projections.ts`
- `packages/engine/test/tools-registry.test.ts`
- `packages/engine/test/tools-projections.test.ts`

**Modify:**

- `packages/engine/src/worker/tools.ts`
- `packages/engine/src/wiki/mcp.ts`
- `packages/engine/src/engines/claude.ts`
- `packages/engine/src/harness/fingerprint.ts`

Define one transport-neutral contract per tool:

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

The registry owns description, usage guidance, schema, permission, transport, and
agent visibility. Runtime implementations remain ordinary code and outside the
candidate-editable surface. Adapters project or validate AI SDK `tool()` entries,
MCP registrations, frontier allowlists, harness exports, and fingerprint records.

Pilot only `wiki_query` and `wiki_map`. Reconcile their existing worker/MCP input
and output differences explicitly rather than silently choosing one transport's
contract. Add a deterministic inventory/projection test so a surface edit that is
not represented in the registry fails CI. Migrate shell/file/edit tools only after
the pilot proves the registry does not obscure runtime behavior.

Avoid the name “ACP” for this abstraction because it is overloaded by an external
Agent Client Protocol; use `ToolSpec` and “projection contract” internally.

### Phase A exit gate

- Two runs with identical components produce the same harness digest.
- A one-component fixture change produces a precisely attributable digest change.
- Every new run has a v2 envelope and ordered metadata events.
- Wiki tool contracts and agent visibility project from one fingerprinted registry,
  and an out-of-registry projection change fails a deterministic test.
- Existing v1 ledgers and current desktop history remain readable.
- Content-exclusion tests prove no task, prompt, diff, command, source, or test
  output entered either store.

## Phase B — Make the evaluator trustworthy

**Purpose:** close the two known integrity gaps—missing wiki context and a shell that
can escape the worktree—before any generated change is scored.

### B1. Explicit context policy and wiki snapshot

**Create:**

- `packages/engine/src/orchestrate/context-policy.ts`
- `packages/engine/src/evals/wiki-snapshot.ts`
- `packages/engine/test/orchestrate-context-policy.test.ts`
- `packages/engine/test/evals-wiki-snapshot.test.ts`

**Modify:**

- `packages/engine/src/orchestrate/orchestrate.ts`
- `packages/engine/src/evals/run.ts`
- `packages/engine/src/evals/bench/prepare.ts`
- `packages/engine/src/evals/bench/runner.ts`

Introduce an internal-only policy:

```ts
type ContextVariant = "none" | "card" | "wiki" | "card+wiki";

interface ContextPolicy {
  variant: ContextVariant;
  knowledgeProjectDir?: string;
  expectedWikiHeadSha?: string;
}
```

The production RPC default remains `card+wiki`. Experiments may select the other
variants. Separate the writable task directory from the read-only knowledge source;
this lets an eval worktree use a wiki snapshot without treating the benchmark store
as writable project state.

Bench prepare builds the wiki at the same commit used for harness generation and
stores a read-only snapshot beside the prepared harness. Every report records the
wiki head and flags staleness when the task base commit differs. A harness arm that
claims `wiki` must fail as a measurement error if the MCP server was not attached;
it must never silently degrade to no wiki.

**Tests:** all four variants, MCP URL present only when selected, read-only snapshot,
head mismatch reported, production default unchanged.

### B2. OS sandbox adapter for worker Bash

**Create:**

- `packages/engine/src/sandbox/types.ts`
- `packages/engine/src/sandbox/macos.ts`
- `packages/engine/src/sandbox/profiles.ts`
- `packages/engine/test/sandbox-macos.test.ts`

**Modify:**

- `packages/engine/src/worker/tools.ts`
- `packages/engine/src/worker/runtime.ts`
- `packages/engine/src/worker/methods.ts`

Use an explicit `SandboxProfile` injected into the Bash tool. The macOS backend may
use the available `/usr/bin/sandbox-exec`, but all policy generation sits behind an
adapter so the benchmark can later use a container backend.

Profiles:

- `developer-v1`: write only inside worktree and declared temporary directories;
  preserves current network behavior and is therefore not eligible for a trusted
  evolution verdict.
- `eval-v1`: read/write only declared worktree/toolchain paths, deny network, deny
  the original repository, benchmark clone, prepared harness, evaluator, and result
  directories.
- `scout-readonly-v1` (reserved for Phase F): read worktree, no writes, no network.

Fail closed in eval mode when the OS backend is missing or the profile cannot be
installed. Production developer mode may report `sandboxProfile: "unavailable"`
and retain current behavior until product policy decides otherwise, but such a run
cannot support a trusted evolution verdict.

**Tests:** worktree write succeeds; parent/absolute write fails; symlink escape
fails; original repo read fails in eval mode; `curl`, `git fetch`, and local socket
access fail; declared test/toolchain execution succeeds; timeout and cancellation
still kill the child.

### B3. Evaluator-owned oracle and policy-violation result

**Implementation status (2026-07-10): partially complete.** The authoritative
review template now lives in a protected static module and its actual content is
part of `review.policy` fingerprinting; dynamic task/summary/diff slots are
excluded. The protected oracle and `policy-violation` result work below remain
pending on B2.

**Create:**

- `packages/engine/src/evals/protected-oracle.ts`
- `packages/engine/test/evals-protected-oracle.test.ts`

**Modify:**

- `packages/engine/src/evals/tasks.ts`
- `packages/engine/src/evals/run.ts`
- `packages/engine/src/evals/bench/report.ts`
- `packages/engine/src/evals/verdict.ts`

Define an oracle that runs outside the agent sandbox, applies protected test
artifacts only after the candidate stops, and scores a fresh candidate tree. Public
SWE-bench continues to use the official scorer. Repo-local golden tasks initially
support only pre-existing fail-to-pass tests; test-overlay construction is a later
extension rather than pretending source+test commits are valid.

Add `policy-violation` as a measurement/safety outcome distinct from ordinary task
failure. A safety violation always blocks promotion and never counts as negative
quality evidence for model comparison.

Move the reviewer/evaluator instructions behind an evaluator-owned
`StaticPromptSource` or an equivalent protected module. Fingerprint the actual
prompt content, not only a manually incremented policy version. Candidate prompt
artifacts and any future managed prompt provider are forbidden in this dependency
path. A general `PromptSource` interface may be introduced for product prompts,
but a remote prompt CMS and label-based traffic rollout remain deferred until a
real multi-environment need exists.

### Phase B exit gate

- A wiki-selected eval demonstrably receives wiki MCP tools and records the pinned
  snapshot.
- Eval agents cannot reach the original repo, hidden evaluator, network, or result
  store through Bash.
- Evaluator files are introduced only after the agent process stops.
- Sandbox/setup failures are measurement failures; policy violations are visible
  safety failures; neither is silently counted as task quality.

## Phase C — Turn evals into experiments

**Purpose:** measure marginal component value, stochastic consistency, and matched
quality/cost tradeoffs instead of comparing only one baseline and one full harness
run.

### C1. Registered experiment variants

**Create:**

- `packages/engine/src/evals/variants.ts`
- `packages/engine/src/evals/experiment.ts`
- `packages/engine/test/evals-variants.test.ts`
- `packages/engine/test/evals-experiment.test.ts`

Define variants as composition, not copied pipelines:

```ts
interface HarnessVariant {
  id: string;
  context: ContextVariant;
  route: "frontier" | "fixed-worker" | "harness";
  fixedWorker?: {
    providerId: string;
    model: string;
    family: string;
    dialectPack: string;
  };
  review: "none" | "frontier";
  retries: number | "policy";
  toolProfile: string;
}
```

`fixedWorker` is required only when `route === "fixed-worker"`; all fixed-worker
variants in an experiment reuse the same value. `retries: "policy"` resolves to the
active harness retry/escalation policy and records the resolved numeric value in the
trial row.

Required built-ins:

| Variant | Context | Route | Review | Retries | Primary comparison |
|---|---|---|---|---:|---|
| `frontier-baseline` | none | frontier | none | 0 | Current direct-frontier control |
| `worker-only` | none | fixed worker | none | 0 | Cheapest unassisted worker control |
| `card-only` | card | fixed worker | none | 0 | Project Card marginal value vs worker-only |
| `wiki-only` | wiki | fixed worker | none | 0 | Wiki marginal value vs worker-only |
| `routing-only` | none | harness | none | 0 | Router/roster value vs worker-only |
| `routing-review` | none | harness | frontier | 0 | Review-filter value vs routing-only |
| `routing-review-retry` | none | harness | frontier | current policy | Retry/repair value vs routing-review |
| `full-harness` | card+wiki | harness | frontier | current policy | Shipped composition vs both controls |

`engine.evals.run` continues to request the existing two variants by default.
Add `engine.evals.experiment` for an explicit variant list. All variants for one
task start from independently materialized identical trees and use the same model,
budget, timeout, sandbox, oracle, and dataset pins unless the variant definition
explicitly names the changed component.

Reject invalid comparisons that differ in undeclared dimensions.

### C2. Repeated trials, seeded arm order, and durable resume

**Modify:**

- `packages/engine/src/evals/experiment.ts`
- `packages/engine/src/evals/bench/runner.ts`
- `packages/engine/src/evals/bench/cli.ts`
- corresponding runner/CLI tests

Add `trialsPerTask` and a recorded random seed. Randomize variant order per
task/trial from the seed to avoid fixed baseline-first endpoint drift. Persist every
trial before starting the next so a cancelled run resumes without duplicating a
completed trial.

Each trial records task ID, trial index, variant ID, order, outcome, cost, latency,
attempts, safety outcome, component fingerprint, and environment digest.

Defaults remain one trial and current two-arm behavior. Reports must label a
single-trial run as directional.

### C3. Statistical report and Pareto view

**Create:**

- `packages/engine/src/evals/stats.ts`
- `packages/engine/test/evals-stats.test.ts`

**Modify:**

- `packages/engine/src/evals/verdict.ts`
- `packages/engine/src/evals/bench/report.ts`

Report per variant:

- `pass@1`, `pass@k`, and `pass^k`;
- success rate and paired delta from control;
- task-clustered 95% bootstrap interval for the quality delta;
- median and p95 latency;
- total and paired cost delta with interval;
- tool-error, retry, escalation, and intervention rates;
- safety and measurement-failure counts.

Use a deterministic seeded bootstrap so reports are reproducible. Retain the
current conservative verdict for one-trial legacy calls. For repeated experiments,
the promotion-quality gate is non-inferiority: the lower 95% bound of the candidate
minus control quality delta must exceed `-5pp`. A savings claim additionally needs
a positive lower bound on paired savings, at least 20 tasks, no unpriced calls, and
no safety violation.

Keep the raw dimensions. A Pareto helper may identify non-dominated variants but
must not collapse quality, consistency, cost, latency, and safety into one stored
reward.

### C4. Experiment report artifacts

Store under the existing benchmark result root:

```text
<run-id>/
  experiment.json
  trials.jsonl
  report.json
  report.md
```

The report contains dataset/config/environment/component digests and caveats. It
contains task IDs and scores but no task text or source. Existing prediction files
remain unchanged for official scoring.

### Phase C exit gate

- The eight built-in variants run through one shared experiment pipeline.
- Two variants that differ in more than their declaration are rejected.
- Seeded reruns reproduce variant order and statistical output.
- Resume never repeats a durable completed trial.
- The report explains marginal value of card, wiki, routing, review, and retries.
- OpenFusion can demonstrate which current harness components earn their cost.

## Phase D — Convert runs into weakness signals

**Purpose:** replace “task failed” with a stable, evidence-bearing diagnosis that
can select the component a future candidate is allowed to change.

### D1. Failure taxonomy

**Create:**

- `packages/engine/src/weaknesses/taxonomy.ts`
- `packages/engine/test/weaknesses-taxonomy.test.ts`

Top-level categories and initial codes:

```text
contract.*       invalid/ambiguous task contract
context.*        missing, stale, irrelevant, retrieval-failed
route.*          misclassified, underpowered-model, chain-exhausted
tool.*           invalid-args, containment, timeout, io, execution
edit.*           not-found, not-unique, patch-failed, empty-diff
review.*         rejected, false-approve, inconsistent
verifier.*       test-failed, setup-error, oracle-error
environment.*    sandbox, dependency, resource, network, cancellation
coordination.*   ownership, merge-conflict, handoff-loss (reserved)
unknown
```

Every signal includes source (`deterministic`, `reviewer`, `human`, `inferred`),
confidence, run ID, affected component IDs, and evidence event IDs. It never embeds
task/source content.

Add a verifier-grounded causal signature beside the surface failure code:

```ts
interface FailureSignature {
  terminalCause: string;
  causalStatus: "causal" | "contributing" | "symptomatic" | "unknown";
  agentMechanism: string;
}
```

For example, `tool.invalid-args` is the terminal cause; an ambiguous ToolSpec,
schema drift, or ignored adequate guidance may be the distinct agent mechanism.
Exact signatures are the initial deterministic cluster key. An LLM may propose a
signature or relationship but cannot overwrite verifier-grounded fields, and
embedding/semantic clustering remains deferred until exact clusters prove too
sparse.

### D2. Deterministic classifier first

**Create:**

- `packages/engine/src/weaknesses/classify.ts`
- `packages/engine/test/weaknesses-classify.test.ts`

Classify direct facts before asking an LLM:

- sandbox denial → `environment.sandbox` or a safety signal;
- tool error counters → matching `tool.*`/`edit.*`;
- no diff → `edit.empty-diff`;
- apply failure → `edit.patch-failed`;
- review rejection → `review.rejected` plus the touched component candidates;
- baseline/harness oracle disagreement → verifier/task outcome signal;
- wiki requested but absent/stale → `context.retrieval-failed`/`context.stale`;
- all worker-chain attempts rejected → `route.chain-exhausted`.

LLM diagnosis is optional and subordinate: it may add `source: "inferred"` signals
but cannot overwrite deterministic evidence or choose promotion by itself.

### D3. Weakness aggregation and RPC

**Create:**

- `packages/engine/src/weaknesses/report.ts`
- `packages/engine/src/weaknesses/methods.ts`
- `packages/engine/test/weaknesses-report.test.ts`
- `packages/engine/test/weaknesses-methods.test.ts`

**Modify:** `packages/engine/src/engine.ts`

Add `engine.weaknesses.report { projectDir, since?, routeId?, family?,
dialectPack?, contextVariant? }`.

Report counts and rates by component, route, task class, model family, dialect pack,
context policy, and outcome. Include minimum sample sizes and show `unknown` rather
than inventing a cause. A report may recommend which single component to investigate,
but it does not mutate anything.

Each aggregated evidence bundle also contains support and denominator,
representative run/event IDs, affected component, addressability, passing behaviors
to preserve, and summaries of prior accepted and rejected edits for the same
signature. Order bundles by support and actionability, not by raw failure count.

### Phase D exit gate

- Every terminal run has at least one top-level signal, including `unknown`.
- Deterministic fixtures always produce the same codes and affected components.
- Aggregation denominators are visible; a high count with high traffic is not
  mistaken for a high failure rate.
- The report can identify, for example, whether one dialect pack has an elevated
  edit-failure rate or wiki absence correlates with a task slice.

## Phase E — Bounded, eval-gated harness evolution

**Purpose:** allow OpenFusion to propose and evaluate a reversible change without
allowing the proposer to modify its evaluator or production harness directly.

### E1. Candidate schema and isolated store

**Create:**

- `packages/engine/src/evolution/schema.ts`
- `packages/engine/src/evolution/store.ts`
- `packages/engine/test/evolution-store.test.ts`

Store candidates under `.openfusion/cache/experiments/<candidateId>/`; never write
them into the active harness during proposal or evaluation.

```ts
interface CandidateProposal {
  id: string;
  baseHarnessDigest: string;
  componentId: string;
  mutation: { beforeDigest: string; afterValue: unknown };
  predictedEffect: {
    failureCodes: string[];
    direction: "quality" | "consistency" | "cost" | "latency";
    rationale: string;
  };
  proposer: { kind: string; model: string; version?: string };
  status: "draft" | "evaluating" | "rejected" | "eligible" | "promoted" | "rolled-back";
}
```

Every terminal candidate, including a rejected one, remains queryable as negative
evidence. The store records its causal signature, evaluation digest, rejection
reason, and compatibility tags so future proposers do not repeatedly suggest the
same failed mechanism.

Initial mutable components are limited to:

- `agent.<name>.prompt`
- `context.wiki.<slug>` digest/summary, only when every new claim is grounded in
  the existing page body and all referenced symbols pass the current wiki validator

The human-approved Project Card, model catalog, sandbox, evaluator, hidden tests,
promotion policy, and OpenFusion runtime code are immutable. Routing mutations are
deferred until prompt/context attribution works.

### E2. Pluggable proposer with reflective v1

**Create:**

- `packages/engine/src/evolution/proposer.ts`
- `packages/engine/src/evolution/reflective-proposer.ts`
- proposer tests with fake frontier adapter

Input is a bounded weakness report, current component, allowed mutation schema, and
selected failure case IDs. It does not receive hidden cases or grader internals.
Output must contain exactly one changed component and an effect prediction.

The proposer may return `K` parallel candidates for one evidence bundle, but they
must be structurally distinct by primary mechanism or editable surface. Each
candidate remains minimal and changes exactly one registered component. Cosmetic
paraphrases do not satisfy the diversity requirement. Passing-behavior preservation
cases and a bounded summary of prior rejected edits are part of proposer context.

If the evidence requires a new tool, fixed composition, permission, transport, or
implementation change, the proposer emits no candidate mutation. Instead it may
create a deduplicated capability-gap record only after a configured recurrence
threshold. That record is a human architecture decision, not an eligible PR or
promotion.

This engine-native reflective proposer is the v1 mechanism. Add a documented
`HarnessOptimizer` interface so GEPA/AFlow-style search can be integrated later
without making Python/DSPy a packaged runtime dependency. A GEPA integration is a
separate spike after the full promotion loop passes with fixtures.

### E3. Candidate evaluation and protected promotion gate

**Create:**

- `packages/engine/src/evolution/evaluate.ts`
- `packages/engine/src/evolution/gate.ts`
- evaluation/gate tests

Evaluation stages:

1. targeted cases matching the weakness;
2. nearby regression cases for the changed component;
3. protected held-out cases unavailable to the proposer;
4. safety and budget gates;
5. canary comparison to the active harness.

Required eligibility:

- no safety or policy violation;
- no protected regression beyond the configured non-inferiority margin;
- targeted gain reproduces across the configured trials;
- candidate is non-dominated by the active harness on quality, consistency, cost,
  latency, and intervention rate;
- the recorded result matches or at least does not falsify the predicted direction;
- evaluator/environment/component digests are complete.

An `eligible` result is not a promotion.

Evaluate one-component candidates independently for causal attribution. Multiple
compatible eligible candidates may be composed only into a new composition
candidate with a fresh fingerprint and the complete targeted, regression,
held-out, safety, and cost sequence; independent eligibility is not inherited.

### E4. Human-controlled promote and rollback

**Create:**

- `packages/engine/src/evolution/methods.ts`
- `packages/engine/test/evolution-methods.test.ts`

RPCs:

- `engine.evolution.candidates.list`
- `engine.evolution.candidates.read`
- `engine.evolution.propose`
- `engine.evolution.evaluate`
- `engine.evolution.promote`
- `engine.evolution.reject`
- `engine.evolution.rollback`

Promotion requires explicit confirmation plus `baseHarnessDigest`. If the active
harness changed after proposal, fail with a stale-candidate error. Before atomic
write, save a complete rollback snapshot under the candidate record. Regeneration,
card approval, and concurrent promotion must use the existing per-project harness
serialization boundary.

Rollback restores the exact prior fingerprint and appends a v2 run record linking
promotion and rollback IDs.

### E5. Minimal desktop review after the current redesign

Only after engine completion, add a read-only candidate list and a diff-like view of
the one changed component to the Evals surface. Promotion and rollback require the
existing confirmation-dialog pattern. Do not add a new navigation rail section.

### Phase E exit gate

- A fixture weakness produces a one-component candidate in an isolated store.
- The proposer cannot see held-out cases or write active harness/evaluator files.
- A targeted-only win that regresses held-out is rejected.
- Stale-base promotion fails; eligible promotion is atomic and human-confirmed.
- Rollback restores the exact previous fingerprint.
- No candidate can mutate runtime code, sandbox, grader, hidden tests, or promotion
  rules.

## Phase F — Conditional multi-agent experiments

**Purpose:** test the research-supported multi-agent use case—parallel, read-only
exploration—without introducing concurrent writers or a conversational mesh.

This phase does not start until Phases B–E are green.

### F1. Centralized scout topology

**Create:**

- `packages/engine/src/orchestrate/scouts.ts`
- `packages/engine/src/orchestrate/task-contract.ts`
- tests with isolated scout contexts

Topology:

```text
orchestrator
  -> 2–3 read-only scouts in scout-readonly-v1 sandboxes
  -> typed evidence reports with file/symbol references
  -> one writer in one worktree
  -> independent verifier/reviewer
```

Scouts cannot write, spawn other agents, or talk to one another. The orchestrator
provides a bounded question and receives a typed evidence result. One writer owns
the patch. Durable artifacts, not agent chat, carry the handoff.

### F2. Matched-budget breakpoint experiment

Add variants:

- `single-agent-control`
- `centralized-readonly-scouts`

Build task slices with low, medium, and high dependency density. Match total token
and dollar budgets; report wall-clock separately so parallel speedup remains visible.
The scout mode is eligible only on task classes where it improves the protected
quality/consistency gate or materially reduces latency without added quality/safety
harm.

Parallel writers and decentralized agent debate remain out of scope. They require a
separate design with mechanically verified file ownership and merge semantics.

### Phase F exit gate

- Scouts are OS-enforced read-only and centrally coordinated.
- Handoffs are typed artifacts with provenance.
- The experiment identifies a task-class breakpoint rather than one global winner.
- Production routing enables scouts only for task classes that passed matched-budget
  evaluation; single-agent remains the fallback.

## Delivery sequence

Each row is intended to be an independently reviewable PR-sized unit.

| Order | Deliverable | Depends on | Primary risk closed |
|---:|---|---|---|
| 1 | A1 component fingerprint | current harness schema | incomparable configurations |
| 2 | A2 run ledger v2 | A1 | missing run identity/provenance |
| 3 | A3 metadata event stream | A2 | no failure timeline |
| 4 | A4 ToolSpec registry pilot | A1 | tool-contract and permission drift |
| 5 | B1 context policy + wiki snapshot | A1 | central artifact absent from eval |
| 6 | B2 eval sandbox | A2 | evaluator/repo/network escape |
| 7 | B3 protected oracle + prompt identity | B2 | grader/test/prompt tampering |
| 8 | C1 generic variants | B1–B3 | no component ablation |
| 9 | C2 trials/order/resume | C1 | stochastic and order bias |
| 10 | C3 statistical/Pareto report | C2 | scalar/noisy verdict |
| 11 | C4 report artifacts | C3 | non-reproducible experiment |
| 12 | D1 taxonomy + causal signature | A3, C1 | undifferentiated failures |
| 13 | D2 deterministic classifier | D1 | LLM-only diagnosis |
| 14 | D3 weakness evidence bundles/RPC | D2 | no component-level evidence |
| 15 | E1 candidate + negative-evidence store | A1, D3 | uncontrolled/repeated mutation |
| 16 | E2 diverse reflective proposer + capability-gap lane | E1 | no bounded proposal mechanism |
| 17 | E3 evaluation/composition gate | C3, E2 | overfit/reward-hacked promotion |
| 18 | E4 promotion/rollback | E3 | irreversible/stale mutation |
| 19 | E5 candidate UI | E4 + desktop redesign landed | premature UI coupling |
| 20 | F1 read-only scouts | B2, E4 | unbounded multi-agent topology |
| 21 | F2 breakpoint experiment | C3, F1 | anecdotal multi-agent adoption |

Before delivery 1, make one docs-only reconciliation: mark
`docs/superpowers/specs/2026-07-08-run-ledger-design.md` implemented with commit
`6535aa6`, and link this post-v1 plan from the roadmap. This prevents a future worker
from rebuilding the already-shipped ledger.

## Verification strategy

Every phase runs the existing clean stack plus focused suites:

```bash
pnpm --filter @openfusion/engine test -- --run
pnpm --filter @openfusion/engine typecheck
pnpm build
```

Desktop tests are required only for E5 and must run after the current UI branch has
settled:

```bash
pnpm --filter @openfusion/desktop test -- --run
pnpm --filter @openfusion/desktop typecheck
```

The first live-key validation occurs after Phase C, not during A/B unit work:

1. one small repo-local paired run proving wiki attachment and sandboxing;
2. a 5-instance directional benchmark to validate durable resume/reporting;
3. the full 50-instance benchmark only after the smoke is clean;
4. repeated trials only after cost projection and explicit operator confirmation.

## Product gates

The project must not claim “self-evolving” until all are true:

- full component and environment fingerprints on every evaluated candidate;
- protected targeted, regression, and held-out suites;
- OS-enforced evaluator isolation and no-network policy;
- repeated-trial consistency metrics;
- human-confirmed promotion and tested rollback;
- at least one candidate that improves a protected metric and survives canary;
- published caveats distinguishing company case studies, peer-reviewed evidence,
  and preprint-inspired mechanisms.

Until then, use **“eval-guided harness optimization”** in product language.

## Deferred beyond this plan

- autonomous promotion;
- mutation of OpenFusion runtime code or tool implementations;
- self-modifying graders, sandbox policy, or promotion thresholds;
- persistent full-content production traces without a separate privacy design and
  explicit user opt-in;
- peer-to-peer agent meshes, nested subagents, or concurrent writers on shared files;
- replacing the frontier reviewer with an actor from the same model/attempt;
- GEPA/DSPy as a packaged dependency before the engine-native optimizer boundary and
  protected gate prove useful;
- cloud/team aggregation of run evidence.
- remote prompt CMS, production/candidate traffic labels, and bot-managed prompt
  rollout until a deployment topology requires them;
- MCE-style optimization of the context-management algorithm before a structured
  playbook beats wiki/no-memory controls;
- autonomous creation of tools, permissions, transports, or tool implementations;
- semantic failure clustering before exact causal signatures are measurable.

## Immediate next move

Finish the remaining **A2–A3 observability integration**, then proceed to **B1:
explicit context policy and wiki snapshots**. A1 and the A4
`wiki_query`/`wiki_map` ToolSpec pilot are implemented, and protected review-prompt
identity from B3 is already in place. Do not start the evolver, weakness LLM,
prompt CMS, or scout team in parallel; each depends on trustworthy configuration
identity and evaluation.
