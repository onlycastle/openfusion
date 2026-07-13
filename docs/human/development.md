# Development

## Recommended feedback loop

```sh
corepack enable
pnpm install
./dev.sh check
```

`./dev.sh check` runs workspace builds, TypeScript typechecks, documentation
validation, TypeScript tests, native Rust sandbox tests, staging for both
sidecars, and Rust desktop-host tests.

For a tighter loop:

```sh
pnpm --filter @openfusion/engine test
pnpm --filter @openfusion/desktop test
pnpm --filter @openfusion/shared test
cargo test --manifest-path native/sandbox-runner/Cargo.toml
pnpm --filter @openfusion/desktop stage-sandbox-runner
pnpm --filter @openfusion/desktop test:rust
pnpm docs:check
```

## Run the desktop application

The Tauri build expects a staged platform-specific engine binary:

```sh
./dev.sh sidecar
./dev.sh app
```

`sidecar` builds the Rust sandbox runner, bundles the engine, stages both under
Tauri's external-binary directory, and proves that the engine responds to
`engine.ping` and `engine.info`.

For UI-only iteration with mocked native APIs:

```sh
pnpm --filter @openfusion/desktop ui:dev
```

## Live model smokes

Live smokes are opt-in because they require credentials and may spend tokens:

```sh
./dev.sh smoke:frontier
OF_API_KEY=... ./dev.sh smoke:worker
OF_API_KEY=... ./dev.sh smoke:orchestrate
OF_API_KEY=... OF_COMMIT=<sha> OF_TEST_COMMAND="pnpm test" ./dev.sh smoke:evals
```

## CI

GitHub Actions runs on pull requests and pushes to `main`. It installs from the
frozen pnpm lockfile, builds, typechecks, validates documentation, and runs the
workspace TypeScript tests on Node 22. The macOS-native containment and Tauri
host suites remain part of the local `./dev.sh check` workflow when the CI job
does not provide the required macOS backend.

### Architecture guardrails

`pnpm arch:check` runs in CI: dependency-cruiser boundary rules
(`.dependency-cruiser.cjs` — layer direction, no cross-module deep imports)
and a file-size ratchet (`scripts/check-file-budget.mjs` — grandfathered
files may shrink but never grow; new files are capped at 400 lines).
Baselines only ever shrink: `pnpm arch:budget:rebase` locks in gains after a
file split — it must never be used to raise a limit. One narrow exception:
a grandfathered `test/` file's baseline may be re-based upward when the growth
is added test coverage, always as its own clearly-labeled `chore(arch)` commit
so the raise is reviewable. Source-file baselines never go up. Rules and
rationale: `docs/superpowers/specs/2026-07-13-clean-architecture-design.md`
(§3, §11).

## Change discipline

- Prefer package-level tests while iterating, then run `./dev.sh check`.
- Rebuild the staged sidecar whenever engine behavior changes before testing
  through Tauri.
- Keep live tests environment-gated.
- Preserve the stdout JSON-RPC-only and no-content-logging invariants.
- Update both human and agent documentation when architecture or workflows
  change.
