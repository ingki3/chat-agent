import fs from "node:fs";
import { createMasterKey, loadMasterKey } from "./crypto/secrets.js";
import { openDb, runMigrations, type Db } from "./db/client.js";
import { SettingsStore } from "./db/settings-store.js";
import { ensureLayout, type StoragePaths } from "./storage/paths.js";
import type { Config } from "./config.js";

export type Storage = { paths: StoragePaths; db: Db; masterKey: Buffer; settings: SettingsStore };

/**
 * Prepares the data directory, master key and database. In development a missing master key is created
 * automatically; in production it must already exist (run `pnpm keygen` once during installation).
 */
export function initStorage(config: Config): Storage {
  const paths = ensureLayout(config.dataDir);
  let masterKey: Buffer;
  if (fs.existsSync(config.masterKeyPath)) masterKey = loadMasterKey(config.masterKeyPath);
  else if (config.env !== "production" && !fs.existsSync(paths.db))
    masterKey = createMasterKey(config.masterKeyPath);
  else if (config.env !== "production")
    throw new Error(
      `master key missing at ${config.masterKeyPath} but ${paths.db} already exists — restore the key (docs/ops.md §3); a new key could not decrypt existing credentials`,
    );
  else
    throw new Error(`master key not found at ${config.masterKeyPath} — run "pnpm keygen" (see docs/ops.md)`);
  const db = openDb(paths.db);
  runMigrations(db);
  return { paths, db, masterKey, settings: new SettingsStore(db, masterKey) };
}
