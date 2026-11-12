import type Database from "better-sqlite3";

/**
 * Every uploaded file the database references (#22), as a path relative to DATA_DIR — the backup's
 * `FILE_REFERENCES`: a snapshot whose row has no file fails the backup instead of saving a broken one.
 */
export function uploadedFileReferences(sqlite: Database.Database): string[] {
  // A database from before the table existed (an older backup's schema) references none.
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'").get()) return [];
  return (
    sqlite.prepare("SELECT id, user_id, conversation_id FROM files ORDER BY id").all() as {
      id: string;
      user_id: string;
      conversation_id: string;
    }[]
  ).map((f) => `files/${f.user_id}/${f.conversation_id}/${f.id}`);
}
