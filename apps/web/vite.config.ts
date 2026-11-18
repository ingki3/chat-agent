import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { firstLoadProblems, type ChunkInfo } from "./build/entry-check.js";

/** Fails the build when mermaid (#182) ends up in the first load (see build/entry-check.ts). */
function firstLoadCheck(): Plugin {
  return {
    name: "agentlee-first-load-check",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks: ChunkInfo[] = [];
      for (const c of Object.values(bundle))
        if (c.type === "chunk")
          chunks.push({
            fileName: c.fileName,
            isEntry: c.isEntry,
            imports: c.imports,
            moduleIds: c.moduleIds,
          });
      const problems = firstLoadProblems(chunks);
      if (problems.length)
        this.error(
          `mermaid must be loaded lazily, not in the first load:\n${problems.slice(0, 10).join("\n")}`,
        );
    },
  };
}

// The dev server is not used directly: apps/server mounts Vite in middleware mode so UI + API share port 3000.
export default defineConfig({
  plugins: [react(), firstLoadCheck()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Fonts always as files: the CSP (default-src 'self', no font-src) refuses data: fonts — small KaTeX fonts
    // inlined as data: URLs were blocked (seen with #182's CSP check in e2e).
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
  },
});
