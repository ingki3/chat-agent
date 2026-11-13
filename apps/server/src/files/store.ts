import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { FILE_KINDS, FILE_LIMITS, type FileKind, type UploadedFile } from "@agentlee/shared";
import type { FileWriteLock } from "../backup/lock.js";
import type { ConversationStore } from "../conversations/store.js";
import type { Db } from "../db/client.js";
import { files } from "../db/schema.js";
import { scrubKnown } from "../secrets/known.js";
import { storagePaths, type StoragePaths } from "../storage/paths.js";

export type FileRow = typeof files.$inferSelect;

/** Server-generated file ids (crypto.randomUUID) — the only names the store ever gives a file on disk. */
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_DIR = /^[A-Za-z0-9_-]{1,128}$/;

/** The store's folder for this conversation is a link or not a folder: nothing is written there. */
export class StoreLinkError extends Error {
  constructor() {
    super("store_link");
    this.name = "StoreLinkError";
  }
}

/** The uploader cancelled this upload (`DELETE /api/uploads/:uploadId`) before it was stored: nothing is kept. */
export class UploadCancelledError extends Error {
  constructor() {
    super("upload_cancelled");
    this.name = "UploadCancelledError";
  }
}

/** How long a cancel is remembered for an upload that has not arrived (longer than any upload can take). */
export const CANCEL_TTL_MS = 6 * 3600_000;
/** Unresolved cancels (no upload came yet) one user may have at a time (review #102 7차). */
export const MAX_PENDING_CANCELS = 100;
/**
 * Every statement on `upload_cancellations` (review #102 7차): keyed by the primary key `(user_id, upload_id)`, a
 * user's count by its prefix, expiry by the `created_at` index — never a scan (a test checks the query plans).
 */
export const CANCEL_SQL = {
  find: "SELECT 1 FROM upload_cancellations WHERE user_id = ? AND upload_id = ? AND created_at >= ?",
  count: "SELECT count(*) AS n FROM upload_cancellations WHERE user_id = ? AND created_at >= ?",
  insert: "INSERT OR REPLACE INTO upload_cancellations (user_id, upload_id, created_at) VALUES (?, ?, ?)",
  drop: "DELETE FROM upload_cancellations WHERE user_id = ? AND upload_id = ?",
  expire: "DELETE FROM upload_cancellations WHERE created_at < ?",
} as const;
/** Client upload ids: UUIDs (any version), lower case. */
export const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class FileLimitError extends Error {
  constructor() {
    super("too_many_files");
    this.name = "FileLimitError";
  }
}
/** `fileIds` of a new message that are not this conversation's unsent files. */
export class AttachmentError extends Error {
  constructor() {
    super("invalid_attachment");
    this.name = "AttachmentError";
  }
}

/**
 * The one file rule of a run (#48 file tools, #45/#106 context): a file is the run's when it went with a message
 * that is still active (`isActive`: the conversation's active messages — the turn's input included). Unsent
 * composer files are not.
 */
export function sentWithActive(
  f: { messageId: string | null },
  isActive: (messageId: string) => boolean,
): boolean {
  return f.messageId !== null && isActive(f.messageId);
}

export function toUploadedFile(f: FileRow): UploadedFile {
  return {
    id: f.id,
    conversationId: f.conversationId,
    messageId: f.messageId ?? null,
    uploadId: f.uploadId ?? null,
    // Stored scrubbed; scrubbed again for secrets registered since (round 25).
    name: scrubKnown(f.name),
    kind: f.kind,
    mediaType: f.mediaType,
    bytes: f.bytes,
    createdAt: f.createdAt,
  };
}

/**
 * The name shown for a file: the last path segment, NFC, without control or bidi-override characters, cut to
 * `FILE_LIMITS.nameChars` code points (keeping the extension). Never used in a path.
 */
export function cleanName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex -- control and bidi-override characters are not part of a name
    .replace(/[\0-\x1f\x7f-\x9f‎‏‪-‮⁦-⁩]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
    .trim();
  const chars = Array.from(base);
  if (chars.length <= FILE_LIMITS.nameChars) return base;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? Array.from(base.slice(dot)).slice(0, 12).join("") : "";
  return chars.slice(0, FILE_LIMITS.nameChars - Array.from(ext).length).join("") + ext;
}

export type FileStoreOptions = {
  now?: () => number;
  /** Tests: runs once the upload is checked, right before its row and file are committed. */
  beforeCommit?: () => Promise<void>;
};

/**
 * Uploaded files (#22): rows in `files`, bytes at `files/<user>/<conversation>/<file id>` under DATA_DIR. Every
 * change to the folder happens inside `lock.write()` (the backup's file-write lock, #37) together with its row, and
 * synchronously — so no other change in this process runs in between, and a backup sees both halves or neither.
 *
 * Order of an add: the checked file is renamed into place, then the row is inserted *only if* the conversation has
 * fewer than `FILE_LIMITS.perConversation` files (one statement — the count check cannot be raced); if it has not,
 * the file is unlinked again. A crash between the two leaves a file without a row, which `sweep()` removes at the
 * next start — never a row without its file (that would fail every backup, `FILE_REFERENCES`).
 */
export class FileStore {
  readonly paths: StoragePaths;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    dataDir: string,
    private readonly lock: FileWriteLock,
    conversations: ConversationStore,
    private readonly opts: FileStoreOptions = {},
  ) {
    this.paths = storagePaths(dataDir);
    this.now = opts.now ?? Date.now;
    // A deleted conversation's files go right after its rows (the route holds the lock around both).
    conversations.onDeleted((c) => this.removeConversationFolder(c.ownerId, c.id));
  }

  get(id: string): FileRow | undefined {
    return this.db.select().from(files).where(eq(files.id, id)).get();
  }

  /**
   * The verified citations of a file in its conversation (#24, the viewer's "is this range a checked passage"):
   * id, the stored quote and locator JSON. Never served — the viewer only compares against them.
   */
  verifiedCitations(
    conversationId: string,
    fileId: string,
  ): { id: string; quote: string; locator: string }[] {
    return this.db.$client
      .prepare(
        `SELECT id, quote, locator FROM citations
         WHERE conversation_id = ? AND file_id = ? AND status = 'verified' AND quote IS NOT NULL AND locator IS NOT NULL`,
      )
      .all(conversationId, fileId) as { id: string; quote: string; locator: string }[];
  }

  list(conversationId: string): FileRow[] {
    return this.db
      .select()
      .from(files)
      .where(eq(files.conversationId, conversationId))
      .orderBy(asc(files.createdAt), asc(files.id))
      .all();
  }

  /**
   * Whether the file went with a message that is still part of the conversation (`messages.active` — not cut off
   * by an edit or a regeneration; #48 file tools, #106 context: "files of active messages + the current input").
   * Unsent composer files are not.
   */
  isActiveAttachment(f: Pick<FileRow, "messageId" | "conversationId">): boolean {
    const active = (id: string) =>
      !!this.db.$client
        .prepare("SELECT 1 FROM messages WHERE id = ? AND conversation_id = ? AND active = 1")
        .get(id, f.conversationId);
    return sentWithActive(f, active);
  }

  count(conversationId: string): number {
    return (
      this.db.$client
        .prepare("SELECT count(*) AS n FROM files WHERE conversation_id = ?")
        .get(conversationId) as { n: number }
    ).n;
  }

  /** Absolute path of a file's bytes (where it should be — reads and writes go through `storeDir`). */
  pathOf(f: Pick<FileRow, "userId" | "conversationId" | "id">): string {
    return this.paths.uploadedFile(f.userId, f.conversationId, f.id);
  }

  /**
   * The folder `files/<user>/<conversation>`, checked step by step with `lstat` from the store's root down: each
   * one a plain folder, never a symbolic link (review #102: `O_NOFOLLOW` guards only the last name — a linked
   * user or conversation folder would read, write or delete outside the store). `create`: missing steps are made
   * (owner-only). Undefined when a step is missing (and not to be made), a link or not a folder.
   */
  storeDir(userId: string, conversationId: string, create = false): string | undefined {
    if (!SAFE_DIR.test(userId) || !SAFE_DIR.test(conversationId)) return undefined;
    const steps = [this.paths.files, path.join(this.paths.files, userId)];
    steps.push(path.join(steps[1]!, conversationId));
    for (const [i, dir] of steps.entries()) {
      let st = fs.lstatSync(dir, { throwIfNoEntry: false });
      if (!st && create) {
        fs.mkdirSync(dir, { recursive: i === 0, mode: 0o700 });
        st = fs.lstatSync(dir);
      }
      if (!st || st.isSymbolicLink() || !st.isDirectory()) return undefined;
    }
    return steps[2]!;
  }

  /**
   * Opens a stored file for reading: through checked folders only, never a link, only a regular file of the size
   * its row says. Returns the descriptor (the caller closes it) or undefined.
   */
  open(f: FileRow): number | undefined {
    const dir = this.storeDir(f.userId, f.conversationId);
    if (!dir) return undefined;
    const file = path.join(dir, f.id);
    let fd: number;
    try {
      // O_NONBLOCK: a FIFO in its place cannot hold the request (refused by the type check below).
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch {
      return undefined;
    }
    try {
      const st = fs.fstatSync(fd);
      // Checked again after the open: the folders are still plain folders and the name is still this file.
      const named = fs.lstatSync(file, { throwIfNoEntry: false });
      if (
        st.isFile() &&
        st.size === f.bytes &&
        this.storeDir(f.userId, f.conversationId) === dir &&
        named?.ino === st.ino &&
        named.dev === st.dev
      )
        return fd;
    } catch {
      // refused below
    }
    fs.closeSync(fd);
    return undefined;
  }

  /** A fresh temp file name for an upload being received (in `uploads-tmp/`, created owner-only). */
  tempFile(): string {
    fs.mkdirSync(this.paths.uploadsTmp, { recursive: true, mode: 0o700 });
    return path.join(this.paths.uploadsTmp, `${crypto.randomUUID()}.part`);
  }

  /**
   * Moves a received and checked upload (`tmp`) into the store and adds its row. Throws `FileLimitError` when the
   * conversation already has the maximum (the file is not kept). `tmp` is gone afterwards either way.
   */
  async add(input: {
    userId: string;
    conversationId: string;
    uploadId: string;
    name: string;
    kind: FileKind;
    bytes: number;
    sha256: string;
    tmp: string;
  }): Promise<FileRow> {
    await this.opts.beforeCommit?.();
    const row: FileRow = {
      id: crypto.randomUUID(),
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: null,
      uploadId: input.uploadId,
      // Known secrets never reach a stored row (round 26); the rescrub covers ones registered later.
      name: scrubKnown(cleanName(input.name)) || "file",
      kind: input.kind,
      mediaType: FILE_KINDS[input.kind].mediaType,
      bytes: input.bytes,
      sha256: input.sha256,
      createdAt: this.now(),
    };
    return this.lock.write(() => {
      // Cancelled while it came in: discarded here, in the same synchronous step that would store it — a cancel
      // either finds the row (and deletes it) or is found here.
      // Resolved too: the one upload this cancel was for has come and been refused (`takeCancel`).
      if (this.takeCancel(row.userId, input.uploadId)) {
        fs.rmSync(input.tmp, { force: true });
        throw new UploadCancelledError();
      }
      const dir = this.storeDir(row.userId, row.conversationId, true);
      if (!dir) throw new StoreLinkError();
      const dest = path.join(dir, row.id);
      fs.renameSync(input.tmp, dest);
      let added = false;
      try {
        // The count check and the insert are one statement: concurrent uploads cannot both take the last place.
        added =
          this.db.$client
            .prepare(
              `INSERT INTO files (id, user_id, conversation_id, message_id, upload_id, name, kind, media_type, bytes,
                 sha256, created_at)
               SELECT ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?
               WHERE (SELECT count(*) FROM files WHERE conversation_id = ?) < ?`,
            )
            .run(
              row.id,
              row.userId,
              row.conversationId,
              row.uploadId,
              row.name,
              row.kind,
              row.mediaType,
              row.bytes,
              row.sha256,
              row.createdAt,
              row.conversationId,
              FILE_LIMITS.perConversation,
            ).changes === 1;
      } finally {
        if (!added) this.unlinkAndPrune(row);
      }
      if (!added) throw new FileLimitError();
      return row;
    });
  }

  /**
   * Stores a file the agent made (#49, `doc_create`): moved from `tmp` into the store like an upload, its row
   * linked to the reply that made it (`messageId`, the run's assistant message) and without an upload id — so it is
   * never a composer file (cannot be attached to another message or removed with ✕) and it reaches a later
   * session's context while that reply is in the history (#45). It takes one of the conversation's
   * `FILE_LIMITS.perConversation` places, checked in the same statement as the insert (`FileLimitError`).
   * `tmp` is gone afterwards either way.
   */
  async addGenerated(input: {
    userId: string;
    conversationId: string;
    messageId: string;
    name: string;
    kind: FileKind;
    bytes: number;
    sha256: string;
    tmp: string;
  }): Promise<FileRow> {
    const row: FileRow = {
      id: crypto.randomUUID(),
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      uploadId: null,
      name: scrubKnown(cleanName(input.name)) || `document.${input.kind}`,
      kind: input.kind,
      mediaType: FILE_KINDS[input.kind].mediaType,
      bytes: input.bytes,
      sha256: input.sha256,
      createdAt: this.now(),
    };
    return this.lock.write(() => {
      const dir = this.storeDir(row.userId, row.conversationId, true);
      if (!dir) {
        fs.rmSync(input.tmp, { force: true });
        throw new StoreLinkError();
      }
      fs.renameSync(input.tmp, path.join(dir, row.id));
      let added = false;
      try {
        added =
          this.db.$client
            .prepare(
              `INSERT INTO files (id, user_id, conversation_id, message_id, upload_id, name, kind, media_type, bytes,
                 sha256, created_at)
               SELECT ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?
               WHERE (SELECT count(*) FROM files WHERE conversation_id = ?) < ?`,
            )
            .run(
              row.id,
              row.userId,
              row.conversationId,
              row.messageId,
              row.name,
              row.kind,
              row.mediaType,
              row.bytes,
              row.sha256,
              row.createdAt,
              row.conversationId,
              FILE_LIMITS.perConversation,
            ).changes === 1;
      } finally {
        if (!added) this.unlinkAndPrune(row);
      }
      if (!added) throw new FileLimitError();
      return row;
    });
  }

  /**
   * A fork's copy of a stored file (#52, "이어서 대화하기"): its bytes copied into the new conversation's folder (never
   * a link to the original — the copy outlives it, #54) and a new row owned by `to.userId`, without an upload id and
   * with no message yet (the fork links it in the same transaction). Synchronous; the caller holds the file-write lock
   * and the transaction, and calls `discard` for every copy if that transaction does not commit. Undefined when the
   * original's bytes cannot be read or are not what its row says (nothing is kept then).
   */
  copyFrom(src: FileRow, to: { userId: string; conversationId: string }): FileRow | undefined {
    const fd = this.open(src);
    if (fd === undefined) return undefined;
    const row: FileRow = {
      id: crypto.randomUUID(),
      userId: to.userId,
      conversationId: to.conversationId,
      messageId: null,
      uploadId: null,
      name: scrubKnown(cleanName(src.name)) || `file.${src.kind}`,
      kind: src.kind,
      mediaType: FILE_KINDS[src.kind].mediaType,
      bytes: src.bytes,
      sha256: src.sha256,
      createdAt: this.now(),
    };
    let out: number | undefined;
    let written = false;
    try {
      const dir = this.storeDir(row.userId, row.conversationId, true);
      if (!dir) throw new StoreLinkError();
      out = fs.openSync(
        path.join(dir, row.id),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      written = true;
      const hash = crypto.createHash("sha256");
      const buf = Buffer.allocUnsafe(1 << 16);
      let total = 0;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        hash.update(buf.subarray(0, n));
        let off = 0;
        while (off < n) off += fs.writeSync(out, buf, off, n - off);
        total += n;
      }
      fs.closeSync(out);
      out = undefined;
      if (total !== src.bytes || hash.digest("hex") !== src.sha256) {
        this.unlinkAndPrune(row);
        return undefined;
      }
    } catch (e) {
      if (out !== undefined) fs.closeSync(out);
      if (written) this.unlinkAndPrune(row);
      throw e;
    } finally {
      fs.closeSync(fd);
    }
    try {
      const added =
        this.db.$client
          .prepare(
            `INSERT INTO files (id, user_id, conversation_id, message_id, upload_id, name, kind, media_type, bytes,
               sha256, created_at)
             SELECT ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?
             WHERE (SELECT count(*) FROM files WHERE conversation_id = ?) < ?`,
          )
          .run(
            row.id,
            row.userId,
            row.conversationId,
            row.name,
            row.kind,
            row.mediaType,
            row.bytes,
            row.sha256,
            row.createdAt,
            row.conversationId,
            FILE_LIMITS.perConversation,
          ).changes === 1;
      if (!added) throw new FileLimitError();
    } catch (e) {
      this.unlinkAndPrune(row);
      throw e;
    }
    return row;
  }

  /** Removes a copy's bytes (`copyFrom`) whose transaction did not commit. */
  discard(f: Pick<FileRow, "userId" | "conversationId" | "id">): void {
    this.unlinkAndPrune(f);
  }

  /** Links a fork's copied file to its copied message (`copyFrom` leaves none), in the fork's transaction. */
  linkCopy(id: string, messageId: string): void {
    this.db.update(files).set({ messageId }).where(eq(files.id, id)).run();
  }

  /** Files the agent made in the reply `messageId` (#49), oldest first. */
  generatedOf(conversationId: string, messageId: string): FileRow[] {
    return this.db
      .select()
      .from(files)
      .where(
        and(eq(files.conversationId, conversationId), eq(files.messageId, messageId), isNull(files.uploadId)),
      )
      .orderBy(asc(files.createdAt), asc(files.id))
      .all();
  }

  /**
   * `file_ref` parts for a new message's `fileIds` (in the order given, duplicates dropped). Throws
   * `AttachmentError` unless every id is an unsent file of this conversation. Synchronous: runs inside the
   * transaction that creates the message (`attach` follows in the same one).
   */
  refs(
    conversationId: string,
    fileIds: readonly string[],
  ): { type: "file_ref"; fileId: string; name: string }[] {
    const ids = [...new Set(fileIds)];
    if (!ids.length) return [];
    const rows = this.db
      .select()
      .from(files)
      .where(and(inArray(files.id, ids), eq(files.conversationId, conversationId), isNull(files.messageId)))
      .all();
    if (rows.length !== ids.length) throw new AttachmentError();
    // Never a cancelled upload's file, however the client came to name it (review #102 6차).
    if (rows.some((r) => r.uploadId && this.isCancelled(r.userId, r.uploadId))) throw new AttachmentError();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => ({ type: "file_ref" as const, fileId: id, name: byId.get(id)!.name }));
  }

  /** Marks the files as sent with `messageId`; throws `AttachmentError` if one was taken meanwhile. */
  attach(conversationId: string, messageId: string, fileIds: readonly string[]): void {
    const ids = [...new Set(fileIds)];
    if (!ids.length) return;
    const changed = this.db
      .update(files)
      .set({ messageId })
      .where(and(inArray(files.id, ids), eq(files.conversationId, conversationId), isNull(files.messageId)))
      .run().changes;
    if (changed !== ids.length) throw new AttachmentError();
  }

  /** An edited message replaces `from`: its files now belong to `to` (same transaction as the edit). */
  moveToMessage(conversationId: string, from: string, to: string): void {
    this.db
      .update(files)
      .set({ messageId: to })
      .where(and(eq(files.conversationId, conversationId), eq(files.messageId, from)))
      .run();
  }

  /** A cancel is on record for this upload (within the last `CANCEL_TTL_MS`): one keyed lookup. */
  isCancelled(userId: string, uploadId: string): boolean {
    return !!this.db.$client.prepare(CANCEL_SQL.find).get(userId, uploadId, this.now() - CANCEL_TTL_MS);
  }

  /**
   * The upload has come and is refused because it was cancelled: true, and its record goes (resolved). Synchronous
   * (one lookup, one delete): an upload refused here is never stored.
   */
  takeCancel(userId: string, uploadId: string): boolean {
    if (!this.isCancelled(userId, uploadId)) return false;
    this.db.$client.prepare(CANCEL_SQL.drop).run(userId, uploadId);
    return true;
  }

  /** Removes cancels older than `CANCEL_TTL_MS` (start-up and a timer, not only when someone cancels). */
  expireCancels(): number {
    return this.db.$client.prepare(CANCEL_SQL.expire).run(this.now() - CANCEL_TTL_MS).changes;
  }

  /**
   * Cancels an upload by the client's id (review #102 6차), wherever it is: not arrived or still coming in (it is
   * discarded when it would be stored), or stored and unsent (deleted now). "attached" when it already went with
   * a message (nothing changes).
   */
  async cancelUpload(userId: string, uploadId: string): Promise<"cancelled" | "attached" | "too_many"> {
    return this.lock.write(() => {
      const t = this.now();
      // Keyed by the unique (user_id, upload_id) index.
      const row = this.db
        .select()
        .from(files)
        .where(and(eq(files.userId, userId), eq(files.uploadId, uploadId)))
        .get();
      if (row?.messageId) return "attached";
      if (row) {
        // Stored and unsent: resolved now — no record is kept (and none is left behind).
        this.db.$client.prepare(CANCEL_SQL.drop).run(userId, uploadId);
        this.db.delete(files).where(eq(files.id, row.id)).run();
        this.unlinkAndPrune(row);
        return "cancelled";
      }
      // Not arrived (or still coming in): kept on record, also across a restart, until it comes or expires.
      if (!this.isCancelled(userId, uploadId)) {
        const pending = (
          this.db.$client.prepare(CANCEL_SQL.count).get(userId, t - CANCEL_TTL_MS) as { n: number }
        ).n;
        if (pending >= MAX_PENDING_CANCELS) return "too_many";
      }
      this.db.$client.prepare(CANCEL_SQL.insert).run(userId, uploadId, t);
      return "cancelled";
    });
  }

  /** Removes an unsent file (the composer's ✕): its row, then its bytes. False when it was already sent. */
  async remove(id: string): Promise<boolean> {
    return this.lock.write(() => {
      const row = this.get(id);
      if (!row) return true;
      if (row.messageId) return false;
      this.db.delete(files).where(eq(files.id, id)).run();
      this.unlinkAndPrune(row);
      return true;
    });
  }

  /**
   * After a conversation's rows are gone: its files (names the store gives, nothing else) and the folders left
   * empty. A failure here leaves files without rows — removed by the next `sweep()`.
   */
  private removeConversationFolder(userId: string, conversationId: string): void {
    // A linked folder is not ours to empty: left as it is (nothing outside the store is touched).
    const dir = this.storeDir(userId, conversationId);
    if (!dir) return;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }))
        // A link in our place is removed as a link (rmSync never follows the last name).
        if (FILE_ID.test(e.name) && (e.isFile() || e.isSymbolicLink()))
          fs.rmSync(path.join(dir, e.name), { force: true });
    } catch {
      // unreadable: the sweep deals with what is left
    }
    this.pruneEmpty(userId, conversationId);
  }

  private unlinkAndPrune(f: Pick<FileRow, "userId" | "conversationId" | "id">): void {
    const dir = this.storeDir(f.userId, f.conversationId);
    if (!dir) return;
    try {
      fs.rmSync(path.join(dir, f.id), { force: true });
    } catch {
      // left for the sweep
    }
    this.pruneEmpty(f.userId, f.conversationId);
  }

  /** Removes the conversation folder and then the user folder if they are empty — plain folders only. */
  private pruneEmpty(userId: string, conversationId: string): void {
    const dir = this.storeDir(userId, conversationId);
    if (!dir) return;
    try {
      fs.rmdirSync(dir);
      fs.rmdirSync(path.dirname(dir));
    } catch {
      // not empty (or gone)
    }
  }

  /**
   * Start-up clean-up (inside the lock): empties `uploads-tmp/` (uploads cut off by the last shutdown), removes
   * store files that have no row (a crash between rename and insert, a conversation deleted while its folder could
   * not be removed, a user deleted from the database), then folders left empty. Only names the store itself gives
   * (`<file id>` under `<user>/<conversation>/`) are ever removed — anything else in `files/` is left alone.
   * Returns how many files went.
   */
  sweep(): number {
    fs.rmSync(this.paths.uploadsTmp, { recursive: true, force: true });
    let removed = 0;
    // A linked store root is not walked at all (ensureLayout refuses one at start; this is the second line).
    const root = fs.lstatSync(this.paths.files, { throwIfNoEntry: false });
    if (!root || root.isSymbolicLink() || !root.isDirectory()) return 0;
    const known = new Set(
      (
        this.db.$client.prepare("SELECT id, user_id, conversation_id FROM files").all() as {
          id: string;
          user_id: string;
          conversation_id: string;
        }[]
      ).map((f) => `${f.user_id}/${f.conversation_id}/${f.id}`),
    );
    const dirs = (dir: string) => {
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && SAFE_DIR.test(e.name))
          .map((e) => e.name);
      } catch {
        return [];
      }
    };
    // Dirent types are the entries' own (links are not followed), so a linked user or conversation folder is
    // skipped; `storeDir` checks the path again before anything is removed.
    for (const user of dirs(this.paths.files))
      for (const conv of dirs(path.join(this.paths.files, user))) {
        const dir = this.storeDir(user, conv);
        if (!dir) continue;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!FILE_ID.test(e.name) || !(e.isFile() || e.isSymbolicLink())) continue;
          if (known.has(`${user}/${conv}/${e.name}`)) continue;
          fs.rmSync(path.join(dir, e.name), { force: true });
          removed++;
        }
        this.pruneEmpty(user, conv);
      }
    return removed;
  }
}
