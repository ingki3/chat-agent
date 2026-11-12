import crypto from "node:crypto";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { SkillResult, ToolScope } from "@agentlee/mcp-tools";
import { DOC_CREATE_TOOL } from "@agentlee/mcp-tools/docgen";
import {
  DOC_HWP_HINT,
  DOC_KINDS,
  DOC_LIMITS,
  DocContent,
  FILE_KINDS,
  docInputProblem,
  fileKindOf,
  type DocCode,
  type DocKind,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { conversations, messages, runs } from "../db/schema.js";
import { contentMatches } from "../files/detect.js";
import { cleanName, FileLimitError, type FileRow, type FileStore } from "../files/store.js";
import { scrubKnownDeep } from "../secrets/known.js";
import type { DocJob, DocRunner } from "./runner.js";

/**
 * `doc_create` (#49, PRD FR-4.4·4.7·5.6): checks the request, gathers its pictures, has the document made by the
 * sandboxed worker (runner.ts), checks the file again and stores it as a file of the conversation (#22), linked to
 * the reply of the run that made it.
 *
 * - Scope: the run's token (user, conversation, run) — the user must own the conversation, and the run must be that
 *   conversation's with its reply message still there (the file is linked to that message).
 * - Known secrets (round 26) are taken out of every string of the request before anything is made: no generated
 *   file holds a secret the server knows at that moment (see docs/ops.md §29 for the limits of this).
 * - Pictures are files of the same conversation and user only — PNG or JPG that went with a message still in the
 *   conversation's history — read through the store's checked open (no links, the size the row says) and checked
 *   against their stored hash. Never a URL: nothing is fetched.
 * - The result is re-opened twice: by the worker (the parts and the title are there) and here (the type detection
 *   uploads go through, `contentMatches`), and it must fit `DOC_LIMITS.outputBytes`. It counts against the
 *   conversation's file limit like an upload.
 */
export class DocError extends Error {
  constructor(
    readonly code: DocCode,
    readonly hint?: string,
  ) {
    super(code);
  }
}

const PICTURE_KINDS: ReadonlySet<string> = new Set(["png", "jpg"]);

export type DocGenOptions = {
  db: Db;
  /** The conversation file store (#22); undefined while the app is starting (refused as unavailable). */
  files: () => FileStore | undefined;
  runner: DocRunner;
};

export type DocCreated = {
  fileId: string;
  name: string;
  kind: DocKind;
  mediaType: string;
  bytes: number;
  url: string;
  document: { fileId: string; name: string; mimeType: string };
  checks: Record<string, number>;
};

export class DocGenService {
  constructor(private readonly opts: DocGenOptions) {}

  /** The reply message of the scope's run, if the user owns the conversation and the run is that conversation's. */
  private replyOf(scope: ToolScope): string | undefined {
    const r = this.opts.db
      .select({ ownerId: conversations.ownerId, messageId: runs.assistantMessageId })
      .from(runs)
      .innerJoin(conversations, eq(conversations.id, runs.conversationId))
      .innerJoin(messages, eq(messages.id, runs.assistantMessageId))
      .where(and(eq(runs.id, scope.runId), eq(runs.conversationId, scope.conversationId)))
      .get();
    return r && r.ownerId === scope.userId ? r.messageId : undefined;
  }

  /** One picture of the document: a PNG/JPG of this user and conversation, sent with a message in the history. */
  private picture(store: FileStore, scope: ToolScope, fileId: string): FileRow {
    const f = store.get(fileId);
    // Another user's or conversation's file, an unsent one, one of a message no longer in the history: the same
    // answer as a file that does not exist (nothing is said about files outside the scope).
    if (!f || f.userId !== scope.userId || f.conversationId !== scope.conversationId || !f.messageId)
      throw new DocError("doc_image_not_found");
    const m = this.opts.db
      .select({ active: messages.active })
      .from(messages)
      .where(and(eq(messages.id, f.messageId), eq(messages.conversationId, scope.conversationId)))
      .get();
    if (!m?.active) throw new DocError("doc_image_not_found");
    if (!PICTURE_KINDS.has(f.kind)) throw new DocError("doc_image_unsupported");
    if (f.bytes > DOC_LIMITS.imageBytes) throw new DocError("doc_image_too_large");
    return f;
  }

  /** The bytes of a picture, read through the store's checked open, and matching the hash stored with it. */
  private read(store: FileStore, f: FileRow): Buffer {
    const fd = store.open(f);
    if (fd === undefined) throw new DocError("doc_image_not_found");
    try {
      const buf = Buffer.alloc(f.bytes);
      let at = 0;
      while (at < buf.length) {
        const n = fs.readSync(fd, buf, at, buf.length - at, at);
        if (n <= 0) break;
        at += n;
      }
      if (at !== f.bytes || crypto.createHash("sha256").update(buf).digest("hex") !== f.sha256)
        throw new DocError("doc_image_not_found");
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  }

  async create(scope: ToolScope, input: Record<string, unknown>): Promise<SkillResult> {
    try {
      return { ok: true, output: await this.make(scope, input) };
    } catch (e) {
      if (e instanceof DocError) return { ok: false, code: e.code, ...(e.hint ? { hint: e.hint } : {}) };
      throw e;
    }
  }

  private async make(scope: ToolScope, raw: Record<string, unknown>): Promise<DocCreated> {
    const parsed = z.strictObject(DOC_CREATE_TOOL.input).safeParse(raw);
    if (!parsed.success)
      throw new DocError(
        parsed.error.issues.some((i) => i.code === "too_big") ? "doc_too_large" : "doc_bad_input",
      );
    const req = parsed.data as {
      kind: DocKind | "hwp" | "hwpx";
      title: string;
      subtitle?: string;
      author?: string;
      fileName?: string;
      blocks: unknown[];
    };
    // FR-4.4: no HWP output in v1 — said in fixed words, with what to ask for instead.
    if (!(DOC_KINDS as readonly string[]).includes(req.kind))
      throw new DocError("doc_hwp_unsupported", DOC_HWP_HINT);
    const kind = req.kind as DocKind;
    const store = this.opts.files();
    if (!store) throw new DocError("doc_unavailable");
    const messageId = this.replyOf(scope);
    if (!messageId) throw new DocError("doc_not_allowed");

    // Known secrets out of every string (a number that spells one becomes the marker text), then checked again:
    // the marker can change a length or a cell's type.
    const scrubbed = scrubKnownDeep({
      title: req.title,
      ...(req.subtitle !== undefined ? { subtitle: req.subtitle } : {}),
      ...(req.author !== undefined ? { author: req.author } : {}),
      blocks: req.blocks,
    });
    const content = DocContent.safeParse(scrubbed);
    if (!content.success) throw new DocError("doc_bad_input");
    const doc = content.data;
    const problem = docInputProblem(doc);
    if (problem) throw new DocError(problem);

    const images: DocJob["images"] = {};
    let total = 0;
    for (const b of doc.blocks) {
      if (b.type !== "image" || images[b.fileId]) continue;
      const f = this.picture(store, scope, b.fileId);
      total += f.bytes;
      if (total > DOC_LIMITS.imagesTotalBytes) throw new DocError("doc_image_too_large");
      images[b.fileId] = { kind: f.kind as "png" | "jpg", data: this.read(store, f).toString("base64") };
    }

    const made = await this.opts.runner({ kind, doc, images });
    if (!made.ok) throw new DocError(isDocCode(made.code) ? made.code : "doc_failed");
    if (made.data.length > DOC_LIMITS.outputBytes) throw new DocError("doc_output_too_large");
    if (!made.data.length) throw new DocError("doc_invalid");

    const tmp = store.tempFile();
    try {
      fs.writeFileSync(tmp, made.data, { flag: "wx", mode: 0o600 });
      const fd = fs.openSync(tmp, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Re-opened the way an upload is checked: a ZIP with the format's main part, or a PDF header.
      if (!contentMatches(tmp, kind)) throw new DocError("doc_invalid");
      const name = fileNameOf(req.fileName ?? doc.title, kind);
      let row: FileRow;
      try {
        row = await store.addGenerated({
          userId: scope.userId,
          conversationId: scope.conversationId,
          messageId,
          name,
          kind,
          bytes: made.data.length,
          sha256: crypto.createHash("sha256").update(made.data).digest("hex"),
          tmp,
        });
      } catch (e) {
        if (e instanceof FileLimitError) throw new DocError("doc_too_many_files");
        // The reply or the conversation went while the file was being made (their foreign keys).
        if ((e as { code?: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY")
          throw new DocError("doc_not_allowed");
        throw e;
      }
      return {
        fileId: row.id,
        name: row.name,
        kind,
        mediaType: row.mediaType,
        bytes: row.bytes,
        url: `/api/files/${row.id}/content`,
        document: { fileId: row.id, name: row.name, mimeType: row.mediaType },
        checks: made.checks,
      };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

const DOC_CODE_SET: ReadonlySet<string> = new Set<DocCode>([
  "doc_bad_input",
  "doc_image_not_found",
  "doc_image_unsupported",
  "doc_image_too_large",
  "doc_invalid",
  "doc_failed",
  "doc_timeout",
  "doc_limit",
  "doc_unavailable",
]);
/** Codes the worker or the runner may give (anything else from it is `doc_failed`). */
const isDocCode = (c: string): c is DocCode => DOC_CODE_SET.has(c);

/**
 * The stored name: the given name (or the title) as a file name — the last path segment, no control characters,
 * cut — with an extension the user might have typed taken off and the kind's own put on.
 */
export function fileNameOf(want: string, kind: DocKind): string {
  const ext = FILE_KINDS[kind].exts[0];
  let base = cleanName(want.replace(/[\\/:*?"<>|]+/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (fileKindOf(base)) base = base.slice(0, base.lastIndexOf("."));
  base =
    Array.from(base)
      .slice(0, DOC_LIMITS.fileName)
      .join("")
      .replace(/[.\s]+$/, "") || "document";
  return `${base}.${ext}`;
}
