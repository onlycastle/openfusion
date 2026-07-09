# OpenFusion

OpenFusion is an open-source macOS app and local engine for building an
AI coding harness around a repository.

It indexes your codebase, asks a frontier model to generate project-specific
working knowledge, then uses that knowledge to route coding tasks to cheaper
worker models with frontier review before anything is applied.

Put more simply:

1. Build a symbol-aware wiki for a local git repo.
2. Generate a `.openfusion/` harness: project notes, specialist agents, and a routing policy.
3. Run tasks through the harness: classify -> worker model -> frontier review -> optional retry/escalation.
4. Measure whether the harness preserves quality while reducing estimated model cost.

OpenFusion never commits or merges on your behalf. It returns diffs for review,
and `engine.orchestrate.apply` only applies a reviewed diff with `git apply --3way`.

## Status

OpenFusion is usable, but still early. Treat it as an alpha developer tool.

What works today:

| Area | Status |
|---|---|
| Repo wiki | Indexes TypeScript, JavaScript, Python, Go, Rust, and Java repositories into a per-project symbol store. |
| Wiki tools | Serves `wiki_query` and `wiki_map` over a local MCP server for model sessions. |
| Harness generation | Generates `.openfusion/` with wiki pages, agents, `routing.yaml`, and `manifest.json`. |
| Project Card | Drafts a human-reviewable project summary. It must be approved before it is trusted in worker prompts. |
| Exports | Writes `AGENTS.md` and Claude Code subagents from a valid harness. |
| Orchestration | Routes a task to a worker model in an isolated git worktree, reviews the diff with a frontier session, retries once, then escalates if needed. |
| Evals | Compares baseline frontier runs against harness runs and reports quality, estimated cost, and pass/fail/inconclusive verdicts. |
| Desktop app | Tauri 2 app with Project, Keys, Orchestrate, and Evals screens. Secrets are stored in macOS Keychain. |
| Bench CLI | Includes a SWE-bench Verified Mini workflow for paired baseline-vs-harness experiments. |

Important caveats:

- Cost numbers are estimates from token usage and pricing tables, not billed amounts.
- A generated harness is marked unverified until evals pass.
- The Project Card approval gate is intentional: the card is not trusted in worker prompts until a human approves it.
- Desktop signing and notarization require your own Apple Developer credentials.
- Live smokes require real model access, for example a logged-in frontier CLI and/or an open-model API key.

## Quick Start

Prerequisites:

- macOS for the desktop app.
- Node.js `>=22`.
- `pnpm` through Corepack.
- Rust toolchain for the Tauri desktop shell.
- Optional: a logged-in Claude Code CLI for frontier smokes and harness generation.
- Optional: an open-model API key for worker, orchestration, and eval smokes.

Install dependencies:

```sh
corepack enable
pnpm install
```

Run the headless checks:

```sh
./dev.sh check
```

Build and stage the engine sidecar:

```sh
./dev.sh sidecar
```

Launch the desktop cockpit:

```sh
./dev.sh app
```

The Project screen can build a repo wiki without model keys. Harness generation,
orchestration, and evals need the model access described above.

## Common Commands

`dev.sh` is the recommended local entry point.

| Command | What it does |
|---|---|
| `./dev.sh test` | Runs the TypeScript suites and Rust desktop host tests. |
| `./dev.sh check` | Runs build, typecheck, and all headless tests. |
| `./dev.sh sidecar` | Builds the standalone engine binary, stages it for Tauri, and pings it. |
| `./dev.sh ping` | Sends `engine.ping` and `engine.info` to the staged sidecar. |
| `./dev.sh app` | Starts the Tauri desktop app in dev mode. |
| `./dev.sh smoke:frontier` | Runs frontier adapter and harness generation smokes. Requires Claude CLI login. |
| `OF_API_KEY=... ./dev.sh smoke:worker` | Runs one real open-model worker in a git worktree. |
| `OF_API_KEY=... ./dev.sh smoke:orchestrate` | Runs the full route -> worker -> frontier-review loop. Also requires Claude CLI login. |
| `OF_API_KEY=... OF_COMMIT=<sha> OF_TEST_COMMAND="pnpm test" ./dev.sh smoke:evals` | Runs a real baseline-vs-harness eval on a golden task. |

Raw workspace commands are also available:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @openfusion/desktop test:rust
```

## How It Works

```text
local git repo
  |
  v
wiki index
  - symbols
  - references
  - token-budgeted repo map
  |
  v
harness generation
  - Project Card
  - wiki pages
  - specialist agents
  - routing policy
  |
  v
orchestration
  - classify task
  - pick agent and model
  - run worker in isolated worktree
  - review diff with frontier model
  - retry or escalate
  - return diff for human review
```

The key design choice is selective context. Workers get the approved Project
Card when one exists. Without one, they may receive a narrow build-and-test
digest fallback. Broader project knowledge stays available through on-demand
wiki lookup tools instead of being blindly injected into every prompt.

## Engine RPC Examples

The engine speaks newline-delimited JSON-RPC 2.0 over stdio. The desktop app
uses this protocol through a supervised sidecar, and other clients can use the
same methods.

Build and query a wiki:

```text
engine.wiki.build  { "projectDir": "/path/to/repo" }
engine.wiki.status { "projectDir": "/path/to/repo" }
engine.wiki.map    { "projectDir": "/path/to/repo", "budgetTokens": 2048 }
engine.wiki.query  { "projectDir": "/path/to/repo", "symbol": "createEngine" }
engine.mcp.start   { "projectDir": "/path/to/repo" }
```

Configure and inspect model providers:

```text
engine.models.configure { ...provider config... }
engine.models.list      {}
engine.models.complete  { "providerId": "deepseek", "model": "deepseek-v4-flash", "prompt": "Hello" }
engine.models.usage     {}
```

Generate and manage a harness:

```text
engine.harness.generate     { "projectDir": "/path/to/repo" }
engine.harness.status       { "projectDir": "/path/to/repo" }
engine.harness.read         { "projectDir": "/path/to/repo" }
engine.harness.card.update  { "projectDir": "/path/to/repo", "digest": "<edited card digest>" }
engine.harness.card.approve { "projectDir": "/path/to/repo" }
engine.harness.export       { "projectDir": "/path/to/repo", "format": "agents-md" }
engine.harness.export       { "projectDir": "/path/to/repo", "format": "claude-subagents" }
```

Run the harness loop:

```text
engine.orchestrate       { "projectDir": "/path/to/repo", "task": "add input validation to the signup form" }
engine.orchestrate.apply { "projectDir": "/path/to/repo", "diff": "<reviewed diff>" }
engine.cancel            { "runId": "<client-generated run id>" }
```

Clean up worker worktrees:

```text
engine.worker.list { "projectDir": "/path/to/repo" }
engine.worker.gc   { "projectDir": "/path/to/repo", "keep": ["/path/to/repo/.openfusion/worktrees/<id>"] }
```

Measure a harness:

```text
engine.evals.run {
  "projectDir": "/path/to/repo",
  "tasks": [
    { "commitSha": "<bug-fix commit>", "testCommand": ["pnpm", "test"] }
  ]
}
```

Eval verdicts are deliberately conservative:

| Verdict | Meaning |
|---|---|
| `pass` | Quality held within the accepted noise band, costs were priced, savings were positive, and the sample size was credible. |
| `fail` | The harness caused a quality hazard or a material cost hazard. It must not be reported as a savings win. |
| `inconclusive` | The run was too small, unpriced, noisy, failed to measure cleanly, or did not show savings. |

## Desktop App

The desktop app lives in `apps/desktop`. It is a Tauri 2 shell:

```text
React + Vite webview
  <-> Tauri Rust command bridge
  <-> openfusion-engine sidecar over stdio JSON-RPC
```

The app has four screens:

| Screen | Purpose |
|---|---|
| Project | Pick a local git repo and build its wiki with live progress. |
| Keys | Configure frontier and open-model providers. Secrets are stored in macOS Keychain. |
| Orchestrate | Run the route -> worker diff -> frontier review -> apply workflow. |
| Evals | Run baseline-vs-harness evals and inspect the report card. |

Desktop-specific architecture, sidecar staging, Rust tests, and operator smoke
details are documented in [`apps/desktop/README.md`](apps/desktop/README.md).
Signed DMG instructions are in [`apps/desktop/BUILDING.md`](apps/desktop/BUILDING.md).

## Benchmarking

The benchmark workflow lives under `benchmarks/` and the engine bench CLI.
It is intended to test the central product claim: the harness should preserve
quality while reducing estimated cost compared with a direct frontier baseline.

```sh
pnpm --filter @openfusion/engine build
pnpm --filter @openfusion/engine exec openfusion-bench help
```

See [`benchmarks/README.md`](benchmarks/README.md) for dataset, layout, scoring,
and caveats.

## Project Layout

| Path | Purpose |
|---|---|
| `apps/desktop/` | Tauri desktop app and Rust sidecar bridge. |
| `packages/engine/` | Core indexing, harness generation, model routing, orchestration, evals, and JSON-RPC server. |
| `packages/shared/` | Shared RPC and wiki types. |
| `benchmarks/` | SWE-bench Verified Mini data and benchmark notes. |
| `docs/research/` | Research notes and milestone verification docs. |
| `docs/superpowers/specs/` | Product and architecture specs. |
| `dev.sh` | Local development, smoke, and app-launch helper. |

## Development Notes

Run this before opening a PR:

```sh
./dev.sh check
```

Useful package-level loops:

```sh
pnpm --filter @openfusion/engine test
pnpm --filter @openfusion/desktop test
pnpm --filter @openfusion/desktop test:rust
```

When changing the engine sidecar or desktop shell, rebuild and restage the
sidecar before running Tauri:

```sh
./dev.sh sidecar
./dev.sh app
```

Live smokes are intentionally environment-gated because they spend real model
tokens or need a logged-in frontier CLI. They should fail loudly if the required
credentials are missing.

## Privacy and Safety

- The engine runs locally.
- Model calls are sent only to the providers you configure or to the official frontier CLI you run locally.
- The engine does not store frontier credentials. It uses the login state of the official CLI.
- The desktop app stores BYOK provider secrets in macOS Keychain.
- Generated Project Cards start as drafts and must be approved before becoming trusted worker context.
- OpenFusion returns diffs; it does not commit, merge, or auto-ship code.

## Further Reading

- [Harness fusion app design](docs/superpowers/specs/2026-07-03-harness-fusion-app-design.md)
- [Harness team cockpit design](docs/superpowers/specs/2026-07-06-harness-team-cockpit-design.md)
- [Project Card design](docs/superpowers/specs/2026-07-08-wiki-project-card-design.md)
- [Harness composition research](docs/research/2026-07-07-harness-composition.md)
- [Open-source landscape research](docs/research/2026-07-03-oss-landscape.md)

## License

Apache-2.0
