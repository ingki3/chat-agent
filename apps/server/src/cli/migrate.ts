import "../env.js";
import { loadConfig } from "../config.js";
import { openDb, runMigrations } from "../db/client.js";
import { acquireDataLock } from "../storage/data-lock.js";
import { ensureLayout } from "../storage/paths.js";

const dataDir = loadConfig().dataDir;
// Not while a server or a restore holds the data folder (#37).
const lock = acquireDataLock(dataDir, "migrate");
const paths = ensureLayout(dataDir);
try {
  const db = openDb(paths.db);
  runMigrations(db);
  db.$client.close();
} finally {
  lock.release();
}
console.log(`migrations applied to ${paths.db}`);
