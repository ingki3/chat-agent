import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);

// Runs against the production build (pnpm build first). One port for UI + API, as in production.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node apps/server/dist/index.js",
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { NODE_ENV: "production", PORT: String(PORT), DATA_DIR: "./data-e2e" },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
