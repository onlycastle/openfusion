# Coding Harness Source Audit: Codex, Claude Code, and OpenCode

**Date:** 2026-07-10  
**Purpose:** identify implementation patterns worth bringing into OpenFusion's
worker harness, based on code rather than product descriptions.

## Source baseline

| Harness | Revision inspected | Notes |
|---|---|---|
| Codex | `dedd1c386a9bb2b4031d26b0494217a20868fb7a` (2026-03-31) | Local source at `~/projects/harness-eng/codex` |
| Claude Code | `0cf2fa2edbc58820f1b4e3af80d2b53a3ec4eaeb` (2026-03-31) | Local source at `~/projects/harness-eng/claude-code` |
| OpenCode | `772e976d801d96f7319af2ee5efc8d5879cb35fc` (2026-07-10) | Current `anomalyco/opencode`; the local `harness-eng/opencode` checkout is the archived Go implementation and was not treated as current |

Important upstream references:

- [Codex middle-output truncation](https://github.com/openai/codex/blob/dedd1c386a9bb2b4031d26b0494217a20868fb7a/codex-rs/utils/output-truncation/src/lib.rs)
- [Codex compaction](https://github.com/openai/codex/blob/dedd1c386a9bb2b4031d26b0494217a20868fb7a/codex-rs/core/src/compact.rs)
- [OpenCode tool-output persistence](https://github.com/anomalyco/opencode/blob/772e976d801d96f7319af2ee5efc8d5879cb35fc/packages/opencode/src/tool/truncate.ts)
- [OpenCode compaction](https://github.com/anomalyco/opencode/blob/772e976d801d96f7319af2ee5efc8d5879cb35fc/packages/opencode/src/session/compaction.ts)
- [OpenCode permissions](https://opencode.ai/docs/permissions/)

## What the code agrees on

### 1. Tool results are a model-facing protocol

All three harnesses shape tool results deliberately. They do not pass arbitrary
process output into context unchanged.

- Codex truncates the middle, retaining both the command's setup and its final
  diagnostics, and reports original line counts.
- Claude Code persists oversized tool results under the session, replaces the
  result with a stable preview/reference, and records the exact replacement so
  resume does not perturb the prompt-cache prefix.
- OpenCode applies output bounds at the common tool wrapper, persists the full
  result for seven days, and tells the model to inspect it with targeted read or
  grep operations.

**OpenFusion implication:** truncation must be recoverable or at least retain
both ends. Silent prefix-only truncation is particularly harmful for test and
compiler output because the failure summary is normally at the end.

### 2. Recovery guidance belongs next to the failure

Tool descriptions explain the happy path, but concrete errors need concrete
next actions. OpenFusion already had `DialectPack.retryHintFor`; it was only
exposed as runtime metadata and never included in the tool result the model
sees. That made the dialect behavior nominal rather than operational.

**OpenFusion implication:** classified failures should return a short recovery
field from the active dialect pack. The raw error remains separate for
telemetry and deterministic tests.

### 3. Large files require targeted retrieval

Claude Code and current OpenCode both expose line `offset` and `limit` on file
reads, with range metadata. A fixed whole-file read cap without pagination
makes omitted content unreachable through the typed file tool.

**OpenFusion implication:** `read_file` needs 1-indexed line pagination,
`totalLines`, a truncation flag, and the next offset. This also reduces context
use when the caller already knows the relevant region.

### 4. Compaction is derived state, not the record

Codex retains a rollout/session record and creates compaction items over it.
OpenCode selects a protected recent tail, summarizes older turns, and prunes
large old tool results. Claude Code persists replacement decisions and session
artifacts separately from the compacted prompt.

**OpenFusion implication:** do not add mid-run summarization directly to the
current single `generateText` call. First introduce an append-only worker trace
that can replay a run, then make compaction a projection over that trace.

### 5. Permission policy is separate from tool implementation

Codex and Claude Code have explicit approval and sandbox policy layers.
OpenCode resolves `allow | ask | deny` rules by tool and argument pattern, with
per-agent overrides. OpenFusion's file tools enforce canonical path containment,
but its bash tool is only cwd-pinned and explicitly permits escape from the
worktree.

**OpenFusion implication:** the next safety milestone is a policy decision
layer before execution, followed by an OS sandbox. Adding more prompt warnings
does not close the current bash boundary.

## Implemented in this pass

The following narrow ports are now part of the OpenFusion worker runtime:

1. **Middle truncation for bash stdout/stderr.** The model retains the first and
   last portions plus an omission marker and original line count.
2. **Paged `read_file`.** Optional `offset`/`limit` inputs return range metadata,
   truncation state, and `nextOffset`.
3. **Dialect recovery in actual tool results.** `edit`, `apply_patch`, and
   `write_file` failures now include the active pack's `recovery` hint when one
   exists; the same classified event still feeds telemetry.

These changes are intentionally below the orchestration layer: every worker
route and dialect pack benefits without changing routing or review behavior.

## Next implementation order

| Priority | Port | Reason and acceptance gate |
|---|---|---|
| P0 | Durable full-output artifacts plus a contained `read_tool_output` tool | Avoids irreversible truncation. Store outside the git diff, retain by policy, expose offset/limit, and test cleanup and containment. |
| P0 | Worker event trace and replay | Record model steps, typed tool calls/results, usage, aborts, and artifacts append-only. A killed run must be inspectable without parsing logs. |
| P0 | Bash policy boundary | Add tool/argument `allow | ask | deny` decisions, then execute bash in a real sandbox. Test absolute paths, `cd ..`, env leakage, network, timeout, and child cleanup. |
| P1 | Trace-derived compaction | Preserve a recent turn/token tail, summarize older state, prune old tool payloads, and keep provenance to source events. Gate on long-run evals and replay equivalence. |
| P1 | Stable prompt-prefix accounting | Version instruction/tool-schema bundles and persist replacement decisions. Report cache-read tokens and prefix changes per run. |
| P1 | Read deduplication and freshness | Track path plus mtime/hash; return an unchanged marker for redundant reads while invalidating after edits or shell mutations. |
| P2 | Resumable worker sessions | Resume from trace and worktree after interruption. Requires idempotent action semantics and the event trace first. |
| P2 | Per-agent permission overrides | Useful once OpenFusion runs heterogeneous specialists. Do not build before the common policy evaluator exists. |

## Explicit deferrals

- **No default multi-agent mesh.** It increases coordination cost before the
  worker protocol is durable and replayable.
- **No compaction by step count alone.** Context pressure is token- and
  payload-dependent; `compactionThresholdSteps` remains insufficient.
- **No full prompt or toolset cloning.** Codex-, Claude-, and OpenCode-shaped
  profiles should only expand when dialect-level evals demonstrate a gain.
- **No silent memory writes from successful runs.** Candidate lessons need
  provenance and regression evaluation before entering durable project policy.

## Verification added

- Bash truncation retains both a beginning marker and an end-of-output failure
  marker.
- Paged reads return exact content and continuation metadata.
- Strict string-edit and whole-file write failures return the pack's recovery
  instruction to the model.
- Existing tool-event telemetry remains argument/content-safe.
