# How OpenFusion works

OpenFusion turns one committed repository snapshot into one verified candidate.
The selected checkout is never used as a model work area and changes only after
an explicit, candidate-bound Apply.

```text
select project
  -> verify runtime and sandbox capabilities
  -> build the committed-source wiki
  -> load or generate an immutable harness generation
  -> capture one TaskSnapshotRef
  -> route and author in detached worktrees
  -> verify and review one exact candidate
  -> mint CandidateRef
  -> optionally prepare and consume ApprovalGrant
```

## 1. Prepare a project

Studio requires a Git repository, the selected lead-model runtimes, at least
one configured worker model, and a structurally valid harness tied to the
current committed `HEAD`. Runtime readiness is capability based: a role is not
started when its selected adapter cannot enforce the required structured
output, MCP, approval, or sandbox contract.

OpenFusion indexes supported source files from Git blobs at exact `HEAD`; it
does not index dirty tracked edits or untracked files. A build is rejected if
`HEAD` changes during indexing. `wiki_map` and `wiki_query` are projected from
one transport-neutral `ToolSpec` registry into worker, MCP, and frontier
surfaces.

The loopback wiki MCP server is ephemeral, request-size and concurrency
bounded, and protected by a random bearer token. Server status never returns
that token.

## 2. Generate the harness

The planning role receives read-only, on-demand wiki access. The engine drives
schema-constrained stages for overview, prose pages, Project Card, agents, and
routing. Each stage has two bounded attempts and is validated with Zod; no
heuristic JSON repair is performed.

Harness storage is immutable-generation based:

```text
.openfusion/
  current.json
  generations/<generation-id>/
    manifest.json
    routing.yaml
    wiki/
      architecture.md
      subsystems.md
      conventions.md
      build-and-test.md
      project-card.md
    agents/<specialist-name>.yaml
  cache/wiki.db
```

The engine builds a complete temporary generation, reloads and fingerprints
it through the normal reader, renames it into `generations/`, then atomically
replaces `current.json`. Failed writes leave the prior pointer untouched.
Legacy flat harnesses remain readable and the next successful write imports
their effective content into the generation layout. Editing or approving a
Project Card creates another validated generation; direct edits to an active
generation invalidate its fingerprint.

The Project Card starts as `draft`. Approved cards contribute their bounded
digest to worker context; otherwise only the build-and-test digest is used
when present. Broader repository knowledge stays on demand.

## 3. Capture the task snapshot

Before a model call, one `RunSupervisor` captures:

- committed base SHA and base-tree digest;
- dirty-state category and digest;
- active harness generation and fingerprint;
- committed wiki identity;
- tool-registry and sandbox-policy digests; and
- selected runtime capability digests.

All retries, verifier clones, reviewers, and escalations start at this exact
base SHA. When the selected working tree is dirty, Studio reports that the
dirty content is excluded. It is preserved, and Apply later rejects any
candidate-touched path that is dirty. Workers atomically read the committed
wiki identity and compare it with the task pin before querying a read-only
in-memory snapshot. Missing or changed pins fail closed, so a live index
rebuild cannot alter retrieval partway through an attempt. Direct public
worker calls enter the same bounded run kernel; nested workers inherit the
parent supervisor.

Top-level admission is bounded to two active runs and eight queued runs, with
one writer per project. A full queue returns `BUSY` with retry guidance.

## 4. Author in isolated worktrees

Task worktrees are detached and stored in host application storage, outside
the selected repository. A worker gets its dialect instructions, the narrow
project digest, the specialist prompt, the structured task contract, and any
retry feedback.

`ContextCompiler` binds that initial view to the worktree base and current wiki
source fingerprint. Stable instructions, the approved Project Card, and a
task-conditioned wiki map precede volatile task text. Inline repository/tool
context is capped at 32 KiB; larger prior outputs enter only as artifact IDs
and digests for bounded reads. The compiled source metadata and fingerprint
are frozen for exact-resume checks without entering content-free journals.

File/edit tools reject traversal, symlink escapes, and Git/OpenFusion control
paths. Bash has no cwd-only fallback: it appears only when the native Rust
sandbox probes successfully. The sandbox canonicalizes roots, clears inherited
environment variables, denies network unless explicitly claimed and approved,
applies the author profile, and supervises descendant processes. Platforms
without a certified backend fail closed.

These core tools project their schemas and guidance from the versioned
`ToolSpec` registry. Every invocation declares dynamic resource claims through
`ToolGateway`; parent, role, tool, and invocation authority intersect before
the filesystem or process operation begins. Journals retain only tool IDs,
claim counts, decisions, and reason codes—not claimed paths or tool content.

Official runtimes remain adapter specific. Codex authoring uses its explicit
workspace-write sandbox with network disabled. Claude currently advertises no
certified authoring sandbox, so OpenFusion refuses to use it for a write-capable
role. Planning and review receive only read-only wiki capabilities.

Tool output is stored as encrypted artifacts instead of being copied into
every later prompt. Model-facing responses contain a bounded preview and an
artifact ID for pagination. The ceilings are 16 MiB per artifact and 256 MiB per
session.

## 5. Verify and review the exact candidate

Every worker and escalation result follows the same pipeline:

1. canonicalize a binary-aware Git diff against the snapshot base;
2. reject empty, oversized, binary, symlink, reserved-path, or escaping
   changes;
3. materialize that exact digest in a disposable verifier clone;
4. run `git diff --check` and the structured contract's deterministic
   verification commands under the verification sandbox;
5. bind requirement coverage to the structured contract digest; and
6. open a fresh, independent reviewer session in the exact candidate tree
   under read-only policy.

The reviewer inspects the tree and structured evidence; the prompt does not
duplicate the full patch. The reviewer session must differ from the author
session. If deterministic verification, capability readiness, or independent
review is unavailable, verification is incomplete and normal Apply is not
offered.

A passing pipeline mints `CandidateRef`. It binds the snapshot and base SHA,
author attempt/session, reviewer session, diff digest, touched paths,
verification-report digests, lifecycle, and expiration.

## 6. Review and Apply

Studio shows the candidate and asks for explicit confirmation. It then calls:

```text
engine.candidates.prepareApply {
  candidateId,
  projectDir
}

engine.orchestrate.apply {
  candidateId,
  approvalGrant,
  projectDir
}
```

Preparation recomputes the candidate digest, requires unchanged `HEAD`, and
checks dirty-path overlap. It returns a one-use grant valid for ten minutes and
bound to the destination, base SHA, and diff digest. Apply validates the grant
again, consumes it, repeats freshness and overlap checks, runs `git apply
--check --3way`, then applies without committing.

Candidate substitution, stale-base Apply, reuse of a grant, and overwriting a
dirty touched path are rejected. The unsafe raw-diff compatibility path exists
only when explicitly enabled in a non-production development process; packaged
builds cannot use it.

## 7. Cancellation, journals, and privacy

The supervisor owns the cancellation tree, sessions, processes, worktrees,
budget, candidate state, and cleanup callbacks. Its durable metadata journal
uses run/span/parent-span/attempt identifiers and permits only the root span to
emit the run terminal event. On startup, an unterminated journal owned by a
dead process becomes `interrupted_nonresumable` unless an enabled encrypted
vault provides exact content.

Metadata contains identifiers, digests, categories, counts, timings, and cost
completeness—not prompts, tasks, diffs, model or command output, RPC payloads,
or secrets. The optional trace vault encrypts content with a Keychain-provided
key. With the vault disabled, transient content is expired at run termination.

Costs are reported as `CostEstimate`. `knownUsd` is the priced portion;
`completeness` and `unpricedCalls` state whether it is complete. A partial sum
is never labeled `totalUsd`.

## 8. Evaluation

`engine.evals.run` remains the directional, one-trial API. For each historical
task, both arms are recreated from the same pre-fix source tree. OpenFusion
verifies the trees have the same Git tree ID, builds one committed-source wiki,
and gives both arms the same authenticated MCP endpoint, sandbox, oracle,
budget posture, and candidate pipeline. Only the declared harness treatment
differs. Public verification commands may run during candidate compilation;
evaluator-only tests and fixtures are materialized only after author and
reviewer sessions close. The protected oracle then runs under the evaluation
sandbox.

`engine.evals.experiment` adds counterbalanced seeded arm order, SQLite-backed
repeated trials, resume without duplicate completed rows, `pass@k`, `pass^k`,
task-clustered 95% intervals, p50/p95 latency, complete cost intervals, retry,
escalation, intervention, tool-error, measurement, and safety outcomes.

Protected results feed an offline evidence compiler. A routing-v3 proposal
needs at least 20 clean matched tasks, complete pricing, no safety failure, a
quality-delta lower bound above -5 percentage points, a positive paired-savings
lower bound, a reproducible shadow check, and explicit human approval against
the current harness digest. Harness owns promotion and rollback; Health stays
metadata-only. A missing or stale match uses the configured route.

## Further detail

- [Architecture](architecture.md)
- [Agent workflow page](../agents/workflows.md)
- [Agent orchestration page](../agents/subsystems/orchestration.md)
- [Agent wiki and harness page](../agents/subsystems/wiki-harness.md)
- [Agent evaluation page](../agents/subsystems/evaluations.md)
- [Universal runtime](runtime.md)
