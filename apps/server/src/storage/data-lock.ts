import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { processIdentity } from "./process-identity.js";

/**
 * The data folder's cross-process lock (#37). One holder at a time: the server for its whole life (taken before the
 * database is opened), `pnpm restore` while it replaces the folder, `pnpm db:migrate`. A second server refuses to
 * start; a restore refuses while a server holds it.
 *
 * The lock is a file next to the data folder — `<parent>/.<name>.lock` — not inside it, so it stays put while a
 * restore swaps the folder. It is created with `O_EXCL` (`wx`) and holds the holder's pid and its start time as `ps`
 * reports it. It is stale when that pid is gone or now belongs to another process (a different start time); a
 * stale lock is moved away and the creation retried. Node has no `flock` without a native module; this is the
 * dependency-free equivalent, and every holder releases it on exit.
 */
export type DataLockKind = "server" | "restore" | "migrate";
type Record_ = { pid: number; lstart: string; kind: DataLockKind; at: number };

export class DataLockHeld extends Error {
  constructor(readonly holder: DataLockKind) {
    super(`data folder is in use (${holder})`);
    this.name = "DataLockHeld";
  }
}

export function dataLockPath(dataDir: string): string {
  const abs = path.resolve(dataDir);
  return path.join(path.dirname(abs), `.${path.basename(abs)}.lock`);
}

function readRecord(file: string): Record_ | undefined {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Record_>;
    if (!Number.isInteger(r.pid) || typeof r.lstart !== "string" || typeof r.kind !== "string")
      return undefined;
    return r as Record_;
  } catch {
    return undefined;
  }
}

/** Whether the process that wrote `r` is still that process. */
function alive(r: Record_): boolean {
  if (r.pid <= 0) return false;
  try {
    process.kill(r.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  const id = processIdentity(r.pid);
  // Alive but `ps` could not tell who it is: treat as held (never steal a lock that may be live).
  return id ? id.lstart === r.lstart : true;
}

/** The holder of the lock, when it is held by a live process. */
export function dataLockHolder(dataDir: string): DataLockKind | undefined {
  const r = readRecord(dataLockPath(dataDir));
  return r && alive(r) ? r.kind : undefined;
}

export type DataLock = { release: () => void };

/** Takes the lock or throws `DataLockHeld`. */
export function acquireDataLock(dataDir: string, kind: DataLockKind): DataLock {
  const file = dataLockPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const me = processIdentity(process.pid);
  if (!me) throw new Error("data lock: cannot identify this process");
  const record: Record_ = { pid: process.pid, lstart: me.lstart, kind, at: Date.now() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(record));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          const now = readRecord(file);
          if (now?.pid === record.pid && now.lstart === record.lstart) fs.rmSync(file, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const held = readRecord(file);
    if (held && alive(held)) throw new DataLockHeld(held.kind);
    // Stale (or half-written by a holder that died at once): move it away, then make sure what was moved is the
    // stale one — another process may have replaced it meanwhile, and that one is put back.
    const aside = `${file}.stale-${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.renameSync(file, aside);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    const moved = readRecord(aside);
    if (moved && alive(moved)) {
      // Put the live holder's record back, unless yet another one exists by now (held either way).
      try {
        fs.writeFileSync(file, JSON.stringify(moved), { mode: 0o600, flag: "wx" });
      } catch {
        // someone else holds it now
      }
      fs.rmSync(aside, { force: true });
      throw new DataLockHeld(moved.kind);
    }
    fs.rmSync(aside, { force: true });
  }
  throw new DataLockHeld(readRecord(file)?.kind ?? "server");
}
