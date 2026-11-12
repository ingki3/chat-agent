import { z } from "zod";
import { RuntimeId } from "./runtime.js";

/**
 * Runtime connections (#17, PRD D2 / FR-11): runtime × auth type × scope. The credential itself never leaves the
 * server — responses carry a masked `hint` (last 4 characters) at most.
 */
export const ConnectionAuthType = z.enum(["api_key", "subscription"]);
export type ConnectionAuthType = z.infer<typeof ConnectionAuthType>;
export const ConnectionScope = z.enum(["shared", "personal"]);
export type ConnectionScope = z.infer<typeof ConnectionScope>;
/** Only `passed` connections are offered in the picker or used for runs. */
export const ConnectionStatus = z.enum(["untested", "passed", "failed", "expired"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const Connection = z.object({
  id: z.string(),
  runtime: RuntimeId,
  authType: ConnectionAuthType,
  scope: ConnectionScope,
  /** The user a personal connection belongs to; null for shared ones. */
  ownerId: z.string().nullable(),
  label: z.string(),
  /** `••••abcd` — never more of the credential. Null for a ChatGPT login (only its email is shown). */
  hint: z.string().nullable(),
  /** The signed-in account's email (ChatGPT login, #18) — the only thing shown of a login. */
  accountEmail: z.string().nullable(),
  status: ConnectionStatus,
  lastTestAt: z.number().nullable(),
  /** Fixed code of the last test (`ok`, `test_no_stream`, `test_no_tool`, `test_no_skill`, `runtime_auth`, …). */
  lastTestCode: z.string().nullable(),
  /** Usage limit reached (#19): until when (ms) — new conversations start elsewhere meanwhile. Null = not limited. */
  limitedUntil: z.number().nullable(),
  /** Registered by an admin on the owner's behalf. */
  registeredByAdmin: z.boolean(),
  createdAt: z.number(),
});
export type Connection = z.infer<typeof Connection>;

const Label = z.string().trim().min(1).max(60);
/** Credentials are short single-line tokens; the server checks the provider's own format. */
const Secret = z
  .string()
  .trim()
  .min(20)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);

/** `POST /api/connections` (personal, own), `POST /api/admin/users/:id/connections`, `POST /api/admin/connections`. */
export const CreateConnectionRequest = z
  .object({
    runtime: RuntimeId,
    authType: ConnectionAuthType,
    label: Label.optional(),
    secret: Secret,
  })
  .strict();
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequest>;

/**
 * Codex ChatGPT login (#18, PRD D2 / FR-11.2): app-server's device-code flow, run on the server, shown in the web
 * screen. `POST /api/connections/logins` starts one — for a new personal connection, or with `connectionId` to log
 * in again on an existing one (its credential is replaced).
 */
export const StartSubscriptionLoginRequest = z
  .object({
    runtime: z.literal("codex"),
    label: Label.optional(),
    connectionId: z.string().min(1).max(100).optional(),
  })
  .strict();
export type StartSubscriptionLoginRequest = z.infer<typeof StartSubscriptionLoginRequest>;
/**
 * - `pending`: waiting for the user to enter `userCode` at `verificationUrl` (until `expiresAt`);
 * - `completed`: logged in — `connectionId` is the connection (it still needs its test);
 * - `failed` (`code`: `login_failed`, `login_expired`, `login_error`), `cancelled`, `timeout`: nothing was stored.
 */
export const SubscriptionLoginStatus = z.enum(["pending", "completed", "failed", "cancelled", "timeout"]);
export type SubscriptionLoginStatus = z.infer<typeof SubscriptionLoginStatus>;
export const SubscriptionLogin = z.object({
  id: z.string(),
  runtime: RuntimeId,
  status: SubscriptionLoginStatus,
  /** Where to sign in (always `https://auth.openai.com/…`). Null once the login has ended. */
  verificationUrl: z.string().nullable(),
  /** One-time code to type there. Shown to the user who started the login only; null once it has ended. */
  userCode: z.string().nullable(),
  expiresAt: z.number().nullable(),
  connectionId: z.string().nullable(),
  code: z.string().nullable(),
});
export type SubscriptionLogin = z.infer<typeof SubscriptionLogin>;

/** Label and credential can change; scope, runtime and auth type never do (a new connection is made instead). */
export const UpdateConnectionRequest = z
  .object({ label: Label.optional(), secret: Secret.optional() })
  .strict()
  .refine((v) => v.label !== undefined || v.secret !== undefined, { message: "nothing to update" });

export const ConnectionTestResult = z.object({
  status: ConnectionStatus,
  code: z.string(),
  checks: z.object({ reply: z.boolean(), streaming: z.boolean(), tool: z.boolean(), skill: z.boolean() }),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResult>;

/** A model the user may pick, with the effort values allowed for them. */
export const RuntimeModelOption = z.object({
  id: z.string(),
  label: z.string(),
  efforts: z.array(z.string()),
  defaultEffort: z.string().nullable(),
});
/** `GET /api/runtimes`: what the picker may show — allowed runtimes, models, efforts and passed connections. */
export const RuntimeOption = z.object({
  runtime: RuntimeId,
  models: z.array(RuntimeModelOption),
  /** Whether runs of this runtime need a connection at all (the development FakeRuntime does not). */
  needsConnection: z.boolean(),
  connections: z.array(Connection),
});
export type RuntimeOption = z.infer<typeof RuntimeOption>;

/** Per-user, per-runtime allowance (admin). Without a row the user's `permissions` apply. */
export const RuntimePolicy = z.object({
  runtime: RuntimeId,
  allowed: z.boolean(),
  models: z.union([z.literal("all"), z.array(z.string().max(100)).max(50)]),
  efforts: z.union([z.literal("all"), z.array(z.string().max(20)).max(20)]),
  allowPersonal: z.boolean(),
  allowShared: z.boolean(),
});
export type RuntimePolicy = z.infer<typeof RuntimePolicy>;

/**
 * Per-turn choices on send / edit / regenerate. Everything is optional: missing values come from the conversation
 * (and later the user's defaults, #19). The server checks all of them (403 when not allowed).
 */
export const RunChoice = z.object({
  runtime: RuntimeId.optional(),
  model: z.string().min(1).max(100).optional(),
  effort: z.string().min(1).max(20).optional(),
  /** A specific connection (must be the caller's own personal one or a shared one they may use). */
  connectionId: z.string().min(1).max(100).optional(),
  /** Use the family shared connection even when a personal one exists. */
  useShared: z.boolean().optional(),
});
export type RunChoice = z.infer<typeof RunChoice>;
