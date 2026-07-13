---
title: Verification matrix
summary: Focused TypeScript loops, native sandbox tests, desktop Rust tests, full checks, staged sidecars, and opt-in live smokes.
status: canonical
verified: 2026-07-12
source_paths: ["dev.sh", "package.json", "packages/engine/package.json", "native/sandbox-runner/Cargo.toml", "apps/desktop/package.json", "apps/desktop/scripts/stage-sandbox-runner.mjs", "apps/desktop/scripts/stage-sidecar.mjs", ".github/workflows/ci.yml"]
---

# Testing

Focused loops:

```sh
pnpm --filter @openfusion/shared test
pnpm --filter @openfusion/engine typecheck
pnpm --filter @openfusion/engine exec vitest run test/<file>.test.ts
pnpm --filter @openfusion/desktop typecheck
pnpm --filter @openfusion/desktop test
cargo test --manifest-path native/sandbox-runner/Cargo.toml
pnpm docs:check
```

The native sandbox integration tests need macOS process and Seatbelt access;
run them outside an enclosing development sandbox when necessary. Desktop Rust
tests require both external binaries to be staged:

```sh
pnpm --filter @openfusion/desktop stage-sandbox-runner
pnpm --filter @openfusion/desktop stage-sidecar
pnpm --filter @openfusion/desktop test:rust
```

The full deterministic gate is `./dev.sh check`: workspace build/typecheck,
documentation checks, TypeScript tests, native sandbox tests, and desktop Rust
host tests. `./dev.sh sidecar` builds/stages both binaries and pings the engine.

Credentialed Claude, Codex, and API smokes remain opt-in and run only after
deterministic suites pass. Missing credentials are a skip condition, never a
reason to weaken deterministic tests.
