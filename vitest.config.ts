import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["apps/server/test/setup/renders.ts"],
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
  },
});
