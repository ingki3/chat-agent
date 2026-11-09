import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

/** Migrations live in apps/server/drizzle (resolved from src/ or dist/). */
export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** Opens SQLite with the pragmas the service relies on. Pass ":memory:" for tests. */
export function openDb(file: string): Db {
  const sqlite = new Database(file);
  if (file !== ":memory:") sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  return drizzle(sqlite, { schema }) as Db;
}

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

/** In-memory database with all migrations applied — for tests. */
export function createTestDb(): Db {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}
