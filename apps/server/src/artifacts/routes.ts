import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ARTIFACT_HTML_DOWNLOAD,
  MyArtifactsQuery,
  RevertArtifactRequest,
  type ArtifactDetail,
  type ArtifactListResponse,
  type ArtifactVersionContent,
  type MyArtifactsResponse,
} from "@agentlee/shared";
import { deny } from "../auth/plugin.js";
import type { ConversationStore } from "../conversations/store.js";
import { BASE_HEADERS } from "../headers.js";
import { logEvent } from "../logging.js";
import { EXPORT_FORMATS, exportDocument, exportFormats, type ExportCode, type Renderer } from "./export.js";
import { artifactCsp, attachment, downloadVersion, serveVersion } from "./serve.js";
import { ArtifactError, toArtifact, toVersionInfo, type ArtifactRow, type ArtifactStore } from "./store.js";
import { sharedWith, viewOf } from "../shares/projection.js";
import { isRedactedContent } from "../secrets/known.js";

/** Resource kind of one artifact: its owner, and shared viewers whose projection holds a version of it (#29). */
export const ARTIFACT_KIND = "artifact";
/** Resource kind of a conversation's artifact list: the owner's full list; a shared viewer's projected one (#29). */
export const CONVERSATION_ARTIFACTS_KIND = "conversation-artifacts";

/** Headers of every served original or download, besides its CSP (`serve.ts`). */
export const RAW_HEADERS = {
  ...BASE_HEADERS,
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()",
} as const;

/** The SPA page (index.html) for an app route, and whether it exists; set by buildApp once the UI is known. */
export type AppPage = (url: string) => Promise<string | Buffer | undefined>;

const VERSION = /^[1-9][0-9]{0,5}$/;
/**
 * A version whose content is unreadable (`REDACTED_CONTENT` — a known secret spans its JSON, #53 review): a fixed
 * 409 on every path that would send or render the content. Never partial content, never a 500.
 */
const redacted = (reply: FastifyReply) =>
  reply.code(409).header("Cache-Control", "no-store").send({ error: "artifact_redacted" });
const notFound = (reply: FastifyReply) =>
  reply.code(404).header("Cache-Control", "no-store").send({ error: "not_found" });

/**
 * Artifact API and pages (#27):
 * - `GET /api/conversations/:id/artifacts` — the conversation's artifacts (owner only)
 * - `GET /api/artifacts` — the caller's own artifacts across conversations (#28 "내가 만든 것"; no id: only the
 *   session's user, never anyone else's)
 * - `GET /api/artifacts/:id` — one artifact with its versions; `GET /api/artifacts/:id/versions/:version` — one
 *   version's stored text as JSON (never rendered by the app)
 * - `POST /api/artifacts/:id/revert` `{ version }` — copy an earlier version as the newest
 * - `GET /a/:id` — the app page (viewer); `GET /a/:id/v/:version/raw` — the sandboxed original;
 *   `GET /a/:id/v/:version/download` — the file (`?format=html`: a chart's or table's page as HTML, #28)
 * - `GET /a/:id/v/:version/png` · `/pdf` — rendered by the isolated browser (#51, `export.ts`); the renderer gets
 *   the stored version only — never the request, its cookies or session
 */
export function registerArtifactRoutes(
  app: FastifyInstance,
  conversations: ConversationStore,
  store: ArtifactStore,
  appPage: AppPage,
  renderer?: Pick<Renderer, "render">,
): void {
  app.resources.register(ARTIFACT_KIND, (id) => {
    const a = store.get(id);
    return a
      ? {
          kind: ARTIFACT_KIND,
          id: a.id,
          ownerId: a.userId,
          // Conversation shares and shares of this artifact alike (#29).
          sharedWith: sharedWith(app, a.conversationId, (p) => !!p.versions.get(a.id)?.size, false),
          scope: a.conversationId,
        }
      : undefined;
  });
  app.resources.register(CONVERSATION_ARTIFACTS_KIND, (id) => {
    const c = conversations.get(id);
    return c
      ? {
          kind: CONVERSATION_ARTIFACTS_KIND,
          id: c.id,
          ownerId: c.ownerId,
          sharedWith: sharedWith(app, c.id),
          scope: c.id,
        }
      : undefined;
  });
  const read = { resource: { kind: ARTIFACT_KIND, action: "read" as const } };
  /**
   * A shared viewer (#29) gets only the versions of their projection: anything else is 403 — a version made after a
   * snapshot, or by a message after its boundary. True for the owner.
   */
  const versionAllowed = (req: FastifyRequest, a: ArtifactRow, version: string) => {
    const p = viewOf(app, req, { artifact: a });
    return p === undefined || (!!p && p.versions.get(a.id)?.has(Number(version)) === true);
  };
  const forbidden = (reply: FastifyReply) =>
    reply.code(403).header("Cache-Control", "no-store").send({ error: "forbidden" });

  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/artifacts",
    { config: { resource: { kind: CONVERSATION_ARTIFACTS_KIND, action: "read" } } },
    async (req, reply) => {
      const p = viewOf(app, req, { conversationId: req.params.id });
      if (p === null) return forbidden(reply);
      // A shared viewer (#29): the artifacts with a visible version, each at its newest visible version.
      const items = p
        ? store.list(req.params.id).flatMap((a) => app.sharing!.artifact(a, p) ?? [])
        : store.list(req.params.id).map(toArtifact);
      return reply.header("Cache-Control", "no-store").send({ items } satisfies ArtifactListResponse);
    },
  );

  app.get(
    "/api/artifacts",
    { config: { noResource: "lists only the caller's own artifacts (no id: only the session's user)" } },
    async (req, reply) => {
      const q = MyArtifactsQuery.safeParse(req.query);
      if (!q.success) return deny(reply, 400, "invalid_request");
      const [at, id] = q.data.cursor ? (q.data.cursor.split(":") as [string, string]) : [];
      const page = store.listByUser(
        req.ctx.user!.id,
        q.data.limit,
        at !== undefined && id !== undefined ? { updatedAt: Number(at), id } : undefined,
      );
      return reply.header("Cache-Control", "no-store").send({
        items: page.items.map((a) => ({ ...toArtifact(a), conversationTitle: a.conversationTitle })),
        nextCursor: page.next ? `${page.next.updatedAt}:${page.next.id}` : null,
      } satisfies MyArtifactsResponse);
    },
  );

  app.get<{ Params: { id: string } }>("/api/artifacts/:id", { config: read }, async (req, reply) => {
    const a = store.get(req.params.id)!;
    const p = viewOf(app, req, { artifact: a });
    if (p === null) return forbidden(reply);
    const shared = p && app.sharing!.artifact(a, p);
    if (p && !shared) return forbidden(reply);
    const detail: ArtifactDetail = shared
      ? (() => {
          const { versions: visible, ...artifact } = shared;
          return {
            ...artifact,
            versions: store
              .versions(a.id)
              .filter((v) => visible.includes(v.version))
              .map(toVersionInfo),
          };
        })()
      : { ...toArtifact(a), versions: store.versions(a.id).map(toVersionInfo) };
    return reply.header("Cache-Control", "no-store").send(detail);
  });

  app.get<{ Params: { id: string; version: string } }>(
    "/api/artifacts/:id/versions/:version",
    { config: read },
    async (req, reply) => {
      const a = store.get(req.params.id)!;
      if (!versionAllowed(req, a, req.params.version)) return forbidden(reply);
      const v = VERSION.test(req.params.version)
        ? store.version(req.params.id, Number(req.params.version))
        : undefined;
      if (!v) return notFound(reply);
      if (isRedactedContent(v.content)) return redacted(reply);
      return reply
        .header("Cache-Control", "no-store")
        .send({ version: v.version, kind: a.kind, content: v.content } satisfies ArtifactVersionContent);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/artifacts/:id/revert",
    { config: { resource: { kind: ARTIFACT_KIND, action: "write" } } },
    async (req, reply) => {
      const body = RevertArtifactRequest.safeParse(req.body);
      if (!body.success) return deny(reply, 400, "invalid_request");
      try {
        const { artifact } = store.revert(req.params.id, body.data.version);
        const detail: ArtifactDetail = {
          ...toArtifact(artifact),
          versions: store.versions(artifact.id).map(toVersionInfo),
        };
        return reply.header("Cache-Control", "no-store").send(detail);
      } catch (e) {
        if (!(e instanceof ArtifactError)) throw e;
        if (e.code === "artifact_not_found") return notFound(reply);
        return reply.code(409).header("Cache-Control", "no-store").send({ error: e.code });
      }
    },
  );

  // The viewer is the SPA (apps/web ArtifactPage); refusals keep their status and show the SPA too (login, 403).
  const sendPage = async (reply: FastifyReply, url: string, status: number) => {
    const html = await appPage(url);
    reply.code(status).header("Cache-Control", "no-store").type("text/html; charset=utf-8");
    return reply.send(html ?? "<!doctype html><title>Agent Lee</title>");
  };
  app.get<{ Params: { id: string } }>(
    "/a/:id",
    {
      config: {
        ...read,
        deniedPage: (reply, status) => sendPage(reply, reply.request.url, status),
      },
    },
    async (req, reply) => sendPage(reply, req.url, 200),
  );

  app.get<{ Params: { id: string; version: string } }>(
    "/a/:id/v/:version/raw",
    { config: read },
    async (req, reply) => {
      const a = store.get(req.params.id)!;
      if (!versionAllowed(req, a, req.params.version)) return forbidden(reply);
      const v = VERSION.test(req.params.version)
        ? store.version(a.id, Number(req.params.version))
        : undefined;
      if (v && isRedactedContent(v.content)) return redacted(reply);
      // In the app's frame: Escape inside the artifact reaches the panel (#28, `ESCAPE_BRIDGE`).
      const served = v && serveVersion(a.kind, v.title, v.content, { escapeBridge: true });
      if (!served) return notFound(reply);
      // The CSP set here is kept by the app's onSend hook (it adds the app CSP only where none is set).
      return reply
        .headers(RAW_HEADERS)
        .header(
          "Content-Security-Policy",
          // One header line per policy (Fastify sends an array as repeated headers).
          served.csp.length === 1 ? served.csp[0]! : [...served.csp],
        )
        .type(served.type)
        .send(served.body);
    },
  );

  app.get<{ Params: { id: string; version: string }; Querystring: { format?: unknown } }>(
    "/a/:id/v/:version/download",
    { config: read },
    async (req, reply) => {
      const a = store.get(req.params.id)!;
      if (!versionAllowed(req, a, req.params.version)) return forbidden(reply);
      const v = VERSION.test(req.params.version)
        ? store.version(a.id, Number(req.params.version))
        : undefined;
      const format = req.query.format;
      if (format !== undefined && (format !== "html" || !ARTIFACT_HTML_DOWNLOAD.has(a.kind)))
        return notFound(reply);
      if (v && isRedactedContent(v.content)) return redacted(reply);
      // `?format=html` (#28): the page the original is served as (server-drawn, no script), as a file.
      const page = v && format === "html" ? serveVersion(a.kind, v.title, v.content) : undefined;
      const file = page
        ? { type: page.type, body: page.body, ext: "html" }
        : v && format === undefined
          ? downloadVersion(a.kind, v.content, v.language ?? null)
          : undefined;
      if (!v || !file) return notFound(reply);
      return (
        reply
          .headers(RAW_HEADERS)
          // A download is never rendered by the app; if a browser shows it anyway it is as sandboxed as the original.
          .header("Content-Security-Policy", artifactCsp([]))
          .header("Content-Disposition", attachment(v.title, file.ext))
          .type(file.type)
          .send(file.body)
      );
    },
  );

  for (const format of EXPORT_FORMATS)
    app.get<{ Params: { id: string; version: string } }>(
      `/a/:id/v/:version/${format}`,
      { config: read },
      async (req, reply) => {
        const a = store.get(req.params.id)!;
        if (!versionAllowed(req, a, req.params.version)) return forbidden(reply);
        const v = VERSION.test(req.params.version)
          ? store.version(a.id, Number(req.params.version))
          : undefined;
        if (v && isRedactedContent(v.content)) return redacted(reply);
        const doc =
          v && exportFormats(a.kind).includes(format)
            ? exportDocument(a.kind, v.title, v.content)
            : undefined;
        if (!v || !doc) return notFound(reply);
        const started = Date.now();
        const done = (exportCode: ExportCode) =>
          logEvent(req.log, exportCode === "export_ok" ? "info" : "warn", "artifact.exported", {
            userId: req.ctx.user!.id,
            exportFormat: format,
            exportCode,
            durationMs: Date.now() - started,
          });
        const r = renderer
          ? await renderer.render({ format, doc, scripts: a.kind === "html" })
          : ({ ok: false, code: "export_unavailable" } as const);
        if (!r.ok) {
          done(r.code);
          if (r.code === "export_busy") reply.header("Retry-After", "5");
          return reply
            .code(EXPORT_STATUS[r.code])
            .header("Cache-Control", "no-store")
            .send({ error: r.code });
        }
        done("export_ok");
        return reply
          .headers(RAW_HEADERS)
          .header("Content-Security-Policy", artifactCsp([]))
          .header("Content-Disposition", attachment(v.title, format))
          .type(r.type)
          .send(r.body);
      },
    );
}

const EXPORT_STATUS: Record<Exclude<ExportCode, "export_ok">, number> = {
  export_unavailable: 503,
  export_busy: 503,
  export_timeout: 504,
  export_limit: 413,
  export_failed: 502,
};
