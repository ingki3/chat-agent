import type { FastifyInstance, FastifyReply } from "fastify";
import {
  DocContent,
  FILE_KINDS,
  REFERENCE_STYLE_LABEL,
  REFERENCES_TITLE,
  ReferencesDownloadQuery,
  ReferencesQuery,
  docInputProblem,
  formatReferences,
  type ReferenceItem,
  type ReferenceStyle,
  type ReferencesResponse,
} from "@agentlee/shared";
import { deny } from "../auth/plugin.js";
import type { ConversationStore } from "../conversations/store.js";
import type { Db } from "../db/client.js";
import { eq } from "drizzle-orm";
import { notificationPrefs } from "../db/schema.js";
import type { DocRunResult } from "../docgen/runner.js";
import type { DocSlots } from "../docgen/slots.js";
import { RAW_HEADERS } from "../artifacts/routes.js";
import { logEvent } from "../logging.js";
import { scrubKnown, scrubKnownDeep } from "../secrets/known.js";
import { maskEscaped, partsHoldSecret, readParts, registryState, type XmlPart } from "./docx-check.js";
import {
  DEFAULT_TIME_ZONE,
  cleanText,
  collectReferences,
  dayIn,
  type CollectedSource,
  type ReferencesView,
} from "./collect.js";
import { viewOf } from "../shares/projection.js";

/**
 * Resource kind of a conversation's reference export (#26). Whoever may read the conversation may export it: the
 * same owner and sharing as the `conversation` resource (its loader is used as it is, so #29's sharing reaches this
 * route without a change here). The export holds nothing the conversation's messages do not already show — the
 * entries come from the citation notes of the history — except the access date of each page.
 */
export const REFERENCES_KIND = "conversation-references";

export type ReferenceExport = {
  style: ReferenceStyle;
  includeUnverified: boolean;
  items: ReferenceItem[];
  /** The included entries' lines, in the style's order. */
  lines: string[];
  excluded: number;
  truncated: boolean;
};

/**
 * The export of one conversation in one style. A failed source (no verified citation) is listed but not included
 * unless `includeUnverified`. Every line is scrubbed once more as it is written (the fields were before formatting).
 */
export function buildExport(
  db: Db,
  conversationId: string,
  style: ReferenceStyle,
  includeUnverified: boolean,
  timeZone: string = DEFAULT_TIME_ZONE,
  /** A shared viewer's projection (#29): the export of what they see, never the whole conversation. */
  view?: ReferencesView,
): ReferenceExport {
  const { sources, truncated } = collectReferences(db, conversationId, timeZone, view);
  const included = (s: CollectedSource) => s.verified || includeUnverified;
  const shown = sources.filter(included);
  const hidden = sources.filter((s) => !included(s));
  // The excluded ones are formatted on their own (they are not in the numbering of the school format).
  const lines = formatReferences(style, shown).map((e) => ({ s: shown[e.index]!, text: scrubKnown(e.text) }));
  const rest = formatReferences(style, hidden).map((e) => ({
    s: hidden[e.index]!,
    text: scrubKnown(style === "school" ? e.text.replace(/^\d+\. /, "") : e.text),
  }));
  const item = (x: { s: CollectedSource; text: string }, inc: boolean): ReferenceItem => ({
    id: x.s.id,
    kind: x.s.kind,
    verified: x.s.verified,
    status: x.s.status,
    included: inc,
    text: x.text,
  });
  return {
    style,
    includeUnverified,
    items: [...lines.map((x) => item(x, true)), ...rest.map((x) => item(x, false))],
    lines: lines.map((x) => x.text),
    excluded: hidden.length,
    truncated,
  };
}

/** The document for the `.docx`: a title, the conversation and style under it, one paragraph per entry. */
export function referencesDocument(title: string, style: ReferenceStyle, lines: string[]): DocContent {
  return {
    title: REFERENCES_TITLE,
    subtitle: `${title} · ${REFERENCE_STYLE_LABEL[style]}`,
    blocks: lines.map((text) => ({ type: "paragraph" as const, text })),
  };
}

/** The style in the download name. */
const NAME_STYLE: Record<ReferenceStyle, { ko: string; ascii: string }> = {
  apa: { ko: "APA", ascii: "APA" },
  mla: { ko: "MLA", ascii: "MLA" },
  school: { ko: "학교용", ascii: "school" },
};

/**
 * The download name is fixed by the server, never made from the conversation title (decision, review #115 round 6):
 * `참고문헌-<형식>-<YYYY-MM-DD>.<ext>` (the date in the user's time zone), ASCII fallback
 * `references-<style>-<YYYY-MM-DD>.<ext>`. A title cut, collapsed and truncated into a file name kept producing
 * pieces of secrets the checks could not see; the title is only in the document (its subtitle), where the rebuild and
 * the XML checks cover it.
 */
export function downloadName(
  style: ReferenceStyle,
  day: string,
  ext: string,
): { full: string; ascii: string } {
  return {
    full: `${REFERENCES_TITLE}-${NAME_STYLE[style].ko}-${day}.${ext}`,
    ascii: `references-${NAME_STYLE[style].ascii}-${day}.${ext}`,
  };
}

/**
 * `Content-Disposition` for the fixed name. Nothing in it is cut, so one whole-value check (`tail: false`) of the
 * final header and both names against the registry: a match (only if someone registered the name itself) sends a
 * bare `attachment`.
 */
export function referencesDisposition(style: ReferenceStyle, day: string, ext: string): string {
  const { full, ascii } = downloadName(style, day, ext);
  const header = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(full)}`;
  const holds = (v: string) => scrubKnown(v, { tail: false }) !== v;
  return [header, full, ascii].some(holds) ? "attachment" : header;
}

/** The user's time zone (notification settings, FR-12.8), for the access dates; Asia/Seoul without one. */
function timeZoneOf(db: Db, userId: string): string {
  return (
    db
      .select({ tz: notificationPrefs.timeZone })
      .from(notificationPrefs)
      .where(eq(notificationPrefs.userId, userId))
      .get()?.tz ?? DEFAULT_TIME_ZONE
  );
}

export function registerReferenceRoutes(
  app: FastifyInstance,
  deps: { db: Db; conversations: ConversationStore; slots: DocSlots; now?: () => number },
): void {
  const now = deps.now ?? Date.now;
  app.resources.register(REFERENCES_KIND, (id) => {
    const c = app.resources.load("conversation", id);
    return c ? { ...c, kind: REFERENCES_KIND } : undefined;
  });
  const config = { resource: { kind: REFERENCES_KIND, action: "read" } } as const;
  const titleOf = (id: string) => cleanText(deps.conversations.get(id)?.title, 100) ?? "대화";

  app.get<{ Params: { id: string } }>("/api/conversations/:id/references", { config }, async (req, reply) => {
    const q = ReferencesQuery.safeParse(req.query);
    if (!q.success) return deny(reply, 400, "invalid_request");
    // A shared viewer (#29): the loader let them in; the export is of their projection only.
    const view = viewOf(app, req, { conversationId: req.params.id });
    if (view === null) return deny(reply, 403, "forbidden");
    const tz = timeZoneOf(deps.db, req.ctx.user!.id);
    const e = buildExport(deps.db, req.params.id, q.data.style, q.data.includeUnverified === "1", tz, view);
    return reply.header("Cache-Control", "no-store").send({
      style: e.style,
      includeUnverified: e.includeUnverified,
      items: e.items,
      text: e.lines.join("\n"),
      excluded: e.excluded,
      truncated: e.truncated,
    } satisfies ReferencesResponse);
  });

  const fail = (reply: FastifyReply, status: number, error: string) =>
    reply.code(status).header("Cache-Control", "no-store").send({ error });

  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/references/download",
    { config },
    async (req, reply) => {
      const q = ReferencesDownloadQuery.safeParse(req.query);
      if (!q.success) return deny(reply, 400, "invalid_request");
      const started = Date.now();
      const view = viewOf(app, req, { conversationId: req.params.id });
      if (view === null) return deny(reply, 403, "forbidden");
      const userId = req.ctx.user!.id;
      const tz = timeZoneOf(deps.db, userId);
      const { style, format } = q.data;
      const e = buildExport(deps.db, req.params.id, style, q.data.includeUnverified === "1", tz, view);
      const done = (docCode?: string) =>
        logEvent(req.log, docCode && docCode !== "doc_ok" ? "warn" : "info", "references.exported", {
          userId,
          conversationId: req.params.id,
          count: e.lines.length,
          durationMs: Date.now() - started,
          ...(format === "docx" ? { docKind: "docx" } : {}),
          ...(docCode ? { docCode } : {}),
        });
      if (!e.lines.length) return fail(reply, 409, "references_empty");
      const title = titleOf(req.params.id);
      const day = dayIn(now(), tz);
      if (format === "txt") {
        done();
        return reply
          .headers(RAW_HEADERS)
          .header("Content-Disposition", referencesDisposition(style, day, "txt"))
          .type("text/plain; charset=utf-8")
          .send(`${e.lines.join("\n")}\n`);
      }

      // `.docx`: the #49 worker, sandboxed (the app's runner), from text blocks only, in one of the server's
      // document worker slots (shared with doc_create: 2 at once, 1 per user).
      const parsed = DocContent.safeParse(referencesDocument(title, style, e.lines));
      if (!parsed.success || docInputProblem(parsed.data)) {
        done("doc_bad_input");
        return fail(reply, 500, "references_unavailable");
      }
      let doc = parsed.data;
      // The document as built from the raw rows (title, source titles, sites, addresses — each through `cleanText`
      // / `cleanUrl`, whose cut-off masking works at the field's real length cap). Re-built after the worker against
      // the registry as it is then: a secret registered meanwhile in a field that was cut (the conversation title at
      // 100 characters, then " · APA 7") cannot be found in the finished line, only in the raw field (review #115
      // round 4).
      // A shared viewer's projection is read again too (review #117 round 4): a share revoked or narrowed while the
      // worker ran changes what they may have — gone entirely (`null`) is a 403, narrower makes the file again.
      const rebuild = () => {
        const now = viewOf(app, req, { conversationId: req.params.id });
        if (now === null) return null;
        return JSON.stringify(
          referencesDocument(
            titleOf(req.params.id),
            style,
            buildExport(deps.db, req.params.id, style, q.data.includeUnverified === "1", tz, now).lines,
          ),
        );
      };
      const gone = () => {
        done("doc_forbidden");
        return deny(reply, 403, "forbidden");
      };
      let built = JSON.stringify(doc);
      let made: DocRunResult | undefined;
      let file: Buffer;
      let checked: XmlPart[];
      let state: unknown;
      // Checked after the worker, against the registry as it is *now* (the compressed bytes are never searched):
      // - a secret registered while the worker ran is in the file: the input is scrubbed again;
      // - writing XML can make a registered value (`&` → `&amp;`): the file's XML parts are read and checked
      //   (`docxHoldsSecret`), and the strings whose escaped form holds it are masked (`maskEscaped`).
      // Either one: the file is discarded and made once more from the fixed input. A hit again (or one no input
      // string explains): a retryable error, no file.
      for (let attempt = 0; ; attempt++) {
        made = await deps.slots.run(userId, { kind: "docx", doc, images: {} });
        if (!made) {
          done("doc_busy");
          return fail(reply.header("Retry-After", "5"), 503, "references_busy");
        }
        // The worker re-opened it; here that it is a ZIP (the upload check of the same kind needs a file).
        if (!made.ok || made.data.length < 4 || made.data.readUInt32LE(0) !== 0x04034b50) {
          done(made.ok ? "doc_invalid" : made.code);
          return fail(reply, 503, "references_unavailable");
        }
        file = made.data;
        // Every asynchronous step first (all XML parts read), then every check at once against the registry as it is
        // at that moment — the input re-scrub included — and that state kept for a last look before sending.
        const parts = await readParts(made.data);
        state = registryState();
        const fresh = rebuild();
        if (fresh === null) return gone();
        if (fresh !== built) {
          const again = DocContent.safeParse(JSON.parse(fresh));
          if (attempt >= 1 || !again.success || docInputProblem(again.data) || !again.data.blocks.length) {
            done("doc_failed");
            return fail(reply.header("Retry-After", "1"), 503, "references_retry");
          }
          built = fresh;
          doc = again.data;
          continue;
        }
        const rescrubbed = scrubKnownDeep(doc, { tail: false });
        const leaked = rescrubbed === doc && (!parts || partsHoldSecret(parts));
        if (rescrubbed === doc && !leaked) {
          checked = parts!;
          break;
        }
        const next = rescrubbed !== doc ? rescrubbed : maskEscaped(doc);
        const again = next === doc ? undefined : DocContent.safeParse(next);
        if (attempt >= 1 || !again?.success || docInputProblem(again.data)) {
          done("doc_failed");
          return fail(reply.header("Retry-After", "1"), 503, "references_retry");
        }
        doc = again.data;
      }
      // Registered since the check (nothing asynchronous runs in between today; kept so a later change cannot open a
      // gap): the parts read are checked again, synchronously, or the file is refused.
      // The projection is read once more here, whatever the registry did.
      const last = rebuild();
      if (last === null) return gone();
      if (
        last !== built ||
        (registryState() !== state &&
          (partsHoldSecret(checked) || scrubKnownDeep(doc, { tail: false }) !== doc))
      ) {
        done("doc_failed");
        return fail(reply.header("Retry-After", "1"), 503, "references_retry");
      }
      done("doc_ok");
      return reply
        .headers(RAW_HEADERS)
        .header("Content-Disposition", referencesDisposition(style, day, "docx"))
        .type(FILE_KINDS.docx.mediaType)
        .send(file);
    },
  );
}
