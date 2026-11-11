import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { connectionAad } from "../connections/store.js";
import { decrypt } from "../crypto/secrets.js";
import { openDb, runMigrations } from "../db/client.js";
import { isInside } from "../fs-safety.js";
import { acquireDataLock, dataLockHolder, DataLockHeld, type DataLock } from "../storage/data-lock.js";
import { ensureLayout } from "../storage/paths.js";
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
    // The key check passed; every value encrypted with the master key must decrypt too (a backup of data whose key
    // was changed, one damaged row): connection credentials, encrypted settings (VAPID key …), push subscriptions.
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
      if (hasTable(db, "push_subscriptions"))
        for (const p of db.prepare("SELECT id, secret FROM push_subscriptions").all() as {
          id: string;
          secret: string;
        }[])
          decrypt(p.secret, key, `push:${p.id}`);
    } catch {
      throw new RestoreError("secret_unreadable");
    }
    return { manifest, pending: schema.pending };
  } finally {
    db.close();
  }
}

/** Whether a server (or another restore or migration) holds the data folder's lock. */
export function serverRunning(dataDir: string): boolean {
  return dataLockHolder(dataDir) !== undefined;
}

// ---- The swap and its journal ----

/**
 * `<parent>/.<name>.restore-journal.json`: written once the new folder is complete, before the first rename, and
 * removed after the last. A restore interrupted between the renames (killed, power cut) is finished by the next
 * restore or server start (`recoverInterruptedRestore`) — the new folder was already checked, so it is moved in.
 */
type Journal = { target: string; staging: string; previous: string | null; step: "staged" | "moved_old" };
export type RestoreStep = Journal["step"] | "swapped";

export function restoreJournalPath(dataDir: string): string {
  const abs = path.resolve(dataDir);
  return path.join(path.dirname(abs), `.${path.basename(abs)}.restore-journal.json`);
}

function writeJournal(file: string, j: Journal): void {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(j));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function readJournal(file: string): Journal | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const j = JSON.parse(text) as Partial<Journal>;
  if (typeof j.target !== "string" || typeof j.staging !== "string" || !("previous" in j))
    throw new Error("restore journal is unreadable");
  return j as Journal;
}

const exists = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;

export type RecoveryOutcome = "none" | "completed" | "rolled_back";

/**
 * Finishes a restore that was interrupted during the swap. Call with the data folder's lock held. The journal names
 * the checked new folder (`staging`), the target and where the old folder goes (`previous`):
 * - the new folder still exists → the swap is completed (old folder aside, new one in);
 * - it is gone and the target is missing → the old folder is moved back;
 * - it is gone and the target exists → the swap had finished, only the journal is left.
 */
export function recoverInterruptedRestore(dataDir: string): RecoveryOutcome {
  const file = restoreJournalPath(dataDir);
  const j = readJournal(file);
  if (!j) return "none";
  if (path.resolve(j.target) !== path.resolve(dataDir))
    throw new Error("restore journal names another folder");
  let outcome: RecoveryOutcome;
  if (exists(j.staging)) {
    if (exists(j.target)) {
      if (j.previous) fs.renameSync(j.target, j.previous);
      else fs.rmdirSync(j.target); // planned as empty: anything in it makes this fail (nothing lost)
    }
    fs.renameSync(j.staging, j.target);
    outcome = "completed";
  } else if (!exists(j.target) && j.previous && exists(j.previous)) {
    fs.renameSync(j.previous, j.target);
    outcome = "rolled_back";
  } else outcome = exists(j.target) ? "completed" : "rolled_back";
  fs.rmSync(file, { force: true });
  return outcome;
}

export type RestoreOptions = {
  /** The backup folder. */
  backup: string;
  /** The data folder to restore into (DATA_DIR, or a fresh folder for a rehearsal). */
  target: string;
  key: Buffer;
  /** BACKUP_DIR: the target may not overlap it. */
  backupDir?: string | undefined;
  /** The key file actually used and MASTER_KEY_PATH: the target may not contain either. */
  keyPaths?: (string | undefined)[];
  now?: () => number;
  /** Tests: the code's migrations. */
  code?: AppliedMigration[];
  /** Tests: the swap's renames (fault injection) and a call after each step (a kill between steps). */
  hooks?: { rename?: (from: string, to: string) => void; step?: (step: RestoreStep) => void };
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
    (o.keyPaths ?? []).some((k) => k !== undefined && isInside(k, target)) ||
    path.dirname(target) === target
  )
    throw new RestoreError("target_unsafe");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // The scheduler and every writer live in the server process: it must be stopped. The lock also keeps a server
  // from starting (and another restore from running) until the swap is done.
  let lock: DataLock;
  try {
    lock = acquireDataLock(target, "restore");
  } catch (e) {
    if (e instanceof DataLockHeld) throw new RestoreError("server_running");
    throw e;
  }
  try {
    recoverInterruptedRestore(target);
    return restoreLocked(o, target, backup);
  } finally {
    lock.release();
  }
}

function restoreLocked(o: RestoreOptions, target: string, backup: string): RestoreResult {
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory()))
    throw new RestoreError("target_unsafe");

  const verified = verifyBackup(backup, o.key, o.code);
  const { manifest } = verified;

  const parent = path.dirname(target);
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
      // An older backup gets this code's missing migrations (checkSchema allowed only that).
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
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }

  let previous: string | null = null;
  if (existing && fs.readdirSync(target).length > 0) {
    const stamp = new Date((o.now ?? Date.now)()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "Z");
    previous = `${target}.before-restore-${stamp}`;
    if (exists(previous)) previous = `${previous}-${crypto.randomBytes(2).toString("hex")}`;
  }
  swap({ target, staging, previous, targetExists: !!existing }, o.hooks);
  return { manifest, pending: verified.pending, previous: previous ?? undefined };
}

/** Old folder aside, new one in — journaled, and undone in place when a rename fails. */
function swap(
  s: { target: string; staging: string; previous: string | null; targetExists: boolean },
  hooks: RestoreOptions["hooks"],
): void {
  const rename = hooks?.rename ?? fs.renameSync;
  const journal = restoreJournalPath(s.target);
  const j: Journal = { target: s.target, staging: s.staging, previous: s.previous, step: "staged" };
  writeJournal(journal, j);
  hooks?.step?.("staged");
  let moved = false;
  try {
    if (s.previous) {
      rename(s.target, s.previous);
      moved = true;
      writeJournal(journal, { ...j, step: "moved_old" });
      hooks?.step?.("moved_old");
    } else if (s.targetExists) fs.rmdirSync(s.target);
    rename(s.staging, s.target);
    hooks?.step?.("swapped");
  } catch (e) {
    // Undo: the old folder goes back to its place, the new one is dropped. If even that fails, the journal stays
    // and the next restore or server start finishes the swap.
    try {
      if (moved && s.previous && !exists(s.target)) fs.renameSync(s.previous, s.target);
      else if (!s.previous && s.targetExists && !exists(s.target)) fs.mkdirSync(s.target, { mode: 0o700 });
      fs.rmSync(s.staging, { recursive: true, force: true });
      fs.rmSync(journal, { force: true });
    } catch {
      // left for recoverInterruptedRestore
    }
    throw e;
  }
  fs.rmSync(journal, { force: true });
}
