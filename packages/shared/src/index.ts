import { z } from "zod";

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

export const RuntimeId = z.enum(["claude-code", "codex"]);
export type RuntimeId = z.infer<typeof RuntimeId>;

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

export const AdminUser = AuthUser.extend({
  active: z.boolean(),
  permissions: UserPermissions,
  defaultRuntime: RuntimeId.nullable(),
  createdAt: z.number(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const CreateUserRequest = z.object({
  name: z.string().trim().min(1).max(40),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  role: Role.default("member"),
  defaultRuntime: RuntimeId.nullable().default(null),
});
/** The temporary password is in this response only; it is never stored or shown again. */
export const CreateUserResponse = z.object({ user: AdminUser, temporaryPassword: z.string() });
export const ResetPasswordResponse = z.object({ temporaryPassword: z.string() });

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
  | "not_found";
