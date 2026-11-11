import crypto from "node:crypto";
import { and, count, eq, gt, lt, ne } from "drizzle-orm";
import {
  DEFAULT_PERMISSIONS,
  RuntimeDefaults,
  type AdminUser,
  type AuthUser,
  type Role,
  type RuntimeId,
  type UserPermissions,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import type { AppEvents } from "../events.js";
import { knownSecrets } from "../secrets/known.js";

export type UserRow = typeof users.$inferSelect;

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** lastSeenAt is refreshed at most this often, to avoid a write per request. */
const TOUCH_MS = 60_000;

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
/** Database id of a session (the hash of its cookie token) — what push subscriptions are bound to (#34). */
export const sessionIdOf = (token: string) => sha256(token);
export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export function toAuthUser(u: UserRow): AuthUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role, mustChangePassword: u.mustChangePassword };
}

/** A stored defaults value, or null when there is none (or it no longer parses — then it is ignored). */
export function storedDefaults(v: unknown): RuntimeDefaults | null {
  if (v === null || v === undefined) return null;
  const r = RuntimeDefaults.safeParse(v);
  return r.success ? r.data : null;
}

export function toAdminUser(u: UserRow): AdminUser {
  const initial = storedDefaults(u.initialDefaults);
  return {
    ...toAuthUser(u),
    active: u.active,
    permissions: u.permissions as UserPermissions,
    defaultRuntime: initial?.runtime ?? null,
    initialDefaults: initial,
    youth: u.youth,
    createdAt: u.createdAt,
  };
}

/** Outcome of `UserStore.update`. */
export type UpdateUserResult =
  | { ok: true; user: UserRow }
  | { ok: false; code: "not_found" | "email_taken" | "last_admin" | "admin_email_change" };

/** Readable temporary password, e.g. `k7mq-3xtp-w9hd` (no 0/o/1/l/i): ~62 bits, shown to the admin once. */
export function temporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const groups = Array.from({ length: 3 }, () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join(""),
  );
  return groups.join("-");
}

/** Accounts and login sessions. Session cookies hold a random token; the database stores only its hash. */
export class UserStore {
  constructor(
    private readonly db: Db,
    private readonly events: AppEvents,
    private readonly now: () => number = Date.now,
  ) {}

  count(): number {
    return this.db.select({ n: count() }).from(users).get()?.n ?? 0;
  }

  byEmail(email: string): UserRow | undefined {
    return this.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .get();
  }

  list(): UserRow[] {
    return this.db.select().from(users).orderBy(users.createdAt).all();
  }

  byId(id: string): UserRow | undefined {
    return this.db.select().from(users).where(eq(users.id, id)).get();
  }

  create(input: {
    email: string;
    name: string;
    role: Role;
    passwordHash: string;
    mustChangePassword?: boolean;
    permissions?: UserPermissions;
    defaultRuntime?: RuntimeId | null;
    youth?: boolean;
  }): UserRow {
    const row = {
      id: crypto.randomUUID(),
      email: normalizeEmail(input.email),
      name: input.name,
      role: input.role,
      passwordHash: input.passwordHash,
      mustChangePassword: input.mustChangePassword ?? false,
      active: true,
      permissions: input.permissions ?? DEFAULT_PERMISSIONS,
      defaultRuntime: null,
      // The create form's runtime is the admin's initial default (#35, FR-12.4).
      initialDefaults: input.defaultRuntime
        ? ({ runtime: input.defaultRuntime, models: {} } satisfies RuntimeDefaults)
        : null,
      defaults: null,
      youth: input.youth ?? false,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.db.insert(users).values(row).run();
    return row;
  }

  /** Creates the first admin only if there are no users yet (atomic: two concurrent setups cannot both win). */
  createFirstAdmin(input: { email: string; name: string; passwordHash: string }): UserRow | undefined {
    return this.db.$client
      .transaction(() => {
        if (this.count() > 0) return undefined;
        return this.create({ ...input, role: "admin" });
      })
      .immediate();
  }

  /** Sets a new password. Other sessions of the user are revoked (all of them when `keepSession` is absent). */
  setPassword(
    userId: string,
    passwordHash: string,
    opts: { mustChange?: boolean; keepSession?: string } = {},
  ) {
    this.db
      .update(users)
      .set({ passwordHash, mustChangePassword: opts.mustChange ?? false, updatedAt: this.now() })
      .where(eq(users.id, userId))
      .run();
    const keep = opts.keepSession ? sha256(opts.keepSession) : undefined;
    this.db
      .delete(sessions)
      .where(keep ? and(eq(sessions.userId, userId), ne(sessions.id, keep)) : eq(sessions.userId, userId))
      .run();
    this.events.emit("user-access-changed", { userId, reason: "password_changed" });
  }

  /**
   * Deactivates unless that would leave no active admin. Check and change run in one transaction, so two admins
   * deactivating each other at the same moment cannot both succeed. Returns false when refused.
   */
  deactivateUnlessLastAdmin(userId: string): boolean {
    const ok = this.db.$client
      .transaction(() => {
        const target = this.byId(userId);
        if (!target) return false;
        if (target.role === "admin" && target.active) {
          const admins =
            this.db
              .select({ n: count() })
              .from(users)
              .where(and(eq(users.role, "admin"), eq(users.active, true)))
              .get()?.n ?? 0;
          if (admins <= 1) return false;
        }
        this.db.update(users).set({ active: false, updatedAt: this.now() }).where(eq(users.id, userId)).run();
        this.db.delete(sessions).where(eq(sessions.userId, userId)).run();
        return true;
      })
      .immediate();
    if (ok) this.events.emit("user-access-changed", { userId, reason: "deactivated" });
    return ok;
  }

  /** Deactivates the account and ends every session at once. */
  deactivate(userId: string): void {
    this.db.update(users).set({ active: false, updatedAt: this.now() }).where(eq(users.id, userId)).run();
    this.db.delete(sessions).where(eq(sessions.userId, userId)).run();
    this.events.emit("user-access-changed", { userId, reason: "deactivated" });
  }

  /** Marks a youth account (#20). Takes effect from the user's next run (new instructions → fresh session). */
  setYouth(userId: string, youth: boolean): void {
    this.db.update(users).set({ youth, updatedAt: this.now() }).where(eq(users.id, userId)).run();
  }

  /**
   * Which skills the user may use (FR-1.6): "all" or a list of PRD §7 names. Only the `skills` field of the
   * permissions changes (read and written in one synchronous step). Takes effect at once: the MCP server checks
   * every call (#21).
   */
  setSkills(userId: string, skills: "all" | string[]): void {
    const u = this.byId(userId);
    if (!u) return;
    const permissions = { ...(u.permissions as UserPermissions), skills };
    this.db.update(users).set({ permissions, updatedAt: this.now() }).where(eq(users.id, userId)).run();
  }

  /** Active admins other than `userId`. */
  private otherActiveAdmins(userId: string): number {
    return (
      this.db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.active, true), ne(users.id, userId)))
        .get()?.n ?? 0
    );
  }

  /**
   * Name, email and role (#35, FR-15.1), checked and written in one transaction:
   * - demoting an active admin is refused when no other active admin would be left (`last_admin`) — the admin
   *   themselves included: two admins demoting each other at once cannot both succeed;
   * - an admin's email changes only through the #36 procedure (FR-15.7: Access first), `admin_email_change`;
   * - an email in use is `email_taken`.
   * A new email ends the user's sessions (they sign in again with it — through Access the old session would no
   * longer match); a new role re-checks their open streams.
   */
  update(
    userId: string,
    patch: { name?: string | undefined; email?: string | undefined; role?: Role | undefined },
  ): UpdateUserResult {
    const result = this.db.$client
      .transaction((): UpdateUserResult & { emailChanged?: boolean; roleChanged?: boolean } => {
        const target = this.byId(userId);
        if (!target) return { ok: false, code: "not_found" };
        const email = patch.email === undefined ? target.email : normalizeEmail(patch.email);
        const role = patch.role ?? target.role;
        const emailChanged = email !== target.email;
        const roleChanged = role !== target.role;
        if (emailChanged && (target.role === "admin" || role === "admin"))
          return { ok: false, code: "admin_email_change" };
        if (emailChanged) {
          const other = this.byEmail(email);
          if (other && other.id !== userId) return { ok: false, code: "email_taken" };
        }
        if (roleChanged && target.role === "admin" && target.active && this.otherActiveAdmins(userId) === 0)
          return { ok: false, code: "last_admin" };
        this.db
          .update(users)
          .set({ name: patch.name ?? target.name, email, role, updatedAt: this.now() })
          .where(eq(users.id, userId))
          .run();
        if (emailChanged) this.db.delete(sessions).where(eq(sessions.userId, userId)).run();
        return { ok: true, user: this.byId(userId)!, emailChanged, roleChanged };
      })
      .immediate();
    if (result.ok && result.emailChanged)
      this.events.emit("user-access-changed", { userId, reason: "session_ended" });
    if (result.ok && result.roleChanged)
      this.events.emit("user-access-changed", { userId, reason: "role_changed" });
    return result.ok ? { ok: true, user: result.user } : result;
  }

  /** The admin's initial defaults for the user (FR-12.4); null = the service default. Checked by the caller. */
  setInitialDefaults(userId: string, d: RuntimeDefaults | null): void {
    this.db
      .update(users)
      .set({ initialDefaults: d, updatedAt: this.now() })
      .where(eq(users.id, userId))
      .run();
  }

  /** The user's own defaults (FR-12.1); null = none. Checked by the caller against the policy. */
  setDefaults(userId: string, d: RuntimeDefaults | null): void {
    this.db.update(users).set({ defaults: d, updatedAt: this.now() }).where(eq(users.id, userId)).run();
  }

  setRole(userId: string, role: Role): void {
    this.db.update(users).set({ role, updatedAt: this.now() }).where(eq(users.id, userId)).run();
    this.events.emit("user-access-changed", { userId, reason: "role_changed" });
  }

  /** Returns the cookie token. */
  createSession(userId: string): string {
    const token = crypto.randomBytes(32).toString("base64url");
    const t = this.now();
    this.db.delete(sessions).where(lt(sessions.expiresAt, t)).run();
    this.db
      .insert(sessions)
      .values({ id: sha256(token), userId, createdAt: t, lastSeenAt: t, expiresAt: t + SESSION_TTL_MS })
      .run();
    knownSecrets.add(token, { fresh: true }); // the cookie never shows up in a reply
    return token;
  }

  /** Active user for a cookie token, or undefined for unknown/expired sessions and inactive users. */
  sessionUser(token: string): UserRow | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const id = sha256(token);
    const t = this.now();
    const row = this.db
      .select({ user: users, lastSeenAt: sessions.lastSeenAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, t), eq(users.active, true)))
      .get();
    if (!row) return undefined;
    knownSecrets.add(token); // sessions from before a restart are known again once used
    if (t - row.lastSeenAt > TOUCH_MS)
      this.db.update(sessions).set({ lastSeenAt: t }).where(eq(sessions.id, id)).run();
    return row.user;
  }

  /** Ends one session (logout). Open streams of that session re-check and close. */
  deleteSession(token: string): void {
    knownSecrets.remove(token);
    const row = this.db
      .delete(sessions)
      .where(eq(sessions.id, sha256(token)))
      .returning({ userId: sessions.userId })
      .get();
    if (row) this.events.emit("user-access-changed", { userId: row.userId, reason: "session_ended" });
  }

  /** Expiry time of a valid session, for streams that must end when it does. */
  sessionExpiresAt(token: string): number | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    return this.db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.id, sha256(token)))
      .get()?.expiresAt;
  }

  sessionCount(userId: string): number {
    return this.db.select({ n: count() }).from(sessions).where(eq(sessions.userId, userId)).get()?.n ?? 0;
  }
}
