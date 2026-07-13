---
title: Desktop subsystem
summary: React workspace state, candidate-bound Apply, runtime controls, Rust native commands, secrets, and lifecycle.
status: canonical
verified: 2026-07-12
source_paths: ["apps/desktop/src/App.tsx", "apps/desktop/src/ProjectContext.tsx", "apps/desktop/src/engineClient.ts", "apps/desktop/src/frontierPreferences.ts", "apps/desktop/src/screens/OrchestrateScreen.tsx", "apps/desktop/src/screens/HarnessHealthScreen.tsx", "apps/desktop/src/components/FrontierRolesPane.tsx", "apps/desktop/src-tauri/src/lib.rs", "apps/desktop/src-tauri/src/engine_bridge.rs", "apps/desktop/src-tauri/src/secrets.rs", "apps/desktop/src-tauri/src/projects.rs"]
---

# Desktop subsystem

The React app has one `ProjectProvider`, one global engine event subscription,
three workspace destinations (Studio, Harness, Health), and a Settings
dialog. Settings presents these subscription-backed planning, review,
escalation, and baseline selections as **Lead models**, and BYOK implementation
providers as **Worker models**. Internal RPC/storage names retain `frontier`
and `provider` for compatibility. Project selection resets the task transcript and reloads wiki/harness state with
stale-response guards.

Studio's pre-task state is an ordered readiness timeline rather than a warning
panel: it shows project, lead-model, worker-model, and harness status together.
Harness generation notifications render as a nested live activity log, and
received log entries survive a generation error.

`engineClient.ts` is the typed boundary for engine RPC and native secret/project
commands. It guarantees one Rust notification pump and maps cancellation-marked
RPC errors to `RunCancelledError`. Studio Apply first requests a short-lived
grant for `result.candidateRef`, then submits that candidate and grant; it never
sends the displayed raw diff as authority. A dirty snapshot warning explains
that committed HEAD was used and dirty edits were excluded.

Runtime settings expose encrypted trace-vault retention, capability-bearing
extensions, approvals, child sessions, artifact pagination, and recovery
choices. Content details remain encrypted or absent from observer telemetry.
Harness owns evidence-routing proposal compilation, shadow replay, explicit
promotion, and rollback. Health remains deterministic and metadata-only.

Rust `EngineBridge` owns sidecar stdin/stdout/stderr, concurrent request
correlation, notifications, bounded calls, and shutdown. Native modules own
Keychain storage, recent projects, folder dialogs, and CLI authentication. The
Tauri bundle stages both the engine and `openfusion-sandbox` external binaries.

UI source must not call `console.*` or log content-bearing data.

Health calls `engine.harness.health` on selection and refresh. It displays
deterministic harness/wiki checks and metadata-only production evidence. It
does not accept golden commits, run paired model arms, or claim answer
correctness.
