import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The API server's default port (see DEFAULTS.port in ../src/config.ts). */
const API_PORT = Number(process.env.CLAUDE_AGENT_UI_PORT ?? 3000);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.join(here, "src") },
  },
  server: {
    // Loopback only, always. This dev server must never be reachable from the network.
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        // /api/events is an open stream; buffering it would defeat the point.
        ws: false,
        // The server's loopbackGuard requires a state-changing request's Origin to match its
        // Host, which is exactly the DNS-rebinding defence we want in production — and exactly
        // what a dev proxy breaks, because `changeOrigin` rewrites Host to the API port while
        // Origin still says 5174. Without this every POST/PUT/DELETE from `vite dev` is a 403.
        // Nothing here loosens the server: the guard still compares the two headers.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (proxyReq.getHeader("origin")) proxyReq.setHeader("origin", `http://127.0.0.1:${API_PORT}`);
          });
        },
      },
    },
  },
  build: {
    // The server serves this directory: see AppOptions.webRoot in ../src/server.ts.
    outDir: path.join(here, "..", "dist", "web"),
    // Required, not cosmetic: `npm run build:server` runs tsup with clean:true first, which
    // leaves a half-emptied dist/web behind. This is what finishes the job.
    emptyOutDir: true,
    // Off because dist/ is the published tarball, and a sourcemap carries the whole TSX source
    // into it — 2.4MB of it. `vite dev` is unaffected; it never reads this.
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [path.join(here, "src", "test", "setup.ts")],
    css: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
