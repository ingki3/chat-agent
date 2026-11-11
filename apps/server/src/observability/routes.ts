import type { FastifyInstance, FastifyRequest } from "fastify";
import { RecentError, type RecentErrorsResponse } from "@agentlee/shared";
import { deny } from "../auth/plugin.js";
import { logEvent } from "../logging.js";
import { classifyError, type ErrorLog } from "./errors.js";

/** Public error codes for client errors, by status. Anything else is "bad_request". */
export const PUBLIC_4XX: Record<number, string> = {
  400: "invalid_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  406: "not_acceptable",
  408: "request_timeout",
  409: "conflict",
  413: "payload_too_large",
  414: "uri_too_long",
  415: "unsupported_media_type",
  429: "too_many_requests",
  431: "headers_too_large",
};

const routeOf = (req: FastifyRequest) => `${req.method} ${req.routeOptions?.url || "<unmatched>"}`;

/**
 * Error handler for every route (#46). A 5xx answers `{ error: "internal_error" }` — Fastify's default would send
 * the error's message, which may hold user data or SDK text — and is logged and recorded with a code only.
 * 4xx errors (bad JSON, body too large, …) answer `{ error: <fixed code for the status> }` — never the error's
 * message or code, which a route or plugin may have filled with request data.
 */
export function registerErrorHandling(app: FastifyInstance, errors: ErrorLog | undefined): void {
  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: unknown; code?: unknown };
    const status =
      typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    const userId = req.ctx?.user?.id;
    const c = classifyError(err);
    if (status >= 500) {
      logEvent(req.log, "error", "request.error", {
        err,
        errorCode: c.code,
        category: c.category,
        ...(userId ? { userId } : {}),
      });
      errors?.record({
        source: "http",
        code: c.code,
        category: c.category,
        route: routeOf(req),
        statusCode: status,
        userId,
      });
      return reply.code(status).header("Cache-Control", "no-store").send({ error: "internal_error" });
    }
    logEvent(req.log, "info", "request.error", { err, errorCode: c.code, category: c.category });
    // Never the error's own message or code: a fixed public code per status.
    return reply
      .code(status)
      .header("Cache-Control", "no-store")
      .send({ error: PUBLIC_4XX[status] ?? "bad_request" });
  });
}

/** `GET /api/admin/errors?limit=50&source=run` — the admin "최근 오류" data (FR-10.4; the screen is #35). */
export function registerErrorRoutes(app: FastifyInstance, errors: ErrorLog): void {
  app.get<{ Querystring: { limit?: string; source?: string } }>(
    "/api/admin/errors",
    { config: { auth: "admin", noResource: "admin-only error list (IDs and codes only)" } },
    async (req, reply) => {
      const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return deny(reply, 400, "invalid_request");
      const source =
        req.query.source === undefined ? undefined : RecentError.shape.source.safeParse(req.query.source);
      if (source && !source.success) return deny(reply, 400, "invalid_request");
      const body: RecentErrorsResponse = {
        errors: errors.recent({ limit, ...(source?.success ? { source: source.data } : {}) }),
      };
      return reply.header("Cache-Control", "no-store").send(body);
    },
  );
}
