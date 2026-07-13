# Clean Architecture Restructure — Design

**Date:** 2026-07-13
**Status:** Approved (brainstormed section-by-section with user; all four sections signed off)
**Primary driver (user-ranked):** safe growth & maintainability — enforced boundaries so parallel /loop dev sessions and new features stop stepping on each other. Secondary: engine reusability, plugin extensibility.
**Scope:** whole system (engine + shared RPC contract + desktop), executed engine-first.
**Sequencing constraint (user-chosen):** the in-flight uncommitted wave (~100 modified + 77 untracked files from the three 2026-07-10 plans) is stabilized and committed FIRST; restructuring happens only on a quiet tree.

## 1. Current-state diagnosis (verified 2026-07-13)

Health: engine typechecks clean; test baseline 900 passed / 2 failed / 5 skipped —
both failures localized to `test/evals-run.test.ts` (an escalation-outcome
assertion and a cancellation-timing poll), consistent with tests lagging the
in-flight wave, not broad breakage.

Three structural forces work against scalability:

1. **God files at every hot spot.** `runtime/store.ts` (2,086 lines),
   `worker/methods.ts` (1,612), `orchestrate/orchestrate.ts` (1,318),
   `evals/run.ts` (1,209); desktop: hand-written `engineClient.ts` (1,430),
   `OrchestrateScreen.tsx` (1,350).
2. **No enforced public boundary.** `engine.ts` is a ~250-line barrel
   re-exporting nearly every internal symbol; anything can import anything;
   tests reach deep into internals. "Module" is a folder convention, not a
   contract.
3. **God-object parameter coupling.** Use-cases take the whole engine —
   `orchestrate(engine: Engine, params)` reaches into `engine.wiki`,
   `engine.worker`, `engine.frontier`, `engine.providerGateway`,
   `engine.cancelRegistry`, … — so the type system says every use-case
   depends on all 13 subsystems. (The internal service-locator-via-dispatcher
   pattern is gone; only `rpc/stdio.ts` calls `dispatch()`. The god-object
   parameter is the coupling vector now.)

Additionally, `packages/shared/contracts.ts` (236 lines) exists but is not the
single source of truth for the wire surface — the 1,430-line hand-written
desktop client duplicates it by hand.

Positive precedent: the codebase has already validated seam extraction twice —
`verdict.ts` out of `evals/run.ts`, and `routing.ts` / `review.ts` /
`review-policy.ts` out of orchestrate. This design generalizes that proven
pattern; it does not impose a foreign one.

## 2. Chosen approach

**Modular monolith with enforced boundaries** (chosen over a full hexagonal
workspace-package split, and over targeted god-file surgery alone). Boundaries
are lint-enforced (dependency-cruiser in CI) rather than package-manager-
enforced: ~95% of the isolation at ~20% of the migration cost, and
forward-compatible — if module contracts are respected, a later package split
is mechanical.

## 3. Target architecture

Three layers inside the engine, one-way dependency rule:

```
┌─────────────────────────────────────────────────────┐
│  TRANSPORT      rpc/ (stdio, dispatcher, registry)  │  knows contracts, calls app
├─────────────────────────────────────────────────────┤
│  APPLICATION    orchestrate, evals, candidates,     │  use-cases; depend on ports,
│                 runtime/supervisor (RunKernel)      │  never on concrete siblings
├─────────────────────────────────────────────────────┤
│  MODULES        worker, harness, wiki, models,      │  each sealed behind ONE
│                 engines, runtime, runs, tools,      │  public index.ts
│                 verification                        │
└─────────────────────────────────────────────────────┘
        shared/  = the RPC contract (Zod), imported by engine AND desktop
```

Note on `runtime/`: today the folder straddles layers — `supervisor.ts`
(RunKernel) and `service.ts` are application-level orchestration, while
`store.ts` / `sandbox.ts` / `policy.ts` / `crypto.ts` are module-level
infrastructure. Phase 3 assigns the supervisor/kernel side to the application
layer and seals the rest behind the runtime module contract; until then the
boundary linter treats `runtime/` as one module.

Additionally there is a small **foundation tier** any layer may import without
a port: `util/`, `tools/` (pure ToolSpec data + registry), the `models/`
catalog/pricing tables, and `shared/` types. Foundation code must be
side-effect-free data and pure functions; anything behavioral stays behind a
module contract or port. This keeps the sibling-import ban honest instead of
forcing ceremony around pure data.

Rules — each mechanically enforced, not aspirational:

1. **One public contract per module.** Every subsystem folder gets an
   `index.ts` that is its only importable surface. `engine.ts` shrinks to the
   composition root plus the handful of types hosts genuinely need.
   Enforcement: dependency-cruiser in CI fails deep imports across module
   boundaries.
2. **Layer direction is one-way.** transport → application → modules. A module
   importing from `orchestrate/` or `rpc/` is a CI failure. Modules may not
   import sibling modules directly; cross-module needs go through ports (§4).
3. **File-size ratchet.** CI records current line counts of the known
   god-files and fails if any grows; new files are capped at ~400 lines. Takes
   effect on day one, before any surgery — converts "don't make it worse" into
   a CI verdict.
4. **Tests import what consumers import.** Tests target module public
   contracts; the boundary linter applies to `test/` too, with a small
   explicit allowlist for deliberate seam tests.

## 4. Typed ports & the composition root

Replace the god-object parameter with **parameter-level dependency injection
using segregated interfaces** (no DI framework):

```ts
// Before
orchestrate(engine: Engine, params)

// After
orchestrate(deps: OrchestrateDeps, params)
interface OrchestrateDeps {
  worker:   WorkerRunnerPort;    // run, cleanup — nothing else
  wiki:     WikiContextPort;     // digest + MCP attach
  frontier: FrontierSessionPort; // open/track/close sessions
  ledger:   RunLedgerPort;       // recordRun
  run:      RunContext;          // log, notify, cancelSignal
}
```

- **The consumer owns the port.** Each port interface is declared next to the
  use-case that needs it — never in a central `ports/` folder (which would
  recreate the everything-depends-on-everything hub).
- **The composition root is the only place that knows concrete wiring.**
  `engine.ts` constructs services and satisfies each use-case's `deps` object
  once, at startup.
- `engines/claude.ts` / `codex.ts` already implement the Adapter pattern
  against `FrontierAdapter`; this generalizes the same shape to every
  cross-module edge.
- Payoffs: compiler-visible dependency graph; use-case unit tests inject fake
  ports without booting an `Engine`; a session editing `worker/` cannot
  silently change behavior `orchestrate/` depends on without a port-type break.

## 5. Contract-first RPC

`packages/shared/contracts.ts` becomes the single registry of the entire wire
surface: for each method — name, Zod params schema, Zod result schema — plus
the server→client notification schemas. Both sides derive from it:

- **Engine:** `registerMethod` takes its types from the contract entry; a
  handler drifting from the contract fails typecheck.
- **Desktop:** the hand-written `engineClient.ts` is deleted, replaced by a
  ~100-line generic transport — `client.call("engine.worker.run", params)`
  with inferred types, plus typed notification subscription/demux.

Changing a method signature becomes a one-file contract edit that breaks both
sides' builds until they align. The contract is runtime-validated (Zod) and
compile-time-propagated (inference) from one definition.

## 6. Decomposition map

Rule for every split: **cut along use-case seams, not line counts** — each
extracted piece gets one reason to change; the module's `index.ts` contract
stays stable while internals move. Each split is an independent,
tree-stays-green unit of work.

Engine:

- `runtime/store.ts` (2,086) → repository-per-aggregate over one shared DB
  handle: sessions / artifacts / approvals / events+checkpoints, plus one
  row-codec module owning the crypto encode/decode currently interleaved with
  queries. The `RuntimeStore` facade survives as the module contract,
  delegating inward — callers don't move.
- `worker/methods.ts` (1,612) → thin RPC adapter + `WorkerService`
  (worktree/session lifecycle) + attempt runner. This is the same
  transport/domain split mandated for every `methods.ts`.
- `orchestrate/orchestrate.ts` (1,318) → explicit pipeline of stages: route →
  attach context → worker attempt loop → review gate → escalate →
  finalize/record. Each stage is a function with declared inputs/outputs and
  its own `deps` ports.
- `evals/run.ts` (1,209) → baseline-arm runner / harness-arm runner /
  measurement collection / report assembly (verdict math already extracted).

Desktop:

- `engineClient.ts` (1,430) → deleted, replaced by the §5 contract-derived
  client.
- `OrchestrateScreen.tsx` (1,350) → container/presenter with hooks as
  view-models: a `useOrchestrateRun` hook owns the run state machine; the
  screen composes presentational components (run timeline, candidate/apply
  sheets, progress rail) that take props and render. Same treatment later for
  other screens, reusing the wave's `ui/` primitives.

## 7. Testing strategy

- **Use-case unit tests** inject hand-rolled fake ports — no `Engine` boot, no
  worktree, millisecond-fast.
- **Module tests** exercise each subsystem strictly through its `index.ts`.
- **Transport tests** validate the stdio wire against the shared Zod contract,
  which doubles as an executable spec both engine and desktop are checked
  against.
- Boundary linting applies to tests (with the explicit seam-test allowlist).
- The 2 failing `evals-run` tests are fixed in Phase 0, before restructuring.

## 8. Error handling

Errors are part of each module's contract:

- Each module declares its error types in its `index.ts`.
- The module's RPC adapter is the single place domain errors map to wire error
  codes — no private error classes or ad-hoc error strings leaking across the
  boundary.
- Three severities with different destinies: **user-facing** (typed, rendered
  by desktop), **operational** (logged + run-ledger), **invariant violations**
  (crash loudly, never swallowed).
- Deliberate never-rejecting contracts (e.g. `recordRun`) stay — documented in
  the port type, not tribal memory.

## 9. Migration path

Six phases; each independently valuable; tree green between all of them; work
can pause after any phase.

| Phase | What | Tree mode |
|---|---|---|
| 0 | Stabilize: fix 2 failing tests; land the in-flight wave as feature-level commits (coordinate with sibling session) | exclusive |
| 1 | Guardrails on: dependency-cruiser layer/deep-import rules + file-size ratchet in CI (zero code moves) | parallel-safe |
| 2 | Contract-first RPC: shared contract registry; derived engine registration + generic desktop client; delete `engineClient.ts` | **exclusive** |
| 3 | Ports: `OrchestrateDeps`/`EvalsDeps`/…; `engine.ts` → pure composition root; barrel shrinks to real public API | parallel-safe |
| 4 | God-file surgery: `store.ts`, `worker/methods.ts`, `orchestrate.ts`, `evals/run.ts` — one at a time | **exclusive** |
| 5 | Desktop: container/presenter screens on `ui/` primitives | parallel-safe |

Phase order is chosen by risk-reduction per unit churn: guardrails (1) protect
everything after them; the contract (2) makes every later move type-checked
across the process boundary; ports (3) make the surgery (4) mechanical because
dependencies are already explicit.

**Concurrent-session guardrails** (this repo's known hazard — the user runs
parallel /loop sessions on one checkout): phases marked exclusive move files
wholesale and run one-session-at-a-time, on a branch, as small PRs. Every
phase task begins with the sibling-session check (recent transcript mtimes,
recent tracked-file mtimes) before structural moves.

## 10. Non-goals

- No workspace-package split (Approach B) now; the module contracts keep it
  mechanical later if an external consumer appears.
- No DI container/framework — composition root + parameter injection only.
- No behavior changes: this restructure is observationally neutral at the RPC
  surface and in worker/orchestrate semantics. Any behavior fix found along
  the way lands as its own commit, never inside a move.
- No renaming of subsystems or RPC method names.

## 11. Success criteria

1. CI fails on: cross-module deep import, layer-direction violation, god-file
   growth, new file > ~400 lines.
2. `engine.ts` exports ≤ 25 symbols (composition root + genuine host API).
3. Every use-case signature declares its dependencies as ports; no
   `engine: Engine` parameters outside the composition root and RPC adapters.
4. `engineClient.ts` deleted; desktop calls the engine only through the
   contract-derived client; a contract edit breaks both sides' typecheck until
   aligned.
5. All files listed in §6 are under their ratchet baselines; after Phase 4
   completes, no engine source file exceeds ~700 lines, and new files stay
   under ~400 from Phase 1 onward.
6. Engine + desktop suites green at every phase boundary; the 2 evals-run
   failures fixed in Phase 0.
