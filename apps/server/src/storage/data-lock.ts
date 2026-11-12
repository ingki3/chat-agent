import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { canonicalPath } from "../fs-safety.js";

/**
 * The data folder's cross-process lock (#37). One holder at a time: the server for its whole life (taken before the
 * database is opened), `pnpm restore` while it replaces the folder, `pnpm db:migrate`. A second server refuses to
 * start; a restore refuses while a server holds it.
 *
 * It is a kernel lock: a small SQLite database next to the data folder (`<parent>/.<name>.lock.db`, outside the
 * folder so a restore's swap leaves it alone) opened with `locking_mode = EXCLUSIVE` and an exclusive transaction.
 * SQLite takes a POSIX `fcntl` lock on the file and keeps it while the connection is open; the system drops it when
 * the process dies (kill -9 included). So there is no stale-lock logic and no window between "check" and "take": a
 * second opener simply gets SQLITE_BUSY (busy timeout 0). The holder's pid and role are written to a side file only
 * for the refusal message — never to decide anything.
 *
 * The folder is named by its real path (symlinks resolved): `alias → data` and `data` share one lock.
 */
export type DataLockKind = "server" | "restore" | "migrate";

export class DataLockHeld extends Error {
  constructor(readonly holder: DataLockKind | "unknown") {
    super(`data folder is in use (${holder})`);
    this.name = "DataLockHeld";
  }
}

/** The data folder's real path (symlinks of it and of its parents resolved; a missing tail kept as written). */
export function realDataDir(dataDir: string): string {
  // readlink semantics, not realpath: a restore interrupted mid-swap leaves a symlinked DATA_DIR dangling (its
  // target was moved aside), and realpath/exists would then name the link itself — another lock, another
  // journal. Each hop: the parent made canonical, then the last component followed if it is a link.
  let p = path.resolve(dataDir);
  for (let hops = 0; ; hops++) {
    if (hops > MAX_LINK_HOPS)
      throw new Error(`DATA_DIR ${dataDir} is a symlink loop (or more than ${MAX_LINK_HOPS} links deep)`);
    p = path.join(canonicalPath(path.dirname(p)), path.basename(p));
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    // An existing last component takes its on-disk name (`Data` typed, `data` on a case-insensitive volume).
    if (st) p = path.join(path.dirname(p), onDiskName(path.dirname(p), path.basename(p)));
    if (!st?.isSymbolicLink()) return p;
    p = path.resolve(path.dirname(p), fs.readlinkSync(p));
  }
}
const MAX_LINK_HOPS = 32;

/** The entry of `dir` that `name` refers to, spelled as on disk. */
function onDiskName(dir: string, name: string): string {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return name;
  }
  if (names.includes(name) || !caseInsensitive(dir)) return name;
  const lower = name.toLowerCase();
  return names.find((n) => n.toLowerCase() === lower) ?? name;
}

const caseCache = new Map<string, boolean>();
const swapCase = (s: string) =>
  [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");

/**
 * Whether names in the existing folder `dir` are compared case-insensitively (macOS APFS default). Probed once
 * per folder: the folder itself under its case-swapped name, or — when its name has no letters — a probe file.
 */
export function caseInsensitive(dir: string): boolean {
  const cached = caseCache.get(dir);
  if (cached !== undefined) return cached;
  let result: boolean;
  try {
    const base = path.basename(dir);
    const parent = path.dirname(dir);
    const st = fs.statSync(dir);
    if (parent !== dir && swapCase(base) !== base) {
      const other = fs.statSync(path.join(parent, swapCase(base)), { throwIfNoEntry: false });
      result = !!other && other.dev === st.dev && other.ino === st.ino;
    } else {
      const probe = path.join(dir, `.agentlee-case-probe-${process.pid}-${Date.now()}`);
      fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
      try {
        result = fs.existsSync(path.join(dir, swapCase(path.basename(probe))));
      } finally {
        fs.rmSync(probe, { force: true });
      }
    }
  } catch {
    result = false;
  }
  caseCache.set(dir, result);
  return result;
}

/**
 * Whether two real data-folder paths (from `realDataDir`) name the same folder, even when it is missing right now:
 * the same canonical parent, and the same last component — case-insensitively on a case-insensitive volume.
 */
export function sameDataDir(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = canonicalPath(path.dirname(a));
  if (pa !== canonicalPath(path.dirname(b))) return false;
  const [na, nb] = [path.basename(a), path.basename(b)];
  return na === nb || (caseInsensitive(pa) && na.toLowerCase() === nb.toLowerCase());
}

function lockBase(dataDir: string): string {
  const real = realDataDir(dataDir);
  return path.join(path.dirname(real), `.${path.basename(real)}.lock`);
}
export const dataLockPath = (dataDir: string) => `${lockBase(dataDir)}.db`;
const infoPath = (dataDir: string) => `${lockBase(dataDir)}.info`;

/** Opens the lock file without following a symlink, creating it owner-only. */
function lockFile(file: string): void {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (st && (st.isSymbolicLink() || !st.isFile()))
    throw new Error(`data lock ${file} must be a regular file`);
  if (!st) {
    try {
      fs.closeSync(
        fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  if ((fs.lstatSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
}

const isBusy = (e: unknown) =>
  typeof (e as { code?: unknown }).code === "string" &&
  /^SQLITE_(BUSY|LOCKED)/.test((e as { code: string }).code);

function holderKind(dataDir: string): DataLockKind | "unknown" {
  try {
    const k = (JSON.parse(fs.readFileSync(infoPath(dataDir), "utf8")) as { kind?: unknown }).kind;
    return k === "server" || k === "restore" || k === "migrate" ? k : "unknown";
  } catch {
    return "unknown";
  }
}

export type DataLock = {
  release: () => void;
  /** Whether this process still holds it (false after `release()`): what the schedule engine checks (#33). */
  held: () => boolean;
};

/**
 * Open lock connections. Kept here so a holder that drops its `DataLock` cannot lose the lock to garbage collection
 * (a collected connection is closed, and closing drops the fcntl lock).
 */
const held = new Set<Database.Database>();

/** Takes the lock or throws `DataLockHeld`. Held until `release()` or the end of the process. */
export function acquireDataLock(dataDir: string, kind: DataLockKind): DataLock {
  const file = dataLockPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  lockFile(file);
  const db = new Database(file, { timeout: 0 });
  try {
    db.pragma("locking_mode = EXCLUSIVE");
    db.pragma("journal_mode = DELETE");
    // The first write takes the EXCLUSIVE lock; in exclusive locking mode it is kept after COMMIT until close.
    db.exec("BEGIN EXCLUSIVE");
    db.exec("CREATE TABLE IF NOT EXISTS holder (kind TEXT, pid INTEGER, at INTEGER)");
    db.prepare("DELETE FROM holder").run();
    db.prepare("INSERT INTO holder VALUES (?, ?, ?)").run(kind, process.pid, Date.now());
    db.exec("COMMIT");
  } catch (e) {
    db.close();
    if (isBusy(e)) throw new DataLockHeld(holderKind(dataDir));
    throw e;
  }
  // For messages only (another process cannot read the locked database).
  try {
    fs.writeFileSync(infoPath(dataDir), JSON.stringify({ kind, pid: process.pid }), { mode: 0o600 });
  } catch {
    // informational
  }
  held.add(db);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      held.delete(db);
      db.close();
    },
    held: () => !released && db.open,
  };
}

/** Who holds the lock right now (undefined = nobody): tries to take it and gives it back at once. */
export function dataLockHolder(dataDir: string): DataLockKind | "unknown" | undefined {
  try {
    acquireDataLock(dataDir, "restore").release();
    return undefined;
  } catch (e) {
    if (e instanceof DataLockHeld) return e.holder;
    throw e;
  }
}
