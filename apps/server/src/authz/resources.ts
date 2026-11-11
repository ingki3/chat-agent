import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { deny } from "../auth/plugin.js";
import type { UserStore } from "../auth/users.js";
import { isApiPath } from "../paths.js";
import { can, type Action, type ResourceRef } from "./policy.js";

export type ResourceLoader = (id: string) => ResourceRef | undefined;

/**
 * Route declaration: which resource the request names and what the route does with it.
 * The id is read from `from` (default the path params) under `param` (default "id"; "*" for a wildcard).
 */
export type ResourceRule = {
  kind: string;
  action: Action;
  param?: string;
  from?: "params" | "query" | "body";
};

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Every API route, and every route with a path parameter or wildcard, must declare either `resource` or
     * `noResource` (the reason it does not touch a user-owned resource). Checked at registration.
     */
    resource?: ResourceRule;
    noResource?: string;
    /**
     * App pages that address a resource (`/a/:id`): a refusal of the resource check (401 / 403 / 404) keeps its
     * status but answers with this page (the SPA shell, which shows the login screen or the error) instead of JSON.
     */
    deniedPage?: (reply: FastifyReply, status: 401 | 403 | 404) => unknown;
  }
  interface FastifyRequest {
    /** The resource loaded and checked for this request (routes with `config.resource`). */
    resource?: ResourceRef;
  }
  interface FastifyInstance {
    resources: ResourceRegistry;
  }
}

export class ResourceRegistry {
  private readonly loaders = new Map<string, ResourceLoader>();
  /** Every route declared with `config.resource` — the permission matrix test needs a row for each. */
  readonly routes: { method: string; url: string; rule: ResourceRule }[] = [];

  register(kind: string, loader: ResourceLoader): void {
    if (this.loaders.has(kind)) throw new Error(`resource kind "${kind}" registered twice`);
    this.loaders.set(kind, loader);
  }

  load(kind: string, id: string): ResourceRef | undefined {
    const loader = this.loaders.get(kind);
    if (!loader) throw new Error(`no loader for resource kind "${kind}"`);
    return loader(id);
  }
}

/** Routes that must carry a permission declaration: all of /api, and anything taking an id from the path. */
export const needsDeclaration = (url: string) => isApiPath(url) || url.includes(":") || url.includes("*");

/**
 * Registration rule. Installed first in buildApp, before any route exists: registering a route without a
 * declaration throws, so the server refuses to start.
 */
export function installRouteRules(app: FastifyInstance): ResourceRegistry {
  const registry = new ResourceRegistry();
  app.decorate("resources", registry);
  app.decorateRequest("resource", undefined);

  app.addHook("onRoute", (route) => {
    const cfg = route.config ?? {};
    // A declared resource is validated and listed wherever it appears, even on a route that needs no declaration.
    if (!cfg.resource && !needsDeclaration(route.url)) return;
    if (cfg.resource && cfg.noResource)
      throw new Error(`${route.url}: declare resource or noResource, not both`);
    if (!cfg.resource && !cfg.noResource?.trim())
      throw new Error(`${route.url}: route must declare config.resource or config.noResource (#10)`);
    if (!cfg.resource) return;
    const param = cfg.resource.param ?? "id";
    const from = cfg.resource.from ?? "params";
    if (from === "params" && !(param === "*" ? route.url.includes("*") : route.url.includes(`:${param}`)))
      throw new Error(`${route.url}: resource param ":${param}" not in path`);
    if (cfg.auth === "public") throw new Error(`${route.url}: a resource route cannot be public`);
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    // HEAD routes are Fastify's automatic mirrors of GET (same config, same check): list the GET only.
    for (const method of methods)
      if (method !== "HEAD") registry.routes.push({ method, url: route.url, rule: cfg.resource });
  });
  return registry;
}

function resourceId(req: FastifyRequest, rule: ResourceRule): string {
  const source = (rule.from === "query" ? req.query : rule.from === "body" ? req.body : req.params) as
    Record<string, unknown> | undefined;
  const v = source?.[rule.param ?? "id"];
  return typeof v === "string" ? v : "";
}

/** Per request, after the login check: load the resource — missing → 404, not allowed → 403. */
export function registerResourceCheck(app: FastifyInstance): void {
  app.addHook("preHandler", async (req, reply) => {
    const rule = req.routeOptions.config?.resource;
    if (!rule) return;
    const page = req.routeOptions.config?.deniedPage;
    const refuse = (status: 401 | 403, error: Parameters<typeof deny>[2]) =>
      page ? page(reply.header("Cache-Control", "no-store"), status) : deny(reply, status, error);
    // Non-API resource routes (e.g. /a/:id) are not covered by the API login rule, so check login here too.
    if (req.ctx.emailMismatch) return refuse(403, "access_email_mismatch");
    const user = req.ctx.user;
    if (!user) return refuse(401, "unauthenticated");
    if (user.mustChangePassword) return refuse(403, "password_change_required");
    const resource = app.resources.load(rule.kind, resourceId(req, rule));
    if (!resource) {
      reply.header("Cache-Control", "no-store");
      return page ? page(reply, 404) : reply.code(404).send({ error: "not_found" });
    }
    if (!can(user, rule.action, resource)) return refuse(403, "forbidden");
    req.resource = resource;
  });
}

/**
 * Re-checks a long-lived request (SSE stream, running job) whenever access may have changed: the user was
 * deactivated or changed role, or the resource's sharing changed. `onRevoke` runs once when access is gone —
 * possibly right away, if access was lost between the request's check and this call.
 * Returns an unsubscribe function; call it when the stream ends.
 */
export function watchAccess(
  app: FastifyInstance,
  req: FastifyRequest,
  onRevoke: () => void,
  users: UserStore | undefined = app.users,
): () => void {
  const userId = req.ctx.user?.id;
  const token = req.ctx.sessionToken;
  const cfg = req.routeOptions.config ?? {};
  const rule = cfg.resource;
  const ref = req.resource;
  let done = false;
  // The same conditions the request passed: the session still exists (not logged out or revoked by a password
  // change), the account is active and needs no password change, the route's role rule, then the resource.
  const stillAllowed = () => {
    const user = token ? users?.sessionUser(token) : undefined;
    if (!user || user.id !== userId || !user.active || user.mustChangePassword) return false;
    if (cfg.auth === "admin" && user.role !== "admin") return false;
    if (!rule || !ref) return true;
    const fresh = app.resources.load(ref.kind, ref.id);
    return !!fresh && can(user, rule.action, fresh);
  };
  const onUser = (e: { userId: string }) => {
    if (e.userId === userId) check();
  };
  const onResource = (e: { kind: string; id: string }) => {
    if (ref && e.kind === ref.kind && e.id === ref.id) check();
  };
  // Sessions also end by time: re-check when this one expires (in steps — setTimeout caps near 24.8 days).
  let expiryTimer: NodeJS.Timeout | undefined;
  const scheduleExpiry = () => {
    const expiresAt = token ? users?.sessionExpiresAt(token) : undefined;
    if (expiresAt === undefined) return;
    const wait = Math.min(Math.max(expiresAt - Date.now(), 0) + 50, 24 * 3600_000);
    expiryTimer = setTimeout(() => {
      check();
      if (!done) scheduleExpiry();
    }, wait);
    expiryTimer.unref();
  };
  const unsubscribe = () => {
    app.appEvents.off("user-access-changed", onUser);
    app.appEvents.off("resource-access-changed", onResource);
    clearTimeout(expiryTimer);
  };
  function check() {
    if (done || stillAllowed()) return;
    done = true;
    unsubscribe();
    onRevoke();
  }
  app.appEvents.on("user-access-changed", onUser);
  app.appEvents.on("resource-access-changed", onResource);
  check();
  if (!done) scheduleExpiry();
  return unsubscribe;
}
