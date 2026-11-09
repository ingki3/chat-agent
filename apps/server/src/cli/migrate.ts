import "../env.js";
import { loadConfig } from "../config.js";
import { openDb, runMigrations } from "../db/client.js";
import { ensureLayout } from "../storage/paths.js";

const paths = ensureLayout(loadConfig().dataDir);
const db = openDb(paths.db);
runMigrations(db);
db.$client.close();
console.log(`migrations applied to ${paths.db}`);
