import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CreateConnectionRequest,
  RuntimePolicy,
  StartSubscriptionLoginRequest,
  UpdateConnectionRequest,
  type RuntimeId,
  type RuntimeOption,
} from "@agentlee/shared";
import { z } from "zod";
import type { UserStore } from "../auth/users.js";
import { logEvent } from "../logging.js";
import type { RuntimeRegistry } from "../runtime/adapter.js";
import type { SubscriptionLoginService } from "./login.js";
import type { ConnectionService } from "./service.js";
import { ConnectionRuleError, toConnection, type ConnectionRow } from "./store.js";

const KIND = "connection";
/** Owner id of shared connections in the resource check: matches no user, so `/api/connections/:id` refuses them. */
const SHARED_OWNER = "shared:";

const send = (reply: FastifyReply, status: number, body: unknown) =>
  reply.code(status).header("Cache-Control", "no-store").send(body);
const fail = (reply: FastifyReply, status: number, error: string) => send(reply, status, { error });

/** Refuses a body that tries to set the scope (it is fixed by the route and never changes — FR-11.4). */
function hasScope(body: unknown): boolean {
  return !!body && typeof body === "object" && "scope" in body;
}

function handle(reply: FastifyReply, e: unknown) {
  if (e instanceof ConnectionRuleError) return fail(reply, e.status, e.code);
  throw e;
}

/**
 * Runtime connection API (#17). Responses never contain a credential — `toConnection` has no field for it, only
 * the masked `hint`.
 * - `/api/connections…`: the caller's own personal connections (resource check: owner only).
 * - `/api/admin/connections…`: shared connections (admin). API keys only.
 * - `/api/admin/users/:id/connections…`: an admin registers or removes a member's personal connection; the
 *   credential cannot be read back by anyone.
 * - `/api/runtimes`: what the caller's picker may show.
 * - `/api/connections/logins…`: the caller's own Codex ChatGPT login (device code, #18). Only the caller sees
 *   their code; the result is a personal connection of theirs (only its account email is shown).
 */
export function registerConnectionRoutes(
  app: FastifyInstance,
  service: ConnectionService,
  users: UserStore,
  registry: RuntimeRegistry,
  logins?: SubscriptionLoginService,
): void {
  const store = service.store;
  app.resources.register(KIND, (id) => {
    const c = store.get(id);
    if (!c || c.disconnectedAt !== null) return undefined;
    return {
      kind: KIND,
      id: c.id,
      ownerId: c.scope === "personal" ? c.ownerId! : SHARED_OWNER,
      sharedWith: [],
    };
  });
  const own = (action: "read" | "write" | "delete") => ({ resource: { kind: KIND, action } });
  const admin = { auth: "admin" as const, noResource: "admin-only runtime connection management" };

  const create = (
    req: FastifyRequest,
    reply: FastifyReply,
    scope: "personal" | "shared",
    ownerId: string | null,
  ) => {
    if (hasScope(req.body)) return fail(reply, 400, "scope_immutable");
    const body = CreateConnectionRequest.safeParse(req.body);
    if (!body.success) return fail(reply, 400, "invalid_request");
    const owner = ownerId ? users.byId(ownerId) : undefined;
    if (ownerId && !owner?.active) return fail(reply, 404, "not_found");
    // A subscription is connected by its owner only (FR-11.4, #35): an admin registering on someone's behalf adds
    // API keys, never a subscription. Members' accounts refuse it anyway (the store's rules); this closes the one
    // case they allow — an admin pasting a token onto another admin's account.
    if (
      owner &&
      owner.id !== req.ctx.user!.id &&
      owner.role === "admin" &&
      body.data.authType === "subscription"
    )
      return fail(reply, 403, "subscription_self_only");
    try {
      const c = store.create({ ...body.data, scope, owner: owner ?? null, createdBy: req.ctx.user!.id });
      logEvent(req.log, "info", "connection.created", {
        connectionId: c.id,
        runtime: c.runtime,
        scope: c.scope,
        authType: c.authType,
      });
      return send(reply, 201, { connection: toConnection(c) });
    } catch (e) {
      return handle(reply, e);
    }
  };
  const update = async (req: FastifyRequest, reply: FastifyReply, c: ConnectionRow) => {
    if (hasScope(req.body)) return fail(reply, 400, "scope_immutable");
    const body = UpdateConnectionRequest.safeParse(req.body);
    if (!body.success) return fail(reply, 400, "invalid_request");
    try {
      return send(reply, 200, { connection: toConnection(await service.update(c.id, body.data)) });
    } catch (e) {
      return handle(reply, e);
    }
  };
  const test = async (reply: FastifyReply, c: ConnectionRow, userId: string) => {
    try {
      const result = await service.test(c, userId);
      return send(reply, 200, { result, connection: toConnection(store.get(c.id)!) });
    } catch (e) {
      return handle(reply, e);
    }
  };
  const disconnect = async (reply: FastifyReply, c: ConnectionRow) => {
    await service.disconnect(c);
    return send(reply, 200, { ok: true });
  };

  // ---- my ChatGPT logins (#18) — registered before `/api/connections/:id` ----

  const noLogin = (reply: FastifyReply) => fail(reply, 400, "unsupported_auth");
  app.post(
    "/api/connections/logins",
    { config: { noResource: "starts the caller's own subscription login" } },
    async (req, reply) => {
      if (!logins) return noLogin(reply);
      const body = StartSubscriptionLoginRequest.safeParse(req.body);
      if (!body.success) return fail(reply, 400, "invalid_request");
      try {
        return send(reply, 201, { login: await logins.start(req.ctx.user!.id, body.data) });
      } catch (e) {
        return handle(reply, e);
      }
    },
  );
  app.get<{ Params: { loginId: string } }>(
    "/api/connections/logins/:loginId",
    { config: { noResource: "the caller's own login only (others are 404)" } },
    (req, reply) => {
      if (!logins) return noLogin(reply);
      try {
        const login = logins.get(req.ctx.user!.id, req.params.loginId);
        const c = login.connectionId ? store.get(login.connectionId) : undefined;
        return send(reply, 200, {
          login,
          connection: c && login.status === "completed" && c.disconnectedAt === null ? toConnection(c) : null,
        });
      } catch (e) {
        return handle(reply, e);
      }
    },
  );
  app.delete<{ Params: { loginId: string } }>(
    "/api/connections/logins/:loginId",
    { config: { noResource: "the caller's own login only (others are 404)" } },
    async (req, reply) => {
      if (!logins) return noLogin(reply);
      try {
        return send(reply, 200, { login: await logins.cancel(req.ctx.user!.id, req.params.loginId) });
      } catch (e) {
        return handle(reply, e);
      }
    },
  );

  // ---- my connections ----

  app.get(
    "/api/connections",
    { config: { noResource: "lists only the caller's own connections" } },
    (req, reply) => send(reply, 200, { items: store.personal(req.ctx.user!.id).map(toConnection) }),
  );
  app.post(
    "/api/connections",
    { config: { noResource: "creates a personal connection owned by the caller" } },
    (req, reply) => create(req, reply, "personal", req.ctx.user!.id),
  );
  app.get<{ Params: { id: string } }>("/api/connections/:id", { config: own("read") }, (req, reply) =>
    send(reply, 200, { connection: toConnection(store.get(req.params.id)!) }),
  );
  app.patch<{ Params: { id: string } }>("/api/connections/:id", { config: own("write") }, (req, reply) =>
    update(req, reply, store.get(req.params.id)!),
  );
  app.delete<{ Params: { id: string } }>("/api/connections/:id", { config: own("delete") }, (req, reply) =>
    disconnect(reply, store.get(req.params.id)!),
  );
  app.post<{ Params: { id: string } }>("/api/connections/:id/test", { config: own("write") }, (req, reply) =>
    test(reply, store.get(req.params.id)!, req.ctx.user!.id),
  );

  // ---- picker ----

  app.get("/api/runtimes", { config: { noResource: "the caller's own runtime choices" } }, (req, reply) => {
    const user = users.byId(req.ctx.user!.id)!;
    const items: RuntimeOption[] = [];
    for (const id of registry.ids()) {
      const caps = registry.get(id)!.capabilities();
      const models = service.access.models(store.policy(user, id), caps);
      if (!models.length) continue;
      items.push({
        runtime: id,
        models: models.map((m) => ({
          id: m.id,
          label: m.label,
          efforts: m.efforts,
          defaultEffort: m.defaultEffort ?? null,
        })),
        needsConnection: caps.needsConnection === true,
        connections: caps.needsConnection ? store.usableFor(user, id).map(toConnection) : [],
      });
    }
    return send(reply, 200, { items });
  });

  // ---- shared connections (admin) ----

  const sharedById = (id: string) => {
    const c = store.get(id);
    return c && c.scope === "shared" && c.disconnectedAt === null ? c : undefined;
  };
  app.get("/api/admin/connections", { config: admin }, (_req, reply) =>
    send(reply, 200, {
      items: store.shared().map(toConnection),
      // `.env` values the last start could not import (docs/ops.md §11): fix `.env` and restart.
      importFailures: service.importFailures,
    }),
  );
  app.post("/api/admin/connections", { config: admin }, (req, reply) => create(req, reply, "shared", null));
  app.patch<{ Params: { id: string } }>("/api/admin/connections/:id", { config: admin }, (req, reply) => {
    const c = sharedById(req.params.id);
    return c ? update(req, reply, c) : fail(reply, 404, "not_found");
  });
  app.delete<{ Params: { id: string } }>("/api/admin/connections/:id", { config: admin }, (req, reply) => {
    const c = sharedById(req.params.id);
    return c ? disconnect(reply, c) : fail(reply, 404, "not_found");
  });
  app.post<{ Params: { id: string } }>("/api/admin/connections/:id/test", { config: admin }, (req, reply) => {
    const c = sharedById(req.params.id);
    return c ? test(reply, c, req.ctx.user!.id) : fail(reply, 404, "not_found");
  });

  // ---- a member's personal connections (admin: register on their behalf, list, remove — never read) ----

  type UserParams = { id: string };
  app.get<{ Params: UserParams }>("/api/admin/users/:id/connections", { config: admin }, (req, reply) =>
    users.byId(req.params.id)
      ? send(reply, 200, { items: store.personal(req.params.id).map(toConnection) })
      : fail(reply, 404, "not_found"),
  );
  app.post<{ Params: UserParams }>("/api/admin/users/:id/connections", { config: admin }, (req, reply) =>
    create(req, reply, "personal", req.params.id),
  );
  const memberConnection = (userId: string, connectionId: string) => {
    const c = store.get(connectionId);
    return c && c.scope === "personal" && c.ownerId === userId && c.disconnectedAt === null ? c : undefined;
  };
  app.delete<{ Params: { id: string; connectionId: string } }>(
    "/api/admin/users/:id/connections/:connectionId",
    { config: admin },
    (req, reply) => {
      const c = memberConnection(req.params.id, req.params.connectionId);
      return c ? disconnect(reply, c) : fail(reply, 404, "not_found");
    },
  );
  // Tests a member's personal API key connection as that member (their policy, their folder, usage on them) — so one
  // the admin registered on their behalf can be made usable (#35). The credential is never shown.
  app.post<{ Params: { id: string; connectionId: string } }>(
    "/api/admin/users/:id/connections/:connectionId/test",
    { config: admin },
    (req, reply) => {
      const c = memberConnection(req.params.id, req.params.connectionId);
      if (!c) return fail(reply, 404, "not_found");
      // On someone's behalf for API keys only: a subscription is used by its owner alone (D2, FR-11.4) — not
      // even for a test run by another admin. Their own one is tested from their own settings.
      if (c.authType !== "api_key" && c.ownerId !== req.ctx.user!.id)
        return fail(reply, 403, "subscription_self_only");
      return test(reply, c, req.params.id);
    },
  );

  // ---- runtime policies (admin) ----

  app.get<{ Params: UserParams }>(
    "/api/admin/users/:id/runtime-policies",
    { config: admin },
    (req, reply) => {
      const user = users.byId(req.params.id);
      if (!user) return fail(reply, 404, "not_found");
      const items = (["claude-code", "codex"] as RuntimeId[]).map((runtime) => ({
        runtime,
        ...store.policy(user, runtime),
      }));
      return send(reply, 200, { items });
    },
  );
  app.put<{ Params: UserParams }>(
    "/api/admin/users/:id/runtime-policies",
    { config: admin },
    (req, reply) => {
      const user = users.byId(req.params.id);
      if (!user) return fail(reply, 404, "not_found");
      const body = z
        .object({ items: z.array(RuntimePolicy).min(1).max(2) })
        .strict()
        .safeParse(req.body);
      if (!body.success) return fail(reply, 400, "invalid_request");
      // Applies from the next run on; running runs keep what they were started with.
      for (const p of body.data.items) store.setPolicy(user.id, p);
      return send(reply, 200, {
        items: (["claude-code", "codex"] as RuntimeId[]).map((runtime) => ({
          runtime,
          ...store.policy(user, runtime),
        })),
      });
    },
  );
}
