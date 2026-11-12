import "./env.js";
import { buildApp } from "./app.js";
import { openServerStorage } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { logEvent } from "./logging.js";

const config = loadConfig();
// Refuses to start when another server, a restore or a migration holds the data folder (#37).
const { storage, recovered, release: releaseDataDir, held } = openServerStorage(config);
process.on("exit", releaseDataDir);
const app = await buildApp(config, {
  vite: config.env === "development",
  db: storage.db,
  masterKey: storage.masterKey,
  // The schedule engine (#33) runs only while this process holds the data folder.
  dataLock: { held },
});
if (recovered !== "none") logEvent(app.log, "warn", "restore.recovered", { restoreCode: recovered });
app.addHook("onClose", async () => {
  storage.db.$client.close();
  releaseDataDir();
});

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
