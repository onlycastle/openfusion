---
title: Engine and RPC subsystem
summary: Typed services, bounded transport/admission, runtime capabilities, journals, cancellation, and ordered shutdown.
status: canonical
verified: 2026-07-12
source_paths: ["packages/engine/src/engine.ts", "packages/engine/src/main.ts", "packages/engine/src/models/gateway.ts", "packages/engine/src/orchestrate/orchestrate.ts", "packages/engine/src/worker/methods.ts", "packages/engine/src/rpc/ndjson.ts", "packages/engine/src/rpc/stdio.ts", "packages/engine/src/rpc/writer.ts", "packages/engine/src/runtime/capabilities.ts", "packages/engine/src/runtime/supervisor.ts", "packages/engine/src/runtime/service.ts"]
---

# Engine and RPC

`Engine` owns wiki, models/frontier adapters, harness, worker, runtime,
candidate, orchestration, evaluation, and run services behind one external
JSON-RPC dispatcher. Internal orchestration invokes `WorkerRunner`, frontier,
candidate/Apply, and evaluation services directly; JSON-RPC remains the
process transport and compatibility surface.

Claude, Codex, and API adapters expose versioned capability records. A role is
rejected when it requires a capability the adapter cannot enforce; security
capabilities are not silently emulated.

Every production API completion and frontier prompt enters `ProviderGateway`.
It caps eight active calls globally, four per provider, and 64 queued calls;
queued cancellation, shutdown abort, transport retry hooks, cache telemetry,
and shared usage accounting live at this seam. Adapter-specific protocol state
does not escape it.

NDJSON input is limited to 8 MiB per line. `StdioPipeline` admits 32 concurrent
handlers. `RunKernel` admits two active/eight queued top-level runs and one
writer per project. Public `engine.worker.run` calls enter that kernel and
receive its captured base, harness, and wiki pins; typed nested workers reuse
their parent supervisor. The writer caps application buffering at 4 MiB, coalesces
or drops observer progress under pressure, and never drops terminal responses.

Each supervisor writes a serialized v2 lifecycle journal with run/span/parent
span/attempt identity and exactly one root terminal. Startup recovery marks a
dead owner's unterminated run `interrupted-nonresumable` unless encrypted
content makes an exact recovery possible.

Budget reservations occur at real execution boundaries: every worker model
turn, structured-output retry, review/escalation prompt, and model-facing tool
invocation reserves before starting. Evaluation arms share their top-level
supervisor rather than maintaining unbounded nested counters.

Shutdown order is: stop admission; abort run/frontier trees; join workers and
runtime children; force bounded cleanup; close frontier then wiki/MCP; drain
RPC handlers; drain terminal output.
