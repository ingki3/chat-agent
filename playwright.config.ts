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
    // Creates the admin through the first-run screen and the family accounts; everything else depends on it.
    { name: "setup", testMatch: /first-run\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, dependencies: ["setup"] },
    { name: "mobile", use: { ...devices["Pixel 7"] }, dependencies: ["setup"] },
  ],
  webServer: {
    // Production mode requires a master key: create a throwaway one for the e2e run.
    // Fresh data every run: the first-run (admin setup) screen only exists while there are no users.
    command: "rm -rf .e2e && node apps/server/dist/cli/keygen.js && node apps/server/dist/index.js",
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: {
      NODE_ENV: "production",
      PORT: String(PORT),
      DATA_DIR: "./.e2e/data",
      MASTER_KEY_PATH: "./.e2e/master.key",
      // Scripted runtime so streaming can be tested end to end.
      FAKE_RUNTIME: "1",
    },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
