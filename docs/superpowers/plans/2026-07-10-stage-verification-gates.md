# Stage Verification Gates — Implementation Plan

**Date:** 2026-07-10  
**Status:** proposed  
**Related plan:** `docs/superpowers/plans/2026-07-10-harness-learning-spine.md`  
**Goal:** make every observable OpenFusion stage return evidence-backed completion,
distinguish execution from verification and approval, and prevent downstream stages
from treating missing or inconclusive evidence as success.

## Outcome

At the end of this plan, OpenFusion will be able to answer, for every run:

1. Which stage ran, against exactly which input snapshot?
2. Did the stage merely finish, or did its required checks pass?
3. What safe, structured evidence supports each check?
4. Is the stage output still current, or has its project/harness/diff changed?
5. Which stage first failed or became inconclusive?
6. Was the final patch verified, independently approved, and applied as the exact
   artifact the user reviewed?

The end state is a stage-gated pipeline:

```text
project snapshot
  -> provider readiness
  -> wiki operational verification
  -> harness artifact verification
  -> setup readiness
  -> task contract
  -> route/context/worktree
  -> worker candidate
  -> diff policy
  -> deterministic verifier
  -> requirement coverage
  -> independent rubric review
  -> approved candidate
  -> bound human approval
  -> fresh apply
```

An internal model step or model-authored summary is never itself a success oracle.
Only observable artifacts, deterministic checks, trusted probes, independent review,
or explicit human approval may close a required gate.

## Relationship to the learning-spine plan

This plan supplies the load-bearing stage/check vocabulary that the learning spine's
run envelopes, failure signals, experiments, and promotions need. It does not replace
that plan.

Implementation order between the plans:

1. Land the shared stage/check contract from this plan.
2. Reuse it in learning-spine run envelopes and events.
3. Land operational wiki/harness/task gates.
4. Use their failure signals for experiments and candidate promotion.

Do not create a second event ledger or a second harness fingerprint system. Extend
`packages/engine/src/runs/events.ts` and
`packages/engine/src/harness/fingerprint.ts` from the learning-spine work.

## Current-state audit

Existing code already provides several useful checks:

| Area | Existing behavior | Gap this plan closes |
|---|---|---|
| Wiki | Build stats, HEAD watermark, symbol/ref counts, query/map RPC, MCP round-trip tests | HEAD-only freshness, ambiguous skipped-file count, no persisted operational verdict or runtime canaries |
| Harness | Per-stage schemas, assembled-bundle schema, referential validation, post-write status | Structural correctness is conflated with semantic grounding and readiness |
| Project Card | Commands and anchors are grounded; card is human-approved | Free-form content and future verifier profiles need separate trust state and hash-bound approval |
| Routing | Deterministic classifier and resolvable routes/chains | Route validity is not separated from route quality; no declared route probe suite |
| Worker | Bounded tool loop, tool error telemetry, worktree isolation, complete diff capture | A normal model return or max-step stop is not task completion |
| Review | Structured approve/request-changes verdict | Rubric is broad; machine failures can be omitted from review input; escalation has no independent review |
| Apply | Explicit UI confirmation and `git apply --3way` | Approval is not bound to base SHA, diff hash, or verification report |
| Evals | Executable oracle and statistical verdict thresholds | Runtime stages do not yet produce the same typed verifier evidence |
| Runs | Metadata ledger and event schemas | No universal stage report, terminal-event completeness check, or freshness invalidation |

Important source behaviors to preserve:

- Sidecar stdout remains JSON-RPC only.
- Never persist prompts, task text, diffs, model output, RPC payloads, command output,
  test output, credentials, or secret values.
- Workers continue editing isolated worktrees.
- Applying to the selected repository remains a separate explicit user action.
- OpenFusion never commits, merges, or pushes user code.
- Unrelated dirty-worktree changes remain untouched.

## Core semantics

### Execution, verification, approval, and apply are different

Use these terms consistently:

- **Execution completed:** the operation returned without cancellation or transport
  failure.
- **Verification passed:** every required deterministic or trusted-probe check passed.
- **Approved:** an independent rubric reviewer accepted the exact verified artifact.
- **Applied:** Git applied the exact approved artifact to the selected working tree.

No one status implies another.

### Stage verdict rule

```text
required check failed          -> stage failed
required evidence unavailable  -> stage inconclusive
all required checks passed     -> stage passed
stage cancelled                -> stage cancelled, never failed/passed
```

`skipped` is a check status, not a successful stage verdict. A required skipped
check makes the stage inconclusive.

### Online and offline assurance

Some properties are valid per-run gates; others require population-level evals.

| Online gate | Offline assurance |
|---|---|
| Route resolves | Route was the best quality/cost choice |
| Wiki can answer canaries | Wiki improves coding-task quality overall |
| Reviewer returned a valid rubric | Reviewer false-approval rate is acceptably low |
| Provider can complete a smoke request | Model is adequate for assigned task classes |
| Verification commands pass | Verification profile catches the important regressions |

Do not block a run on claims that cannot be established from that run. Record them as
offline evaluation obligations instead.

## Phase A — Shared contracts and policy registry

**Purpose:** define one result language before adding phase-specific validators.

### A1. Shared schemas

**Create:**

- `packages/shared/src/verification.ts`
- `packages/shared/test/verification.test.ts`

**Modify:**

- `packages/shared/src/index.ts`

Define strict Zod schemas and inferred types:

```ts
type CheckStatus = "passed" | "failed" | "skipped" | "inconclusive";
type StageExecution = "completed" | "failed" | "cancelled";
type StageVerdict = "passed" | "failed" | "inconclusive" | "cancelled";

interface CheckEvidence {
  artifactId?: string;
  artifactDigest?: string;
  verifierId?: string;
  exitCode?: number;
  durationMs?: number;
  count?: number;
  expectedCount?: number;
  reasonCode?: string;
}

interface CheckResult {
  id: string;
  required: boolean;
  status: CheckStatus;
  summary: string;
  evidence?: CheckEvidence;
}

interface StageReport {
  schemaVersion: 1;
  stageId: string;
  policyVersion: number;
  attempt: number;
  inputRef: { id: string; digest: string };
  outputRef?: { id: string; digest: string };
  execution: StageExecution;
  verdict: StageVerdict;
  checks: CheckResult[];
  startedAt: string;
  durationMs: number;
}
```

The schema must reject unknown fields so prompts, outputs, paths, and other forbidden
payloads cannot accidentally enter durable evidence through an unreviewed property.

Add a pure `computeStageVerdict(checks, execution)` function. Callers may not handcraft
an overall verdict inconsistent with required checks.

**Tests:** truth table for every verdict branch, unknown-key rejection, evidence
bounds, duplicate check ID rejection, required-skipped -> inconclusive, cancellation
dominance, and distinctive forbidden-field fixtures.

### A2. Stage policy registry

**Create:**

- `packages/engine/src/verification/policy.ts`
- `packages/engine/test/verification-policy.test.ts`

Register stable stage and check IDs without executable callbacks:

```text
setup.project
setup.providers
setup.wiki.index
setup.wiki.retrieval
setup.wiki.delivery
setup.harness.overview
setup.harness.pages
setup.harness.card
setup.harness.agents
setup.harness.routing
setup.harness.persistence
setup.ready
task.contract
task.route
task.context
task.worktree
task.worker
task.diff
task.verify
task.coverage
task.review
task.retry
task.escalate
task.candidate
apply.preflight
apply.write
eval.task
eval.isolation
eval.oracle
eval.verdict
```

Each policy declares required check IDs and a policy version. The registry prevents a
caller from silently omitting a required check by constructing a shorter array.

**Exit criteria for Phase A:** shared tests pass; adding a required policy check makes
an incomplete report inconclusive; no runtime behavior changes yet.

## Phase B — Project and provider readiness

### B1. Project snapshot identity

**Create:**

- `packages/engine/src/verification/project.ts`
- `packages/engine/test/project-verification.test.ts`

Compute a safe project snapshot reference from:

- canonical project identity;
- Git HEAD SHA;
- deterministic digest of tracked supported-file path + content hashes;
- dirty-state category, without storing paths or diff content in the run ledger.

The full path remains in live RPC scope but is not copied into durable stage evidence.

Required checks:

- `project.git-repository`
- `project.head-resolved`
- `project.snapshot-stable` (HEAD and fingerprint unchanged across the operation)
- `project.scope-allowed`

### B2. Provider readiness

**Modify:**

- `packages/engine/src/models/methods.ts`
- `packages/engine/src/engines/methods.ts`
- corresponding provider/frontier tests

Add a read-only readiness composition over existing provider verification and frontier
availability. Required checks prove only connectivity and capability resolution:

- provider registered;
- model resolves;
- minimal bounded structured completion succeeds;
- required dialect pack resolves;
- frontier role selection resolves.

Unknown pricing is advisory/inconclusive for cost claims, not a connectivity failure.
Model adequacy remains an offline eval property.

**Exit criteria for Phase B:** a setup run can name the exact current project snapshot
and distinguish unavailable, unpriced, and low-confidence providers.

## Phase C — Wiki as the reference validator

**Purpose:** implement the first complete stage family and establish the pattern for
later LLM-produced artifacts.

### C1. Make index statistics verifiable

**Modify:**

- `packages/engine/src/wiki/indexer.ts`
- `packages/engine/src/wiki/store.ts`
- `packages/engine/test/wiki-indexer.test.ts`
- `packages/engine/test/wiki-store.test.ts`

Replace the ambiguous `filesSkipped` evidence with categorized counters while keeping
the old field additively for RPC compatibility:

```ts
interface WikiCoverage {
  supportedTracked: number;
  currentEntries: number;
  unchanged: number;
  oversized: number;
  unreadable: number;
  parseFailed: number;
  removed: number;
}
```

Store a source fingerprint and build-start/build-finish HEAD. Do not mark the index
current when HEAD changed during the build. After the write, verify every eligible
file has a row with the current content hash. Oversized files are explicit exclusions;
unreadable and parse-failed files are required failures unless a future approved
policy explicitly excludes them.

### C2. Wiki verifier

**Create:**

- `packages/engine/src/wiki/verify.ts`
- `packages/engine/test/wiki-verify.test.ts`

Required operational checks:

- `wiki.db-present`
- `wiki.db-integrity`
- `wiki.head-current`
- `wiki.source-current`
- `wiki.coverage-complete`
- `wiki.query-canaries`
- `wiki.map-canary`

Select bounded deterministic canaries from parsed build output before persistence:

- at least one definition per indexed language;
- bounded samples from high-ranked files;
- a symbol with references when available.

After persistence, query through the public shared helpers and require the expected
file, line, kind, and references. The map canary must be non-empty when definitions
exist, remain within budget, and contain only current tracked paths.

A repository with no supported files or no definitions receives operational
`inconclusive`, not a false pass.

### C3. Delivery verifier

**Modify:**

- `packages/engine/src/wiki/mcp.ts`
- `packages/engine/src/wiki/methods.ts`
- `packages/engine/test/wiki-mcp.test.ts`

Add a bounded official-client round trip:

- server starts;
- tool list contains `wiki_query` and `wiki_map`;
- both tools answer canaries;
- stop/cleanup completes.

The in-process worker tools use the same query helpers, so their equivalence remains a
unit/integration test rather than starting a real worker model.

### C4. Semantic probes

**Modify later in Phase D:** harness schema and card approval UI.

Define optional human-approved probes that name a query and expected artifact IDs.
Automatically selected canaries prove plumbing. Approved semantic probes prove
repository usefulness. Without approved probes:

```text
operational = passed
quality = inconclusive
```

The existing credentialed Claude wiki smoke remains a release/provider smoke, not a
normal readiness gate.

### C5. RPC and status integration

**Modify:**

- `packages/engine/src/wiki/methods.ts`
- `packages/shared/src/wiki.ts`
- `apps/desktop/src/engineClient.ts` only after engine contracts stabilize

Add `engine.wiki.verify` and additive `verification` data to `engine.wiki.status`.
Persist the latest report under the run evidence directory, tied to the source
fingerprint. Any HEAD/content mismatch invalidates it.

**Negative tests:** corrupt DB, HEAD changes mid-build, dirty file changes after
indexing, parse failure, missing eligible row, empty map with definitions, bad canary,
MCP timeout, missing tool, unbuilt wiki, no supported files.

**Exit criteria for Phase C:** `built: true` alone never satisfies setup readiness;
the wiki must carry a current operational StageReport.

## Phase D — Harness generation and readiness gates

### D1. Grounded LLM artifact envelope

**Create:**

- `packages/engine/src/harness/verify.ts`
- `packages/engine/test/harness-verify.test.ts`

For every model-generated harness artifact, validate four layers:

1. schema and size bounds;
2. grounding against paths, symbols, manifests, or mined commands;
3. cross-artifact consistency;
4. downstream handoff compatibility.

Do not use a second LLM to establish deterministic facts that source inspection can
prove.

### D2. Overview and prose pages

**Modify:**

- `packages/engine/src/harness/generate.ts`
- `packages/engine/src/harness/schema.ts`
- `packages/engine/test/harness-generate.test.ts`

Required overview checks:

- schema valid;
- subsystem paths exist;
- commands resolve;
- mandatory source roots are represented;
- no duplicate subsystem IDs.

Required page checks:

- schema and digest budgets;
- referenced anchors resolve;
- page/overview consistency;
- mandatory topic coverage;
- no forbidden injected workflow or secret material.

Free-form claims without deterministic grounding remain inconclusive or require human
review; they are never silently upgraded to machine-verified facts.

### D3. Project Card, probes, and verification profiles

**Modify:**

- `packages/engine/src/harness/card.ts`
- `packages/engine/src/harness/schema.ts`
- `packages/engine/src/harness/methods.ts`
- `packages/engine/src/harness/store.ts`
- related tests

Bump the generated harness schema additively and define:

```yaml
verificationProfiles:
  codegen:
    - id: typecheck
      argv: ["pnpm", "typecheck"]
      required: true
      timeoutMs: 300000
wikiProbes: []
```

Profiles use program + argv, not arbitrary shell strings. Commands must be mined or
resolve to a current manifest/CI target. Generated profiles and probes start draft.
Approval is bound to their content digest; edits reset approval.

Legacy harnesses without profiles remain loadable but report verification readiness
as inconclusive/manual-required. Do not invent a passing legacy default.

### D4. Agent and routing verification

Required online checks:

- unique agents;
- required task-class coverage;
- provider/model/dialect resolution;
- reachable agents;
- valid chains and escalation bounds;
- deterministic route probe matrix.

Model adequacy and route optimality are recorded as offline eval obligations.

### D5. Persistence and aggregate readiness

After atomic write, reload and compare the bundle/fingerprint to the candidate. Add an
engine-owned readiness aggregator:

```text
project current
AND providers operational
AND wiki operational
AND harness structural/grounding checks passed
AND routes resolvable
AND verification configuration approved or explicitly manual-required
```

Expose separate readiness levels:

- `operational`
- `reviewed`
- `evaluated`

**Exit criteria for Phase D:** harness generation no longer reports one undifferentiated
structural pass; the UI/API can show exactly which setup stage remains draft,
inconclusive, stale, or failed.

## Phase E — Task contract, routing, context, and worktree

### E1. Task contract

**Create:**

- `packages/engine/src/orchestrate/task-contract.ts`
- `packages/engine/test/task-contract.test.ts`

Extract an ephemeral structured contract:

```ts
interface TaskContract {
  requirements: Array<{ id: string; sourceOrdinal: number; required: boolean }>;
  constraints: Array<{ id: string; sourceOrdinal: number }>;
  proposedChecks: Array<{ id: string; requirementIds: string[] }>;
  ambiguity: "none" | "non-material" | "material";
}
```

Do not persist task text or model-authored requirement prose in the ledger. The
original task remains authoritative. Generated criteria may clarify but never remove
or weaken original requirements. Material ambiguity is inconclusive and requires user
direction; ordinary unambiguous tasks continue automatically.

### E2. Route and context gates

**Modify:**

- `packages/engine/src/orchestrate/routing.ts`
- `packages/engine/src/orchestrate/orchestrate.ts`
- corresponding tests

Route verification proves that route/agent/model/dialect resolve and records the
stable route ID. Context verification proves that only current approved artifacts are
included, token limits hold, and retrieval failures are explicit.

### E3. Worktree gate

**Modify:**

- `packages/engine/src/worker/worktree.ts`
- `packages/engine/test/worker-worktree.test.ts`

Required checks:

- based on expected task base SHA;
- isolated from selected repository;
- initial diff empty;
- containment root canonicalized;
- user repository unchanged after creation.

**Exit criteria for Phase E:** every implementation attempt starts from a verified
task/context/worktree handoff with stable input references.

## Phase F — Candidate, verifier, coverage, and review

### F1. Worker termination semantics

**Modify:**

- `packages/engine/src/worker/loop.ts`
- `packages/engine/src/worker/methods.ts`
- worker tests

Separate loop completion from candidate completion. Reaching `maxSteps` while the
finish reason still requests tools is inconclusive. Timeouts and cancellation remain
separate terminal states. Tool-error counters are evidence, not an automatic failure
unless policy marks the error unresolved/fatal.

### F2. Diff policy gate

**Create:**

- `packages/engine/src/orchestrate/diff-policy.ts`
- `packages/engine/test/diff-policy.test.ts`

Required checks:

- non-empty when changes are required;
- valid patch;
- complete against creation-time base;
- untracked files included;
- paths contained and allowed;
- no credentials/cache/forbidden generated artifacts;
- stable diff digest produced.

### F3. Deterministic verifier service

**Create:**

- `packages/engine/src/verify/run.ts`
- `packages/engine/src/verify/types.ts`
- `packages/engine/test/verifier.test.ts`

Select the approved profile for the routed task class. Run structured argv commands
inside the worktree with bounded timeouts and cancellation. Distinguish:

- command pass;
- command/test failure;
- missing executable or invalid profile;
- timeout;
- cancellation;
- verifier-caused tracked mutation;
- policy violation.

Record IDs, exit codes, duration, and categories only. Do not persist command strings
or output.

### F4. Requirement coverage

**Create:**

- `packages/engine/src/orchestrate/coverage.ts`
- `packages/engine/test/orchestrate-coverage.test.ts`

Map each required task-contract ID to safe evidence IDs: changed artifact, verifier
check, test identifier, documentation artifact, or reviewer dimension. Missing
required evidence is inconclusive.

### F5. Explicit review rubric

**Modify:**

- `packages/engine/src/orchestrate/review.ts`
- `packages/engine/test/orchestrate-review.test.ts`

Replace the broad verdict with fixed dimensions:

```text
requirements
correctness
verification
regression-risk
safety-security
scope
tests
documentation-migrations
```

The engine derives the overall decision. A model-provided `approve` is invalid when a
required dimension is missing/inconclusive or deterministic verification failed.
Machine checks cannot be overridden by reviewer prose.

### F6. Retry and escalation parity

**Modify:**

- `packages/engine/src/orchestrate/orchestrate.ts`
- `packages/engine/test/orchestrate.test.ts`

Retries begin from the immutable task base and receive structured prior failure IDs
plus bounded reviewer reasons. Frontier escalation produces only a candidate, then
runs the same diff, verifier, coverage, and separate read-only review gates. The
writer may not approve its own result in the same session.

Additive outcomes during migration:

- `worker-approved`
- `frontier-approved`
- `human-review-required`
- `verification-failed`
- `failed`
- `cancelled`

Keep legacy `escalated` decoding temporarily in desktop/eval clients, but stop
producing it after all callers migrate.

**Negative tests:** max-step stop, normal completion/no diff, forbidden path, failed
test plus reviewer approve, missing rubric dimension, verifier timeout, verifier
mutation, uncovered requirement, frontier non-empty broken diff, writer self-approval.

**Exit criteria for Phase F:** no worker or frontier result can become approved solely
because a model returned normally or created a non-empty diff.

## Phase G — Approval and Apply binding

### G1. Candidate reference

Return a safe candidate reference containing random run/candidate IDs plus digests of
the base snapshot, harness, diff, verification report, and review report. Do not put
task text or diff content into durable logs.

### G2. Preflight and apply

**Modify:**

- `packages/engine/src/orchestrate/methods.ts`
- `apps/desktop/src/engineClient.ts`
- `apps/desktop/src/screens/OrchestrateScreen.tsx`
- corresponding tests

Before Apply require:

- project identity matches;
- current HEAD and relevant source fingerprint match the candidate base;
- diff/report digests match the approved candidate;
- Git apply preflight succeeds;
- user approved this exact candidate.

After Apply report `applied`, not `verified`. Do not automatically run commands in a
dirty selected working tree. If an unverified Apply escape hatch is retained, make it
a separate, explicit action that displays every failed/inconclusive check.

**Exit criteria for Phase G:** stale or substituted diffs cannot reuse an earlier
approval.

## Phase H — Evaluations, evidence, and learning integration

### H1. Reuse verifier reports in evals

**Modify:**

- `packages/engine/src/evals/run.ts`
- `packages/engine/src/evals/tasks.ts`
- `packages/engine/src/evals/verdict.ts`
- eval tests

Golden task construction verifies parent-fails/golden-passes where supported. Both
arms record identical snapshot/oracle identities. Runtime verifier failure remains
distinct from evaluator-owned oracle failure. Existing measurement-failure and
statistical thresholds remain authoritative.

### H2. Complete metadata events

**Modify:**

- `packages/engine/src/runs/events.ts`
- `packages/engine/src/runs/ledger.ts`
- related tests

Emit stage started/finished events and verifier/reviewer terminal evidence. Validate:

- exactly one terminal event for every started stage;
- monotonic sequence numbers;
- final result references every required stage report;
- event schemas reject forbidden fields;
- ledger/event write failure remains observer-only.

### H3. Learning-spine failure signals

Map failed/inconclusive check IDs to the learning spine's deterministic failure
categories. Experiments use stable check IDs rather than parsing reviewer prose.

**Exit criteria for Phase H:** offline evals can measure wiki, route, model, reviewer,
and verifier quality using the same stage evidence emitted online.

## Phase I — Desktop presentation and rollout

Desktop work begins after engine contracts stabilize because the current worktree has
broad overlapping UI changes.

Display a checklist grouped by setup, attempt, verification, review, and Apply:

```text
passed        green
failed        red
inconclusive  yellow
skipped       gray
cancelled     neutral
```

Never render a progress notification as a passed check. A progress row means only
that work was reported.

Roll out enforcement in three modes:

1. **Observe:** produce reports without changing outcomes; compare against current
   behavior in tests and local smokes.
2. **Warn:** block the normal Apply path on failed/inconclusive required checks, with
   an explicit unverified path if product policy allows it.
3. **Enforce:** orchestration approval itself requires all mandatory gates.

Mode is an engine-owned release setting, not an LLM-controlled task parameter.

## Fault-injection test rule

Every required check must have at least one negative test that deliberately violates
the condition and proves the stage cannot pass. A happy-path assertion alone is not
acceptance coverage.

Minimum cross-stage fault matrix:

| Fault | Expected first terminal stage |
|---|---|
| Git HEAD changes during setup | `setup.project` failed |
| Wiki DB exists but source changed | `setup.wiki.index` failed |
| Wiki query plumbing broken | `setup.wiki.retrieval` failed |
| MCP tool absent | `setup.wiki.delivery` failed |
| Hallucinated harness command | `setup.harness.card` failed/inconclusive |
| Unknown routed model | `task.route` failed |
| Draft/stale context injected | `task.context` failed |
| Worktree starts dirty | `task.worktree` failed |
| Worker hits max steps | `task.worker` inconclusive |
| Empty or forbidden diff | `task.diff` failed |
| Required test fails | `task.verify` failed |
| Requirement lacks evidence | `task.coverage` inconclusive |
| Reviewer approves despite test failure | `task.review` schema/policy failed |
| Escalation creates broken diff | `task.escalate` failed |
| HEAD changes before Apply | `apply.preflight` failed |
| Oracle command missing | `eval.oracle` measurement failure |

## Documentation changes required with behavior

When implementation changes behavior, update in the same change:

- `docs/human/workflows.md`
- `docs/human/getting-started.md` when setup/readiness UX changes
- `docs/agents/workflows.md`
- `docs/agents/subsystems/wiki-harness.md`
- `docs/agents/subsystems/orchestration.md`
- `docs/agents/subsystems/evaluations.md`
- `docs/agents/testing.md` for new commands/smokes
- `docs/agents/map.json` when adding a new canonical agent topic page

Plans remain historical evidence; the human and agent pages describe shipped
behavior.

## Delivery slices

Implement and verify in these reviewable slices:

1. **Contracts only:** Phase A, no behavior change.
2. **Wiki reference gate:** Phase C plus project snapshot subset of Phase B.
3. **Harness setup gate:** Phase D and readiness aggregation.
4. **Attempt mechanics:** Phase E plus F1/F2.
5. **Deterministic verification:** F3/F4.
6. **Rubric and escalation parity:** F5/F6.
7. **Approval binding:** Phase G.
8. **Eval/evidence integration:** Phase H.
9. **Desktop checklist and enforcement:** Phase I.

Each slice runs targeted tests first, then:

```sh
pnpm --filter @openfusion/shared test
pnpm --filter @openfusion/engine test
pnpm --filter @openfusion/desktop test
pnpm docs:check
./dev.sh check
```

Credentialed wiki/frontier/worker/orchestrate/eval smokes remain opt-in and run at the
release boundary after deterministic suites pass.

## Plan completion criteria

This plan is complete only when:

1. Every registered runtime stage emits a policy-complete StageReport.
2. Required missing evidence produces inconclusive, never success.
3. Setup readiness requires current project, wiki, harness, route, and provider
   evidence.
4. Worker max-step completion and non-empty diffs cannot bypass verification.
5. Required deterministic commands gate review approval.
6. Frontier escalation passes the same verifier and independent review as workers.
7. Human approval is bound to the exact fresh candidate.
8. Apply reports mechanical application separately from verification.
9. Evals reuse stage evidence without weakening the evaluator-owned oracle.
10. Every required check has fault-injection coverage.
11. Durable evidence contains no prohibited content.
12. Human and agent documentation match the shipped behavior.

## First execution slice

Begin with **Contracts only**:

1. Add `packages/shared/src/verification.ts`.
2. Add its truth-table and forbidden-field tests.
3. Add the engine stage policy registry and completeness tests.
4. Export the shared types.
5. Update only the canonical documentation needed to describe the additive contract.
6. Run shared tests, engine policy tests, docs checks, then `./dev.sh check`.

Do not modify orchestration outcomes, harness schemas, wiki status, or desktop UI in
this first slice. That keeps the foundational contract reviewable before it becomes
load-bearing.
