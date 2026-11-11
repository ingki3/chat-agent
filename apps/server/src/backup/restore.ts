import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { connectionAad } from "../connections/store.js";
import { decrypt } from "../crypto/secrets.js";
import { openDb, runMigrations } from "../db/client.js";
import { isInside } from "../fs-safety.js";
import { ensureLayout, storagePaths } from "../storage/paths.js";
import {
  BACKUP_FILE_ROOTS,
  BACKUP_ID,
  DB_FILE,
  keyMatches,
  readManifest,
  sha256File,
  type Manifest,
} from "./backup.js";
import { appliedMigrations, checkSchema, codeMigrations, type AppliedMigration } from "./schema.js";

/**
 * Restore (#37). Run with the server stopped (`pnpm -s restore`, docs/ops.md §21): no scheduler, no writer and no
 * open database while the data folder is replaced. Everything is checked before anything is written; the new data
 * folder is built next to the target and swapped in with one rename; the old one is kept beside it.
 */
export const RESTORE_CODES = [
  "backup_not_found",
  "manifest_invalid",
  "backup_corrupt",
  "wrong_key",
  "secret_unreadable",
  "schema_newer",
  "schema_mismatch",
  "server_running",
  "target_unsafe",
] as const;
export type RestoreCode = (typeof RESTORE_CODES)[number];

export class RestoreError extends Error {
  constructor(readonly code: RestoreCode) {
    super(code);
    this.name = "RestoreError";
  }
}

/** A backup argument: an id in BACKUP_DIR, or a path to a backup folder. */
export function resolveBackup(arg: string, backupDir: string | undefined, cwd = process.cwd()): string {
  if (BACKUP_ID.test(arg) && backupDir) return path.join(backupDir, arg);
  return path.resolve(cwd, arg);
}

/** Manifest paths: `<root>/<safe segments>` only — a tampered manifest cannot reach outside the new folder. */
function safeRel(p: string): boolean {
  if (p.includes("\\") || p.includes("\0")) return false;
  const parts = p.split("/");
  return (
    (BACKUP_FILE_ROOTS as readonly string[]).includes(parts[0]!) &&
    parts.length > 1 &&
    parts.every((s) => s !== "" && s !== "." && s !== "..")
  );
}

function fileMatches(file: string, f: { bytes: number; sha256: string }): boolean {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size === f.bytes && sha256File(file) === f.sha256;
  } catch {
    return false;
  }
}

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export type Verified = { manifest: Manifest; pending: number };

/**
 * Checks a backup completely without writing anything: manifest, the key (`wrong_key` before anything else is
 * read), every file's SHA-256, the database's integrity, its schema version against this build, and that every
 * stored secret decrypts with the key.
 */
export function verifyBackup(
  dir: string,
  key: Buffer,
  code: AppliedMigration[] = codeMigrations(),
): Verified {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new RestoreError("backup_not_found");
  const manifest = readManifest(dir);
  if (!manifest || !manifest.files.every((f) => safeRel(f.path))) throw new RestoreError("manifest_invalid");
  if (!keyMatches(manifest, key)) throw new RestoreError("wrong_key");
  const dbFile = path.join(dir, DB_FILE);
  if (!fileMatches(dbFile, manifest.db)) throw new RestoreError("backup_corrupt");
  for (const f of manifest.files)
    if (!fileMatches(path.join(dir, f.path), f)) throw new RestoreError("backup_corrupt");

  let db: Database.Database;
  try {
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
  } catch {
    throw new RestoreError("backup_corrupt");
  }
  try {
    let applied: AppliedMigration[];
    try {
      if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new RestoreError("backup_corrupt");
      applied = appliedMigrations(db);
    } catch (e) {
      throw e instanceof RestoreError ? e : new RestoreError("backup_corrupt");
    }
    if (
      applied.length !== manifest.schema.migrations ||
      (applied.at(-1)?.createdAt ?? null) !== manifest.schema.lastMigrationAt
    )
      throw new RestoreError("backup_corrupt");
    const schema = checkSchema(applied, code);
    if (!schema.ok) throw new RestoreError(schema.code);
    // The key check passed; every stored credential must decrypt too (a backup of data whose key was changed).
    try {
      if (hasTable(db, "connections"))
        for (const c of db
          .prepare(
            "SELECT id, runtime, auth_type AS authType, secret FROM connections WHERE secret IS NOT NULL",
          )
          .all() as { id: string; runtime: string; authType: "api_key" | "subscription"; secret: string }[])
          decrypt(c.secret, key, connectionAad(c));
      if (hasTable(db, "settings"))
        for (const s of db.prepare("SELECT key, value FROM settings WHERE encrypted = 1").all() as {
          key: string;
          value: string;
        }[])
          decrypt(s.value, key, `setting:${s.key}`);
    } catch {
      throw new RestoreError("secret_unreadable");
    }
    return { manifest, pending: schema.pending };
  } finally {
    db.close();
  }
}

/** Whether the server named in `<dataDir>/server.pid` is still running. */
export function serverRunning(dataDir: string): boolean {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(storagePaths(dataDir).serverPid, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type RestoreOptions = {
  /** The backup folder. */
  backup: string;
  /** The data folder to restore into (DATA_DIR, or a fresh folder for a rehearsal). */
  target: string;
  key: Buffer;
  /** BACKUP_DIR and MASTER_KEY_PATH: the target may not overlap either. */
  backupDir?: string | undefined;
  masterKeyPath?: string | undefined;
  now?: () => number;
  /** Tests: the code's migrations. */
  code?: AppliedMigration[];
};

export type RestoreResult = {
  manifest: Manifest;
  /** Migrations applied on top of the backup's schema. */
  pending: number;
  /** Where the replaced data folder was moved (undefined when the target was missing or empty). */
  previous: string | undefined;
};

export function restoreBackup(o: RestoreOptions): RestoreResult {
  const target = path.resolve(o.target);
  const backup = path.resolve(o.backup);
  if (
    isInside(target, backup) ||
    isInside(backup, target) ||
    (o.backupDir && (isInside(target, o.backupDir) || isInside(o.backupDir, target))) ||
    (o.masterKeyPath && isInside(o.masterKeyPath, target)) ||
    path.dirname(target) === target
  )
    throw new RestoreError("target_unsafe");
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory()))
    throw new RestoreError("target_unsafe");
  // The scheduler and every writer live in the server process: it must be stopped.
  if (existing && serverRunning(target)) throw new RestoreError("server_running");

  const verified = verifyBackup(backup, o.key, o.code);
  const { manifest } = verified;

  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(
    parent,
    `.${path.basename(target)}.restore-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    const copy = (rel: string, f: { bytes: number; sha256: string }) => {
      const dest = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(backup, rel), dest, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dest, 0o600);
      // Checked again on the copy: the backup cannot change between the check and the copy unnoticed.
      if (!fileMatches(dest, f)) throw new RestoreError("backup_corrupt");
    };
    copy(DB_FILE, manifest.db);
    for (const f of manifest.files) copy(f.path, f);
    const paths = ensureLayout(staging);
    const db = openDb(paths.db);
    try {
      runMigrations(db);
      // The runtime folders are not in backups: no CLI session can be resumed, the next turn starts a fresh one
      // from the server's history (as after a rewrite).
      db.$client.prepare("UPDATE runtime_sessions SET invalidated = 1").run();
      db.$client.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.$client.close();
    }
    for (const f of [paths.db, `${paths.db}-wal`, `${paths.db}-shm`])
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);

    let previous: string | undefined;
    if (existing) {
      if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
      else {
        const stamp = new Date((o.now ?? Date.now)())
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\..*$/, "Z");
        previous = `${target}.before-restore-${stamp}`;
        fs.renameSync(target, previous);
      }
    }
    fs.renameSync(staging, target);
    return { manifest, pending: verified.pending, previous };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}
