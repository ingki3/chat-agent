import { Writable } from "node:stream";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CSRF_HEADER, type AuthState } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { hashPassword } from "../src/auth/passwords.js";

/**
 * Single sign-on through Cloudflare Access (#178, FR-15.8): a verified Access login on the public host becomes an
 * app session for the one active account with that email — no app password. Synthetic keys and JWTs only (a local
 * JWKS), never the real Cloudflare.
 */

const TEAM = "family.cloudflareaccess.com";
const AUD = "c".repeat(64);
const HOST = "chat.2prostream.com";
const ADMIN = "ingki3@gmail.com";
const MOM = "mom@example.com";
const PW = "correct horse battery";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

async function jwt(
  claims: Record<string, unknown>,
  o: { aud?: string; iss?: string; exp?: string | number; nbf?: string | number; key?: CryptoKey } = {},
) {
  const t = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(o.iss ?? `https://${TEAM}`)
    .setAudience(o.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? "5m");
  if (o.nbf !== undefined) t.setNotBefore(o.nbf);
  return t.sign(o.key ?? privateKey);
}

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
  const records = () =>
    lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { stream, text: () => lines.join(""), records };
}

async function start() {
  const log = capture();
  const config = loadConfig({ NODE_ENV: "test", CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD });
  const app = await buildApp(config, { db: createTestDb(), accessKeys: jwks, logStream: log.stream });
  app.get("/api/test/user", { config: { noResource: "test" } }, async (req) => ({ id: req.ctx.user!.id }));
  apps.push(app);
  const users = app.users!;
  const admin = users.create({
    email: ADMIN,
    name: "아빠",
    role: "admin",
    passwordHash: await hashPassword(PW),
  });
  const mom = users.create({
    email: MOM,
    name: "엄마",
    role: "member",
    passwordHash: await hashPassword(PW),
  });
  return { app, users, admin, mom, log };
}

const local = { host: "localhost:3000" };
const localWrite = { ...local, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
const edge = async (email: string) => ({
  host: HOST,
  "cf-connecting-ip": "198.51.100.7",
  "cf-access-jwt-assertion": await jwt({ email }),
});
const edgeWrite = async (email: string) => ({
  ...(await edge(email)),
  origin: `https://${HOST}`,
  [CSRF_HEADER]: "1",
});
const setCookie = (r: { headers: Record<string, unknown> }) => r.headers["set-cookie"];
const cookieOf = (sc: unknown) => String(Array.isArray(sc) ? sc[0] : sc).split(";")[0]!;

async function accessLogin(app: App, headers: Record<string, string>) {
  return app.inject({ method: "POST", url: "/api/auth/access-login", headers, payload: {} });
}

describe("Access single sign-on", () => {
  it("signs an active user in with their Access email: fresh session, same cookie attributes, audit line", async () => {
    const { app, users, mom, log } = await start();
    // Signed out on the public host: the state says who passed Access, no user yet.
    const before = await app.inject({ url: "/api/auth/state", headers: await edge(MOM) });
    expect((before.json() as AuthState).user).toBeNull();
    expect((before.json() as AuthState).accessEmail).toBe(MOM);
    expect(setCookie(before)).toBeUndefined(); // reading the state never starts a session

    const r = await accessLogin(app, await edgeWrite(MOM));
    expect(r.statusCode).toBe(200);
    expect((r.json() as AuthState).user?.id).toBe(mom.id);
    expect(r.headers["cache-control"]).toBe("no-store");
    const sc = String(setCookie(r));
    expect(sc).toMatch(/^al_session=[A-Za-z0-9_-]{43}; /);
    for (const attr of ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${30 * 24 * 3600}`, "Secure"])
      expect(sc).toContain(attr);
    expect(users.sessionCount(mom.id)).toBe(1);

    // The conversation list (any private route) opens with that session, through Access.
    const cookie = cookieOf(setCookie(r));
    const h = { ...(await edge(MOM)), cookie };
    expect((await app.inject({ url: "/api/conversations", headers: h })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/test/user", headers: h })).json()).toEqual({ id: mom.id });

    // Audit: `auth.access_login` with the user id only — no email, JWT, cookie or header value anywhere.
    const lines = log.records().filter((l) => l.msg === "auth.access_login");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.userId).toBe(mom.id);
    const text = log.text();
    expect(text).not.toContain(MOM);
    expect(text).not.toContain(cookie.split("=")[1]!);
    expect(text).not.toContain(h["cf-access-jwt-assertion"]);
  });

  it("matches the email case-insensitively", async () => {
    const { app, mom } = await start();
    const r = await accessLogin(app, await edgeWrite("Mom@Example.COM"));
    expect(r.statusCode).toBe(200);
    expect((r.json() as AuthState).user?.id).toBe(mom.id);
  });

  it("never adopts a session id the browser brought (fixation): always a new random token", async () => {
    const { app, users, mom } = await start();
    const planted = "A".repeat(43); // well-formed, but no such session
    const r = await accessLogin(app, { ...(await edgeWrite(MOM)), cookie: `al_session=${planted}` });
    expect(r.statusCode).toBe(200);
    const token = cookieOf(setCookie(r)).split("=")[1]!;
    expect(token).not.toBe(planted);
    expect(users.sessionUser(planted)).toBeUndefined();

    // An ended session's old token is not revived either.
    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { ...(await edgeWrite(MOM)), cookie: `al_session=${token}` },
      payload: {},
    });
    expect(users.sessionUser(token)).toBeUndefined();
    const again = await accessLogin(app, { ...(await edgeWrite(MOM)), cookie: `al_session=${token}` });
    expect(again.statusCode).toBe(200);
    const next = cookieOf(setCookie(again)).split("=")[1]!;
    expect(next).not.toBe(token);
    expect(users.sessionUser(token)).toBeUndefined();
    expect(users.sessionUser(next)?.id).toBe(mom.id);
  });

  it("keeps a valid session of the same account as it is (a second tab), without a new one", async () => {
    const { app, users, mom } = await start();
    const cookie = cookieOf(setCookie(await accessLogin(app, await edgeWrite(MOM))));
    const r = await accessLogin(app, { ...(await edgeWrite(MOM)), cookie });
    expect(r.statusCode).toBe(200);
    expect(setCookie(r)).toBeUndefined();
    expect((r.json() as AuthState).user?.id).toBe(mom.id);
    expect(users.sessionCount(mom.id)).toBe(1);
  });

  it("concurrent cookie-less requests (no cross-tab lock) each get a session; logout ends only its own", async () => {
    // What the server guarantees on its own (the web app's Web Locks keep a browser's tabs to one session): every
    // session is the Access email's own account, and the browser keeps only the last Set-Cookie.
    const { app, users, mom } = await start();
    const [a, b] = await Promise.all([
      accessLogin(app, await edgeWrite(MOM)),
      accessLogin(app, await edgeWrite(MOM)),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(users.sessionCount(mom.id)).toBe(2);
    const ta = cookieOf(setCookie(a)).split("=")[1]!;
    const tb = cookieOf(setCookie(b)).split("=")[1]!;
    expect(ta).not.toBe(tb);
    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { ...(await edgeWrite(MOM)), cookie: `al_session=${tb}` },
      payload: {},
    });
    expect(users.sessionUser(tb)).toBeUndefined();
    expect(users.sessionUser(ta)?.id).toBe(mom.id);
  });

  it("refuses an email without an active account: missing, deactivated, or a pending admin email change", async () => {
    const { app, users, admin, mom, log } = await start();
    const refused = async (email: string) => {
      const r = await accessLogin(app, await edgeWrite(email));
      expect(r.statusCode, email).toBe(403);
      expect(r.json(), email).toEqual({ error: "access_no_account" });
      expect(setCookie(r), email).toBeUndefined();
    };
    await refused("stranger@example.com");

    users.deactivate(mom.id);
    await refused(MOM);
    expect(users.sessionCount(mom.id)).toBe(0);

    // FR-15.7 step 1: the admin's new email is reserved, but no account has it until the switch.
    const adminCookie = cookieOf(
      setCookie(
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: localWrite,
          payload: { email: ADMIN, password: PW },
        }),
      ),
    );
    const req = await app.inject({
      method: "POST",
      url: "/api/admin/access/admin-email",
      headers: { ...localWrite, cookie: adminCookie },
      payload: { email: "dad-new@example.com" },
    });
    expect(req.statusCode).toBe(200);
    await refused("dad-new@example.com");
    // …while the admin's current email still signs in.
    expect((await accessLogin(app, await edgeWrite(ADMIN))).statusCode).toBe(200);
    expect(users.sessionCount(admin.id)).toBe(2);
    expect(log.records().filter((l) => l.msg === "auth.access_login")).toHaveLength(1);
  });

  it("refuses a password login as a way around it", async () => {
    const { app, users, mom } = await start();
    users.deactivate(mom.id);
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: await edgeWrite(MOM),
      payload: { email: MOM, password: PW },
    });
    expect(r.statusCode).toBe(401);
    expect(setCookie(r)).toBeUndefined();
    // Nor with another account's password under this Access login.
    const other = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: await edgeWrite(MOM),
      payload: { email: ADMIN, password: PW },
    });
    expect(other.json()).toEqual({ error: "access_email_mismatch" });
  });

  it("starts no session for an invalid or missing Access JWT", async () => {
    const { app, users, mom } = await start();
    const now = Math.floor(Date.now() / 1000);
    const write = { host: HOST, origin: `https://${HOST}`, [CSRF_HEADER]: "1" };
    const cases: [string, Record<string, string>][] = [
      ["none", write],
      ["garbage", { ...write, "cf-access-jwt-assertion": "x.y.z" }],
      [
        "bad signature",
        { ...write, "cf-access-jwt-assertion": await jwt({ email: MOM }, { key: otherKey }) },
      ],
      [
        "other aud",
        { ...write, "cf-access-jwt-assertion": await jwt({ email: MOM }, { aud: "d".repeat(64) }) },
      ],
      [
        "other issuer",
        {
          ...write,
          "cf-access-jwt-assertion": await jwt({ email: MOM }, { iss: "https://evil.cloudflareaccess.com" }),
        },
      ],
      ["expired", { ...write, "cf-access-jwt-assertion": await jwt({ email: MOM }, { exp: now - 120 }) }],
      [
        "not yet valid",
        { ...write, "cf-access-jwt-assertion": await jwt({ email: MOM }, { nbf: now + 600 }) },
      ],
      // A service token (no person behind it) reaches the health check only.
      ["service token", { ...write, "cf-access-jwt-assertion": await jwt({ common_name: "probe.access" }) }],
    ];
    for (const [name, headers] of cases) {
      const r = await accessLogin(app, headers);
      expect(r.statusCode, name).toBe(403);
      expect(r.json(), name).toEqual({ error: "access_denied" });
      expect(setCookie(r), name).toBeUndefined();
    }
    expect(users.sessionCount(mom.id)).toBe(0);
  });

  it("is not available without Access: local requests keep the password login", async () => {
    const { app, users, mom } = await start();
    const r = await accessLogin(app, localWrite);
    expect(r.statusCode).toBe(403);
    expect(setCookie(r)).toBeUndefined();
    // A loopback Host carrying an Access header is refused outright (a forged tunnel request).
    const forged = await accessLogin(app, {
      ...localWrite,
      "cf-access-jwt-assertion": await jwt({ email: MOM }),
    });
    expect(forged.json()).toEqual({ error: "bad_host" });
    expect(users.sessionCount(mom.id)).toBe(0);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: localWrite,
      payload: { email: MOM, password: PW },
    });
    expect(login.statusCode).toBe(200);
  });

  it("cannot be triggered cross-site: the CSRF check (own Origin + custom header) and POST only", async () => {
    const { app, users, mom } = await start();
    const base = await edge(MOM);
    for (const [name, headers] of [
      ["no origin", { ...base, [CSRF_HEADER]: "1" }],
      ["other origin", { ...base, origin: "https://evil.example", [CSRF_HEADER]: "1" }],
      ["no custom header", { ...base, origin: `https://${HOST}` }],
    ] as const) {
      const r = await accessLogin(app, headers);
      expect(r.statusCode, name).toBe(403);
      expect(r.json(), name).toEqual({ error: "csrf" });
      expect(setCookie(r), name).toBeUndefined();
    }
    // A top-level GET (a link or an <img> on another site) starts nothing.
    const get = await app.inject({ url: "/api/auth/access-login", headers: base });
    expect(get.statusCode).toBe(404);
    expect(setCookie(get)).toBeUndefined();
    expect(users.sessionCount(mom.id)).toBe(0);
  });

  it("keeps the mismatch rule: another account's session is neither replaced nor used", async () => {
    const { app, users, admin, mom } = await start();
    const momCookie = cookieOf(setCookie(await accessLogin(app, await edgeWrite(MOM))));
    // The admin passes Access in a browser still holding Mom's app session.
    const r = await accessLogin(app, { ...(await edgeWrite(ADMIN)), cookie: momCookie });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "access_email_mismatch" });
    expect(setCookie(r)).toBeUndefined();
    expect(users.sessionCount(admin.id)).toBe(0);
    expect(users.sessionUser(momCookie.split("=")[1]!)?.id).toBe(mom.id);
    expect(
      (
        await app.inject({
          url: "/api/conversations",
          headers: { ...(await edge(ADMIN)), cookie: momCookie },
        })
      ).json(),
    ).toEqual({ error: "access_email_mismatch" });
    // Clearing the app login (logout) lets the Access email in.
    const out = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { ...(await edgeWrite(ADMIN)), cookie: momCookie },
      payload: {},
    });
    expect(String(setCookie(out))).toContain("Max-Age=0");
    expect((await accessLogin(app, await edgeWrite(ADMIN))).statusCode).toBe(200);
  });

  it("does not force a temporary-password change through Access; the local login still does", async () => {
    const { app, users } = await start();
    const son = users.create({
      email: "son@example.com",
      name: "아들",
      role: "member",
      passwordHash: await hashPassword("temp-pass-1234"),
      mustChangePassword: true,
    });
    const r = await accessLogin(app, await edgeWrite("son@example.com"));
    expect((r.json() as AuthState).user).toMatchObject({ id: son.id, mustChangePassword: false });
    const cookie = cookieOf(setCookie(r));
    expect(
      (
        await app.inject({
          url: "/api/conversations",
          headers: { ...(await edge("son@example.com")), cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(users.byId(son.id)?.mustChangePassword).toBe(true);

    const localLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: localWrite,
      payload: { email: "son@example.com", password: "temp-pass-1234" },
    });
    expect((localLogin.json() as AuthState).user?.mustChangePassword).toBe(true);
    const localCookie = cookieOf(setCookie(localLogin));
    expect(
      (
        await app.inject({ url: "/api/conversations", headers: { ...localWrite, cookie: localCookie } })
      ).json(),
    ).toEqual({ error: "password_change_required" });
  });
});
