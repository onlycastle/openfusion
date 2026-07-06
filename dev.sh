#!/usr/bin/env bash
#
# dev.sh — one entry point for testing & running OpenFusion locally.
#
#   ./dev.sh <command>
#
# Tiers (see README for detail):
#   Tier 1  test / check      headless suites, no keys           (works now)
#   Tier 2  sidecar / app     build the engine binary + run UI   (toolchain only)
#   Tier 3  smoke:*           real end-to-end runs               (needs an API key)
#   Tier 4  (signing)         see apps/desktop/BUILDING.md        (needs Apple creds)
#
# Smoke commands set their env-gate for you and FAIL LOUDLY on a missing key,
# instead of vitest silently skipping the test. Provide a key via OF_API_KEY
# (or the provider-specific one below); model defaults to a non-retiring id.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

# ---- config knobs (override via env) ----------------------------------------
OF_MODEL="${OF_MODEL:-deepseek-v4-flash}"   # NOT deepseek-chat (retires 2026-07-24)
OF_KIND="${OF_KIND:-deepseek}"              # deepseek | moonshot | zai | openai-compatible
OF_API_KEY="${OF_API_KEY:-${DEEPSEEK_API_KEY:-}}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

need_key() {
  [ -n "$OF_API_KEY" ] || die "this smoke needs an open-model API key.
  Set one:  OF_API_KEY=sk-... ./dev.sh $1
  (or export DEEPSEEK_API_KEY). Model defaults to $OF_MODEL, kind $OF_KIND —
  override with OF_MODEL / OF_KIND."
}

cmd="${1:-help}"; shift || true
case "$cmd" in

# ---- Tier 1 : headless -------------------------------------------------------
  test)
    bold "TypeScript suites (engine + shared + desktop)…"
    pnpm test
    bold "Rust host suite (needs the test-mocks feature — plain 'cargo test' fails)…"
    pnpm --filter @openfusion/desktop test:rust
    bold "✓ all headless suites passed" ;;

  check)   # CI-equivalent: build + typecheck + full test
    bold "build…";     pnpm build
    bold "typecheck…"; pnpm typecheck
    "$0" test ;;

# ---- Tier 2 : build the engine binary + run the app --------------------------
  sidecar) # compile the standalone engine + stage it + prove it speaks JSON-RPC
    bold "build:sidecar (esbuild bundle → pkg, embeds Node)…"
    pnpm --filter @openfusion/engine build:sidecar
    bold "stage-sidecar → apps/desktop/src-tauri/binaries/…"
    pnpm --filter @openfusion/desktop stage-sidecar
    "$0" ping ;;

  ping)    # spawn the staged binary and send engine.ping (EOF exits it — no timeout)
    bin=$(ls apps/desktop/src-tauri/binaries/openfusion-engine-*-apple-darwin 2>/dev/null | grep -v '\.assets' | head -1) \
      || die "no staged sidecar — run: ./dev.sh sidecar"
    bold "engine.ping / engine.info via the staged binary…"
    printf '{"jsonrpc":"2.0","id":1,"method":"engine.ping","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"engine.info","params":{}}\n' \
      | "$bin" 2>/dev/null ;;

  app)     # ensure a staged sidecar exists, then launch the cockpit
    ls apps/desktop/src-tauri/binaries/openfusion-engine-*-apple-darwin >/dev/null 2>&1 \
      || { bold "no staged sidecar yet — building it first…"; "$0" sidecar; }
    bold "launching the cockpit (tauri dev)… open a project → Build wiki works with no keys"
    pnpm --filter @openfusion/desktop tauri dev ;;

# ---- Tier 3 : live smokes (need an API key) ----------------------------------
  smoke:worker)    # one open-model worker edits a real git worktree
    need_key "$cmd"
    bold "worker smoke: $OF_KIND / $OF_MODEL edits a worktree…"
    OPENFUSION_WORKER_SMOKE=1 \
    OPENFUSION_WORKER_SMOKE_API_KEY="$OF_API_KEY" \
    OPENFUSION_WORKER_SMOKE_KIND="$OF_KIND" \
    OPENFUSION_WORKER_SMOKE_MODEL="$OF_MODEL" \
      pnpm --filter @openfusion/engine test -- worker-run-smoke ;;

  smoke:orchestrate)  # full loop: route → worker → frontier review → escalate (needs the claude CLI too)
    need_key "$cmd"
    bold "orchestrate smoke: the whole loop (also needs 'claude' CLI logged in)…"
    OPENFUSION_ORCHESTRATE_SMOKE=1 \
    OPENFUSION_ORCHESTRATE_SMOKE_API_KEY="$OF_API_KEY" \
    OPENFUSION_ORCHESTRATE_SMOKE_KIND="$OF_KIND" \
    OPENFUSION_ORCHESTRATE_SMOKE_MODEL="$OF_MODEL" \
      pnpm --filter @openfusion/engine test -- orchestrate-smoke ;;

  smoke:evals)     # THE FIRST REAL SAVINGS NUMBER — needs a commit + its test command
    need_key "$cmd"
    [ -n "${OF_COMMIT:-}" ]       || die "set OF_COMMIT to a real fail-to-pass fix commit sha"
    [ -n "${OF_TEST_COMMAND:-}" ] || die "set OF_TEST_COMMAND to the repo test command, e.g. pnpm test"
    bold "evals smoke: baseline-vs-harness on $OF_COMMIT → the savings report card…"
    [ -n "${OF_REPO:-}" ] && export OPENFUSION_EVALS_SMOKE_REPO="$OF_REPO"
    OPENFUSION_EVALS_SMOKE=1 \
    OPENFUSION_EVALS_SMOKE_API_KEY="$OF_API_KEY" \
    OPENFUSION_EVALS_SMOKE_KIND="$OF_KIND" \
    OPENFUSION_EVALS_SMOKE_MODEL="$OF_MODEL" \
    OPENFUSION_EVALS_SMOKE_COMMIT="$OF_COMMIT" \
    OPENFUSION_EVALS_SMOKE_TEST_COMMAND="$OF_TEST_COMMAND" \
      pnpm --filter @openfusion/engine test -- evals-run-smoke ;;

  smoke:frontier)  # frontier adapter + harness generation (needs the claude CLI, no open-model key)
    bold "frontier smokes: claude adapter + harness generation (needs 'claude' CLI logged in)…"
    OPENFUSION_CLAUDE_SMOKE=1 pnpm --filter @openfusion/engine test -- frontier-claude-smoke harness-generate-smoke ;;

# ---- help --------------------------------------------------------------------
  help|-h|--help|*)
    cat <<'EOF'
OpenFusion dev.sh — testing & local run

  Tier 1 (no setup):
    ./dev.sh test        headless suites: TS (712) + Rust (59)
    ./dev.sh check       build + typecheck + test  (CI-equivalent)

  Tier 2 (toolchain only, no keys):
    ./dev.sh sidecar     compile the engine binary, stage it, ping it
    ./dev.sh ping        just re-ping the staged binary
    ./dev.sh app         launch the cockpit (tauri dev)

  Tier 3 (need an open-model API key — OF_API_KEY=sk-... or DEEPSEEK_API_KEY):
    ./dev.sh smoke:worker        a cheap model edits a real worktree
    ./dev.sh smoke:orchestrate   the full loop (also needs the 'claude' CLI)
    ./dev.sh smoke:evals         THE savings report card
                                 (also: OF_COMMIT=<sha> OF_TEST_COMMAND="pnpm test")
    ./dev.sh smoke:frontier      claude adapter + harness gen (needs 'claude' CLI)

  Knobs: OF_MODEL (default deepseek-v4-flash), OF_KIND (deepseek),
         OF_API_KEY, OF_COMMIT, OF_TEST_COMMAND, OF_REPO

  Tier 4 (signed DMG): see apps/desktop/BUILDING.md
EOF
    ;;
esac
