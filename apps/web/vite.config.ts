import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server is not used directly: apps/server mounts Vite in middleware mode so UI + API share port 3000.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
