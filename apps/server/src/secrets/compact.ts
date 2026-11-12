import type { Db } from "../db/client.js";
import { logEvent, type EventLogger } from "../logging.js";
import {
  CLEANUP_PENDING_KEY,
  COMPACTED_KEY,
  compactionCheckpointed,
  compactionState,
  deleteKey,
  setKey,
} from "./markers.js";

export { COMPACTED_KEY };

/**
 * One-time compaction for `secure_delete` (review #111 rounds 3–5). Since that release every write zeroes the space
 * it frees (db/client.ts). Free space left by writes from before — an old, longer title that was shortened or masked,
 * a deleted row — can still hold old bytes in the file. A `VACUUM` rewrites the file from its live rows only, with no
 * free pages and no freed cell space. The file is also switched to `auto_vacuum = INCREMENTAL`, so the rescrub can
 * hand freed pages back cheaply afterwards (`PRAGMA incremental_vacuum`) without another full `VACUUM`.
 *
 * First tried at start-up, before the server serves anything or a backup can start (index.ts holds the data folder
 * lock across `buildApp`; backups run later, on the same connection, so the two never overlap). Its state is durable
 * (markers.ts): `needed` until a `VACUUM` completes (`vacuumed`), done (`1`) only after a TRUNCATE checkpoint
 * succeeds after that. When the `VACUUM` fails — most likely no free space (it can need about twice the file) — the
 * server still starts, the state stays `needed`, and the running server's rescrub loop tries again with backoff
 * (rescrub.ts); `idle()` waits for it. When the checkpoint is blocked, the same loop finishes it.
 */
export type CompactResult = "skipped" | "done" | "pending" | "failed";

/**
 * Runs the `VACUUM` if the compaction is still `needed`. The state is `needed` (with the clean-up marker) before, and
 * `vacuumed` after it completes; on failure it stays `needed` and the failure is logged (`storage.compact_failed`, the
 * error class only). Never throws.
 */
export function runVacuum(db: Db, log?: EventLogger): "vacuumed" | "failed" {
  const sql = db.$client;
  try {
    sql.pragma("secure_delete = ON");
    sql.transaction(() => {
      setKey(sql, COMPACTED_KEY, "needed");
      setKey(sql, CLEANUP_PENDING_KEY, "1");
    })();
    // Takes effect with the VACUUM below (it cannot change on its own once tables exist).
    sql.pragma("auto_vacuum = INCREMENTAL");
    sql.exec("VACUUM");
    setKey(sql, COMPACTED_KEY, "vacuumed");
    return "vacuumed";
  } catch (e) {
    logEvent(log, "warn", "storage.compact_failed", { err: e });
    return "failed";
  }
}

/** A TRUNCATE checkpoint that never waits (a reader on an old snapshot makes it busy). True when it succeeded. */
export function truncateCheckpoint(db: Db): boolean {
  const sql = db.$client;
  const timeout = sql.pragma("busy_timeout", { simple: true }) as number;
  sql.pragma("busy_timeout = 0");
  try {
    return !(sql.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[])[0]?.busy;
  } catch {
    return false;
  } finally {
    sql.pragma(`busy_timeout = ${Number(timeout) || 0}`);
  }
}

/** The start-up attempt: the `VACUUM` if needed, then the checkpoint. Never throws. */
export function compactOnce(db: Db, log?: EventLogger, now: () => number = Date.now): CompactResult {
  const sql = db.$client;
  const state = compactionState(sql);
  if (state === "done") return "skipped";
  const t0 = now();
  if (state === "needed" && runVacuum(db, log) === "failed") return "failed";
  if (!truncateCheckpoint(db)) {
    logEvent(log, "info", "storage.compacted", { durationMs: now() - t0, status: "running" });
    return "pending";
  }
  sql.transaction(() => {
    compactionCheckpointed(sql);
    deleteKey(sql, CLEANUP_PENDING_KEY);
  })();
  logEvent(log, "info", "storage.compacted", { durationMs: now() - t0, status: "done" });
  return "done";
}
