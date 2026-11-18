import { defineConfig } from "vite";

/**
 * The diagram frame's bundle (#182): one classic script (no chunks — the frame has no network, it runs this code
 * from a blob), built before the app, which emits it as a hashed asset with its address as a constant (vite.config.ts `frameBundle`).
 */
export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist-frame",
    emptyOutDir: true,
    copyPublicDir: false,
    minify: true,
    lib: {
      entry: "src/mermaid-frame/main.ts",
      formats: ["iife"],
      name: "AgentLeeMermaidFrame",
      fileName: () => "mermaid-frame.js",
    },
  },
});
