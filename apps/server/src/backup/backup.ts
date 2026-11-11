import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { decrypt, encrypt, SecretError } from "../crypto/secrets.js";
import { logEvent, type EventLogger } from "../logging.js";
import { DEFAULT_TIME_ZONE, minuteOfDay } from "../notifications/quiet.js";
import type { FileWriteLock } from "./lock.js";
import { appliedMigrations } from "./schema.js";

/**
 * Daily backups (#37, PRD FR-10.5 · NFR 백업). One folder per backup under BACKUP_DIR:
 *
 *   <BACKUP_DIR>/<YYYYMMDD-HHMMSSZ-xxxxxx>/
 *     manifest.json   format, time, schema version, SHA-256 of every file, the key check
 *     agentlee.db     the database, `VACUUM INTO` (one consistent snapshot, no free pages with deleted rows)
 *     files/ artifacts/ sources/   the data folder's file stores, copied while file writes wait (lock.ts)
 *
 * Never in a backup: the master key (it lives outside DATA_DIR — config.ts refuses otherwise — and nothing here
 * reads it), the runtime folders (`runtimes/`: CLI session caches, login folders that may hold a provider's tokens
 * file in clear while a login is under way, and the login quarantine), the server skill folder (`skills/`:
 * reinstalled from the allow-list with `pnpm skills:install`, which verifies every file), temp folders and
 * the data folder lock (outside DATA_DIR anyway). Credentials stay what they are in the database: AES-256-GCM ciphertext.
 */

export const BACKUP_CODES = [
  "backup_ok",
  "backup_running",
  "backup_unavailable",
  "backup_failed",
  "backup_disk_full",
] as const;
export type BackupCode = (typeof BACKUP_CODES)[number];

export const BACKUP_FORMAT = 1;
/** Kept for this long; the next prune (every backup attempt, and server start) deletes it — the newest one too. */
export const RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;
/** Every day at this local time (service time zone, Asia/Seoul) — the family is asleep. */
export const BACKUP_TIME = "03:30";
/** Folders of DATA_DIR copied besides the database. Every writer of files there goes through `FileWriteLock`. */
export const BACKUP_FILE_ROOTS = ["files", "artifacts", "sources"] as const;
export const DB_FILE = "agentlee.db";
export const MANIFEST_FILE = "manifest.json";

/** `20261111-033000Z-1a2b3c`: UTC time and a random suffix. Only names of this shape are ever listed or deleted. */
export const BACKUP_ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{6}$/;
const TMP_PREFIX = ".tmp-";

/** Encrypted with the master key: a restore proves it has the right key before touching anything. */
const KEY_CHECK_TEXT = "agentlee-backup-key-check-v1";
const KEY_CHECK_AAD = "backup:key-check";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const Manifest = z.object({
  format: z.literal(BACKUP_FORMAT),
  id: z.string().regex(BACKUP_ID),
  createdAt: z.number().int().nonnegative(),
  schema: z.object({
    migrations: z.number().int().nonnegative(),
    lastMigrationAt: z.number().int().nullable(),
  }),
  db: z.object({ file: z.literal(DB_FILE), bytes: z.number().int().nonnegative(), sha256: Sha256 }),
  files: z.array(
    z.object({ path: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: Sha256 }),
  ),
  /** Entries that were not regular files or folders (symlinks, sockets …) and were left out. */
  skipped: z.number().int().nonnegative(),
  keyCheck: z.string().startsWith("v1:"),
});
export type Manifest = z.infer<typeof Manifest>;

export type BackupInfo = {
  id: string;
  createdAt: number;
  /** Database plus files. */
  bytes: number;
  fileCount: number;
  migrations: number;
  /** False when the manifest is missing or unreadable (an interrupted copy, a damaged disk). */
  valid: boolean;
};

export class BackupError extends Error {
  constructor(readonly code: BackupCode) {
    super(code);
    this.name = "BackupError";
  }
}

export const keyCheck = (key: Buffer) => encrypt(KEY_CHECK_TEXT, key, KEY_CHECK_AAD);
/** True when `key` is the key the backup was made with. */
export function keyMatches(manifest: Pick<Manifest, "keyCheck">, key: Buffer): boolean {
  try {
    return decrypt(manifest.keyCheck, key, KEY_CHECK_AAD) === KEY_CHECK_TEXT;
  } catch (e) {
    if (e instanceof SecretError) return false;
    throw e;
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function backupId(at: number): string {
  const d = new Date(at);
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return `${date}-${time}Z-${crypto.randomBytes(3).toString("hex")}`;
}
function idTime(id: string): number {
  const m = BACKUP_ID.exec(id)!;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}

export function sha256File(file: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** The backup folder: created owner-only, never a symlink, permissions tightened if loose. */
export function ensureBackupDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new BackupError("backup_failed");
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/**
 * Files the database points at, by store (relative POSIX paths under DATA_DIR, e.g. `files/<user>/<conv>/<name>`).
 * Empty today — no table references a file yet (attachments, artifacts and sources live in the database). A new file
 * store adds its query here: the backup then refuses to finish when one of these files is missing.
 */
export const FILE_REFERENCES: ((db: Database.Database) => string[])[] = [];

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Copies the file stores under the lock. Returns the copied files (relative POSIX paths) and the skipped count.
 * Only one thing may be absent: a file that vanished during the walk (ENOENT) and that the snapshot does not
 * reference — deleted after the snapshot. Any other error (EIO, EACCES …) fails the whole backup.
 */
async function copyFileRoots(
  dataDir: string,
  out: string,
  referenced: ReadonlySet<string>,
  beforeCopy?: (rel: string) => Promise<void>,
): Promise<{ files: string[]; skipped: number }> {
  const files: string[] = [];
  let skipped = 0;
  const needed = (rel: string) => [...referenced].some((r) => r === rel || r.startsWith(`${rel}/`));
  const walk = async (rel: string) => {
    const src = path.join(dataDir, rel);
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(src);
    } catch (e) {
      if (isMissing(e) && !needed(rel)) return;
      throw e;
    }
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = await fs.promises.readdir(src);
      } catch (e) {
        if (isMissing(e) && !needed(rel)) return;
        throw e;
      }
      await fs.promises.mkdir(path.join(out, rel), { mode: 0o700 });
      for (const name of names.sort()) await walk(path.posix.join(rel, name));
    } else if (st.isFile()) {
      const dest = path.join(out, rel);
      await beforeCopy?.(rel);
      try {
        // APFS clone when possible (instant, no extra space until either side changes), else a plain copy.
        await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_FICLONE);
      } catch (e) {
        if (isMissing(e) && !needed(rel)) return;
        throw e;
      }
      await fs.promises.chmod(dest, 0o600);
      files.push(rel);
    } else skipped++;
  };
  for (const root of BACKUP_FILE_ROOTS) await walk(root);
  const copied = new Set(files);
  for (const r of referenced) if (!copied.has(r)) throw new BackupError("backup_failed");
  return { files, skipped };
}

export type CreateBackupOptions = {
  sqlite: Database.Database;
  dataDir: string;
  backupDir: string;
  masterKey: Buffer;
  lock: FileWriteLock;
  now: () => number;
  /** Tests: runs between the database snapshot and the file copy, with the lock held. */
  afterDbSnapshot?: () => Promise<void>;
  /** Tests: runs before each file is copied. */
  beforeCopy?: (rel: string) => Promise<void>;
  /** Files the snapshot references (default `FILE_REFERENCES`). */
  referencedFiles?: (db: Database.Database) => string[];
};

/** Makes one backup. Visible under its id only once complete (written as `.tmp-…`, then renamed). */
export async function createBackup(o: CreateBackupOptions): Promise<BackupInfo> {
  ensureBackupDir(o.backupDir);
  // Left by a backup that died half-way (crash, full disk): never listed, removed before a new one starts.
  for (const name of fs.readdirSync(o.backupDir))
    if (name.startsWith(TMP_PREFIX))
      fs.rmSync(path.join(o.backupDir, name), { recursive: true, force: true });
  const createdAt = o.now();
  const id = backupId(createdAt);
  const tmp = path.join(o.backupDir, `${TMP_PREFIX}${id}`);
  fs.mkdirSync(tmp, { mode: 0o700 });
  try {
    const dbFile = path.join(tmp, DB_FILE);
    const copied = await o.lock.exclusive(async () => {
      // One statement, one read transaction: the snapshot is the database at a single point in time whatever
      // other connections write meanwhile. It is a fresh file — deleted rows are not left behind in free pages.
      o.sqlite.prepare("VACUUM INTO ?").run(dbFile);
      // Same moment as the snapshot: nothing in this process runs between the two statements, and no other
      // process writes the database while the server holds the data folder's lock.
      const referenced = new Set(
        o.referencedFiles ? o.referencedFiles(o.sqlite) : FILE_REFERENCES.flatMap((q) => q(o.sqlite)),
      );
      await o.afterDbSnapshot?.();
      return copyFileRoots(o.dataDir, tmp, referenced, o.beforeCopy);
    });
    // A standalone file: rollback journal, so a later read-only open needs no -wal/-shm next to it.
    const snap = new Database(dbFile);
    let migrations;
    try {
      snap.pragma("journal_mode = DELETE");
      migrations = appliedMigrations(snap);
    } finally {
      snap.close();
    }
    fs.chmodSync(dbFile, 0o600);
    const files = copied.files.map((rel) => {
      const abs = path.join(tmp, rel);
      return { path: rel, bytes: fs.statSync(abs).size, sha256: sha256File(abs) };
    });
    const manifest: Manifest = {
      format: BACKUP_FORMAT,
      id,
      createdAt,
      schema: { migrations: migrations.length, lastMigrationAt: migrations.at(-1)?.createdAt ?? null },
      db: { file: DB_FILE, bytes: fs.statSync(dbFile).size, sha256: sha256File(dbFile) },
      files,
      skipped: copied.skipped,
      keyCheck: keyCheck(o.masterKey),
    };
    fs.writeFileSync(path.join(tmp, MANIFEST_FILE), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(tmp, path.join(o.backupDir, id));
    return info(manifest);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (e instanceof BackupError) throw e;
    throw new BackupError(
      (e as NodeJS.ErrnoException).code === "ENOSPC" ? "backup_disk_full" : "backup_failed",
    );
  }
}

const info = (m: Manifest): BackupInfo => ({
  id: m.id,
  createdAt: m.createdAt,
  bytes: m.db.bytes + m.files.reduce((n, f) => n + f.bytes, 0),
  fileCount: m.files.length,
  migrations: m.schema.migrations,
  valid: true,
});

/**
 * Reads and checks a backup's manifest (size-limited); undefined when missing or invalid. `expectId`: the folder
 * name must match (the list; a restore also takes a copy under another name, e.g. on an external disk).
 */
export function readManifest(dir: string, expectId?: string): Manifest | undefined {
  try {
    const file = path.join(dir, MANIFEST_FILE);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 16 * 1024 * 1024) return undefined;
    const parsed = Manifest.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed.success && (expectId === undefined || parsed.data.id === expectId)
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}

/** Backups in the folder, newest first. Only folders named like a backup id count. */
export function listBackups(backupDir: string): BackupInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(backupDir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const id of names) {
    if (!BACKUP_ID.test(id)) continue;
    const dir = path.join(backupDir, id);
    if (!fs.lstatSync(dir).isDirectory()) continue;
    const m = readManifest(dir, id);
    out.push(
      m ? info(m) : { id, createdAt: idTime(id), bytes: 0, fileCount: 0, migrations: 0, valid: false },
    );
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

/**
 * Retention: every backup made `RETENTION_DAYS` or more ago is deleted — the newest one too. Deleted data must
 * leave the backups within the window even when new backups keep failing (then none may remain: the admins are
 * notified of every failure, and loudly when no backup is left). Returns how many were deleted.
 */
export function pruneBackups(backupDir: string, now: number, days = RETENTION_DAYS): number {
  let deleted = 0;
  for (const b of listBackups(backupDir)) {
    if (now - b.createdAt < days * DAY_MS) continue;
    fs.rmSync(path.join(backupDir, b.id), { recursive: true, force: true });
    deleted++;
  }
  return deleted;
}

/** The next time after `now` whose wall-clock time in `timeZone` is `hhmm` (minute precision). */
export function nextRunAt(now: number, timeZone = DEFAULT_TIME_ZONE, hhmm = BACKUP_TIME): number {
  const target = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const minuteStart = now - (now % 60_000);
  let delta = (target - minuteOfDay(now, timeZone) + 1440) % 1440;
  if (delta === 0) delta = 1440;
  return minuteStart + delta * 60_000;
}

export type BackupStatus = {
  running: boolean;
  nextRunAt: number | null;
  last: { at: number; code: BackupCode } | null;
};

export type BackupServiceOptions = {
  now?: () => number;
  timeZone?: string;
  /** A missed backup (server off at 03:30) runs this long after start when the newest one is a day old. */
  catchUpMs?: number;
  afterDbSnapshot?: () => Promise<void>;
  beforeCopy?: (rel: string) => Promise<void>;
  referencedFiles?: (db: Database.Database) => string[];
};

/** Admin notification texts (system_warning) — fixed, codes only. */
export const BACKUP_FAILED_MESSAGE = (code: BackupCode) =>
  `백업에 실패했어요 (${code}) — 관리자 → 백업에서 디스크와 백업 폴더를 확인하세요.`;
export const NO_BACKUPS_MESSAGE =
  "백업이 하나도 남지 않았어요 — 7일 넘게 실패해 모두 만료됐어요. 지금 디스크와 BACKUP_DIR을 확인하세요.";

/** Backup runs (scheduled and "지금 백업"), one at a time, plus retention. */
export class BackupService {
  private running: Promise<unknown> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private next: number | undefined;
  private stopped = false;
  private last: BackupStatus["last"] = null;
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      sqlite: Database.Database;
      dataDir: string;
      backupDir: string;
      masterKey: Buffer;
      lock: FileWriteLock;
      log?: EventLogger;
      /** Tells every active admin (system_warning). */
      notifyAdmins?: (message: string) => void;
    },
    private readonly opts: BackupServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  list(): BackupInfo[] {
    return listBackups(this.deps.backupDir);
  }

  status(): BackupStatus {
    return { running: this.running !== undefined, nextRunAt: this.next ?? null, last: this.last };
  }

  async run(
    trigger: "scheduled" | "manual",
  ): Promise<{ ok: true; item: BackupInfo } | { ok: false; code: BackupCode }> {
    if (this.stopped) return { ok: false, code: "backup_unavailable" };
    if (this.running) return { ok: false, code: "backup_running" };
    const started = this.now();
    const work = (async () => {
      try {
        const item = await createBackup({
          ...this.deps,
          now: this.now,
          ...(this.opts.afterDbSnapshot ? { afterDbSnapshot: this.opts.afterDbSnapshot } : {}),
          ...(this.opts.beforeCopy ? { beforeCopy: this.opts.beforeCopy } : {}),
          ...(this.opts.referencedFiles ? { referencedFiles: this.opts.referencedFiles } : {}),
        });
        return { ok: true as const, item };
      } catch (e) {
        return { ok: false as const, code: e instanceof BackupError ? e.code : ("backup_failed" as const) };
      } finally {
        // Whatever the outcome: expiry never waits for a successful backup.
        this.prune();
      }
    })();
    this.running = work;
    try {
      const r = await work;
      const code: BackupCode = r.ok ? "backup_ok" : r.code;
      this.last = { at: this.now(), code };
      logEvent(this.deps.log, r.ok ? "info" : "error", "backup.finished", {
        backupTrigger: trigger,
        backupCode: code,
        durationMs: this.now() - started,
        ...(r.ok ? { count: r.item.fileCount } : {}),
      });
      if (!r.ok) this.warnAdmins(r.code);
      return r;
    } finally {
      this.running = undefined;
    }
  }

  /** Deletes expired backups (after every run and at start). Never throws. */
  prune(): void {
    try {
      const pruned = pruneBackups(this.deps.backupDir, this.now());
      if (pruned) logEvent(this.deps.log, "info", "backup.pruned", { count: pruned });
    } catch (e) {
      logEvent(this.deps.log, "error", "backup.pruned", { err: e });
    }
  }

  private warnAdmins(code: BackupCode): void {
    try {
      this.deps.notifyAdmins?.(BACKUP_FAILED_MESSAGE(code));
      if (!this.list().some((b) => b.valid)) this.deps.notifyAdmins?.(NO_BACKUPS_MESSAGE);
    } catch {
      // a notification never breaks the backup service
    }
  }

  /** Schedules the daily backup (and a catch-up when the newest backup is more than a day old). */
  start(): void {
    if (this.stopped) return;
    // A server that was off for a while: expired backups go now, not after the next backup.
    this.prune();
    const now = this.now();
    let at = nextRunAt(now, this.opts.timeZone);
    const newest = this.list().find((b) => b.valid);
    const catchUp = now + (this.opts.catchUpMs ?? 10 * 60_000);
    if ((!newest || now - newest.createdAt > DAY_MS) && catchUp < at) at = catchUp;
    this.schedule(at);
  }

  private schedule(at: number): void {
    clearTimeout(this.timer);
    this.next = at;
    this.timer = setTimeout(
      () => {
        // Woken early (a long timer drifting): wait for the rest.
        if (this.now() < at - 1000) return this.schedule(at);
        void this.run("scheduled").finally(() => {
          if (!this.stopped) this.schedule(nextRunAt(this.now(), this.opts.timeZone));
        });
      },
      Math.max(0, at - this.now()),
    );
    this.timer.unref();
  }

  /** No new backup after this; waits for one in progress (server shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.next = undefined;
    await this.running?.catch(() => undefined);
  }
}
