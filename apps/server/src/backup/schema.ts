import type Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { MIGRATIONS_DIR } from "../db/client.js";

/** One applied migration as drizzle records it (`__drizzle_migrations`): file hash and the journal's `when`. */
export type AppliedMigration = { hash: string; createdAt: number };

/** The schema version of a database: the migrations applied to it, oldest first. */
export function appliedMigrations(sqlite: Database.Database): AppliedMigration[] {
  const table = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  if (!table) return [];
  return (
    sqlite
      .prepare("SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at")
      .all() as {
      hash: string;
      createdAt: number | string;
    }[]
  ).map((r) => ({ hash: r.hash, createdAt: Number(r.createdAt) }));
}

/** The migrations this build of the server knows (`apps/server/drizzle`), oldest first. */
export function codeMigrations(folder = MIGRATIONS_DIR): AppliedMigration[] {
  return readMigrationFiles({ migrationsFolder: folder }).map((m) => ({
    hash: m.hash,
    createdAt: m.folderMillis,
  }));
}

export type SchemaCheck =
  | { ok: true; pending: number }
  /**
   * `schema_newer`: the backup was made by a newer server (a migration this build does not know) — update the code
   * first. `schema_mismatch`: same position, different migration file (another branch's database).
   */
  | { ok: false; code: "schema_newer" | "schema_mismatch" };

/**
 * Whether a database with `backup`'s migrations can be served by this build: its migrations must be exactly the
 * first ones of the code's list (same `when`, same file hash). An older backup is fine — the missing migrations are
 * applied on restore (`pending`). A newer or different one is refused: this server would misread its tables.
 */
export function checkSchema(backup: AppliedMigration[], code: AppliedMigration[]): SchemaCheck {
  if (backup.length > code.length) return { ok: false, code: "schema_newer" };
  for (const [i, m] of backup.entries()) {
    const c = code[i]!;
    if (m.createdAt > c.createdAt && !code.some((x) => x.createdAt === m.createdAt))
      return { ok: false, code: "schema_newer" };
    if (m.createdAt !== c.createdAt || m.hash !== c.hash) return { ok: false, code: "schema_mismatch" };
  }
  return { ok: true, pending: code.length - backup.length };
}
