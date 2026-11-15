import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { BackupError, createBackup, ensureBackupDir } from "../backup/backup.js";
import { FileWriteLock } from "../backup/lock.js";
import { restoreJournalPath, RestoreError, verifyBackup } from "../backup/restore.js";
import type { Config } from "../config.js";
import { isInside } from "../fs-safety.js";
import { acquireDataLock, DataLockHeld, type DataLock } from "../storage/data-lock.js";
import { storagePaths } from "../storage/paths.js";

/**
 * The installed-release side of `scripts/release.sh` (#143, docs/ops.md §43): what the production configuration
 * resolves to, the pre-deploy backup and the one-time data move. Everything here prints paths, ids and counts only —
 * never a value from `.env`.
 */

export class ReleaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ReleaseSummary = {
  host: string;
  port: number;
  dataDir: string;
  backupDir: string;
  database: "present" | "absent";
  workerRunUser: boolean;
  pythonRun: boolean;
};

/**
 * Checks that the configuration is one a release can run with: `.env` present at the release root (the link to
 * `shared/.env`), DATA_DIR and BACKUP_DIR set explicitly to absolute paths (a relative or default path would land
 * inside the release folder or in the home folder) and both outside the release and the folder all releases live in.
 */
export function releaseSummary(
  config: Config,
  o: { repoRoot: string; env: Record<string, string | undefined> },
): ReleaseSummary {
  const problems: string[] = [];
  if (!fs.existsSync(path.join(o.repoRoot, ".env")))
    problems.push(".env not found at the release root (link to shared/.env)");
  for (const name of ["DATA_DIR", "BACKUP_DIR"] as const) {
    const v = o.env[name];
    if (v === undefined || v === "") problems.push(`${name} is not set (set it in shared/.env)`);
    else if (!path.isAbsolute(v)) problems.push(`${name} must be an absolute path`);
  }
  if (config.backupDir === undefined) problems.push("backups are off (BACKUP_DIR)");
  // Releases sit side by side in `<home>/releases/`: data inside one of them would vanish with a prune.
  const releasesDir = path.dirname(o.repoRoot);
  const container = path.basename(releasesDir) === "releases" ? releasesDir : o.repoRoot;
  if (isInside(config.dataDir, container)) problems.push("DATA_DIR must be outside the releases folder");
  if (config.backupDir !== undefined && isInside(config.backupDir, container))
    problems.push("BACKUP_DIR must be outside the releases folder");
  if (problems.length) throw new ReleaseError("config_invalid", problems.join("; "));
  return {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    backupDir: config.backupDir!,
    database: fs.existsSync(storagePaths(config.dataDir).db) ? "present" : "absent",
    workerRunUser: config.workerRunUser !== undefined,
    pythonRun: config.pythonRun,
  };
}

export type PredeployResult = { id: string; dir: string; pendingMigrations: number };

/**
 * A full backup (DB + file stores, the app's own format — `pnpm -s restore` reads it) taken while the server may be
 * running: the live database is opened read-only and copied with `VACUUM INTO` (one read transaction — a single point
 * in time while the server writes). Upload files are written once under their id and renamed into place before their
 * row commits, so every file the snapshot references already exists; one deleted between the snapshot and the copy
 * fails the backup (the deploy stops, nothing changed — run it again).
 *
 * Built in a private staging folder inside BACKUP_DIR (the server's own backup run clears `.tmp-*` folders there, so
 * a shared `.tmp-` name could be removed under us) and renamed into BACKUP_DIR once complete. Then checked exactly as
 * `pnpm -s restore check` does (key, hashes, `integrity_check`, schema, every secret decrypts) against this release's
 * migrations: a database newer than this release (`schema_newer`) or from another branch stops the deploy.
 * Undefined when there is no database yet.
 */
export async function predeployBackup(o: {
  dataDir: string;
  backupDir: string;
  masterKey: Buffer;
  now?: () => number;
  /** Tests: runs right after the live database was snapshotted (the server may write or purge meanwhile). */
  afterSnapshot?: () => void;
}): Promise<PredeployResult | undefined> {
  const dbFile = storagePaths(o.dataDir).db;
  if (!fs.existsSync(dbFile)) return undefined;
  ensureBackupDir(o.backupDir);
  // One pre-deploy backup per BACKUP_DIR at a time, whatever started it (two release roots can share a BACKUP_DIR,
  // and release.sh's own lock is per root): a kernel lock next to the staging folders, `<BACKUP_DIR>/.predeploy.lock.db`
  // (the data lock's mechanism — dropped by the system if the process dies), held from the clean-up below until the
  // backup is complete. The server's daily backups use `.tmp-*` and never touch `.predeploy-*`.
  let lock: DataLock;
  try {
    lock = acquireDataLock(path.join(o.backupDir, "predeploy"), "predeploy");
  } catch (e) {
    if (e instanceof DataLockHeld)
      throw new ReleaseError("backup_running", "another pre-deploy backup is using BACKUP_DIR — try again");
    throw e;
  }
  try {
    return await predeployLocked(o, dbFile);
  } finally {
    lock.release();
  }
}

async function predeployLocked(
  o: Parameters<typeof predeployBackup>[0],
  dbFile: string,
): Promise<PredeployResult> {
  // Staging folders left by a killed run (never listed as backups, but they hold a copy of the database). Safe to
  // remove: we hold the lock, so no other pre-deploy backup is writing one.
  for (const name of fs.readdirSync(o.backupDir))
    if (name.startsWith(".predeploy-"))
      fs.rmSync(path.join(o.backupDir, name), { recursive: true, force: true });
  const staging = path.join(o.backupDir, `.predeploy-${crypto.randomBytes(4).toString("hex")}`);
  let live: Database.Database | undefined;
  let sqlite: Database.Database | undefined;
  try {
    // First a private snapshot of the live database (one read transaction), then the backup is made from THAT
    // snapshot: the files it must contain and the deleted folders it must leave out are read from the same moment
    // as the rows. Reading them from the live database (another process — our FileWriteLock does not stop the
    // server) could miss a file whose row the snapshot still has, if the server purged it in between (#148 review).
    fs.mkdirSync(staging, { mode: 0o700 });
    fs.chmodSync(staging, 0o700); // whatever the caller's umask
    const snapFile = path.join(staging, "live-snapshot.db");
    fs.writeFileSync(snapFile, "", { mode: 0o600, flag: "wx" }); // owner-only before any data is written
    fs.chmodSync(snapFile, 0o600);
    live = new Database(dbFile, { readonly: true, fileMustExist: true });
    live.pragma("busy_timeout = 5000");
    live.prepare("VACUUM INTO ?").run(snapFile);
    fs.chmodSync(snapFile, 0o600);
    live.close();
    live = undefined;
    o.afterSnapshot?.();
    sqlite = new Database(snapFile, { readonly: true, fileMustExist: true });
    const info = await createBackup({
      sqlite,
      dataDir: o.dataDir,
      backupDir: staging,
      masterKey: o.masterKey,
      lock: new FileWriteLock(),
      now: o.now ?? Date.now,
    });
    const dir = path.join(o.backupDir, info.id);
    fs.renameSync(path.join(staging, info.id), dir);
    const verified = verifyBackup(dir, o.masterKey);
    return { id: info.id, dir, pendingMigrations: verified.pending };
  } catch (e) {
    if (e instanceof RestoreError)
      throw new ReleaseError(e.code, `pre-deploy backup check failed: ${e.code}`);
    if (e instanceof BackupError) throw new ReleaseError(e.code, `pre-deploy backup failed: ${e.code}`);
    throw new ReleaseError("backup_failed", "pre-deploy backup failed: backup_failed");
  } finally {
    live?.close();
    sqlite?.close();
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const lstatOrUndefined = (f: string) => fs.lstatSync(f, { throwIfNoEntry: false });

/**
 * Whether backup `id` in BACKUP_DIR can be restored by THIS release (`pnpm -s restore check`: key, hashes,
 * integrity, schema not newer than this release's migrations, secrets). The rollback hint picks its backup with it.
 */
export function checkBackup(backupDir: string, id: string, masterKey: Buffer): { pending: number } {
  if (!/^[0-9A-Za-z-]{1,64}$/.test(id)) throw new ReleaseError("usage", "invalid backup id");
  try {
    return { pending: verifyBackup(path.join(backupDir, id), masterKey).pending };
  } catch (e) {
    if (e instanceof RestoreError) throw new ReleaseError(e.code, `backup ${id}: ${e.code}`);
    throw e;
  }
}

type Node = { type: "dir" | "file" | "link"; mode: number; size: number; link?: string };

/** Every entry under `root` (lstat — links are not followed), keyed by relative path. */
function tree(root: string): Map<string, Node> {
  const out = new Map<string, Node>();
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    const mode = st.mode & 0o7777;
    if (st.isSymbolicLink()) out.set(rel, { type: "link", mode: 0, size: 0, link: fs.readlinkSync(abs) });
    else if (st.isDirectory()) {
      out.set(rel, { type: "dir", mode, size: 0 });
      for (const name of fs.readdirSync(abs)) walk(rel ? path.join(rel, name) : name);
    } else if (st.isFile()) out.set(rel, { type: "file", mode, size: st.size });
    else throw new ReleaseError("copy_unsupported", `unsupported file type in the data folder: ${rel}`);
  };
  walk("");
  return out;
}

export type MigrateResult = {
  from: string;
  to: string;
  files: number;
  bytes: number;
  sessionsInvalidated: number;
};

/**
 * The one-time move of the data folder (#143): copies `from` (left untouched) to the configured DATA_DIR, preserving
 * modes (`ditto` on macOS — also ACLs and groups, e.g. the python scratch folder; `cp -a` elsewhere). Refuses while a
 * server, restore or migration holds either folder's lock, when an interrupted restore is pending next to `from`, or
 * when DATA_DIR already has content. The copy is made next to DATA_DIR and renamed into place only once every entry
 * matches the original (type, mode, size, link target) and `PRAGMA integrity_check` passes.
 *
 * Runtime sessions are marked invalid in the copy (as a restore does): Claude keeps its transcripts under
 * `projects/<the absolute working folder>/`, and the working folder lives in DATA_DIR — after the move a resume would
 * look for a folder that no longer exists. The next turn of each conversation starts a fresh session from the
 * server's history (#45).
 */
export function migrateData(o: { from: string; to: string }): MigrateResult {
  if (!path.isAbsolute(o.from)) throw new ReleaseError("usage", "--from must be an absolute path");
  const st = fs.lstatSync(o.from, { throwIfNoEntry: false });
  if (!st?.isDirectory()) throw new ReleaseError("from_not_found", "--from is not a directory");
  const from = fs.realpathSync(o.from);
  const to = path.resolve(o.to);
  if (isInside(to, from) || isInside(from, to))
    throw new ReleaseError("target_unsafe", "DATA_DIR and --from must not contain each other");
  if (!fs.existsSync(storagePaths(from).db))
    throw new ReleaseError("from_not_found", "--from has no agentlee.db — not a data folder");
  // The copy's database is opened read-write (session invalidation): a link would be kept as a link and write
  // through to the original (#148 review). The database and its side files must be plain files.
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const f = lstatOrUndefined(storagePaths(from).db + suffix);
    if (f && !f.isFile())
      throw new ReleaseError(
        "db_not_plain",
        `agentlee.db${suffix} in --from is not a plain file (a link?) — nothing copied`,
      );
  }
  if (fs.existsSync(restoreJournalPath(from)))
    throw new ReleaseError(
      "restore_pending",
      "an interrupted restore is pending next to --from (docs/ops.md §21.4)",
    );
  const target = fs.lstatSync(to, { throwIfNoEntry: false });
  if (target && (!target.isDirectory() || target.isSymbolicLink() || fs.readdirSync(to).length > 0))
    throw new ReleaseError("target_exists", "DATA_DIR already exists and is not empty — nothing copied");

  // Both folders' locks for the whole copy (the same kernel lock the server takes): no server can start on either.
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  const locks: DataLock[] = [];
  try {
    for (const dir of [from, to]) locks.push(acquireDataLock(dir, "migrate"));
  } catch (e) {
    for (const l of locks) l.release();
    if (e instanceof DataLockHeld)
      throw new ReleaseError(
        "server_running",
        "a server (or restore) is still using the data folder — stop it first",
      );
    throw e;
  }
  try {
    return copyData(from, to, !!target);
  } finally {
    for (const l of locks) l.release();
  }
}

function copyData(from: string, to: string, targetExists: boolean): MigrateResult {
  const staging = path.join(
    path.dirname(to),
    `.${path.basename(to)}.migrating-${crypto.randomBytes(4).toString("hex")}`,
  );
  try {
    if (process.platform === "darwin") execFileSync("ditto", [from, staging], { stdio: "ignore" });
    else execFileSync("cp", ["-a", from, staging], { stdio: "ignore" });
    const a = tree(from);
    const b = tree(staging);
    let files = 0;
    let bytes = 0;
    for (const [rel, n] of a) {
      const m = b.get(rel);
      if (!m || m.type !== n.type || m.mode !== n.mode || m.size !== n.size || m.link !== n.link)
        throw new ReleaseError("copy_mismatch", `copy differs from the original: ${rel || "."}`);
      if (n.type === "file") {
        files++;
        bytes += n.size;
      }
    }
    if (b.size !== a.size) throw new ReleaseError("copy_mismatch", "copy has entries the original does not");

    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const f = lstatOrUndefined(storagePaths(staging).db + suffix);
      if (f && !f.isFile()) throw new ReleaseError("db_not_plain", "the copied database is not a plain file");
    }
    const db = new Database(storagePaths(staging).db, { fileMustExist: true });
    let sessionsInvalidated = 0;
    try {
      if (db.pragma("integrity_check", { simple: true }) !== "ok")
        throw new ReleaseError("db_corrupt", "integrity_check failed on the copied database");
      const hasSessions = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runtime_sessions'")
        .get();
      if (hasSessions)
        sessionsInvalidated = db
          .prepare("UPDATE runtime_sessions SET invalidated = 1 WHERE invalidated = 0")
          .run().changes;
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    if (targetExists) fs.rmdirSync(to);
    fs.renameSync(staging, to);
    return { from, to, files, bytes, sessionsInvalidated };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (e instanceof ReleaseError) throw e;
    throw new ReleaseError("copy_failed", "copying the data folder failed — nothing changed at DATA_DIR");
  }
}
