import net from "node:net";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CSRF_HEADER, type AuthError, type AuthUser } from "@agentlee/shared";
import type { Config } from "../config.js";
import { isApiRequest, isPublicLinkPath, routerPath } from "../paths.js";
import { knownSecrets } from "../secrets/known.js";
import type { AccessVerifier } from "./access-jwt.js";
import "./context.js";
import { toAuthUser, type UserRow, type UserStore } from "./users.js";

export const SESSION_COOKIE = "al_session";
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const deny = (reply: FastifyReply, status: number, error: AuthError) =>
  reply.code(status).header("Cache-Control", "no-store").send({ error });

/** Access tokens registered as known secrets, with the timer that forgets each when it expires. */
const accessTokens = new Map<string, NodeJS.Timeout>();
function rememberAccessToken(token: string, expiresAt: number | undefined): void {
  if (accessTokens.has(token)) return;
  knownSecrets.add(token);
  // Cloudflare tokens last hours; without `exp` (never: it is required) a day.
  const ms = Math.max(0, (expiresAt ?? Date.now() + 86_400_000) - Date.now()) + 60_000;
  const timer = setTimeout(
    () => {
      accessTokens.delete(token);
      knownSecrets.remove(token);
    },
    Math.min(ms, 2 ** 31 - 1),
  );
  timer.unref();
  accessTokens.set(token, timer);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** All values of a header as sent on the wire (Node folds duplicate Host headers into one). */
function rawHeaderValues(req: FastifyRequest, name: string): string[] {
  const raw = req.raw.rawHeaders;
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) out.push(raw[i + 1]!);
  return out;
}

/** `GET|HEAD /api/health` — the only thing an Access service token may reach. */
export const isHealthCheck = (req: FastifyRequest) =>
  (req.method === "GET" || req.method === "HEAD") && routerPath(req.url) === "/api/health";

export type TrustDeps = { config: Config; verifier: AccessVerifier | undefined };

/**
 * A public artifact link request (#204) — the one exemption from Access and the app login, and it is exactly this:
 * public links switched on (`PUBLIC_LINKS_ENABLED=1`), a GET or HEAD, a path of the exact shape `/artifact/<token>`
 * (`/raw`, `/download`) — `isPublicLinkPath` — **and** the matched route is one of the three public link routes
 * (`config.publicLink`). Anything else under `/artifact/`, `/artifacts`, `/a/…` or `/api/…` is not.
 * test/public-links.test.ts sends every other route of the app without an Access JWT and expects it refused.
 */
export const isPublicLinkRequest = (req: FastifyRequest, config: Config) =>
  config.publicLinks &&
  (req.method === "GET" || req.method === "HEAD") &&
  req.routeOptions.config?.publicLink === true &&
  isPublicLinkPath(req.url);

/**
 * Trust boundary (PRD FR-1.3/1.4, issue #9). Runs before every route, static file and the temporary gate:
 * - Host = PUBLIC_HOST → a valid Access JWT is required (fail closed when Access is not configured, unless the
 *   temporary code gate is on).
 * - Host = localhost/127.0.0.1/[::1] with no `Cf-*` header → local request (app login only).
 * - Anything else, a repeated Host, or a local Host carrying `Cf-*` headers → refused.
 */
export function registerTrustBoundary(app: FastifyInstance, deps: TrustDeps): void {
  const { config, verifier } = deps;
  app.decorateRequest("ctx", null as never);
  // A public link answer (#204) never sets a cookie, whatever route code might try.
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.ctx?.publicLink) reply.removeHeader("set-cookie");
    return payload;
  });

  app.addHook("onRequest", async (req, reply) => {
    const hosts = rawHeaderValues(req, "host");
    if (hosts.length !== 1) return deny(reply, 400, "bad_host");
    const host = hosts[0]!.trim().toLowerCase();
    const ctx = (req.ctx = {
      origin: "local",
      clientIp: req.ip,
      accessEmail: undefined,
      user: undefined,
      sessionToken: undefined,
      emailMismatch: false,
      publicLink: isPublicLinkRequest(req, config),
    } as FastifyRequest["ctx"]);

    if (host === config.publicHost) {
      ctx.origin = "edge";
      const ip = req.headers["cf-connecting-ip"];
      ctx.clientIp = typeof ip === "string" && net.isIP(ip) ? ip : "unknown";
      // A public link (#204): Cloudflare lets it through without Access (the Bypass application for `/artifact/`), so
      // no JWT is required — and one that comes along (a family member's browser) is neither verified nor used.
      if (ctx.publicLink) return;
      if (!verifier) {
        if (!config.tempGateCode) return deny(reply, 403, "access_not_configured");
        return; // the temporary gate (gate.ts) guards edge requests until Access exists
      }
      const token = req.headers["cf-access-jwt-assertion"];
      if (typeof token !== "string" || !token) return deny(reply, 403, "access_denied");
      let id;
      try {
        id = await verifier(token);
      } catch {
        return deny(reply, 403, "access_denied");
      }
      // A verified Access token is a bearer credential the server knows (round 28): registered on first sight —
      // not fresh, since the person may have pasted it somewhere already (a rescrub pass looks for it) — and
      // forgotten when it expires.
      rememberAccessToken(token, id.expiresAt);
      if ("email" in id) ctx.accessEmail = id.email;
      // A service token (no person behind it) may only read the health check — the external uptime probe.
      else if (!isHealthCheck(req)) return deny(reply, 403, "access_denied");
      return;
    }

    if (!LOCAL_HOST.test(host)) return deny(reply, 403, "bad_host");
    // A loopback Host with Cloudflare headers is a tunnel request pretending to be local (or a forged one).
    for (let i = 0; i < req.raw.rawHeaders.length; i += 2)
      if (req.raw.rawHeaders[i]!.toLowerCase().startsWith("cf-")) return deny(reply, 403, "bad_host");
  });
}

/**
 * CSRF (state-changing API calls): `Origin` must be this service's own origin for the request's trust zone, and
 * the custom header must be present (a cross-site form cannot set it). GET never changes state.
 */
export function registerCsrf(app: FastifyInstance, config: Config): void {
  app.addHook("onRequest", async (req, reply) => {
    // All API calls, and any route that acts on a resource (non-API ones like /a/:id included).
    if (SAFE_METHODS.has(req.method) || !(isApiRequest(req) || req.routeOptions.config?.resource)) return;
    const expected =
      req.ctx.origin === "edge"
        ? `https://${config.publicHost}`
        : `http://${String(req.headers.host).toLowerCase()}`;
    const origin = req.headers.origin;
    if (origin !== expected || req.headers[CSRF_HEADER] !== "1") return deny(reply, 403, "csrf");
  });
}

/** Resolves the session cookie to an active user and checks it against the Access email. */
export function registerSession(app: FastifyInstance, users: UserStore | undefined): void {
  app.addHook("onRequest", async (req) => {
    // A public link (#204) reads no cookie: whoever opens it is nobody to the app.
    if (!users || req.ctx.publicLink) return;
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!token) return;
    const user = users.sessionUser(token);
    if (!user) return;
    if (req.ctx.accessEmail !== undefined && req.ctx.accessEmail !== user.email) {
      req.ctx.emailMismatch = true;
      return;
    }
    req.ctx.user = user;
    req.ctx.sessionToken = token;
  });

  // Route rules. API routes are private unless they opt out, so a new route cannot be public by accident.
  app.addHook("preHandler", async (req, reply) => {
    const cfg = req.routeOptions.config ?? {};
    const rule = cfg.auth ?? (isApiRequest(req) ? "user" : "public");
    if (rule === "public") return;
    if (req.ctx.emailMismatch) return deny(reply, 403, "access_email_mismatch");
    const user = req.ctx.user;
    if (!user) return deny(reply, 401, "unauthenticated");
    if (passwordChangePending(req, user) && !cfg.allowPendingPassword)
      return deny(reply, 403, "password_change_required");
    if (rule === "admin" && user.role !== "admin") return deny(reply, 403, "forbidden");
  });
}

/**
 * A temporary password must be replaced before the app can be used (FR-1.5) — but only where the password is what
 * signed the user in. Through Cloudflare Access (#178) every request carries a verified Access login whose email is
 * the session's own (`registerSession` refuses any other pairing), so the password plays no part there: the flag
 * stays for the next local login and is not enforced on Access requests.
 */
export const passwordChangePending = (req: FastifyRequest, user: Pick<UserRow, "mustChangePassword">) =>
  user.mustChangePassword && req.ctx.accessEmail === undefined;

/** The signed-in user as the client sees it: the password-change flag as it applies to this request. */
export const authUserFor = (req: FastifyRequest, user: UserRow): AuthUser => ({
  ...toAuthUser(user),
  mustChangePassword: passwordChangePending(req, user),
});

export function sessionCookie(req: FastifyRequest, token: string, maxAgeSec: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
    // Only plain-http localhost goes without Secure (PRD FR-1.2).
    ...(req.ctx.origin === "edge" ? ["Secure"] : []),
  ].join("; ");
}
