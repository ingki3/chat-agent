import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ARTIFACT_EXPORTS,
  CreatePublicLinkRequest,
  PUBLIC_LINK_MAX_ACTIVE,
  publicLinkPath,
  type AdminPublicLinksResponse,
  type ArtifactKind,
  type CreatePublicLinkResponse,
  type PublicLink,
  type PublicLinkCheck,
  type PublicLinkSettings,
  type PublicLinksResponse,
} from "@agentlee/shared";
import { deny } from "../auth/plugin.js";
import { FailureLimiter } from "../auth/rate-limit.js";
import type { Config } from "../config.js";
import { logEvent } from "../logging.js";
import { isRedactedContent, scrubKnown } from "../secrets/known.js";
import { ARTIFACT_KIND, RAW_HEADERS } from "../artifacts/routes.js";
import { exportDocument, exportFormats, type Renderer } from "../artifacts/export.js";
import { artifactCsp, attachment, downloadVersion, escapeHtml, serveVersion } from "../artifacts/serve.js";
import type { ArtifactStore } from "../artifacts/store.js";
import { checkVersion } from "./check.js";
import {
  decodeCursor,
  encodeCursor,
  statusOf,
  type LiveLink,
  type PublicLinkRow,
  type PublicLinkStore,
} from "./store.js";

export const PUBLIC_LINK_KIND = "public-link";
/** Expired and turned-off links per page of a list (open links are always listed in full). */
export const HISTORY_PAGE = 50;

/**
 * Headers of every public link response (#204): never cached by anything between (and not kept by the browser), never
 * indexed, no referrer sent onwards. `RAW_HEADERS` adds CORP same-origin and the Permissions-Policy.
 */
export const PUBLIC_HEADERS = {
  ...RAW_HEADERS,
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

/**
 * CSP of the public viewer page: no script at all (the page is plain HTML — not the app, none of its bundle), styles
 * inline, the one frame from this origin (the sandboxed original), and nobody may frame the page itself.
 */
export const VIEWER_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "img-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Rate limits of the public routes, per link and for all links together (sliding windows). */
export type PublicLinkLimits = {
  /** Page, original and HTML/original downloads. */
  perLink: number;
  global: number;
  windowMs: number;
  /** PNG/PDF renders (the isolated browser, #51): far fewer. */
  renderPerLink: number;
  renderGlobal: number;
  renderWindowMs: number;
};
export const PUBLIC_LINK_LIMITS: PublicLinkLimits = {
  perLink: 120,
  global: 1200,
  windowMs: 60_000,
  renderPerLink: 10,
  renderGlobal: 30,
  renderWindowMs: 10 * 60_000,
};

class Limits {
  private readonly link: FailureLimiter;
  private readonly all: FailureLimiter;
  private readonly renderLink: FailureLimiter;
  private readonly renderAll: FailureLimiter;
  constructor(l: PublicLinkLimits, now?: () => number) {
    this.link = new FailureLimiter(l.perLink, l.windowMs, now);
    this.all = new FailureLimiter(l.global, l.windowMs, now);
    this.renderLink = new FailureLimiter(l.renderPerLink, l.renderWindowMs, now);
    this.renderAll = new FailureLimiter(l.renderGlobal, l.renderWindowMs, now);
  }
  /** Every public request, a token that names nothing too (guessing is bounded by the global window). */
  any(): boolean {
    if (this.all.blocked("all")) return false;
    this.all.fail("all");
    return true;
  }
  perLink(id: string): boolean {
    if (this.link.blocked(id)) return false;
    this.link.fail(id);
    return true;
  }
  render(id: string): boolean {
    if (this.renderAll.blocked("all") || this.renderLink.blocked(id)) return false;
    this.renderAll.fail("all");
    this.renderLink.fail(id);
    return true;
  }
}

const KIND_LABEL: Record<ArtifactKind, string> = {
  html: "HTML",
  svg: "SVG",
  markdown: "마크다운",
  code: "코드",
  chart: "차트",
  table: "표",
  document: "문서",
};

const ORIGINAL_LABEL: Record<ArtifactKind, string> = {
  html: "HTML 원본",
  svg: "SVG 원본",
  markdown: "마크다운 원본(.md)",
  code: "코드 원본",
  chart: "SVG",
  table: "CSV",
  document: "원본",
};

const PAGE_STYLE =
  ":root{color-scheme:light dark;--bg:#f6f5f2;--fg:#23211d;--muted:#6b6860;--line:#dedad2;--card:#fff;--accent:#2f5bd3}" +
  "@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe7;--muted:#a3a097;--line:#3a3833;--card:#1d1c1a;--accent:#8aa8ff}}" +
  "*{box-sizing:border-box}html,body{height:100%}body{margin:0;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);" +
  "font:15px/1.5 system-ui,-apple-system,'Apple SD Gothic Neo',sans-serif}" +
  "header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}" +
  "h1{margin:0;font-size:17px;flex:1 1 240px;min-width:0;overflow-wrap:anywhere}.kind{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted)}" +
  "nav{display:flex;flex-wrap:wrap;gap:8px}nav a{font-size:13px;color:var(--accent);text-decoration:none;border:1px solid var(--line);border-radius:8px;padding:4px 10px;background:var(--card)}" +
  "main{flex:1;display:flex;min-height:60vh}iframe{flex:1;width:100%;border:0;background:#fff}" +
  "footer{padding:10px 16px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}" +
  ".gone{margin:auto;padding:32px 16px;text-align:center;max-width:420px}";

const day = (ms: number) =>
  new Date(ms).toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

/** The public page: title, downloads, the sandboxed original in a frame, the footer. No script. */
function viewerHtml(token: string, kind: ArtifactKind, title: string, expiresAt: number): string {
  const base = publicLinkPath(token);
  const downloads = [
    kind === "document" ? undefined : [`${base}/download`, `${ORIGINAL_LABEL[kind]} 내려받기`],
    HTML_PAGE(kind) ? [`${base}/download?format=html`, "HTML 내려받기"] : undefined,
    ...exportFormats(kind).map((f) => [`${base}/download?format=${f}`, `${f.toUpperCase()} 내려받기`]),
  ].filter((x): x is [string, string] => !!x);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>
<body><header><h1 data-testid="public-title">${escapeHtml(title)}</h1><span class="kind">${KIND_LABEL[kind]}</span>
<nav aria-label="내려받기">${downloads
    .map(
      ([href, label]) =>
        `<a href="${escapeHtml(href)}" download rel="nofollow noreferrer">${escapeHtml(label)}</a>`,
    )
    .join("")}</nav></header>
<main><iframe src="${escapeHtml(base)}/raw" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeHtml(title)}" data-testid="public-frame"></iframe></main>
<footer>Agent Lee에서 공유됨 · ${escapeHtml(day(expiresAt))}까지 열려 있어요</footer></body></html>`;
}

const GONE_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Agent Lee</title><style>${PAGE_STYLE}</style></head>
<body><main><div class="gone" role="alert"><h1>링크를 열 수 없어요</h1><p>없는 링크이거나, 만료됐거나, 공유한 사람이 껐어요.</p></div></main></body></html>`;

/**
 * Kinds whose served page is HTML made by the server (`?format=html`): an html artifact's original already is its HTML,
 * an SVG is served as itself.
 */
const HTML_PAGE = (kind: ArtifactKind) =>
  kind === "markdown" || kind === "code" || kind === "chart" || kind === "table";

/** Kinds a public link can show: everything with a served original (`document` has none yet, #49). */
const LINKABLE = (kind: ArtifactKind) => kind !== "document";

export type PublicLinkRouteOptions = {
  config: Config;
  store: PublicLinkStore;
  artifacts: ArtifactStore;
  renderer?: Pick<Renderer, "render"> | undefined;
  limits?: Partial<PublicLinkLimits>;
  now?: () => number;
};

/**
 * Public artifact links (#204, PRD FR-14.7 v0.7, docs/decisions/isolation.md "공개 링크").
 *
 * Owner API (app login, like every other API route):
 * - `GET /api/public-links/settings` — whether the server offers them, the cap and how many I have on
 * - `GET /api/public-links[?artifactId=]` — my links (never their tokens)
 * - `GET /api/artifacts/:id/public-links/check[?version=]` — what the pre-publish check finds in a version
 * - `POST /api/artifacts/:id/public-links` `{ version, expiresInDays }` — a new link (owner only: action `share`);
 *   refused for a known secret value; the token is in the answer once
 * - `DELETE /api/public-links/:id` — turn mine off
 * Admin (FR-1.5 — no title, no content): `GET /api/admin/public-links`, `POST /api/admin/public-links/:id/disable`.
 *
 * Public (no Access, no login — `isPublicLinkRequest`): `GET /artifact/:token` (the page), `/raw` (the sandboxed
 * original, the same CSP as `/a/:id/v/:ver/raw`), `/download[?format=html|png|pdf]`. Any token that is malformed,
 * unknown, expired, off, or whose artifact, conversation or owner is gone: the same 404.
 */
export function registerPublicLinkRoutes(app: FastifyInstance, o: PublicLinkRouteOptions): void {
  const { config, store, artifacts } = o;
  const now = o.now ?? Date.now;
  const limits = new Limits({ ...PUBLIC_LINK_LIMITS, ...o.limits }, o.now);

  app.resources.register(PUBLIC_LINK_KIND, (id) => {
    const l = store.get(id);
    return l ? { kind: PUBLIC_LINK_KIND, id: l.id, ownerId: l.ownerId } : undefined;
  });

  const toLink = (r: { link: PublicLinkRow; title: string; kind: ArtifactKind }): PublicLink => ({
    id: r.link.id,
    artifactId: r.link.artifactId,
    artifactTitle: scrubKnown(r.title),
    kind: r.kind,
    version: r.link.version,
    createdAt: r.link.createdAt,
    expiresAt: r.link.expiresAt,
    disabledAt: r.link.disabledAt,
    viewCount: r.link.viewCount,
    lastViewedAt: r.link.lastViewedAt,
    status: statusOf(r.link, now()),
  });
  const code = (reply: FastifyReply, status: number, error: string) =>
    reply.code(status).header("Cache-Control", "no-store").send({ error });
  const off = (reply: FastifyReply) => code(reply, 403, "public_links_disabled");
  const event = (req: FastifyRequest, publicLinkCode: string, userId?: string) =>
    logEvent(req.log, "info", "public_link.event", { publicLinkCode, ...(userId ? { userId } : {}) });

  /** The version to check or link: the one asked for, else the newest. */
  const pickVersion = (a: { id: string; latestVersion: number }, raw: unknown) => {
    const n = raw === undefined ? a.latestVersion : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  /** The pre-publish check of a stored version (its text as written: a secret registered later is still found). */
  const check = (artifactId: string, version: number): PublicLinkCheck | undefined => {
    const v = store.storedVersion(artifactId, version);
    return v && checkVersion({ version, title: v.title, content: v.content });
  };

  app.get(
    "/api/public-links/settings",
    { config: { noResource: "the caller's own count and the server switch" } },
    async (req, reply) =>
      reply.header("Cache-Control", "no-store").send({
        enabled: config.publicLinks,
        maxActive: PUBLIC_LINK_MAX_ACTIVE,
        active: store.activeCount(req.ctx.user!.id),
      } satisfies PublicLinkSettings),
  );

  app.get<{ Querystring: { artifactId?: unknown; cursor?: unknown } }>(
    "/api/public-links",
    { config: { noResource: "lists only the caller's own links (no id: only the session's user)" } },
    async (req, reply) => {
      const artifactId = typeof req.query.artifactId === "string" ? req.query.artifactId : undefined;
      const cursor = decodeCursor(req.query.cursor);
      if (cursor === "invalid") return deny(reply, 400, "invalid_request");
      const owner = req.ctx.user!.id;
      const history = store.historyByOwner(owner, {
        ...(artifactId !== undefined ? { artifactId } : {}),
        ...(cursor ? { cursor } : {}),
        limit: HISTORY_PAGE,
      });
      return reply.header("Cache-Control", "no-store").send({
        // The first page carries every open link; later pages only more history.
        active: cursor ? [] : store.activeByOwner(owner, artifactId).map(toLink),
        history: history.items.map(toLink),
        nextCursor: encodeCursor(history.next),
      } satisfies PublicLinksResponse);
    },
  );

  const share = { resource: { kind: ARTIFACT_KIND, action: "share" as const } };

  app.get<{ Params: { id: string }; Querystring: { version?: unknown } }>(
    "/api/artifacts/:id/public-links/check",
    { config: share },
    async (req, reply) => {
      if (!config.publicLinks) return off(reply);
      const a = artifacts.get(req.params.id)!;
      const version = pickVersion(a, req.query.version);
      const found = version === undefined ? undefined : check(a.id, version);
      if (!found) return code(reply, 404, "not_found");
      return reply.header("Cache-Control", "no-store").send(found);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/artifacts/:id/public-links",
    { config: share },
    async (req, reply) => {
      if (!config.publicLinks) return off(reply);
      const body = CreatePublicLinkRequest.safeParse(req.body ?? {});
      if (!body.success) return deny(reply, 400, "invalid_request");
      const user = req.ctx.user!;
      const a = artifacts.get(req.params.id)!;
      // `share` is the owner's alone (policy.ts); said again here — a link is never made of someone else's artifact.
      if (a.userId !== user.id) return deny(reply, 403, "forbidden");
      if (!LINKABLE(a.kind)) return code(reply, 409, "public_link_unsupported");
      const v = artifacts.version(a.id, body.data.version);
      if (!v) return code(reply, 404, "not_found");
      if (isRedactedContent(v.content)) return code(reply, 409, "artifact_redacted");
      const found = check(a.id, v.version)!;
      if (found.secret) {
        event(req, "public_link_secret", user.id);
        return code(reply, 422, "public_link_secret");
      }
      if (store.activeCount(user.id) >= PUBLIC_LINK_MAX_ACTIVE) return code(reply, 409, "public_link_limit");
      const { row, token } = store.create({
        ownerId: user.id,
        artifactId: a.id,
        version: v.version,
        days: body.data.expiresInDays,
      });
      event(req, "public_link_created", user.id);
      return reply
        .code(201)
        .header("Cache-Control", "no-store")
        .send({
          link: toLink({ link: row, title: v.title, kind: a.kind }),
          path: publicLinkPath(token),
          // The address outsiders open: always the public host over https, wherever the owner made it from.
          url: `https://${config.publicHost}${publicLinkPath(token)}`,
          check: found,
        } satisfies CreatePublicLinkResponse);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/public-links/:id",
    { config: { resource: { kind: PUBLIC_LINK_KIND, action: "write" } } },
    async (req, reply) => {
      if (store.disable(req.params.id)) event(req, "public_link_disabled", req.ctx.user!.id);
      const r = store.withArtifact(req.params.id);
      if (!r) return code(reply, 404, "not_found");
      return reply.header("Cache-Control", "no-store").send(toLink(r));
    },
  );

  const admin = (what: string) => ({ auth: "admin" as const, noResource: what });
  app.get<{ Querystring: { cursor?: unknown } }>(
    "/api/admin/public-links",
    { config: admin("admin-only counts and expiry of every link (no title, no content)") },
    async (req, reply) => {
      const at = now();
      const cursor = decodeCursor(req.query.cursor);
      if (cursor === "invalid") return deny(reply, 400, "invalid_request");
      const row = (r: { link: PublicLinkRow; ownerName: string }) => ({
        id: r.link.id,
        ownerName: r.ownerName,
        createdAt: r.link.createdAt,
        expiresAt: r.link.expiresAt,
        disabledAt: r.link.disabledAt,
        viewCount: r.link.viewCount,
        status: statusOf(r.link, at),
      });
      const history = store.historyAll({ ...(cursor ? { cursor } : {}), limit: HISTORY_PAGE });
      return reply.header("Cache-Control", "no-store").send({
        enabled: config.publicLinks,
        counts: store.counts(),
        active: cursor ? [] : store.activeAll().map(row),
        history: history.items.map(row),
        nextCursor: encodeCursor(history.next),
      } satisfies AdminPublicLinksResponse);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/admin/public-links/:id/disable",
    { config: admin("the admin turns any link off (FR-10: no content is read)") },
    async (req, reply) => {
      if (!store.get(req.params.id)) return code(reply, 404, "not_found");
      if (store.disable(req.params.id)) event(req, "public_link_disabled", req.ctx.user!.id);
      return reply.header("Cache-Control", "no-store").send({ ok: true });
    },
  );

  // An owner deactivated: every link of theirs off, for good (a reactivation does not bring them back).
  app.appEvents.on("user-access-changed", (e) => {
    if (e.reason === "deactivated") store.disableAllOf(e.userId);
  });

  // ---- The public routes ----

  const publicRoute = {
    auth: "public" as const,
    publicLink: true,
    noResource: "public artifact link: the token is the only permission (PublicLinkStore.live)",
  };
  const gone = (reply: FastifyReply) =>
    reply
      .code(404)
      .headers(PUBLIC_HEADERS)
      .header("Content-Security-Policy", VIEWER_CSP)
      .type("text/html; charset=utf-8")
      .send(GONE_HTML);
  const limited = (req: FastifyRequest, reply: FastifyReply, retryAfter: number) => {
    event(req, "public_link_rate_limited");
    return reply
      .code(429)
      .headers(PUBLIC_HEADERS)
      .header("Retry-After", String(retryAfter))
      .header("Content-Security-Policy", artifactCsp([]))
      .send({ error: "rate_limited" });
  };
  /** The live link and its (scrubbed) version, or undefined → 404. Rate limits first. */
  const resolve = (
    req: FastifyRequest<{ Params: { token: string } }>,
    reply: FastifyReply,
  ): { live: LiveLink; title: string; content: string; language: string | null } | "limited" | undefined => {
    if (!config.publicLinks) return undefined;
    if (!limits.any()) return (limited(req, reply, 60), "limited");
    const live = store.live(req.params.token);
    if (!live || !LINKABLE(live.artifact.kind)) return undefined;
    if (!limits.perLink(live.link.id)) return (limited(req, reply, 60), "limited");
    const v = artifacts.version(live.artifact.id, live.link.version);
    if (!v || isRedactedContent(v.content)) return undefined;
    return { live, title: v.title, content: v.content, language: v.language ?? null };
  };

  app.get<{ Params: { token: string } }>("/artifact/:token", { config: publicRoute }, async (req, reply) => {
    const r = resolve(req, reply);
    if (r === "limited") return reply;
    if (!r) return gone(reply);
    if (req.method === "GET") {
      store.recordView(r.live.link.id);
      event(req, "public_link_viewed");
    }
    return reply
      .headers(PUBLIC_HEADERS)
      .header("Content-Security-Policy", VIEWER_CSP)
      .type("text/html; charset=utf-8")
      .send(viewerHtml(req.params.token, r.live.artifact.kind, r.title, r.live.link.expiresAt));
  });

  app.get<{ Params: { token: string } }>(
    "/artifact/:token/raw",
    { config: publicRoute },
    async (req, reply) => {
      const r = resolve(req, reply);
      if (r === "limited") return reply;
      // Exactly as `/a/:id/v/:ver/raw` serves it (serve.ts): `sandbox allow-scripts`, `connect-src 'none'`, scripts by
      // hash and the allow-listed CDN URLs with SRI only. No Escape bridge: there is no app around it.
      const served = r && serveVersion(r.live.artifact.kind, r.title, r.content);
      if (!served) return gone(reply);
      return reply
        .headers(PUBLIC_HEADERS)
        .header("Content-Security-Policy", served.csp.length === 1 ? served.csp[0]! : [...served.csp])
        .type(served.type)
        .send(served.body);
    },
  );

  app.get<{ Params: { token: string }; Querystring: { format?: unknown } }>(
    "/artifact/:token/download",
    { config: publicRoute },
    async (req, reply) => {
      // Order (review #209): the rate limits come first — every request counts, a malformed one too — then the
      // format, then (PNG/PDF) the render limit, and only then is a document prepared.
      const r = resolve(req, reply);
      if (r === "limited") return reply;
      if (!r) return gone(reply);
      const format = req.query.format;
      if (format !== undefined && format !== "html" && format !== "png" && format !== "pdf")
        return gone(reply);
      const kind = r.live.artifact.kind;
      const send = (type: string, body: string | Buffer, ext: string) =>
        reply
          .headers(PUBLIC_HEADERS)
          // A download is never rendered by the page; if a browser shows it anyway it is as sandboxed as the original.
          .header("Content-Security-Policy", artifactCsp([]))
          .header("Content-Disposition", attachment(r.title, ext))
          .type(type)
          .send(body);
      if (format === undefined) {
        const file = downloadVersion(kind, r.content, r.language);
        return file ? send(file.type, file.body, file.ext) : gone(reply);
      }
      if (format === "html") {
        if (!HTML_PAGE(kind)) return gone(reply);
        const page = serveVersion(kind, r.title, r.content);
        return page ? send(page.type, page.body, "html") : gone(reply);
      }
      if (!ARTIFACT_EXPORTS[kind].includes(format)) return gone(reply);
      if (!limits.render(r.live.link.id)) return limited(req, reply, 600);
      const doc = exportDocument(kind, r.title, r.content);
      if (!doc) return gone(reply);
      const out = o.renderer
        ? await o.renderer.render({ format, doc, scripts: kind === "html" })
        : ({ ok: false, code: "export_unavailable" } as const);
      if (!out.ok) {
        if (out.code === "export_busy") reply.header("Retry-After", "5");
        return reply
          .code(out.code === "export_limit" ? 413 : out.code === "export_timeout" ? 504 : 503)
          .headers(PUBLIC_HEADERS)
          .header("Content-Security-Policy", artifactCsp([]))
          .send({ error: out.code });
      }
      return send(out.type, out.body, format);
    },
  );
}
