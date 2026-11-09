import path from "node:path";
import dotenv from "dotenv";
import { buildApp } from "./app.js";
import { loadConfig, REPO_ROOT } from "./config.js";

// Same .env regardless of where the process was started (pnpm runs scripts from apps/server).
dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });

const config = loadConfig();
const app = await buildApp(config, { vite: config.env === "development" });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
