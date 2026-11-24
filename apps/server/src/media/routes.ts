import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MediaKeyRequest, MediaKind, MediaSettings } from "@agentlee/shared";
import { passwordChangePending } from "../auth/plugin.js";
import type { UserStore } from "../auth/users.js";
import { MediaError, type MediaAdminService } from "./service.js";

const send = (reply: FastifyReply, body: unknown) => reply.header("Cache-Control", "no-store").send(body);
const refuse = (reply: FastifyReply, e: unknown) => {
  if (e instanceof MediaError)
    return send(reply.code(e.status), { error: e.code, ...(e.kind ? { kind: e.kind } : {}) });
  throw e;
};

/**
 * 관리자 → 미디어 생성 (#238 stage 1). Admin only; the key itself never leaves the server (its last 4 characters
 * only). Each write re-checks, right before it is stored, that the caller is still the same active admin session.
 */
export function registerMediaRoutes(
  app: FastifyInstance,
  deps: { users: Pick<UserStore, "sessionUser">; media: MediaAdminService },
): void {
  const { users, media } = deps;
  const admin = { auth: "admin" as const, noResource: "admin-only media generation settings" };
  const stillAdmin = (req: FastifyRequest) => () => {
    const token = req.ctx.sessionToken;
    const u = token ? users.sessionUser(token) : undefined;
    return !!u && u.id === req.ctx.user?.id && u.role === "admin" && !passwordChangePending(req, u);
  };
  const bad = (reply: FastifyReply) => send(reply.code(400), { error: "invalid_request" });

  app.get("/api/admin/media", { config: admin }, async (_req, reply) => send(reply, media.view()));

  app.put("/api/admin/media/key", { config: admin }, async (req, reply) => {
    const r = MediaKeyRequest.safeParse(req.body);
    if (!r.success) return bad(reply);
    try {
      return send(reply, await media.registerKey(r.data.key, stillAdmin(req)));
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.delete("/api/admin/media/key", { config: admin }, async (req, reply) => {
    try {
      return send(reply, await media.deleteKey(stillAdmin(req)));
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.post("/api/admin/media/key/check", { config: admin }, async (req, reply) => {
    try {
      return send(reply, await media.refreshKey(stillAdmin(req)));
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.get("/api/admin/media/catalog/:kind", { config: admin }, async (req, reply) => {
    const kind = MediaKind.safeParse((req.params as { kind?: string }).kind);
    if (!kind.success) return bad(reply);
    const fresh = (req.query as { fresh?: string } | undefined)?.fresh === "1";
    try {
      return send(reply, await media.catalog(kind.data, fresh));
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.put("/api/admin/media/settings", { config: admin }, async (req, reply) => {
    const r = MediaSettings.safeParse(req.body);
    if (!r.success) return bad(reply);
    try {
      return send(reply, await media.saveSettings(r.data, stillAdmin(req)));
    } catch (e) {
      return refuse(reply, e);
    }
  });
}
