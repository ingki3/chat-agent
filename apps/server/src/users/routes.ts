import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CreateUserRequest,
  PreviewSettingsRequest,
  SetDefaultsRequest,
  SetSkillEnabledRequest,
  SetUserSkillsRequest,
  SetYouthRequest,
  UpdateUserRequest,
  type AdminUser,
  type UserSkillsResponse,
} from "@agentlee/shared";
import { SKILL_CATALOGUE } from "@agentlee/mcp-tools/skills";
import { hashPassword } from "../auth/passwords.js";
import { deny } from "../auth/plugin.js";
import { temporaryPassword, toAdminUser, type UserRow, type UserStore } from "../auth/users.js";
import { RunAccessDenied } from "../connections/access.js";
import { isFinanceSkill, skillPermitted, type McpService } from "../mcp/service.js";
import type { DefaultsService } from "./defaults.js";

/**
 * Minimal user management (#41, PRD FR-1.1): the admin adds family accounts with a one-time temporary password,
 * deactivates them (sessions and open streams end at once) and resets passwords. Access allow-list changes are
 * manual until #36 (docs/ops.md §10). The full admin screen is #35.
 */
export type UserAdminOptions = {
  /** Password hashing override (tests hold it open to race other requests against it). */
  hash?: (password: string) => Promise<string>;
};

/**
 * Re-checks the caller right before a change (after any await): still the same session, active admin, no pending
 * password change. Another admin may have deactivated or demoted them, or the session ended, meanwhile.
 * Callers must not await between this check and the write.
 */
function isStillAdmin(users: UserStore, req: FastifyRequest): boolean {
  const token = req.ctx.sessionToken;
  const u = token ? users.sessionUser(token) : undefined;
  return !!u && u.id === req.ctx.user?.id && u.role === "admin" && !u.mustChangePassword;
}

export function registerUserAdmin(app: FastifyInstance, users: UserStore, opts: UserAdminOptions = {}): void {
  const hash = opts.hash ?? hashPassword;
  // Accounts are not user-owned resources; access is the admin role itself.
  const admin = { auth: "admin" as const, noResource: "admin-only account management" };
  const byId = admin;
  const stillAdmin = (req: FastifyRequest) => isStillAdmin(users, req);
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

  // Which skills a user may use (FR-1.6, #21): "all" or PRD §7 names — e.g. the son without the finance skills.
  // Unknown names are refused. The full admin screen is #35.
  const catalogue = new Set(SKILL_CATALOGUE.map((e) => e.name));
  app.put<{ Params: { id: string } }>("/api/admin/users/:id/skills", { config: byId }, async (req, reply) => {
    const r = SetUserSkillsRequest.safeParse(req.body);
    if (!r.success) return deny(reply, 400, "invalid_request");
    const skills = r.data.skills;
    if (skills !== "all" && skills.some((s) => !catalogue.has(s))) return deny(reply, 400, "unknown_skill");
    const target = users.byId(req.params.id);
    if (!target) return deny(reply, 404, "not_found");
    if (!stillAdmin(req)) return deny(reply, 403, "forbidden");
    users.setSkills(target.id, skills === "all" ? "all" : [...new Set(skills)]);
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

const CATALOGUE = SKILL_CATALOGUE.map((e) => e.name);

/** One user's skills as the admin screen shows them (FR-1.6): allowed by their permissions, and why. */
export function userSkills(u: UserRow, mcp: Pick<McpService, "serverEnabled">): UserSkillsResponse {
  const p = (u.permissions as { skills?: unknown }).skills;
  return {
    mode: p === "all" ? "all" : "list",
    youth: u.youth,
    skills: SKILL_CATALOGUE.map((e) => {
      const allowed = skillPermitted(u, e.name);
      return {
        name: e.name,
        finance: e.finance,
        allowed,
        reason: p === "all" ? (allowed ? "all" : "youth_hidden") : allowed ? "listed" : "unlisted",
        serverEnabled: mcp.serverEnabled(e.name),
      };
    }),
  };
}

/**
 * The new skill permissions after turning one skill on or off for a user: from what is allowed *now* — so a youth
 * account's hidden finance skills stay hidden when another skill is switched (#30) — back to "all" when the result
 * is exactly what "all" gives that account.
 */
export function toggledSkills(u: UserRow, skill: string, enabled: boolean): "all" | string[] {
  const next = new Set(CATALOGUE.filter((s) => skillPermitted(u, s)));
  if (enabled) next.add(skill);
  else next.delete(skill);
  const all = CATALOGUE.filter((s) => !(u.youth && isFinanceSkill(s)));
  if (next.size === all.length && all.every((s) => next.has(s))) return "all";
  return CATALOGUE.filter((s) => next.has(s));
}

/**
 * The rest of the admin screen's account routes (#35): name/email/role, the admin's initial defaults, one skill at a
 * time, the server skill allow-list — and the user's own defaults (`/api/settings/defaults`). Registered once the
 * MCP service and the run check exist.
 */
export function registerAccountSettings(
  app: FastifyInstance,
  users: UserStore,
  deps: { defaults: DefaultsService; mcp: McpService },
): void {
  const admin = { auth: "admin" as const, noResource: "admin-only account management" };
  const stillAdmin = (req: FastifyRequest) => isStillAdmin(users, req);
  const send = (reply: import("fastify").FastifyReply, body: unknown) =>
    reply.header("Cache-Control", "no-store").send(body);
  const catalogue = new Set(CATALOGUE);

  // Name, email, role (FR-15.1). The Access allow-list follows by hand until #36 (docs/ops.md §10).
  app.patch<{ Params: { id: string } }>("/api/admin/users/:id", { config: admin }, async (req, reply) => {
    const r = UpdateUserRequest.safeParse(req.body);
    if (!r.success) return deny(reply, 400, "invalid_request");
    if (!users.byId(req.params.id)) return deny(reply, 404, "not_found");
    if (!stillAdmin(req)) return deny(reply, 403, "forbidden");
    const out = users.update(req.params.id, r.data);
    if (!out.ok) return deny(reply, out.code === "not_found" ? 404 : 409, out.code);
    return send(reply, { user: toAdminUser(out.user) });
  });

  // The admin's initial defaults for a user (FR-12.4): checked against that user's policy (400 when not allowed).
  app.put<{ Params: { id: string } }>(
    "/api/admin/users/:id/defaults",
    { config: admin },
    async (req, reply) => {
      const r = SetDefaultsRequest.safeParse(req.body);
      if (!r.success) return deny(reply, 400, "invalid_request");
      const target = users.byId(req.params.id);
      if (!target) return deny(reply, 404, "not_found");
      if (!stillAdmin(req)) return deny(reply, 403, "forbidden");
      if (r.data.defaults) {
        try {
          deps.defaults.check(target.id, r.data.defaults);
        } catch (e) {
          if (e instanceof RunAccessDenied)
            return reply.code(400).header("Cache-Control", "no-store").send({ error: e.code });
          throw e;
        }
      }
      users.setInitialDefaults(target.id, r.data.defaults);
      return send(reply, { user: toAdminUser(users.byId(target.id)!) });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/admin/users/:id/skills",
    { config: admin },
    async (req, reply) => {
      const target = users.byId(req.params.id);
      if (!target) return deny(reply, 404, "not_found");
      return send(reply, userSkills(target, deps.mcp));
    },
  );

  // One skill on or off for one user (FR-1.6, FR-10.3). Takes effect from the next tool call (#21).
  app.put<{ Params: { id: string; name: string } }>(
    "/api/admin/users/:id/skills/:name",
    { config: admin },
    async (req, reply) => {
      const r = SetSkillEnabledRequest.safeParse(req.body);
      if (!r.success) return deny(reply, 400, "invalid_request");
      if (!catalogue.has(req.params.name)) return deny(reply, 404, "not_found");
      const target = users.byId(req.params.id);
      if (!target) return deny(reply, 404, "not_found");
      if (!stillAdmin(req)) return deny(reply, 403, "forbidden");
      users.setSkills(target.id, toggledSkills(target, req.params.name, r.data.enabled));
      return send(reply, userSkills(users.byId(target.id)!, deps.mcp));
    },
  );

  // The server allow-list (FR-10.3, D5): a skill switched off here is offered to nobody.
  app.put<{ Params: { name: string } }>("/api/admin/skills/:name", { config: admin }, async (req, reply) => {
    const r = SetSkillEnabledRequest.safeParse(req.body);
    if (!r.success) return deny(reply, 400, "invalid_request");
    if (!catalogue.has(req.params.name)) return deny(reply, 404, "not_found");
    if (!stillAdmin(req)) return deny(reply, 403, "forbidden");
    deps.mcp.setServerEnabled(req.params.name, r.data.enabled);
    return send(reply, { skills: deps.mcp.overview() });
  });

  // ---- the caller's own defaults (FR-12.1) ----

  // The new-conversation chip (#19): the server computes the choice, so the screen cannot drift from the rules the
  // conversation is created with (runtime only → its default or first model not at a limit; 403 when refused).
  app.post(
    "/api/settings/preview",
    { config: { noResource: "the caller's own runtime choice, nothing stored" } },
    async (req, reply) => {
      const r = PreviewSettingsRequest.safeParse(req.body);
      if (!r.success) return deny(reply, 400, "invalid_request");
      try {
        return send(reply, deps.defaults.change(users.byId(req.ctx.user!.id)!, r.data.base, r.data.change));
      } catch (e) {
        if (e instanceof RunAccessDenied)
          return reply.code(403).header("Cache-Control", "no-store").send({ error: e.code });
        throw e;
      }
    },
  );

  app.get(
    "/api/settings/defaults",
    { config: { noResource: "the caller's own defaults" } },
    async (req, reply) => send(reply, deps.defaults.effective(users.byId(req.ctx.user!.id)!)),
  );
  // A model, effort or runtime the admin did not allow is 403 — the same codes as a run (#17).
  app.put(
    "/api/settings/defaults",
    { config: { noResource: "the caller's own defaults" } },
    async (req, reply) => {
      const r = SetDefaultsRequest.safeParse(req.body);
      if (!r.success) return deny(reply, 400, "invalid_request");
      const userId = req.ctx.user!.id;
      if (r.data.defaults) {
        try {
          deps.defaults.check(userId, r.data.defaults);
        } catch (e) {
          if (e instanceof RunAccessDenied)
            return reply.code(403).header("Cache-Control", "no-store").send({ error: e.code });
          throw e;
        }
      }
      users.setDefaults(userId, r.data.defaults);
      return send(reply, deps.defaults.effective(users.byId(userId)!));
    },
  );
}
