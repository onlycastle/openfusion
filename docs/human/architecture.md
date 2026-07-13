# Architecture

OpenFusion is a macOS-first Tauri application with a TypeScript control plane
and a small Rust security layer.

```text
React webview
  -> Tauri invoke / Channel
  -> Rust desktop host
  -> NDJSON JSON-RPC over stdio
  -> TypeScript engine
       -> RunKernel / RunSupervisor
       -> ProviderGateway -> Claude, Codex, and API adapters
       -> candidate verification and Apply
       -> Rust openfusion-sandbox process runner
```

The split is intentional. TypeScript owns orchestration, provider adapters,
context, tools, verification, evaluation, and policy composition. Rust owns
desktop lifecycle, Keychain access, sidecar supervision, and the native process
containment that JavaScript cannot enforce reliably.

Inside the engine, orchestration calls typed worker, frontier, candidate,
Apply, and experiment services directly. The JSON-RPC dispatcher is only the
external process transport and compatibility adapter; internal calls never
serialize and redispatch application work.

## Run ownership

Every top-level orchestration, Apply, or evaluation is admitted by one bounded
`RunKernel`. A `RunSupervisor` captures one immutable `TaskSnapshotRef` before
the first model call and owns cancellation, budgets, child cleanup, cost
completeness, and a serialized lifecycle journal.
The public worker RPC enters this same kernel; nested worker and child calls
reuse the owning supervisor rather than opening an unsupervised run.
Worker model turns, validation retries, reviews, escalations, and every
model-facing tool execution reserve from that supervisor before the operation
starts; nested evaluation arms use the same top-level budget.

The snapshot pins committed `HEAD`, the committed tree digest, dirty-state
category and digest, the active harness generation and fingerprint, wiki
identity, tool-registry digest, sandbox policy, and runtime capability digests.
Snapshot capture rechecks `HEAD` after every asynchronous capability probe, so
base drift anywhere in the capture window rejects the run before model work.
Workers, retries, verifier clones, reviewers, and escalations use that captured
base SHA. A worker attaches wiki context only when its atomically read source
identity and digest match the captured pins and that SHA, then queries a
read-only in-memory SQLite copy for the attempt. Missing or drifted pinned
state fails closed; rebuilding the live wiki cannot change the view. Dirty
checkout content is excluded.

Admission is bounded to two active top-level runs and eight queued runs
globally, with only one writer run per project. JSON-RPC handling is separately
bounded to 32 concurrent handlers, 8 MiB per inbound line, and 4 MiB of
application-managed outbound buffering. Saturation returns the stable `BUSY`
error; progress notifications may be coalesced or dropped, while terminal
responses wait for capacity.

All production model turns enter one `ProviderGateway`. It caps global and
per-provider concurrency, bounds its queue, propagates cancellation and
shutdown, provides the transport-retry seam, records cache telemetry, and is
the sole production path into shared usage/cost accounting. Frontier streams
retain their native adapter protocol behind the same permit lifecycle.

Core wiki, file, edit, patch, artifact-read, process, skill-load, and child
tools are declared in one versioned `ToolSpec` registry; approved MCP
inventories register dynamically. Each call enters `ToolGateway` with dynamic
filesystem, process, network, or secret claims. The gateway requires every
claim to be covered by parent, role, and tool policy and then applies the
composed runtime decision; an approval can satisfy `ask` but cannot override a
deny or widen any resource claim.

## Worktrees and native containment

Task worktrees are detached Git worktrees stored under the host application
storage root, outside the selected repository. They always start at the
captured base SHA. Candidate policy rejects binary patches, symlinks, oversized
diffs, traversal, and changes to `.git`, `.gitmodules`, or `.openfusion`.

`openfusion-sandbox` is a standalone Rust runner bundled beside the engine.
On macOS it canonicalizes every path and applies role-specific Seatbelt
profiles for authoring, verification, review, evaluation, and scouting. The
runner clears the inherited environment, denies network by default, supervises
the full descendant process group, and fails closed when its backend or policy
is unavailable. API-worker Bash is exposed only after this backend probes as
available. Claude authoring remains disabled because its adapter does not yet
provide a certified containment boundary; Codex uses its explicit native
read-only/workspace-write sandbox contract.

## Candidate boundary and Apply

Model output is not directly applicable. The engine canonicalizes one exact
candidate, materializes it in a disposable verifier clone, runs deterministic
commands, checks the structured task contract, and opens a fresh independent
reviewer in that exact candidate tree. Only a passing result receives a
`CandidateRef` binding the snapshot, base SHA, author and reviewer sessions,
diff digest, touched paths, reports, lifecycle, and expiry.

Apply is a two-step capability flow. `engine.candidates.prepareApply` repeats
freshness checks and mints a one-use ten-minute `ApprovalGrant` for the exact
candidate, destination, base SHA, and diff digest. `engine.orchestrate.apply`
recomputes those identities, rejects changed `HEAD` or dirty overlapping paths,
runs a final mechanical check, consumes the grant, and applies without
committing. Raw-diff Apply is disabled in packaged builds and is available only
behind an explicitly unsafe development flag.

## Storage and privacy

Portable harness state is generation based:

```text
.openfusion/
  current.json
  generations/<generation-id>/
    manifest.json
    routing.yaml
    wiki/*.md
    agents/*.yaml
  cache/
    wiki.db
    runtime.db
    runs.jsonl
```

Writers build and validate a complete immutable generation, rename it into
place, then atomically replace `current.json`. Readers therefore see either the
previous valid generation or the new valid generation, never a mixture. Task
capture pins bundle, generation ID, and fingerprint from one pointer read. Legacy
flat harnesses remain readable and are superseded by the first successful
generation write.

`cache/runtime.db` is the authoritative session/evidence store. It uses SQLite
WAL, `synchronous=FULL`, forward-only migrations, transactions, and optimistic
versions. `runs.jsonl` and metadata event files are rebuildable compatibility
projections, not lifecycle authority.

Large tool and verifier output goes to an encrypted, content-addressed artifact
store under host-private application storage. Limits are 16 MiB per artifact
and 256 MiB per session; opt-in trace retention defaults to seven days or 2 GiB.
Metadata remains content-free. Without the vault, transient content is expired
when the run terminates and an interrupted run is explicitly non-resumable; no
exact history is fabricated. Vault keys are supplied by the Rust host from
macOS Keychain and are never returned to the UI.

Loopback wiki MCP servers are supervisor-owned, size/concurrency bounded, and
require a random bearer token. Tokens are returned only to the session that
starts the server and are omitted from status output.

## Shutdown

Shutdown order is load-bearing:

1. stop RPC and run admission;
2. abort supervisor trees and active frontier turns;
3. close compatibility workers and runtime sessions, including child stdin;
4. wait within bounds, then force supervisor cleanup and process-group kill;
5. close frontier/MCP sessions, then wiki servers;
6. drain admitted RPC handlers; and
7. drain the bounded terminal-response queue before process exit.

The Rust bridge first closes sidecar stdin, then waits within its own deadline
and kills and reaps the child if it does not exit. Normal app shutdown does not
rely on destructors.

## Invariants

- Engine stdout is complete JSON-RPC lines only; diagnostics use stderr.
- Prompts, task text, diffs, model output, command output, RPC payloads, paths,
  and secrets are excluded from metadata journals and logs.
- The selected checkout changes only through explicit candidate-bound Apply.
- OpenFusion never commits, merges, or pushes user code.
- Generated Project Cards remain untrusted until approved.

See [Universal runtime](runtime.md) for session, approval, recovery,
extension, child, and evidence-routing details.
