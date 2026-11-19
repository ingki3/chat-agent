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
  /**
   * A public artifact link request (#204, `isPublicLinkRequest`): no Access JWT is required or read, no session cookie
   * is read, nothing signs anyone in. `accessEmail`, `user` and `sessionToken` stay undefined.
   */
  publicLink: boolean;
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
    /**
     * One of the three public artifact link routes (#204, `public-links/routes.ts`) — the only routes outside Access and
     * the app login. Together with the exact path shape (`isPublicLinkPath`) and `PUBLIC_LINKS_ENABLED`.
     */
    publicLink?: boolean;
  }
}
