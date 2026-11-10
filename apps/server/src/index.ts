import "./env.js";
import { buildApp } from "./app.js";
import { initStorage } from "./bootstrap.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const storage = initStorage(config);
const app = await buildApp(config, { vite: config.env === "development", db: storage.db });
app.addHook("onClose", async () => storage.db.$client.close());

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
