import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { connectionAad } from "../connections/store.js";
import { decrypt } from "../crypto/secrets.js";
import { openDb, runMigrations } from "../db/client.js";
import { isInside } from "../fs-safety.js";
import {
  acquireDataLock,
  dataLockHolder,
  DataLockHeld,
  realDataDir,
  type DataLock,
  type DataLockKind,
} from "../storage/data-lock.js";
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
 * `<parent>/.<name>.restore-journal.json` (real path): the swap's phases, fsynced before each step.
 *
 *   prepared     the new folder is complete and checked (its `.restore-complete` marker written); nothing moved yet
 *   old_moved    the old folder is at `previous`
 *   swapped      the new folder is at the target
 *   done         only clean-up left
 *   rolling_back a step failed: going back to the old folder (written before anything is undone)
 *
 * Recovery (`recoverInterruptedRestore`, run by every writer before it opens anything) rolls *forward* only from
 * `old_moved` with a staging folder whose marker matches its database and whose database opens and passes a quick
 * check — or once `swapped`. Every other case rolls *back* to the old folder. A target it cannot account for (data
 * that is neither the old folder nor the checked new one) stops it: never a fresh empty database over a journal.
 */
type Phase = "prepared" | "old_moved" | "swapped" | "done" | "rolling_back";
type Journal = { target: string; staging: string; previous: string | null; phase: Phase };
export type RestoreStep = Phase;
export const COMPLETE_MARKER = ".restore-complete";

export function restoreJournalPath(dataDir: string): string {
  const real = realDataDir(dataDir);
  return path.join(path.dirname(real), `.${path.basename(real)}.restore-journal.json`);
}

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // best effort (not every file system allows it)
  }
}

function writeDurable(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
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
  const phases: Phase[] = ["prepared", "old_moved", "swapped", "done", "rolling_back"];
  if (
    typeof j.target !== "string" ||
    typeof j.staging !== "string" ||
    !("previous" in j) ||
    !phases.includes(j.phase as Phase)
  )
    throw new Error("restore journal is unreadable");
  return j as Journal;
}

const exists = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;

/** The marker of a complete, checked new data folder: the SHA-256 of its database. */
function writeMarker(dir: string): void {
  writeDurable(path.join(dir, COMPLETE_MARKER), JSON.stringify({ db: sha256File(path.join(dir, DB_FILE)) }));
}

/** True when `dir` is a complete new data folder: marker present, database unchanged since, opens, quick check ok. */
export function isCompleteStaging(dir: string): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, COMPLETE_MARKER), "utf8")) as { db?: unknown };
    const dbFile = path.join(dir, DB_FILE);
    if (typeof m.db !== "string" || sha256File(dbFile) !== m.db) return false;
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      return db.pragma("quick_check", { simple: true }) === "ok";
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export type RecoveryOutcome = "none" | "completed" | "rolled_back";

export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryError";
  }
}

/** Finishes or undoes a restore interrupted during the swap. Call with the data folder's lock held. */
export function recoverInterruptedRestore(dataDir: string): RecoveryOutcome {
  const file = restoreJournalPath(dataDir);
  const j = readJournal(file);
  if (!j) return "none";
  if (j.target !== realDataDir(dataDir)) throw new RecoveryError("restore journal names another folder");
  const forward =
    j.phase === "swapped" ||
    j.phase === "done" ||
    (j.phase === "old_moved" && (isCompleteStaging(j.staging) || isCompleteStaging(j.target)));
  let outcome: RecoveryOutcome;
  if (forward) {
    if (!exists(j.target)) fs.renameSync(j.staging, j.target);
    else if (!isCompleteStaging(j.target))
      throw new RecoveryError("restore journal: the data folder is neither the old one nor the restored one");
    fs.rmSync(path.join(j.target, COMPLETE_MARKER), { force: true });
    outcome = "completed";
  } else {
    // Back to the old folder, whatever is in staging (possibly half-deleted).
    writeDurable(file, JSON.stringify({ ...j, phase: "rolling_back" } satisfies Journal));
    if (exists(j.target) && isCompleteStaging(j.target) && j.previous && exists(j.previous))
      fs.renameSync(j.target, `${j.staging}.undo`);
    if (!exists(j.target) && j.previous && exists(j.previous)) fs.renameSync(j.previous, j.target);
    if (!exists(j.target) && j.previous)
      throw new RecoveryError("restore journal: the old data folder is missing — nothing was started");
    fs.rmSync(j.staging, { recursive: true, force: true });
    fs.rmSync(`${j.staging}.undo`, { recursive: true, force: true });
    outcome = "rolled_back";
  }
  fs.rmSync(file, { force: true });
  fsyncDir(path.dirname(file));
  return outcome;
}

/**
 * Everything that writes the data folder starts here — the server, `pnpm db:migrate`, `pnpm restore`: the lock (a
 * second writer is refused), then recovery of an interrupted restore, then a check that the folder is not simply
 * missing while an older copy sits next to it (a fresh empty database must never replace the family's data
 * unnoticed). Only then may the caller open the layout and the database.
 */
export function openStorageForWrite(
  dataDir: string,
  kind: DataLockKind,
): { lock: DataLock; recovered: RecoveryOutcome; dataDir: string } {
  const lock = acquireDataLock(dataDir, kind);
  try {
    const recovered = recoverInterruptedRestore(dataDir);
    const real = realDataDir(dataDir);
    if (kind !== "restore" && !exists(path.join(real, DB_FILE))) {
      const prefix = `${path.basename(real)}.before-restore-`;
      const parent = path.dirname(real);
      const asides = exists(parent) ? fs.readdirSync(parent).filter((n) => n.startsWith(prefix)) : [];
      if (asides.length)
        throw new RecoveryError(
          `no database in the data folder but an earlier one is next to it (${asides[0]}) — move it back or restore (docs/ops.md §21.4)`,
        );
    }
    return { lock, recovered, dataDir: real };
  } catch (e) {
    lock.release();
    throw e;
  }
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
  /**
   * Tests: the swap's renames and removals (fault injection) and a call after each journal phase is written (a kill
   * between steps).
   */
  hooks?: {
    rename?: (from: string, to: string) => void;
    rm?: (p: string) => void;
    step?: (step: RestoreStep) => void;
  };
};

export type RestoreResult = {
  manifest: Manifest;
  /** Migrations applied on top of the backup's schema. */
  pending: number;
  /** Where the replaced data folder was moved (undefined when the target was missing or empty). */
  previous: string | undefined;
};

export function restoreBackup(o: RestoreOptions): RestoreResult {
  // The real path: renaming through a symlinked alias would move the link, not the folder.
  const target = realDataDir(o.target);
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
  let claim: ReturnType<typeof openStorageForWrite>;
  try {
    claim = openStorageForWrite(target, "restore");
  } catch (e) {
    if (e instanceof DataLockHeld) throw new RestoreError("server_running");
    throw e;
  }
  try {
    return restoreLocked(o, target, backup);
  } finally {
    claim.lock.release();
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
      db.$client.pragma("journal_mode = DELETE");
    } finally {
      db.$client.close();
    }
    for (const f of [paths.db, `${paths.db}-wal`, `${paths.db}-shm`])
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    writeMarker(staging);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }

  let previous: string | null = null;
  if (existing && fs.readdirSync(target).length > 0) {
    const stamp = new Date((o.now ?? Date.now)()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "Z");
    previous = `${target}.before-restore-${stamp}`;
    if (exists(previous)) previous = `${previous}-${crypto.randomBytes(2).toString("hex")}`;
  } else if (existing) fs.rmdirSync(target);
  swap({ target, staging, previous }, o.hooks);
  return { manifest, pending: verified.pending, previous: previous ?? undefined };
}

/** Old folder aside, new one in — every phase journaled; a failure is undone in place, a kill by the next writer. */
function swap(
  s: { target: string; staging: string; previous: string | null },
  hooks: RestoreOptions["hooks"],
): void {
  const rename = hooks?.rename ?? fs.renameSync;
  const rm = hooks?.rm ?? ((p: string) => fs.rmSync(p, { recursive: true, force: true }));
  const journal = restoreJournalPath(s.target);
  const phase = (p: Phase) => {
    writeDurable(journal, JSON.stringify({ ...s, phase: p } satisfies Journal));
    hooks?.step?.(p);
  };
  phase("prepared");
  try {
    if (s.previous) {
      rename(s.target, s.previous);
      phase("old_moved");
    }
    rename(s.staging, s.target);
  } catch (e) {
    // Recorded first, so a crash in the middle of undoing is undone too (never rolled forward).
    try {
      phase("rolling_back");
      if (!exists(s.target) && s.previous && exists(s.previous)) rename(s.previous, s.target);
      rm(s.staging);
      fs.rmSync(journal, { force: true });
    } catch {
      // the journal says rolling_back: the next writer finishes the undo
    }
    throw e;
  }
  phase("swapped");
  fs.rmSync(path.join(s.target, COMPLETE_MARKER), { force: true });
  phase("done");
  fs.rmSync(journal, { force: true });
  fsyncDir(path.dirname(journal));
}
