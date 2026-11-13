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
  caseInsensitive,
  sameDataDir,
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
  // The old data folder's database could not be settled (checkpointed, no -wal/-shm left) before the swap.
  "old_unsettled",
  // A file of the new folder could not be made durable (fsync failed: EIO, ENOSPC …) — nothing was swapped.
  "not_durable",
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
 * `<parent>/.<name>.restore-journal.json` (real path), written before the first rename and fsynced on every phase:
 *
 *   prepared     the new folder (candidate) is complete; nothing moved yet
 *   old_moved    the old folder is at `previous`
 *   swapped      the candidate is at the target
 *   done         only clean-up left
 *   rolling_back a step failed: going back (written before anything is undone)
 *
 * It carries everything needed to tell the folders apart — recovery never guesses:
 * - `old`: a random id written into the old folder (`.restore-old`) before it is moved, and its database's SHA-256;
 * - `candidate`: a random id written into the candidate (`.restore-candidate`) and its full manifest — every file
 *   (database, files/, artifacts/, sources/) with size and SHA-256.
 * A folder *is* the old one only if its id file and database match; it *is* the candidate only if its id file
 * matches and every file is exactly the manifest (none missing, none extra, none changed — a 0-byte database never
 * passes). Recovery (every writer runs it first) rolls forward to a proven candidate (from `old_moved` on), else
 * back to the proven old folder. A target it cannot prove is moved aside only if it carries the candidate's id
 * (a damaged copy of the backup); anything else, or no provable folder at all, keeps the journal and stops with
 * `restore_unresolved` — both folders left untouched.
 */
type Phase = "prepared" | "old_moved" | "swapped" | "done" | "rolling_back";
type FileEntry = { path: string; bytes: number; sha256: string };
/** A file's state: absent, or its size and SHA-256. */
type FileState = { bytes: number; sha256: string } | null;
const SIDECARS = ["-wal", "-shm"] as const;
type Sidecar = (typeof SIDECARS)[number];
type Journal = {
  target: string;
  staging: string;
  previous: string | null;
  phase: Phase;
  /** Null when the target was missing or empty (rolling back = no data folder). */
  old: { id: string; dbSha256: string | null; sidecars: Record<Sidecar, FileState> } | null;
  candidate: { id: string; files: FileEntry[] };
};
export type RestoreStep = Phase | "journal_removed" | "cleaned";
export const OLD_ID_FILE = ".restore-old";
export const CANDIDATE_ID_FILE = ".restore-candidate";
const ID_FILES = new Set([OLD_ID_FILE, CANDIDATE_ID_FILE]);

export function restoreJournalPath(dataDir: string): string {
  const real = realDataDir(dataDir);
  return path.join(path.dirname(real), `.${path.basename(real)}.restore-journal.json`);
}

/** Errors a directory fsync may give on file systems that do not support it — the only ones ever ignored. */
const DIR_FSYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"]);
/** Tests: called before every fsync (fault injection). */
let fsyncHook: ((p: string) => void) | undefined;

/**
 * fsync of a file or a directory. A file's open or fsync error always propagates (the data is not durable); a
 * directory's only when it is not one of the "unsupported" answers above.
 */
function fsyncPath(p: string): void {
  let dir = false;
  try {
    dir = fs.lstatSync(p).isDirectory();
    fsyncHook?.(p);
    const fd = fs.openSync(p, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    if (dir && DIR_FSYNC_UNSUPPORTED.has((e as NodeJS.ErrnoException).code ?? "")) return;
    throw e;
  }
}

function writeDurable(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, text);
    fsyncHook?.(tmp);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  fsyncPath(path.dirname(file));
}

function readJournal(file: string): Journal | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let j: Partial<Journal>;
  try {
    j = JSON.parse(text) as Partial<Journal>;
  } catch {
    throw new RecoveryError("restore journal is unreadable");
  }
  const phases: Phase[] = ["prepared", "old_moved", "swapped", "done", "rolling_back"];
  if (
    typeof j.target !== "string" ||
    typeof j.staging !== "string" ||
    !("previous" in j) ||
    !("old" in j) ||
    typeof j.candidate?.id !== "string" ||
    !Array.isArray(j.candidate.files) ||
    !phases.includes(j.phase as Phase)
  )
    throw new RecoveryError("restore journal is unreadable");
  return j as Journal;
}

const exists = (p: string) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;

/** Every regular file under `dir` (relative POSIX paths, id files left out), sorted. Symlinks count as foreign. */
function listFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (!rel && ID_FILES.has(e.name)) continue;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (e.isFile()) out.push(r);
    else out.push(`${r}\0not-a-file`);
  }
  return out.sort();
}

function manifestOf(dir: string): FileEntry[] {
  return listFiles(dir).map((rel) => {
    const abs = path.join(dir, rel);
    return { path: rel, bytes: fs.statSync(abs).size, sha256: sha256File(abs) };
  });
}

const readId = (dir: string, file: string): string | undefined => {
  try {
    return fs.readFileSync(path.join(dir, file), "utf8").trim();
  } catch {
    return undefined;
  }
};
const dbSha = (dir: string): string | null => {
  const f = path.join(dir, DB_FILE);
  const st = fs.lstatSync(f, { throwIfNoEntry: false });
  return st?.isFile() && st.size > 0 ? sha256File(f) : null;
};
function fileState(f: string): FileState {
  const st = fs.lstatSync(f, { throwIfNoEntry: false });
  if (!st) return null;
  if (!st.isFile()) return { bytes: -1, sha256: "not-a-file" };
  return { bytes: st.size, sha256: sha256File(f) };
}
const sidecarStates = (dir: string) =>
  Object.fromEntries(SIDECARS.map((x) => [x, fileState(path.join(dir, `${DB_FILE}${x}`))])) as Record<
    Sidecar,
    FileState
  >;
const sameState = (a: FileState, b: FileState) =>
  a === null ? b === null : b !== null && a.bytes === b.bytes && a.sha256 === b.sha256;

/**
 * Settles the old database before it is identified (#37 review 4): the server is stopped (restore holds the lock),
 * so its WAL is checkpointed into the main file and the journal mode set to DELETE — no committed row lives only in
 * a `-wal` that could be lost. Afterwards no `-wal` (or an empty one) and no `-shm` may remain.
 */
function settleOldDb(dir: string): void {
  const file = path.join(dir, DB_FILE);
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st?.isFile() || st.size === 0) return;
  let db: Database.Database;
  try {
    db = new Database(file, { fileMustExist: true, timeout: 0 });
  } catch {
    throw new RestoreError("old_unsettled");
  }
  try {
    const r = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    if (r[0]?.busy) throw new RestoreError("old_unsettled");
    if (db.pragma("journal_mode = DELETE", { simple: true }) !== "delete")
      throw new RestoreError("old_unsettled");
    // The checkpoint only sees WAL readers: a database already in rollback-journal mode (e.g. after an earlier
    // restore) reports busy=0 whoever is reading it (#139 review). In rollback mode every reader holds a SHARED lock
    // on the main file for its whole transaction, so an EXCLUSIVE lock (no waiting) is the check for both modes —
    // any other connection inside a transaction, of any kind, makes it fail. Taken and dropped at once, not held
    // across the swap: the swap hashes the file with plain fs calls, and closing any descriptor of a file drops all
    // of the process's POSIX locks on it, so a held lock would silently vanish.
    db.exec("BEGIN EXCLUSIVE");
    db.exec("ROLLBACK");
  } catch (e) {
    throw e instanceof RestoreError ? e : new RestoreError("old_unsettled");
  } finally {
    db.close();
  }
  const wal = fs.lstatSync(`${file}-wal`, { throwIfNoEntry: false });
  if ((wal && wal.size > 0) || exists(`${file}-shm`)) throw new RestoreError("old_unsettled");
  try {
    fsyncPath(file);
    fsyncPath(dir);
  } catch {
    throw new RestoreError("not_durable");
  }
}

/** `dir` is exactly the journaled candidate. */
function isCandidate(dir: string, j: Journal): boolean {
  try {
    if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return false;
    if (readId(dir, CANDIDATE_ID_FILE) !== j.candidate.id) return false;
    const want = j.candidate.files;
    const have = listFiles(dir);
    if (have.length !== want.length || have.some((p, i) => p !== want[i]!.path)) return false;
    if (!want.some((f) => f.path === DB_FILE && f.bytes > 0)) return false;
    return want.every((f) => {
      const abs = path.join(dir, f.path);
      return fs.statSync(abs).size === f.bytes && sha256File(abs) === f.sha256;
    });
  } catch {
    return false;
  }
}

/** `dir` is the journaled old folder (its id file, and its database unchanged). */
function isOld(dir: string, j: Journal): boolean {
  if (!j.old || !fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return false;
  try {
    if (readId(dir, OLD_ID_FILE) !== j.old.id || dbSha(dir) !== j.old.dbSha256) return false;
    // The database is its main file *and* its sidecars: a lost or changed -wal is a different database.
    const now = sidecarStates(dir);
    return SIDECARS.every((x) => sameState(now[x], j.old!.sidecars?.[x] ?? null));
  } catch {
    return false;
  }
}

export type RecoveryOutcome = "none" | "completed" | "rolled_back";

export class RecoveryError extends Error {
  readonly code = "restore_unresolved";
  constructor(message: string) {
    super(`restore_unresolved: ${message}`);
    this.name = "RecoveryError";
  }
}

const FORWARD: ReadonlySet<Phase> = new Set(["old_moved", "swapped", "done"]);
/** Without an old folder there is nothing to go back to: a proven candidate may be completed from `prepared` too. */
const forwardAllowed = (j: Journal) => FORWARD.has(j.phase) || (j.old === null && j.phase === "prepared");

/** Removes the id files once nothing needs them (no journal any more). */
function dropIdFiles(...dirs: (string | null)[]): void {
  for (const d of dirs) if (d) for (const f of ID_FILES) fs.rmSync(path.join(d, f), { force: true });
}

/**
 * Finishes or undoes a restore interrupted during the swap. Call with the data folder's lock held. Throws
 * `RecoveryError` (journal kept, nothing moved) when it cannot prove which folder is which.
 */
export function recoverInterruptedRestore(dataDir: string): RecoveryOutcome {
  const file = restoreJournalPath(dataDir);
  const read = readJournal(file);
  if (!read) return "none";
  const real = realDataDir(dataDir);
  if (!sameDataDir(read.target, real)) throw new RecoveryError("the journal names another folder");
  // The same folder: renamed under this spelling (the on-disk one when it exists), never the journal's.
  const j: Journal = { ...read, target: real };
  const finish = (outcome: RecoveryOutcome) => {
    fs.rmSync(file, { force: true });
    fsyncPath(path.dirname(file));
    dropIdFiles(j.target, j.previous);
    return outcome;
  };
  const rejected = `${j.target}.restore-rejected-${crypto.randomBytes(3).toString("hex")}`;

  // Forward: only to a proven candidate, and only once the old folder was moved (or the swap happened).
  if (forwardAllowed(j)) {
    if (isCandidate(j.target, j)) {
      fs.rmSync(j.staging, { recursive: true, force: true });
      return finish("completed");
    }
    if (!exists(j.target) && isCandidate(j.staging, j)) {
      fs.renameSync(j.staging, j.target);
      fsyncPath(path.dirname(j.target));
      return finish("completed");
    }
  }
  // Back: to the proven old folder (or to "no data folder" when there was none). Decided before anything is
  // written: a refusal leaves the journal exactly as it was.
  const targetIsOurs = () => readId(j.target, CANDIDATE_ID_FILE) === j.candidate.id;
  let plan: "keep_target" | "restore_previous" | "clear_target";
  if (j.old) {
    if (isOld(j.target, j)) plan = "keep_target";
    else if (j.previous && isOld(j.previous, j)) {
      // Only our own (damaged) candidate is moved aside — never data we cannot account for.
      if (exists(j.target) && !targetIsOurs())
        throw new RecoveryError("the data folder is neither the old one nor the restored one");
      plan = "restore_previous";
    } else throw new RecoveryError("the old data folder cannot be found or has changed");
  } else {
    if (exists(j.target) && !targetIsOurs())
      throw new RecoveryError("the data folder is not the restored one");
    plan = "clear_target";
  }
  writeDurable(file, JSON.stringify({ ...j, phase: "rolling_back" } satisfies Journal));
  if (plan !== "keep_target" && exists(j.target)) fs.renameSync(j.target, rejected);
  if (plan === "restore_previous") {
    fs.renameSync(j.previous!, j.target);
    fsyncPath(path.dirname(j.target));
  }
  fs.rmSync(j.staging, { recursive: true, force: true });
  return finish("rolled_back");
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
    // No journal any more: id files a finished restore did not get to remove are left-overs.
    if (exists(real)) dropIdFiles(real);
    // A 0-byte database is no database.
    if (
      kind !== "restore" &&
      !(fs.statSync(path.join(real, DB_FILE), { throwIfNoEntry: false })?.size ?? 0)
    ) {
      const prefix = `${path.basename(real)}.before-restore-`;
      const parent = path.dirname(real);
      const fold =
        exists(parent) && caseInsensitive(parent) ? (n: string) => n.toLowerCase() : (n: string) => n;
      const asides = exists(parent)
        ? fs.readdirSync(parent).filter((n) => fold(n).startsWith(fold(prefix)))
        : [];
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
    /** Called before every fsync with its path (throw to inject EIO, ENOSPC …). */
    fsync?: (p: string) => void;
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
    fsyncHook = o.hooks?.fsync;
    return restoreLocked(o, target, backup);
  } finally {
    fsyncHook = undefined;
    claim.lock.release();
  }
}

function restoreLocked(o: RestoreOptions, target: string, backup: string): RestoreResult {
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory()))
    throw new RestoreError("target_unsafe");

  const verified = verifyBackup(backup, o.key, o.code);
  // Before anything is copied: the old database checkpointed and closed, so its identity is its main file alone.
  if (existing) settleOldDb(target);
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
    // Power-loss order: every file, then every folder (deepest first), then — in swap() — the id file and journal.
    try {
      syncTree(staging);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code) throw new RestoreError("not_durable");
      throw e;
    }
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

/** fsync of every file and folder under `dir`, children before parents. */
function syncTree(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) syncTree(p);
    else if (e.isFile()) fsyncPath(p);
  }
  fsyncPath(dir);
}

/**
 * Old folder aside, new one in. Before anything moves, both folders get their id file and the journal records
 * both identities and the candidate's full manifest; every phase is fsynced. A failure is undone in place, a kill
 * by the next writer (`recoverInterruptedRestore`). Id files go only after the journal is gone.
 */
function swap(
  s: { target: string; staging: string; previous: string | null },
  hooks: RestoreOptions["hooks"],
): void {
  const rename = hooks?.rename ?? fs.renameSync;
  const rm = hooks?.rm ?? ((p: string) => fs.rmSync(p, { recursive: true, force: true }));
  const journal = restoreJournalPath(s.target);
  let candidate: Journal["candidate"];
  let old: Journal["old"] = null;
  try {
    candidate = { id: crypto.randomBytes(16).toString("hex"), files: manifestOf(s.staging) };
    writeDurable(path.join(s.staging, CANDIDATE_ID_FILE), candidate.id);
    if (s.previous) {
      old = {
        id: crypto.randomBytes(16).toString("hex"),
        dbSha256: dbSha(s.target),
        sidecars: sidecarStates(s.target),
      };
      writeDurable(path.join(s.target, OLD_ID_FILE), old.id);
    }
  } catch (e) {
    // Nothing journaled or moved yet: drop the candidate, leave the old folder as it was.
    fs.rmSync(s.staging, { recursive: true, force: true });
    dropIdFiles(s.target);
    throw (e as NodeJS.ErrnoException).code ? new RestoreError("not_durable") : e;
  }
  const j: Omit<Journal, "phase"> = { ...s, old, candidate };
  const phase = (p: Phase) => {
    writeDurable(journal, JSON.stringify({ ...j, phase: p } satisfies Journal));
    hooks?.step?.(p);
  };
  try {
    phase("prepared");
  } catch (e) {
    fs.rmSync(journal, { force: true });
    fs.rmSync(s.staging, { recursive: true, force: true });
    dropIdFiles(s.target);
    throw (e as NodeJS.ErrnoException).code ? new RestoreError("not_durable") : e;
  }
  // From the first rename until `done` is durably written, any error is handled the same way: back to the old
  // folder. The journal is removed only once the folders are back where it says they end and that is synced;
  // if any undo step fails, the `rolling_back` journal and both id files stay for the next writer.
  try {
    if (s.previous) {
      rename(s.target, s.previous);
      fsyncPath(path.dirname(s.target));
      phase("old_moved");
    }
    rename(s.staging, s.target);
    fsyncPath(path.dirname(s.target));
    phase("swapped");
    phase("done");
  } catch (e) {
    undoSwap(s, candidate.id, journal, j, rename, rm);
    throw e;
  }
  // `done` is durable: the folders are final. Clean-up is best effort — a journal left behind says `done` and the
  // next writer only finishes this clean-up.
  try {
    fs.rmSync(journal, { force: true });
    fsyncPath(path.dirname(journal));
    hooks?.step?.("journal_removed");
    dropIdFiles(s.target, s.previous);
    hooks?.step?.("cleaned");
  } catch {
    // finished by recoverInterruptedRestore
  }
}

/** Undo of a failed swap, in place. Throws nothing; leaves the journal whenever it could not finish. */
function undoSwap(
  s: { target: string; staging: string; previous: string | null },
  candidateId: string,
  journal: string,
  j: Omit<Journal, "phase">,
  rename: (from: string, to: string) => void,
  rm: (p: string) => void,
): void {
  try {
    writeDurable(journal, JSON.stringify({ ...j, phase: "rolling_back" } satisfies Journal));
  } catch {
    // best effort: the journal still names both folders, and recovery proves which is which
  }
  // The same proofs as recovery: the old folder only when its id, database and sidecars match the journal.
  const proof: Journal = { ...j, phase: "rolling_back" };
  const isOurCandidate = (dir: string) => exists(dir) && readId(dir, CANDIDATE_ID_FILE) === candidateId;
  const aside = () => `${s.target}.restore-rejected-${crypto.randomBytes(3).toString("hex")}`;
  try {
    const parent = path.dirname(s.target);
    if (s.previous) {
      if (!isOld(s.target, proof)) {
        // Nothing further moves unless the folder going back is provably the old one (and the target is free or
        // holds our candidate): otherwise the journal and both ids stay for `restore_unresolved`.
        if (!isOld(s.previous, proof)) return;
        if (exists(s.target)) {
          if (!isOurCandidate(s.target)) return;
          rename(s.target, aside());
        }
        rename(s.previous, s.target);
      }
    } else if (isOurCandidate(s.target)) rename(s.target, aside());
    fsyncPath(parent);
    // Done only when the folders are where the journal ends — checked again before the journal goes.
    const back = s.previous ? isOld(s.target, proof) && !exists(s.previous) : !exists(s.target);
    if (!back) return;
    rm(s.staging);
    fsyncPath(parent);
    fs.rmSync(journal, { force: true });
    fsyncPath(path.dirname(journal));
    dropIdFiles(s.target);
  } catch {
    // the journal (rolling_back, or an earlier phase) stays: the next writer finishes the undo
  }
}
