# Getting started

OpenFusion is an alpha macOS application. It uses a local engine to understand
a Git repository, generate a project-specific coding harness, route work to
configured worker models, and ask a lead model to review the result.

## Prerequisites

- macOS for the desktop application.
- Node.js 22 or newer.
- Corepack and pnpm.
- A Rust toolchain for the Tauri shell.
- Claude Code and/or OpenAI Codex installed and connected for the lead-model
  roles assigned to them.
- An API key for at least one worker model if you want inexpensive
  routed implementation work.

## Install and launch

```sh
corepack enable
pnpm install
./dev.sh check
./dev.sh sidecar
./dev.sh app
```

`./dev.sh app` builds and stages the sidecar automatically when no staged
binary exists. Rebuild it after engine changes.

## First project

1. Open Settings with `Command-,`.
2. Connect Claude Code and/or OpenAI Codex under Connections.
3. Under Lead models, select the runtime and model for planning, review,
   escalation, and the evaluation baseline. The lists come from the signed-in
   accounts.
4. Under Worker models, add and verify an implementation model. Saving its key to macOS Keychain is
   optional; otherwise it lasts for the current session.
5. Open a local Git repository from the project switcher.
6. In Studio, build the harness. The symbol wiki is built automatically if it
   is absent or stale.
7. In Harness, review and approve the Project Card and adjust specialist model
   routing if necessary.
8. Return to Studio, describe a task, review the resulting diff, and explicitly
   apply it if it is correct.

OpenFusion applies a reviewed diff to the working tree only. It does not commit,
merge, push, or open a pull request.

## Continue reading

- [How OpenFusion works](workflows.md)
- [Development workflow](development.md)
- [Signed application builds](../../apps/desktop/BUILDING.md)
