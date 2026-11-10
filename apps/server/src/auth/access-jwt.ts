import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type AccessIdentity = { email: string };
export type AccessVerifier = (token: string) => Promise<AccessIdentity>;

/**
 * Verifies the `Cf-Access-Jwt-Assertion` header as Cloudflare documents it: RS256 signature against the team's
 * JWKS (`https://<team>/cdn-cgi/access/certs`, cached, refetched for an unknown `kid` so key rotation works),
 * `iss` = team domain, `aud` = the application's AUD tag, `exp`/`nbf`. Tokens without an email (service tokens)
 * are refused — every request must map to a family member.
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
    if (typeof payload.email !== "string" || !payload.email.includes("@")) throw new Error("no email claim");
    return { email: payload.email.trim().toLowerCase() };
  };
}
