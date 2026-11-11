import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** A family member, or a Cloudflare Access service token (the uptime check — allowed on /api/health only). */
export type AccessIdentity = { email: string } | { serviceToken: string };
export type AccessVerifier = (token: string) => Promise<AccessIdentity>;

/**
 * Verifies the `Cf-Access-Jwt-Assertion` header as Cloudflare documents it: RS256 signature against the team's
 * JWKS (`https://<team>/cdn-cgi/access/certs`, cached, refetched for an unknown `kid` so key rotation works),
 * `iss` = team domain, `aud` = the application's AUD tag, `exp`/`nbf`. A token without an email is accepted only
 * as a service token (`common_name` = its client ID); the trust boundary lets those reach the health check and
 * nothing else (#46 uptime measurement).
 */
export function createAccessVerifier(opts: {
  teamDomain: string;
  aud: string;
  /** Key source override (tests use a local JWKS). */
  keys?: JWTVerifyGetKey;
}): AccessVerifier {
  const issuer = `https://${opts.teamDomain}`;
  const keys =
    opts.keys ??
    createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: opts.aud,
      algorithms: ["RS256"],
      clockTolerance: 30,
      requiredClaims: ["exp", "iat"],
    });
    if (typeof payload.email === "string" && payload.email.includes("@"))
      return { email: payload.email.trim().toLowerCase() };
    const cn = payload.common_name;
    if (payload.email === undefined && typeof cn === "string" && cn.length > 0) return { serviceToken: cn };
    throw new Error("no email claim");
  };
}
