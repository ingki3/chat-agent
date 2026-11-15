import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AuthState,
  LoginRequest,
  PasswordChangeRequest,
  SetupRequest,
  type AuthState as AuthStateT,
} from "@agentlee/shared";
import type { z } from "zod";
import type { Config } from "../config.js";
import { dummyHash, hashPassword, verifyPassword } from "./passwords.js";
import { deny, SESSION_COOKIE, sessionCookie } from "./plugin.js";
import { FailureLimiter } from "./rate-limit.js";
import { SESSION_TTL_MS, toAuthUser, type UserRow, type UserStore } from "./users.js";

export type AuthRouteOptions = {
  /** Failed logins allowed per account / per client IP within `windowMs`. */
  perAccount?: number;
  perIp?: number;
  windowMs?: number;
  now?: () => number;
  /** Password check override (tests use it to hold a check open while something else changes). */
  verify?: (hash: string, password: string) => Promise<boolean>;
};

function parse<T extends z.ZodType>(
  schema: T,
  req: FastifyRequest,
  reply: FastifyReply,
): z.infer<T> | undefined {
  const r = schema.safeParse(req.body);
  if (!r.success) {
    void deny(reply, 400, "invalid_request");
    return undefined;
  }
  return r.data;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { config: Config; users: UserStore } & AuthRouteOptions,
): void {
  const { config, users } = deps;
  const windowMs = deps.windowMs ?? 15 * 60_000;
  const byAccount = new FailureLimiter(deps.perAccount ?? 5, windowMs, deps.now);
  const byIp = new FailureLimiter(deps.perIp ?? 20, windowMs, deps.now);
  const verify = deps.verify ?? verifyPassword;

  const state = (req: FastifyRequest, user: UserRow | null): AuthStateT =>
    AuthState.parse({
      setupRequired: users.count() === 0,
      user: user ? toAuthUser(user) : null,
      accessEmail: req.ctx.accessEmail ?? null,
      adminEmail: config.adminEmail,
    });

  const startSession = (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    const token = users.createSession(userId);
    reply.header("Set-Cookie", sessionCookie(req, token, SESSION_TTL_MS / 1000));
  };

  app.get(
    "/api/auth/state",
    { config: { auth: "public", noResource: "session endpoint" } },
    async (req, reply) => reply.header("Cache-Control", "no-store").send(state(req, req.ctx.user ?? null)),
  );

  // First run only: creates the admin (PRD FR-1.1). Once any user exists this route is closed for good.
  app.post(
    "/api/auth/setup",
    { config: { auth: "public", noResource: "session endpoint" } },
    async (req, reply) => {
      const body = parse(SetupRequest, req, reply);
      if (!body) return reply;
      if (users.count() > 0) return deny(reply, 409, "already_set_up");
      // Through Access, only the admin's own Access login may create the admin account.
      if (req.ctx.accessEmail !== undefined && req.ctx.accessEmail !== config.adminEmail)
        return deny(reply, 403, "access_email_mismatch");
      const passwordHash = await hashPassword(body.password);
      const user = users.createFirstAdmin({ email: config.adminEmail, name: body.name, passwordHash });
      if (!user) return deny(reply, 409, "already_set_up");
      startSession(req, reply, user.id);
      return reply.header("Cache-Control", "no-store").send(state(req, user));
    },
  );

  app.post(
    "/api/auth/login",
    { config: { auth: "public", noResource: "session endpoint" } },
    async (req, reply) => {
      const body = parse(LoginRequest, req, reply);
      if (!body) return reply;
      const ipKey = `ip:${req.ctx.clientIp}`;
      const accountKey = `acct:${body.email}`;
      if (byIp.blocked(ipKey) || byAccount.blocked(accountKey)) return deny(reply, 429, "too_many_attempts");
      // Count the attempt before the (slow, async) password check, so parallel guesses hit the limit too.
      // A successful login takes it back.
      byIp.fail(ipKey);
      byAccount.fail(accountKey);
      // Through Access you can only sign in to the account of the email you passed Access with.
      if (req.ctx.accessEmail !== undefined && req.ctx.accessEmail !== body.email) {
        byAccount.release(accountKey);
        return deny(reply, 403, "access_email_mismatch");
      }
      const user = users.byEmail(body.email);
      const usable = user?.active && user.passwordHash ? user : undefined;
      const ok = await verify(usable?.passwordHash ?? (await dummyHash()), body.password);
      // Re-read after the await: the password may have changed or the account been deactivated meanwhile.
      // No await between this check and creating the session, so nothing can slip in between.
      const fresh = usable && users.byId(usable.id);
      if (!usable || !ok || !fresh?.active || fresh.passwordHash !== usable.passwordHash)
        return deny(reply, 401, "invalid_credentials");
      byIp.release(ipKey);
      byAccount.reset(accountKey);
      if (req.ctx.sessionToken) users.deleteSession(req.ctx.sessionToken);
      startSession(req, reply, fresh.id);
      return reply.header("Cache-Control", "no-store").send(state(req, fresh));
    },
  );

  app.post(
    "/api/auth/logout",
    { config: { auth: "public", noResource: "session endpoint" } },
    async (req, reply) => {
      if (req.ctx.sessionToken) users.deleteSession(req.ctx.sessionToken);
      return reply
        .header("Set-Cookie", sessionCookie(req, "", 0))
        .header("Cache-Control", "no-store")
        .send(state(req, null));
    },
  );

  app.post(
    "/api/auth/password",
    { config: { auth: "user", allowPendingPassword: true, noResource: "own password" } },
    async (req, reply) => {
      const body = parse(PasswordChangeRequest, req, reply);
      if (!body) return reply;
      const user = req.ctx.user!;
      const accountKey = `acct:${user.email}`;
      if (byAccount.blocked(accountKey)) return deny(reply, 429, "too_many_attempts");
      byAccount.fail(accountKey);
      if (!user.passwordHash || !(await verify(user.passwordHash, body.currentPassword)))
        return deny(reply, 401, "invalid_credentials");
      byAccount.release(accountKey);
      if (body.newPassword === body.currentPassword) return deny(reply, 400, "invalid_request");
      const newHash = await hashPassword(body.newPassword);
      // Same re-check as login: refuse if the password changed or the session ended during the awaits.
      const fresh = users.byId(user.id);
      if (
        !fresh?.active ||
        fresh.passwordHash !== user.passwordHash ||
        !users.sessionUser(req.ctx.sessionToken!)
      )
        return deny(reply, 401, "invalid_credentials");
      users.setPassword(user.id, newHash, { keepSession: req.ctx.sessionToken! });
      return reply.header("Cache-Control", "no-store").send(state(req, users.byId(user.id) ?? null));
    },
  );
}

export { SESSION_COOKIE };
