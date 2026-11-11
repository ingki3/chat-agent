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

/**
 * Marks the data folder as served by this process (`server.pid`, mode 600) so `pnpm restore` refuses to replace it
 * underneath (#37). A file left by a crashed server names a dead pid and is simply overwritten. Returns the release.
 */
export function claimDataDir(paths: StoragePaths): () => void {
  fs.writeFileSync(paths.serverPid, `${process.pid}\n`, { mode: 0o600 });
  return () => {
    try {
      if (fs.readFileSync(paths.serverPid, "utf8").trim() === String(process.pid)) fs.rmSync(paths.serverPid);
    } catch {
      // already gone
    }
  };
}
