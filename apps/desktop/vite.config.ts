// `defineConfig` from "vitest/config" (not plain "vite") re-exports Vite's
// own config types merged with the `test` block's — this file is Vite's
// config AND vitest's (vitest reads `test` straight off it, no separate
// vitest.config.ts needed). Neither this file nor its `test` block is
// covered by `tsc` (the build script's typecheck only walks `src`, per
// tsconfig.json's `include`), so it's exercised at runtime only.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    // Component tests render into a DOM (App shell, screens); jsdom gives
    // them one without a real browser/webview.
    environment: "jsdom",
    // `scripts/**` are plain Node ESM build/CI scripts (no DOM involved) --
    // `environmentMatchGlobs` overrides them to the real `node` environment
    // rather than jsdom.
    environmentMatchGlobs: [["scripts/**", "node"]],
    // No `vitest/globals` — every test file imports `describe`/`it`/`expect`
    // explicitly, so tsconfig.json needs no ambient-globals type addition.
    globals: false,
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
  },
}));
