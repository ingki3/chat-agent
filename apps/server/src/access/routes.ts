import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AccessApplyRequest,
  AccessManualDoneRequest,
  AccessPreviewRequest,
  AccessRegisterRequest,
  AdminEmailChangeRequest,
  AuthState,
  type AdminEmailConfirmState,
} from "@agentlee/shared";
import type { Config } from "../config.js";
import { deny, readCookie, SESSION_COOKIE, sessionCookie } from "../auth/plugin.js";
import { SESSION_TTL_MS, toAuthUser, type UserStore } from "../auth/users.js";
import { AccessSyncError, type AccessSyncService } from "./service.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Cloudflare Access sync (#36); undefined without a database. */
    accessSync: AccessSyncService | undefined;
  }
}

const send = (reply: FastifyReply, body: unknown) => reply.header("Cache-Control", "no-store").send(body);
const refuse = (reply: FastifyReply, e: unknown) => {
  if (e instanceof AccessSyncError) return send(reply.code(e.status), { error: e.code });
  throw e;
};

/**
 * Same re-check as the user routes: the caller is still the same active admin session (another admin may have
 * demoted them, or the session ended, during an await).
 */
function stillAdmin(users: UserStore, req: FastifyRequest): boolean {
  const token = req.ctx.sessionToken;
  const u = token ? users.sessionUser(token) : undefined;
  return !!u && u.id === req.ctx.user?.id && u.role === "admin" && !u.mustChangePassword;
}

/**
 * The admin screen's Access tab (#36, PRD FR-15): registration, the comparison/preview, apply, retry, manual mode,
 * the admin's email change — and the one non-admin route of it, the confirmation of the new email, which runs with
 * the admin's existing session through an Access login with the *new* email (the session check refuses that
 * pairing everywhere else: `access_email_mismatch`).
 */
export function registerAccessRoutes(
  app: FastifyInstance,
  deps: { users: UserStore; access: AccessSyncService; config: Config },
): void {
  const { users, access, config } = deps;
  const admin = { auth: "admin" as const, noResource: "admin-only Cloudflare Access sync" };
  /** The caller, re-checked by the service when its queued write starts and again right before the PUT. */
  const caller = (req: FastifyRequest) => ({
    userId: req.ctx.user!.id,
    authorize: () => stillAdmin(users, req),
  });

  app.get("/api/admin/access", { config: admin }, async (_req, reply) => send(reply, access.overview()));

  app.put("/api/admin/access/registration", { config: admin }, async (req, reply) => {
    const r = AccessRegisterRequest.safeParse(req.body);
    if (!r.success) return deny(reply, 400, "invalid_request");
    try {
      // The caller is re-checked inside, after Cloudflare answered and right before anything is saved.
      return send(reply, { registration: await access.register(r.data, () => stillAdmin(users, req)) });
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.delete("/api/admin/access/registration", { config: admin }, async (_req, reply) => {
    await access.unregister();
    return send(reply, access.overview());
  });

  app.post("/api/admin/access/preview", { config: admin }, async (req, reply) => {
    const r = AccessPreviewRequest.safeParse(req.body ?? {});
    if (!r.success) return deny(reply, 400, "invalid_request");
    try {
      return send(reply, await access.preview(r.data.change));
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.post("/api/admin/access/apply", { config: admin }, async (req, reply) => {
    const r = AccessApplyRequest.safeParse(req.body);
    if (!r.success) return deny(reply, 400, "invalid_request");
    if (!stillAdmin(users, req)) return deny(reply, 403, "forbidden");
    try {
      return send(reply, { sync: await access.apply(r.data, caller(req)) });
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.post("/api/admin/access/retry", { config: admin }, async (req, reply) => {
    if (!stillAdmin(users, req)) return deny(reply, 403, "forbidden");
    try {
      return send(reply, { sync: await access.retry(false, caller(req)) });
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.post("/api/admin/access/manual-done", { config: admin }, async (req, reply) => {
    const r = AccessManualDoneRequest.safeParse(req.body);
    if (!r.success) return deny(reply, 400, "invalid_request");
    try {
      return send(reply, { sync: await access.manualDone(r.data.final) });
    } catch (e) {
      return refuse(reply, e);
    }
  });

  // FR-15.7 step 1 (and cancel). The admin changes their own email; the account keeps the old one until step 4.
  app.post("/api/admin/access/admin-email", { config: admin }, async (req, reply) => {
    const r = AdminEmailChangeRequest.safeParse(req.body);
    if (!r.success) return deny(reply, 400, "invalid_request");
    try {
      return send(reply, { change: access.requestAdminEmail(req.ctx.user!, r.data.email) });
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.post("/api/admin/access/admin-email/cancel", { config: admin }, async (req, reply) => {
    try {
      return send(reply, { change: access.cancelAdminEmail(req.ctx.user!) });
    } catch (e) {
      return refuse(reply, e);
    }
  });

  // FR-15.7 steps 3–4. Public as a route rule because the session check refuses the old session with the new Access
  // email; the handler itself requires both: the admin's session cookie and an Access login with the new email.
  const confirm = { auth: "public" as const, noResource: "the admin's own pending email change" };
  const cookieToken = (req: FastifyRequest) => readCookie(req.headers.cookie, SESSION_COOKIE);

  app.get("/api/access/admin-email/confirm", { config: confirm }, async (req, reply) => {
    const ready =
      req.ctx.origin === "edge" ? access.confirmState(cookieToken(req), req.ctx.accessEmail) : null;
    const body: AdminEmailConfirmState = ready
      ? { ready: true, oldEmail: ready.change.oldEmail, newEmail: ready.change.newEmail }
      : { ready: false, oldEmail: null, newEmail: null };
    return send(reply, body);
  });

  app.post("/api/access/admin-email/confirm", { config: confirm }, async (req, reply) => {
    try {
      const user = access.switchAdminEmail(cookieToken(req), req.ctx.accessEmail, req.ctx.origin === "edge");
      const token = users.createSession(user.id);
      reply.header("Set-Cookie", sessionCookie(req, token, SESSION_TTL_MS / 1000));
      return send(
        reply,
        AuthState.parse({
          setupRequired: false,
          user: toAuthUser(user),
          accessEmail: req.ctx.accessEmail ?? null,
          adminEmail: config.adminEmail,
        }),
      );
    } catch (e) {
      return refuse(reply, e);
    }
  });
}
