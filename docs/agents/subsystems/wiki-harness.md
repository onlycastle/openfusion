---
title: Wiki and harness subsystem
summary: Commit-pinned wiki retrieval, authenticated MCP, ToolSpec projection, fingerprints, health, and immutable harness generations.
status: canonical
verified: 2026-07-12
source_paths: ["packages/engine/src/tools/spec.ts", "packages/engine/src/tools/registry.ts", "packages/engine/src/tools/projections.ts", "packages/engine/src/tools/gateway.ts", "packages/engine/src/wiki/indexer.ts", "packages/engine/src/wiki/store.ts", "packages/engine/src/wiki/query.ts", "packages/engine/src/wiki/verify.ts", "packages/engine/src/wiki/mcp.ts", "packages/engine/src/worker/methods.ts", "packages/engine/src/harness/generate.ts", "packages/engine/src/harness/registry.ts", "packages/engine/src/harness/fingerprint.ts", "packages/engine/src/harness/store.ts", "packages/engine/src/harness/health.ts"]
---

# Wiki and harness

The wiki indexes supported-language blobs from exact Git HEAD, records a source
fingerprint, and rejects publication if HEAD moves. Dirty checkout content is
not part of wiki or worker identity. A worker that matches the captured base
and wiki identity digest opens a read-only in-memory SQLite snapshot. A
missing or changed pinned index fails closed, and a later live-index rebuild
cannot mix wiki identities or change retrieval during the attempt. Wiki
retrieval plus file, edit, patch,
artifact-read, process, skill-load, and child tools project descriptions,
schemas, scopes, and transport visibility from one ToolSpec registry whose
digest is a harness fingerprint component. Approved MCP inventories register
at runtime against the same gateway. `ToolGateway` intersects dynamic invocation claims with
parent, role, tool, and runtime policy before execution.

Loopback MCP is per-engine/project, bearer authenticated, limited to 1 MiB
requests and eight concurrent requests, and closed with its owning service.
Status omits bearer tokens. Operational verification covers index integrity,
source freshness/coverage, deterministic retrieval canaries, and an official
client round trip.

Harness generation uses read-only wiki access and validated structured stages.
The fingerprint includes registered harness components, protected reviewer
content, tool inventory, runtime/model identity, and policy versions.

`writeHarness` builds, reloads, and fingerprints a complete temporary
generation, renames it to `.openfusion/generations/<id>`, and atomically
publishes `.openfusion/current.json`. Failures preserve the last pointer.
Snapshot readers pin one pointer read for bundle, generation ID, and
fingerprint. Legacy flat harnesses remain readable. Active-generation mutation produces a
fingerprint failure; card edits and approvals create new generations.

Health combines bundle/fingerprint validity, HEAD freshness, wiki verification,
and metadata-only production evidence. It is operational evidence, not a
semantic task oracle.
