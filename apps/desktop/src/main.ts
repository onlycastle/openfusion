// M7a shell backbone: this is a placeholder view only. The window renders,
// but there is no engine bridge wired up yet — that lands in Task 3 (the
// Rust-side sidecar spawn/JSON-RPC bridge) and Task 4 (the frontend
// invoke/Channel wiring). See docs/research/2026-07-04-m7-tauri-verification.md
// for the architecture this scaffold is built toward.
const app = document.querySelector<HTMLDivElement>("#app");

if (app) {
  app.innerHTML = `
    <main style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
      <p>OpenFusion — engine bridge coming in Task 4</p>
    </main>
  `;
}
