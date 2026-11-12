import crypto from "node:crypto";
import fs from "node:fs";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  FILE_ERRORS,
  FILE_LIMITS,
  FILE_NAME_HEADER,
  UPLOAD_ID_HEADER,
  fileKindOf,
  type FileError,
  type FileKind,
  type FileListResponse,
} from "@agentlee/shared";
import { attachment } from "../artifacts/serve.js";
import { RAW_HEADERS } from "../artifacts/routes.js";
import type { ConversationStore } from "../conversations/store.js";
import { logEvent } from "../logging.js";
import { contentMatches } from "./detect.js";
import { FileLimitError, toUploadedFile, UPLOAD_ID, UploadCancelledError, type FileStore } from "./store.js";

/** Resource kind of one uploaded file: its uploader only (family sharing, #29, gets its own projection). */
export const FILE_KIND = "file";
/** Resource kind of a conversation's file list: owner only, like its artifacts. */
export const CONVERSATION_FILES_KIND = "conversation-files";

/** Outcome codes of an upload, logged as `fileCode` (observability/policy.ts keeps the same list). */
export const FILE_CODES = ["file_ok", "file_aborted", "invalid_request", ...FILE_ERRORS] as const;

/**
 * Kinds a browser may show in the page (`?inline=1`): raster images only. Everything else — PDF, office files,
 * text — is always a download; active content (SVG, HTML, XML) is not even accepted (FILE_KINDS).
 */
export const INLINE_KINDS: ReadonlySet<FileKind> = new Set(["png", "jpg"]);
/** CSP of every served original: nothing in it may run or load anything, and it gets an opaque origin. */
export const FILE_CSP = "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";

const ERROR_STATUS: Record<FileError | "invalid_request", number> = {
  file_too_large: 413,
  too_many_files: 409,
  file_type_unsupported: 415,
  file_type_mismatch: 415,
  file_empty: 400,
  file_attached: 409,
  upload_cancelled: 409,
  too_many_cancels: 429,
  invalid_request: 400,
};

type Received = { bytes: number; sha256: string } | "too_large" | "aborted";

/**
 * Streams the request body into `dest` (created new, owner-only), counting and hashing as it goes — never more
 * than `max` bytes are written and the body is never held in memory. Over `max`: stops reading at once
 * ("too_large"); the caller answers and closes the connection, so the rest is never received.
 */
export function receive(src: Readable, dest: string, max: number): Promise<Received> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, { flags: "wx", mode: 0o600 });
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    let settled = false;
    const stop = (r: Received | Error) => {
      if (settled) return;
      settled = true;
      src.off("data", onData);
      src.off("end", onEnd);
      src.off("error", onAbort);
      src.off("aborted", onAbort);
      src.off("close", onClose);
      if (typeof r === "object" && !(r instanceof Error)) return resolve(r);
      if (typeof r === "string") src.pause();
      // Settled only once the file is closed: the caller removes it, and nothing may be written after that.
      if (out.closed) return r instanceof Error ? reject(r) : resolve(r);
      out.once("close", () => (r instanceof Error ? reject(r) : resolve(r)));
      out.destroy();
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      // The limit is checked before the chunk is written: the file never holds more than `max` bytes.
      if (bytes > max) return stop("too_large");
      hash.update(chunk);
      if (!out.write(chunk)) {
        src.pause();
        out.once("drain", () => src.resume());
      }
    };
    const onEnd = () => {
      src.off("data", onData);
      out.end(() => {
        try {
          // Durable before it is renamed into the store and a row points at it. The descriptor is closed whatever
          // fsync says (review #102: an ENOSPC left it open, holding the space of the removed temp file).
          const fd = fs.openSync(dest, "r");
          try {
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        } catch (e) {
          return stop(e as Error);
        }
        stop({ bytes, sha256: hash.digest("hex") });
      });
    };
    const onAbort = () => stop("aborted");
    const onClose = () => {
      if (!src.readableEnded) stop("aborted");
    };
    out.on("error", (e) => stop(e));
    src.on("data", onData);
    src.on("end", onEnd);
    src.on("error", onAbort);
    src.on("aborted", onAbort);
    src.on("close", onClose);
    src.resume();
  });
}

function decodeName(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw || raw.length > 4096) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/** The extension that goes into a download's name: the one the file had (it matched its kind). */
const nameParts = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? { base: name.slice(0, dot), ext: name.slice(dot + 1).toLowerCase() }
    : { base: name, ext: "" };
};

/**
 * File API (#22):
 * - `POST /api/conversations/:id/files` — upload one file: the raw bytes as the body (`application/octet-stream`),
 *   the name in `X-File-Name` (percent-encoded UTF-8). Checks: type by extension, size (Content-Length, then while
 *   streaming), count (before, and atomically on insert), content matches the extension. 201 `UploadedFile`.
 * - `GET /api/conversations/:id/files` — the conversation's files (owner only)
 * - `GET /api/files/:id` — one file's metadata; `GET /api/files/:id/content` — the original, a download
 *   (`?inline=1` shows a PNG/JPG in the page; nothing else is ever inline)
 * - `DELETE /api/files/:id` — an unsent file (409 `file_attached` once it went with a message)
 */
export function registerFileRoutes(
  app: FastifyInstance,
  conversations: ConversationStore,
  store: FileStore,
): void {
  app.resources.register(FILE_KIND, (id) => {
    const f = store.get(id);
    return f ? { kind: FILE_KIND, id: f.id, ownerId: f.userId, sharedWith: [] } : undefined;
  });
  app.resources.register(CONVERSATION_FILES_KIND, (id) => {
    const c = conversations.get(id);
    return c ? { kind: CONVERSATION_FILES_KIND, id: c.id, ownerId: c.ownerId, sharedWith: [] } : undefined;
  });

  const fail = (reply: FastifyReply, error: FileError | "invalid_request", close = false) => {
    reply.code(ERROR_STATUS[error]).header("Cache-Control", "no-store");
    // The rest of a refused body is not wanted: the connection closes once the answer is out.
    if (close) reply.header("Connection", "close");
    return reply.send({ error });
  };

  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/files",
    { config: { resource: { kind: CONVERSATION_FILES_KIND, action: "read" } } },
    async (req, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .send({ items: store.list(req.params.id).map(toUploadedFile) } satisfies FileListResponse),
  );

  // The upload route reads its body itself (streamed to disk): its own scope, with a parser that hands the
  // request stream over untouched. Fastify's body limit does not apply to it — `receive` enforces ours.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    scope.post<{ Params: { id: string } }>(
      "/api/conversations/:id/files",
      { config: { resource: { kind: "conversation", action: "write" } } },
      async (req, reply) => {
        const started = Date.now();
        const userId = req.ctx.user!.id;
        const conversationId = req.params.id;
        const done = (fileCode: (typeof FILE_CODES)[number], level: "info" | "warn" = "warn") =>
          logEvent(req.log, level, "file.uploaded", {
            userId,
            conversationId,
            fileCode,
            durationMs: Date.now() - started,
          });
        const refuse = (error: FileError | "invalid_request", close = true) => {
          done(error);
          return fail(reply, error, close);
        };
        const type = String(req.headers["content-type"] ?? "")
          .split(";")[0]!
          .trim()
          .toLowerCase();
        if (type !== "application/octet-stream") return refuse("invalid_request");
        const name = decodeName(req.headers[FILE_NAME_HEADER]);
        if (!name) return refuse("invalid_request");
        const uploadId = String(req.headers[UPLOAD_ID_HEADER] ?? "");
        if (!UPLOAD_ID.test(uploadId)) return refuse("invalid_request");
        // Cancelled before it was even sent: nothing is read, and the cancel is resolved.
        if (store.takeCancel(userId, uploadId)) return refuse("upload_cancelled");
        const kind = fileKindOf(name);
        if (!kind) return refuse("file_type_unsupported");
        const declared = Number(req.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > FILE_LIMITS.bytes) return refuse("file_too_large");
        // Early answer for the common case; the insert checks again (concurrent uploads).
        if (store.count(conversationId) >= FILE_LIMITS.perConversation) return refuse("too_many_files");
        const body = req.body as Readable | undefined;
        if (!body || typeof body.on !== "function") return refuse("file_empty", false);

        const tmp = store.tempFile();
        try {
          const got = await receive(body, tmp, FILE_LIMITS.bytes);
          if (got === "too_large") return refuse("file_too_large");
          if (got === "aborted") {
            // The client went away mid-body: nobody reads this answer, but the request is finished properly.
            done("file_aborted");
            return fail(reply, "invalid_request", true);
          }
          if (got.bytes === 0) return refuse("file_empty", false);
          if (!contentMatches(tmp, kind)) return refuse("file_type_mismatch", false);
          try {
            const row = await store.add({ userId, conversationId, uploadId, name, kind, ...got, tmp });
            done("file_ok", "info");
            return reply.code(201).header("Cache-Control", "no-store").send(toUploadedFile(row));
          } catch (e) {
            if (e instanceof FileLimitError) return refuse("too_many_files", false);
            if (e instanceof UploadCancelledError) return refuse("upload_cancelled", false);
            // The same upload id twice (unique per user): a client error.
            if ((e as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE")
              return refuse("invalid_request", false);
            // The conversation went while the file was coming in (its foreign key).
            if ((e as { code?: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY")
              return reply.code(404).header("Cache-Control", "no-store").send({ error: "not_found" });
            throw e;
          }
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      },
    );
  });

  const read = { resource: { kind: FILE_KIND, action: "read" as const } };
  app.get<{ Params: { id: string } }>("/api/files/:id", { config: read }, async (req, reply) =>
    reply.header("Cache-Control", "no-store").send(toUploadedFile(store.get(req.params.id)!)),
  );

  app.get<{ Params: { id: string }; Querystring: { inline?: string } }>(
    "/api/files/:id/content",
    // No automatic HEAD: it would open the file for a body nobody reads.
    { config: read, exposeHeadRoute: false },
    async (req, reply) => {
      const f = store.get(req.params.id)!;
      // Checked folders only, never a link, a regular file of the size the row says (FileStore.open).
      const fd = store.open(f);
      if (fd === undefined)
        return reply.code(404).header("Cache-Control", "no-store").send({ error: "not_found" });
      const inline = req.query.inline === "1" && INLINE_KINDS.has(f.kind);
      const { base, ext } = nameParts(toUploadedFile(f).name);
      const disposition = attachment(base, ext || f.kind);
      return reply
        .headers(RAW_HEADERS)
        .header("Content-Security-Policy", FILE_CSP)
        .header("Content-Disposition", inline ? disposition.replace(/^attachment/, "inline") : disposition)
        .header("Content-Length", String(f.bytes))
        .type(f.mediaType)
        .send(fs.createReadStream("", { fd, autoClose: true }));
    },
  );

  // Cancel by the client's upload id (review #102 6차): the caller's own uploads only — the id is looked up among
  // them, so another user's id is just "nothing there" (and is remembered as cancelled for the caller alone).
  app.delete<{ Params: { uploadId: string } }>(
    "/api/uploads/:uploadId",
    { config: { noResource: "the caller's own upload id, looked up among the caller's files only" } },
    async (req, reply) => {
      if (!UPLOAD_ID.test(req.params.uploadId)) return fail(reply, "invalid_request");
      const r = await store.cancelUpload(req.ctx.user!.id, req.params.uploadId);
      if (r === "attached") return fail(reply, "file_attached");
      if (r === "too_many") return fail(reply, "too_many_cancels");
      return reply.header("Cache-Control", "no-store").send({ ok: true });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/files/:id",
    { config: { resource: { kind: FILE_KIND, action: "delete" } } },
    async (req, reply) => {
      if (!(await store.remove(req.params.id))) return fail(reply, "file_attached");
      return reply.header("Cache-Control", "no-store").send({ ok: true });
    },
  );
}
