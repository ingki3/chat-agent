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
  | "invalid_request";
