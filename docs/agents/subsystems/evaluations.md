---
title: System benchmarks subsystem
summary: Historical snapshots, paired wiki parity, protected sandboxed oracles, durable repeated trials, intervals, and promotion gates.
status: canonical
verified: 2026-07-12
source_paths: ["packages/engine/src/evals/tasks.ts", "packages/engine/src/evals/run.ts", "packages/engine/src/evals/experiment.ts", "packages/engine/src/evals/verdict.ts", "packages/engine/src/evals/methods.ts", "packages/engine/src/runtime/evidence.ts", "packages/engine/src/runtime/sandbox.ts"]
---

# System benchmarks

Golden tasks reconstruct a pre-fix source state without retaining a route to
the source repository history. Per task, baseline and harness directories are
initialized independently and their Git tree IDs must match. One wiki is built
from that committed source and the same authenticated MCP URL/token is passed
to both arm sessions. Arm order can be deterministically randomized.

Public candidate-verification commands are explicitly separated from protected
evaluator material. Optional evaluator-only tests and fixtures are materialized
only after author and independent reviewer sessions close. The oracle then runs
with a protected identity under the native eval sandbox, has network disabled,
and stores bounded output as transient encrypted artifacts. Sandbox/policy
failures are safety or measurement outcomes, not task-quality evidence.

`engine.evals.run` retains the directional one-trial report and conservative
pass/fail/inconclusive verdict. `engine.evals.experiment` stores durable trial
rows in authoritative `runtime.db`, keyed by experiment/match/variant/repeat.
It resumes without duplicating completed trials and reports pass@k, pass^k,
task-clustered deterministic bootstrap 95%
intervals, p50/p95 latency, complete cost intervals, retries, escalation,
intervention, tool errors, measurement failures, and safety violations.

The offline evidence compiler proposes a one-component routing-v3 table from
safe metadata only. Promotion requires at least 20 clean matched tasks, no
unpriced calls or safety failure, a quality-delta lower bound above -5pp, a
positive paired-savings lower bound, deterministic shadow replay, and explicit
human approval against the current harness digest. Reports never mutate a
harness manifest; stale or sparse evidence falls back to configured routing.
