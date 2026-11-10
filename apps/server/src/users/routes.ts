import type { FastifyInstance } from "fastify";
import { CreateUserRequest, type AdminUser } from "@agentlee/shared";
import { hashPassword } from "../auth/passwords.js";
import { deny } from "../auth/plugin.js";
import { temporaryPassword, toAdminUser, type UserStore } from "../auth/users.js";

/**
 * Minimal user management (#41, PRD FR-1.1): the admin adds family accounts with a one-time temporary password,
 * deactivates them (sessions and open streams end at once) and resets passwords. Access allow-list changes are
 * manual until #36 (docs/ops.md §10). The full admin screen is #35.
 */
export function registerUserAdmin(app: FastifyInstance, users: UserStore): void {
  // Accounts are not user-owned resources; access is the admin role itself.
  const admin = { auth: "admin" as const, noResource: "admin-only account management" };
  const byId = admin;

  app.get("/api/admin/users", { config: admin }, async (_req, reply) =>
    reply.header("Cache-Control", "no-store").send({ users: users.list().map(toAdminUser) }),
  );

  app.post("/api/admin/users", { config: admin }, async (req, reply) => {
    const r = CreateUserRequest.safeParse(req.body);
    if (!r.success) return deny(reply, 400, "invalid_request");
    if (users.byEmail(r.data.email)) return deny(reply, 409, "email_taken");
    const password = temporaryPassword();
    const user = users.create({
      email: r.data.email,
      name: r.data.name,
      role: r.data.role,
      defaultRuntime: r.data.defaultRuntime,
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
    });
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
      users.deactivate(target.id);
      return reply.header("Cache-Control", "no-store").send({ user: toAdminUser(users.byId(target.id)!) });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/admin/users/:id/reset-password",
    { config: byId },
    async (req, reply) => {
      const target = users.byId(req.params.id);
      if (!target) return deny(reply, 404, "not_found");
      // Your own password is changed with the current one (/api/auth/password), not reset.
      if (target.id === req.ctx.user!.id) return deny(reply, 400, "cannot_change_self");
      const password = temporaryPassword();
      users.setPassword(target.id, await hashPassword(password), { mustChange: true });
      return reply.header("Cache-Control", "no-store").send({ temporaryPassword: password });
    },
  );
}
