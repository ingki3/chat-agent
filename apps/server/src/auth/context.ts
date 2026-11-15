import type { UserRow } from "./users.js";

/**
 * Per-request trust and identity, filled by the onRequest hooks in auth/plugin.ts.
 * - `edge`: came through Cloudflare (Host = PUBLIC_HOST). `accessEmail` is set when Access is configured.
 * - `local`: loopback Host with no Cloudflare headers (home use, app login only).
 */
export type RequestContext = {
  origin: "edge" | "local";
  /** For rate limiting: CF-Connecting-IP on edge requests, the socket address on local ones. */
  clientIp: string;
  accessEmail: string | undefined;
  user: UserRow | undefined;
  sessionToken: string | undefined;
  /** A valid session whose email differs from the Access email — every authenticated route refuses it. */
  emailMismatch: boolean;
};

/** Route-level access rule (`config.auth`). API routes default to "user", other routes (SPA, static) to "public". */
export type AuthRule = "public" | "user" | "admin";

declare module "fastify" {
  interface FastifyRequest {
    ctx: RequestContext;
  }
  interface FastifyContextConfig {
    auth?: AuthRule;
    /** Lets a user who must change a temporary password reach this route. */
    allowPendingPassword?: boolean;
  }
}
