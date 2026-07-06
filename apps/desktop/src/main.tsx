import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

/* The macOS shell (vibrancy translucency, traffic-light clearance) is opt-in
 * via a root attribute: only the real Tauri webview on macOS gets it. A plain
 * browser tab (`pnpm dev`) and jsdom keep the opaque fallback — there is no
 * NSVisualEffectView behind them, so "transparent" would just mean broken. */
if ("__TAURI_INTERNALS__" in window && /Mac/.test(navigator.userAgent)) {
  document.documentElement.dataset.shell = "mac";
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
