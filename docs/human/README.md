# Human documentation

These pages explain OpenFusion as it works today. They are intentionally
shorter and more stable than the dated research and implementation records.

## Read by goal

- [Product vision and requirements](product-vision.md): the evergreen PRD,
  evidence-backed thesis, target users, and provider-neutral runtime it is
  building toward.
- [Getting started](getting-started.md): install, configure, and launch.
- [How OpenFusion works](workflows.md): repository setup, harness generation,
  task execution, review, apply, harness health, and system benchmarks.
- [Architecture](architecture.md): desktop shell, Rust bridge, engine sidecar,
  providers, storage, and trust boundaries.
- [Universal runtime](runtime.md): durable sessions, encrypted content,
  approvals, recovery, containment, extensions, children, and routing evidence.
- [Development](development.md): local feedback loops, tests, live smokes, and
  CI.
- [Documentation maintenance](documentation.md): how the human and agent
  documentation layers stay synchronized.

## Deep historical material

Use [`../research/`](../research/) for evidence and verification notes, and
[`../superpowers/`](../superpowers/) for dated specs and plans. Those files
are valuable context, but current code and the evergreen guides above win if
they disagree.
