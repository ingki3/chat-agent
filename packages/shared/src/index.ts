import { z } from "zod";
import { RuntimeId } from "./runtime.js";
import { ChatSettings } from "./chat.js";

export * from "./runtime.js";
export * from "./chat.js";
export * from "./notifications.js";
export * from "./external.js";
export * from "./connections.js";
export * from "./sources.js";
export * from "./artifacts.js";
export * from "./files.js";
export * from "./usage.js";
export * from "./finance.js";
export * from "./admin.js";
export * from "./redact.js";
export * from "./citations.js";
export * from "./schedules.js";
export * from "./docgen.js";

/** Response of `GET /api/health`. Shared by server and web so both sides agree on the shape. */
export const HealthResponse = z.object({
  status: z.literal("ok"),
  service: z.literal("agent-lee"),
  version: z.string(),
  uptimeSec: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const SERVICE_NAME = "Agent Lee";

// ---- Auth (#9) ----

/** State-changing API calls must carry this header (plus a same-origin `Origin`), see apps/server/src/auth/csrf.ts. */
export const CSRF_HEADER = "x-agent-lee";
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export const Role = z.enum(["admin", "member"]);
export type Role = z.infer<typeof Role>;

export const AuthUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: Role,
  mustChangePassword: z.boolean(),
});
export type AuthUser = z.infer<typeof AuthUser>;

/** `GET /api/auth/state`. */
export const AuthState = z.object({
  setupRequired: z.boolean(),
  user: AuthUser.nullable(),
  /** Email that passed Cloudflare Access (external requests only); login must use the same email. */
  accessEmail: z.string().nullable(),
  /** Admin email used by the first-run screen. */
  adminEmail: z.string(),
});
export type AuthState = z.infer<typeof AuthState>;

const Password = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);

export const SetupRequest = z.object({ name: z.string().trim().min(1).max(40), password: Password });
export const LoginRequest = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1).max(PASSWORD_MAX),
});
export const PasswordChangeRequest = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX),
  newPassword: Password,
});

// ---- Users (#41) ----

/** What a user may use. Enforced by #17/#19/#21; set by the admin (#35). */
export const UserPermissions = z.object({
  runtimes: z.array(RuntimeId),
  models: z.union([z.literal("all"), z.array(z.string())]),
  skills: z.union([z.literal("all"), z.array(z.string())]),
});
export type UserPermissions = z.infer<typeof UserPermissions>;
export const DEFAULT_PERMISSIONS: UserPermissions = {
  runtimes: ["claude-code", "codex"],
  models: "all",
  skills: "all",
};

/**
 * Default runtime and, per runtime, default model and effort (PRD D3, FR-12.1·12.3·12.4). Stored twice per user:
 * the user's own choice, and the admin's initial value for that user (used while the user has made none).
 * Both are checked against the user's policy when they are saved (403 / 400 when not allowed).
 */
export const ModelDefault = z
  .object({ model: z.string().min(1).max(100), effort: z.string().min(1).max(20).nullable() })
  .strict();
export type ModelDefault = z.infer<typeof ModelDefault>;
export const RuntimeDefaults = z
  .object({
    runtime: RuntimeId,
    models: z.object({ "claude-code": ModelDefault.optional(), codex: ModelDefault.optional() }).strict(),
  })
  .strict();
export type RuntimeDefaults = z.infer<typeof RuntimeDefaults>;
/** Without any saved value (PRD D3, FR-12.4): Claude Code · Opus 5.5. */
export const SERVICE_DEFAULTS: RuntimeDefaults = {
  runtime: "claude-code",
  models: { "claude-code": { model: "claude-opus-5-5", effort: null } },
};
/**
 * `GET /api/settings/defaults`: what new conversations start with — the user's own choice, else the admin's
 * initial value, else the service default — and which runtimes' saved model is no longer allowed (FR-12.6 notice).
 * `start` is what a new conversation would really start with right now after the FR-12.6 fallback order (#19), null
 * when nothing is usable ("쓸 수 있는 런타임이 없어요"); `fallback` says the default itself could not be used.
 */
export const DefaultsResponse = z.object({
  defaults: RuntimeDefaults,
  source: z.enum(["own", "initial", "service"]),
  unavailable: z.array(RuntimeId),
  start: ChatSettings.nullable(),
  fallback: z.boolean(),
  /** The default is at a usage limit until then (the cause of the fallback, FR-9.2); null otherwise. */
  limitedUntil: z.number().nullable(),
});
export type DefaultsResponse = z.infer<typeof DefaultsResponse>;
/** `PUT /api/settings/defaults` (own) and `PUT /api/admin/users/:id/defaults` (initial; null clears it). */
export const SetDefaultsRequest = z.object({ defaults: RuntimeDefaults.nullable() }).strict();

export const AdminUser = AuthUser.extend({
  active: z.boolean(),
  permissions: UserPermissions,
  /** The admin's initial runtime (= `initialDefaults.runtime`); kept for the create form (#41). */
  defaultRuntime: RuntimeId.nullable(),
  /** The admin's initial defaults for this user (FR-12.4); null = the service default. */
  initialDefaults: RuntimeDefaults.nullable(),
  /** Youth account (the son): gets the youth safety and learning-support instructions (#20). */
  youth: z.boolean(),
  createdAt: z.number(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const CreateUserRequest = z.object({
  name: z.string().trim().min(1).max(40),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  role: Role.default("member"),
  defaultRuntime: RuntimeId.nullable().default(null),
  youth: z.boolean().default(false),
});
export const SetYouthRequest = z.object({ youth: z.boolean() });
/**
 * `PATCH /api/admin/users/:id` (#35, FR-15.1): name, email and role. An admin's email is changed by the #36
 * procedure only (FR-15.7); the last active admin cannot be demoted.
 */
export const UpdateUserRequest = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()).optional(),
    role: Role.optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.email !== undefined || v.role !== undefined, {
    message: "nothing to update",
  });
/** The temporary password is in this response only; it is never stored or shown again. */
export const CreateUserResponse = z.object({ user: AdminUser, temporaryPassword: z.string() });
export const ResetPasswordResponse = z.object({ temporaryPassword: z.string() });

// ---- Skills (#21, PRD §7, FR-1.6, FR-10.3; the admin screen is #35) ----

/** Which skills one user may use: all of them, or only these (PRD §7 names; e.g. the son without finance). */
export const SetUserSkillsRequest = z.object({
  skills: z.union([z.literal("all"), z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)).max(64)]),
});
/** A PRD §7 skill and where it stands on this server. */
export const AdminSkill = z.object({
  name: z.string(),
  /** MCP tool name (`skill_<name>`). */
  tool: z.string(),
  finance: z.boolean(),
  /**
   * available: offered · not_installed: `pnpm skills:install` not run · broken: the installed copy changed ·
   * needs_python: SKILL_PYTHON missing or unusable · planned: comes with a later issue · document: becomes a server
   * function (file tools).
   */
  status: z.enum(["available", "not_installed", "broken", "needs_python", "planned", "document"]),
  issue: z.string().optional(),
  /** On the server allow-list (FR-10.3). Off: no user gets it, whatever their own permissions say. */
  enabled: z.boolean(),
});
export type AdminSkill = z.infer<typeof AdminSkill>;
export const AdminSkillsResponse = z.object({ skills: z.array(AdminSkill) });
/** `PUT /api/admin/skills/:name` (server allow-list) and `PUT /api/admin/users/:id/skills/:name` (one user). */
export const SetSkillEnabledRequest = z.object({ enabled: z.boolean() }).strict();
/**
 * One skill for one user (`GET /api/admin/users/:id/skills`): whether their permissions allow it (`allowed`) and
 * why — `all` (every skill), `youth_hidden` (finance skill of a youth account under "all"), `listed` / `unlisted`
 * (an explicit list). `serverEnabled` false = off for everyone on the server allow-list.
 */
export const UserSkill = z.object({
  name: z.string(),
  finance: z.boolean(),
  allowed: z.boolean(),
  reason: z.enum(["all", "youth_hidden", "listed", "unlisted"]),
  serverEnabled: z.boolean(),
});
export type UserSkill = z.infer<typeof UserSkill>;
export const UserSkillsResponse = z.object({
  mode: z.enum(["all", "list"]),
  youth: z.boolean(),
  skills: z.array(UserSkill),
});
export type UserSkillsResponse = z.infer<typeof UserSkillsResponse>;

/** Error codes returned as `{ error }` by the auth layer. */
export type AuthError =
  | "bad_host"
  | "access_denied"
  | "access_not_configured"
  | "access_email_mismatch"
  | "csrf"
  | "unauthenticated"
  | "forbidden"
  | "password_change_required"
  | "invalid_credentials"
  | "too_many_attempts"
  | "already_set_up"
  | "invalid_request"
  | "email_taken"
  | "cannot_change_self"
  | "last_admin"
  | "admin_email_change"
  | "unknown_skill"
  | "not_found";

/**
 * One entry of the admin "최근 오류" list (`GET /api/admin/errors`, #46). Same policy as the logs: IDs, sanitised
 * codes and route patterns only — never an error message, prompt or tool output.
 */
export const RecentError = z.object({
  id: z.number().int(),
  at: z.number().int(),
  source: z.enum(["http", "run", "tool"]),
  code: z.string(),
  category: z.string(),
  userId: z.string().nullable(),
  conversationId: z.string().nullable(),
  runId: z.string().nullable(),
  runtime: z.string().nullable(),
  tool: z.string().nullable(),
  route: z.string().nullable(),
  statusCode: z.number().int().nullable(),
});
export type RecentError = z.infer<typeof RecentError>;
export const RecentErrorsResponse = z.object({ errors: z.array(RecentError) });
export type RecentErrorsResponse = z.infer<typeof RecentErrorsResponse>;
