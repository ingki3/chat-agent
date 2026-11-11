import "../env.js";
import { openStorageForWrite } from "../backup/restore.js";
import { loadConfig } from "../config.js";
import { openDb, runMigrations } from "../db/client.js";
import { ensureLayout } from "../storage/paths.js";

// Like the server (#37): the data folder's lock (not while a server or a restore holds it), then recovery of an
// interrupted restore — only then the layout and the database (never a fresh one over a half-done swap).
const claim = openStorageForWrite(loadConfig().dataDir, "migrate");
let file: string;
try {
  const paths = ensureLayout(claim.dataDir);
  file = paths.db;
  const db = openDb(paths.db);
  runMigrations(db);
  db.$client.close();
} finally {
  claim.lock.release();
}
console.log(
  `migrations applied to ${file}${claim.recovered === "none" ? "" : ` (interrupted restore ${claim.recovered})`}`,
);
