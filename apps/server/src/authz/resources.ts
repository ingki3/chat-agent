import type { FastifyInstance, FastifyRequest } from "fastify";
import { deny } from "../auth/plugin.js";
import type { UserStore } from "../auth/users.js";
import { isApiPath } from "../paths.js";
import { can, type Action, type ResourceRef } from "./policy.js";

export type ResourceLoader = (id: string) => ResourceRef | undefined;

/** Route declaration: which resource the `:param` names and what the route does with it. */
export type ResourceRule = { kind: string; action: Action; param?: string };

declare module "fastify" {
  interface FastifyContextConfig {
    /** Required on every API route with a path parameter (or `noResource`), checked at registration. */
    resource?: ResourceRule;
    /** Explicit opt-out for parameterised API routes that do not address a user-owned resource. */
    noResource?: string;
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

/**
 * Wires the policy into Fastify:
 * - at registration, every API route with a path parameter must declare `config.resource` (or `noResource`
 *   with a reason) — otherwise the server refuses to start;
 * - per request (after the login check), the resource is loaded: missing → 404, not allowed → 403.
 */
export function registerResources(app: FastifyInstance): ResourceRegistry {
  const registry = new ResourceRegistry();
  app.decorate("resources", registry);
  app.decorateRequest("resource", undefined);

  app.addHook("onRoute", (route) => {
    if (!isApiPath(route.url) || !route.url.includes(":")) return;
    const cfg = route.config ?? {};
    if (cfg.resource && cfg.noResource)
      throw new Error(`${route.url}: declare resource or noResource, not both`);
    if (!cfg.resource && !cfg.noResource)
      throw new Error(`${route.url}: API route with a path parameter must declare config.resource (#10)`);
    if (cfg.resource) {
      const param = cfg.resource.param ?? "id";
      if (!route.url.includes(`:${param}`))
        throw new Error(`${route.url}: resource param ":${param}" not in path`);
      if (cfg.auth === "public") throw new Error(`${route.url}: a resource route cannot be public`);
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) registry.routes.push({ method, url: route.url, rule: cfg.resource });
    }
  });

  app.addHook("preHandler", async (req, reply) => {
    const rule = req.routeOptions.config?.resource;
    if (!rule) return;
    const user = req.ctx.user;
    // The login check runs first; this only guards against a route that slipped past it.
    if (!user) return deny(reply, 401, "unauthenticated");
    const id = (req.params as Record<string, string | undefined>)[rule.param ?? "id"] ?? "";
    const resource = registry.load(rule.kind, id);
    if (!resource) return reply.code(404).header("Cache-Control", "no-store").send({ error: "not_found" });
    if (!can(user, rule.action, resource)) return deny(reply, 403, "forbidden");
    req.resource = resource;
  });

  return registry;
}

/**
 * Re-checks a long-lived request (SSE stream, running job) whenever access may have changed: the user was
 * deactivated or changed role, or the resource's sharing changed. `onRevoke` runs once when access is gone.
 * Returns an unsubscribe function; call it when the stream ends.
 */
export function watchAccess(
  app: FastifyInstance,
  req: FastifyRequest,
  onRevoke: () => void,
  users: UserStore | undefined = app.users,
): () => void {
  const userId = req.ctx.user?.id;
  const rule = req.routeOptions.config?.resource;
  const ref = req.resource;
  let done = false;
  const stillAllowed = () => {
    const user = userId ? users?.byId(userId) : undefined;
    if (!user?.active) return false;
    if (!rule || !ref) return true;
    const fresh = app.resources.load(ref.kind, ref.id);
    return !!fresh && can(user, rule.action, fresh);
  };
  const check = () => {
    if (done || stillAllowed()) return;
    done = true;
    unsubscribe();
    onRevoke();
  };
  const onUser = (e: { userId: string }) => {
    if (e.userId === userId) check();
  };
  const onResource = (e: { kind: string; id: string }) => {
    if (ref && e.kind === ref.kind && e.id === ref.id) check();
  };
  app.appEvents.on("user-access-changed", onUser);
  app.appEvents.on("resource-access-changed", onResource);
  const unsubscribe = () => {
    app.appEvents.off("user-access-changed", onUser);
    app.appEvents.off("resource-access-changed", onResource);
  };
  return unsubscribe;
}
