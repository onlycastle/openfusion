# Universal runtime

OpenFusion runs workers, children, review helpers, and evaluation oracles on one
durable session model. The runtime is local to a project and is designed to
survive approvals, engine restarts, and partial tool failures without treating
observer logs as authority.

## Durable sessions and encrypted content

`.openfusion/cache/runtime.db` is the authoritative SQLite database. It uses
WAL, `synchronous=FULL`, forward-only migrations, transactions, and optimistic
session versions. `runs.jsonl` and metadata event files remain compatibility
views that can be rebuilt from authoritative state.

Session notifications expose IDs, status, version, usage, and other safe
metadata. Task text, prompts, model messages, diffs, commands, and tool output
are absent. Projects may opt into exact traces; each content record then uses
AES-256-GCM and large artifacts are encrypted after a temporary-file `fsync`
and atomic rename. The Rust host keeps a random per-project key in macOS
Keychain and passes it to the engine in memory. Without that key, metadata is
still readable and content is reported as locked.

Trace retention defaults to seven days or 2 GiB. One artifact, including one
tool-output stream, is limited to 16 MiB and one session to 256 MiB.
Metadata-only sessions expire transient
content when they terminate. Startup cleanup removes temporary and
unreferenced artifact files.

## Lifecycle, approval, and recovery

Sessions move through `created`, `running`, `waiting-approval`, `interrupted`,
`needs-recovery`, and terminal states. Every state-changing action supplies
the expected version, so a stale Studio tab cannot overwrite a newer answer.
Async orchestration returns its session and run IDs immediately; Studio then
uses `sessions.get`, `sessions.list`, and `sessions.action`.

The worker loop persists each completed model response batch before another
model call. Tool start, result, usage, and approvals are persisted around tool
execution. A blocking compatibility call denies an unresolved `ask`; an
interactive session stops and waits for an approval response.

Worker RPCs enter the shutdown drain before their first setup await. Engine
shutdown stops new worker admission, cancels admitted work, and waits for its
setup, persistence, and error mapping to finish before closing SQLite.

After a successful mutating batch and before an externally visible pause, the
runtime stores a compressed binary Git patch against the immutable base SHA.
It never automatically replays an incomplete side-effecting tool. Recovery can
continue the current isolated worktree, reconstruct a fresh worktree from the
last checkpoint, or abandon the session. Exact model-history resume requires
an enabled, unlocked trace.

## Policy and process containment

Policy authority is layered: immutable product/evaluation ceilings, approved
project grants, session grants, extension restrictions, and finally the
intersection inherited by a child. Most-specific rules win within one layer;
a lower layer can narrow authority but cannot override a hard deny.

The bundled `openfusion-sandbox` runner canonicalizes paths, clears the host
environment, applies role-specific macOS Seatbelt profiles, denies network by
default, and supervises the descendant process group. Bash is unavailable
when the runner or its startup probe is unavailable. There is no cwd-only or
unsandboxed fallback.

## Context and approved extensions

At session start the runtime freezes instructions, ordered tool schemas,
policy, sandbox identity, skill/MCP/hook fingerprints, and adapter versions.
At 70% of a model-family context limit it derives a bounded summary while
retaining the authoritative events and a recent tail. Canonical reads are
deduplicated until the worktree mutation epoch changes.

`ContextCompiler` pins the initial model view to the worktree base and wiki
source identity. It orders stable instructions, approved Project Card context,
and a task-conditioned wiki map before the volatile task; inline retrieved
context is capped at 32 KiB and larger output is represented only by validated
artifact references. Its content-derived fingerprint is frozen with the
session and must match on exact resume.

Claude Code and Codex skill dialects normalize into one internal skill shape.
Unsupported vendor fields produce diagnostics. Instructions alone may load
without additional authority; scripts, hooks, tools, MCP, network, or
permission expansion require an approved fingerprint.

MCP supports stdio and Streamable HTTP over HTTPS or loopback HTTP. Redirects
are rejected, credentials stay in Keychain, and imported tools pass through
policy, cancellation, timeouts, hooks, and artifact output handling. Process
hooks receive normalized risk facts rather than model or tool content. They may
observe or narrow a decision, never mutate inputs or grant authority.

Wiki, file, edit, patch, artifact-read, Bash, skill-load, MCP, and child tools
share one versioned `ToolSpec`/approved-inventory registry. `ToolGateway` validates each invocation's
dynamic filesystem/process/network/secret claims against every applicable
claim layer before consulting the composed policy. Unknown tools and uncovered
claims fail closed; approval resolves only an existing `ask` decision.

Every production API completion and official-runtime prompt is admitted by
`ProviderGateway`. The gateway enforces eight active calls globally, four per
provider, and 64 queued calls; queued cancellation is immediate and saturation
returns stable retry guidance. It owns transport retry hooks, cache hit/miss
telemetry, shutdown abort, and the shared usage-accounting seam while adapters
retain their model-specific protocols.

## Children and evidence-backed routing

Children are ordinary depth-one sessions with independent worktrees, traces,
budgets, approvals, and cancellation. They are disabled per project by
default, capped at three per parent and six globally, and inherit the
intersection of parent authority. Child control and patch import enter
`ToolGateway`; spawning fails closed without certified containment. A child patch is opaque until the parent
explicitly imports it. Import checks parent version/checkpoint identity,
serializes mutation, reports conflicts, and rolls back from a pre-import
checkpoint on an unexpected partial failure.

The model-facing spawn tool accepts only a bounded task. The runtime resolves
the configured provider internally, reserves the child budget, and mints a
typed `DelegationRequest` bound to parent, base SHA, target adapter, deadline,
and inherited-authority digest. Provider credentials never enter the request,
prompt, child environment, or returned artifact.

Protected evaluations store repeated seeded trials in `runtime.db`. The
offline evidence compiler uses safe metadata features and produces a
deterministic routing-v3 override table. Promotion requires at least 20 clean
matched tasks, complete pricing, no safety violation, conservative quality and
savings bounds, a reproducible shadow check, and explicit human approval
against the current harness digest. Sparse or stale evidence falls back to the
configured harness route. Promotion and exact rollback live in the Harness
workspace; Health remains metadata-only.
