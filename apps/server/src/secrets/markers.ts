import type { Db } from "../db/client.js";

/**
 * Persisted clean-up state in `settings` (review #111 rounds 3–5), shared by the one-time compaction (compact.ts) and
 * the background rescrub (rescrub.ts), so a restart resumes whatever was not finished.
 *
 * - `secrets.file_cleanup_pending` = `1`: rows were masked or removed, or the file was rewritten, and a
 *   `wal_checkpoint(TRUNCATE)` has not succeeded since — old values may still be in WAL frames or old pages.
 * - `storage.secure_delete_compacted`: the one-time `VACUUM` for space freed before `secure_delete`.
 *   - absent or `needed` — the `VACUUM` has to run (never ran, failed — e.g. no free space — or was interrupted);
 *   - `vacuumed` — it completed; its pages reach the file with the next successful TRUNCATE checkpoint;
 *   - `1` — done: it completed **and** a TRUNCATE checkpoint succeeded after it.
 */
export const CLEANUP_PENDING_KEY = "secrets.file_cleanup_pending";
export const COMPACTED_KEY = "storage.secure_delete_compacted";
export type CompactionState = "needed" | "vacuumed" | "done";

type Sql = Db["$client"];

export const readKey = (sql: Sql, key: string): string | undefined =>
  (sql.prepare("select value from settings where key = ?").get(key) as { value: string } | undefined)?.value;

export const setKey = (sql: Sql, key: string, value: string): void => {
  sql
    .prepare(
      "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
    )
    .run(key, value);
};

export const deleteKey = (sql: Sql, key: string): void => {
  sql.prepare("delete from settings where key = ?").run(key);
};

export function compactionState(sql: Sql): CompactionState {
  const v = readKey(sql, COMPACTED_KEY);
  return v === "1" ? "done" : v === "vacuumed" ? "vacuumed" : "needed";
}

/**
 * After a successful TRUNCATE checkpoint: a completed `VACUUM` (`vacuumed`) is now done. A `VACUUM` that is still
 * `needed` stays so — a checkpoint alone never finishes a compaction that did not run.
 */
export function compactionCheckpointed(sql: Sql): void {
  sql.prepare("update settings set value = '1' where key = ? and value = 'vacuumed'").run(COMPACTED_KEY);
}
