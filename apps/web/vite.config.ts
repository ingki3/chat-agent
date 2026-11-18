import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/** The diagram frame's bundle (#182), built first by vite.frame.config.ts. */
const FRAME_BUNDLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "dist-frame/mermaid-frame.js",
);

/**
 * The frame bundle as a hashed asset of the app, its address a build-time constant (`__MERMAID_FRAME_URL__`): no
 * extra module to load before the bundle itself, so the only request when a frame starts is the one fetch the
 * frame host can abort (review #189 3차). The dev server points at the built file (`/@fs/…`).
 */
function frameBundle(): Plugin {
  let fileName = "";
  return {
    name: "agentlee-mermaid-frame-bundle",
    config(_config, env) {
      if (env.command !== "build")
        return { define: { __MERMAID_FRAME_URL__: JSON.stringify(`/@fs${FRAME_BUNDLE}`) } };
      if (!fs.existsSync(FRAME_BUNDLE))
        throw new Error(
          "dist-frame/mermaid-frame.js is missing: run `vite build -c vite.frame.config.ts` first",
        );
      const hash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(FRAME_BUNDLE))
        .digest("hex")
        .slice(0, 12);
      fileName = `assets/mermaid-frame-${hash}.js`;
      return { define: { __MERMAID_FRAME_URL__: JSON.stringify(`/${fileName}`) } };
    },
    generateBundle() {
      if (fileName) this.emitFile({ type: "asset", fileName, source: fs.readFileSync(FRAME_BUNDLE) });
    },
  };
}

// The dev server is not used directly: apps/server mounts Vite in middleware mode so UI + API share port 3000.
export default defineConfig({
  plugins: [react(), firstLoadCheck(), frameBundle()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Fonts always as files: the CSP (default-src 'self', no font-src) refuses data: fonts — small KaTeX fonts
    // inlined as data: URLs were blocked (seen with #182's CSP check in e2e).
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
  },
});
