import type { FastifyInstance, FastifyRequest } from "fastify";
import { CreateUserRequest, SetYouthRequest, type AdminUser } from "@agentlee/shared";
import { hashPassword } from "../auth/passwords.js";
import { deny } from "../auth/plugin.js";
import { temporaryPassword, toAdminUser, type UserStore } from "../auth/users.js";

/**
 * Minimal user management (#41, PRD FR-1.1): the admin adds family accounts with a one-time temporary password,
 * deactivates them (sessions and open streams end at once) and resets passwords. Access allow-list changes are
 * manual until #36 (docs/ops.md §10). The full admin screen is #35.
 */
export type UserAdminOptions = {
  /** Password hashing override (tests hold it open to race other requests against it). */
  hash?: (password: string) => Promise<string>;
};

export function registerUserAdmin(app: FastifyInstance, users: UserStore, opts: UserAdminOptions = {}): void {
  const hash = opts.hash ?? hashPassword;
  // Accounts are not user-owned resources; access is the admin role itself.
  const admin = { auth: "admin" as const, noResource: "admin-only account management" };
  const byId = admin;

  /**
   * Re-checks the caller right before a change (after any await): still the same session, active admin, no pending
   * password change. Another admin may have deactivated or demoted them, or the session ended, meanwhile.
   * Callers must not await between this check and the write.
   */
  const stillAdmin = (req: FastifyRequest) => {
    const token = req.ctx.sessionToken;
    const u = token ? users.sessionUser(token) : undefined;
    return !!u && u.id === req.ctx.user?.id && u.role === "admin" && !u.mustChangePassword;
  };
  const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE";

  app.get("/api/admin/users", { config: admin }, async (_req, reply) =>
    reply.header("Cache-Control", "no-store").send({ users: users.list().map(toAdminUser) }),
  );

  app.post("/api/admin/users", { config: admin }, async (req, reply) => {
    const r = CreateUserRequest.safeParse(req.body);
    if (!r.success) return deny(reply, 400, "invalid_request");
    if (users.byEmail(r.data.email)) return deny(reply, 409, "email_taken");
    const password = temporaryPassword();
    const passwordHash = await hash(password);
    if (!stillAdmin(req)) return deny(reply, 403, "forbidden");
    let user;
    try {
      user = users.create({
        email: r.data.email,
        name: r.data.name,
        role: r.data.role,
        defaultRuntime: r.data.defaultRuntime,
        youth: r.data.youth,
        passwordHash,
        mustChangePassword: true,
      });
    } catch (e) {
      // Two requests for the same email at once: the second one hits the UNIQUE index.
      if (isUniqueViolation(e)) return deny(reply, 409, "email_taken");
      throw e;
    }
    return reply
      .code(201)
      .header("Cache-Control", "no-store")
      .send({ user: toAdminUser(user) satisfies AdminUser, temporaryPassword: password });
  });

  app.post<{ Params: { id: string } }>(
    "/api/admin/users/:id/deactivate",
    { config: byId },
    async (req, reply) => {
      const target = users.byId(req.params.id);
      if (!target) return deny(reply, 404, "not_found");
      // The admin cannot lock themselves out (there is no other admin to undo it).
      if (target.id === req.ctx.user!.id) return deny(reply, 400, "cannot_change_self");
      if (!stillAdmin(req)) return deny(reply, 403, "forbidden");
      if (!users.deactivateUnlessLastAdmin(target.id)) return deny(reply, 409, "last_admin");
      return reply.header("Cache-Control", "no-store").send({ user: toAdminUser(users.byId(target.id)!) });
    },
  );

  // Youth account (the son, PRD NFR 청소년): his runs get the youth instructions (#20). The full admin screen is #35.
  app.put<{ Params: { id: string } }>("/api/admin/users/:id/youth", { config: byId }, async (req, reply) => {
    const r = SetYouthRequest.safeParse(req.body);
    if (!r.success) return deny(reply, 400, "invalid_request");
    const target = users.byId(req.params.id);
    if (!target) return deny(reply, 404, "not_found");
    if (!stillAdmin(req)) return deny(reply, 403, "forbidden");
    users.setYouth(target.id, r.data.youth);
    return reply.header("Cache-Control", "no-store").send({ user: toAdminUser(users.byId(target.id)!) });
  });

  app.post<{ Params: { id: string } }>(
    "/api/admin/users/:id/reset-password",
    { config: byId },
    async (req, reply) => {
      const target = users.byId(req.params.id);
      if (!target) return deny(reply, 404, "not_found");
      // Your own password is changed with the current one (/api/auth/password), not reset.
      if (target.id === req.ctx.user!.id) return deny(reply, 400, "cannot_change_self");
      const password = temporaryPassword();
      const passwordHash = await hash(password);
      if (!stillAdmin(req)) return deny(reply, 403, "forbidden");
      if (!users.byId(target.id)?.active) return deny(reply, 404, "not_found");
      users.setPassword(target.id, passwordHash, { mustChange: true });
      return reply.header("Cache-Control", "no-store").send({ temporaryPassword: password });
    },
  );
}
