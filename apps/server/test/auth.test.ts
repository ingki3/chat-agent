import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CSRF_HEADER, type AuthState } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { hashPassword } from "../src/auth/passwords.js";
import type { UserAccessChanged } from "../src/events.js";

const TEAM = "family.cloudflareaccess.com";
const AUD = "a".repeat(64);
const HOST = "chat.2prostream.com";
const ADMIN = "ingki3@gmail.com";
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
  email: string | undefined,
  o: { aud?: string; iss?: string; exp?: string | number; key?: CryptoKey; kid?: string } = {},
) {
  return new SignJWT(email ? { email } : {})
    .setProtectedHeader({ alg: "RS256", kid: o.kid ?? "k1" })
    .setIssuer(o.iss ?? `https://${TEAM}`)
    .setAudience(o.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(o.exp ?? "5m")
    .sign(o.key ?? privateKey);
}

async function start(env: Record<string, string> = {}, auth = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    CF_ACCESS_AUD: AUD,
    ...env,
  });
  const db = createTestDb();
  const app = await buildApp(config, { db, accessKeys: jwks, auth, logger: false });
  app.get("/api/test/admin-only", { config: { auth: "admin" } }, async () => ({ ok: true }));
  app.get("/api/test/user", async (req) => ({ id: req.ctx.user!.id }));
  apps.push(app);
  return { app, db };
}

/** Request helpers: `local` = http://localhost:3000, `edge` = through the tunnel with an Access JWT. */
const local = { host: "localhost:3000" };
const localWrite = { ...local, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
const edge = async (email = ADMIN) => ({
  host: HOST,
  "cf-connecting-ip": "198.51.100.7",
  "cf-access-jwt-assertion": await jwt(email),
});
const edgeWrite = async (email = ADMIN) => ({
  ...(await edge(email)),
  origin: `https://${HOST}`,
  [CSRF_HEADER]: "1",
});
const cookieOf = (sc: unknown) => String(Array.isArray(sc) ? sc[0] : sc).split(";")[0]!;

async function setup(app: App, headers: Record<string, string> = localWrite) {
  return app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers,
    payload: { name: "아빠", password: PW },
  });
}
async function login(
  app: App,
  email: string,
  password: string,
  headers: Record<string, string> = localWrite,
) {
  return app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { email, password } });
}

describe("trust boundary (Host)", () => {
  it("accepts local hosts without Cloudflare headers", async () => {
    const { app } = await start();
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST:3000"])
      expect((await app.inject({ url: "/api/health", headers: { host } })).statusCode, host).toBe(200);
  });

  it("refuses unknown hosts, repeated Host headers and local hosts with Cf-* headers", async () => {
    const { app } = await start();
    for (const host of [
      "evil.example",
      "chat.2prostream.com.evil.example",
      "localhost.evil:3000",
      "127.0.0.2:3000",
    ])
      expect((await app.inject({ url: "/api/health", headers: { host } })).statusCode, host).toBe(403);
    for (const h of ["cf-connecting-ip", "CF-Access-Jwt-Assertion", "cf-ray"]) {
      const r = await app.inject({ url: "/api/health", headers: { ...local, [h]: "1.2.3.4" } });
      expect(r.statusCode, h).toBe(403);
      expect(r.json()).toEqual({ error: "bad_host" });
    }
    // Two Host headers on the wire (inject passes raw header arrays through).
    const dup = await app.inject({
      url: "/api/health",
      headers: { host: ["localhost:3000", HOST] as unknown as string },
    });
    expect(dup.statusCode).toBe(400);
  });

  it("requires a valid Access JWT on the public host — pages and static files too", async () => {
    const { app } = await start();
    const cases: [string, Record<string, string>][] = [
      ["none", { host: HOST }],
      ["garbage", { host: HOST, "cf-access-jwt-assertion": "x.y.z" }],
      ["forged", { host: HOST, "cf-access-jwt-assertion": await jwt(ADMIN, { key: otherKey }) }],
      [
        "expired",
        {
          host: HOST,
          "cf-access-jwt-assertion": await jwt(ADMIN, { exp: Math.floor(Date.now() / 1000) - 120 }),
        },
      ],
      ["other aud", { host: HOST, "cf-access-jwt-assertion": await jwt(ADMIN, { aud: "b".repeat(64) }) }],
      [
        "other iss",
        {
          host: HOST,
          "cf-access-jwt-assertion": await jwt(ADMIN, { iss: "https://evil.cloudflareaccess.com" }),
        },
      ],
      ["unknown kid", { host: HOST, "cf-access-jwt-assertion": await jwt(ADMIN, { kid: "k2" }) }],
      ["no email", { host: HOST, "cf-access-jwt-assertion": await jwt(undefined) }],
    ];
    for (const [name, headers] of cases)
      for (const url of ["/api/health", "/", "/c/1"]) {
        const r = await app.inject({ url, headers });
        expect(r.statusCode, `${name} ${url}`).toBe(403);
        expect(r.json(), name).toEqual({ error: "access_denied" });
      }
    expect((await app.inject({ url: "/api/health", headers: await edge() })).statusCode).toBe(200);
    const state = (
      await app.inject({ url: "/api/auth/state", headers: await edge("Mom@Example.com") })
    ).json<AuthState>();
    expect(state.accessEmail).toBe("mom@example.com");
  });

  it("fails closed on the public host when Access is not configured (and no temporary gate)", async () => {
    const { app } = await start({ CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: "" });
    const r = await app.inject({ url: "/", headers: { host: HOST } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "access_not_configured" });
    expect((await app.inject({ url: "/api/health", headers: local })).statusCode).toBe(200);
  });

  it("validates the Access settings", () => {
    expect(() => loadConfig({ CF_ACCESS_TEAM_DOMAIN: TEAM })).toThrow(/both/);
    expect(() => loadConfig({ CF_ACCESS_TEAM_DOMAIN: "evil.com", CF_ACCESS_AUD: AUD })).toThrow(
      /team domain|cloudflareaccess/i,
    );
    expect(() => loadConfig({ CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: "short" })).toThrow(/AUD/);
  });
});

describe("first run", () => {
  it("creates the admin once, then closes for good", async () => {
    const { app } = await start();
    const s0 = (await app.inject({ url: "/api/auth/state", headers: local })).json<AuthState>();
    expect(s0).toMatchObject({ setupRequired: true, user: null, adminEmail: ADMIN });
    const r = await setup(app);
    expect(r.statusCode).toBe(200);
    expect(r.json<AuthState>()).toMatchObject({
      setupRequired: false,
      user: { email: ADMIN, role: "admin" },
    });
    const again = await setup(app);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "already_set_up" });
  });

  it("rejects a short password and, through Access, anyone but the admin", async () => {
    const { app } = await start();
    const short = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: localWrite,
      payload: { name: "x", password: "short" },
    });
    expect(short.statusCode).toBe(400);
    expect((await setup(app, await edgeWrite("son@example.com"))).statusCode).toBe(403);
    expect((await setup(app, await edgeWrite())).statusCode).toBe(200);
  });

  it("lets only one of two concurrent setups win", async () => {
    const { app, db } = await start();
    const rs = await Promise.all([setup(app), setup(app), setup(app)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    expect(db.$client.prepare("select count(*) n from users").get()).toEqual({ n: 1 });
  });
});

describe("login and sessions", () => {
  it("sets a HttpOnly SameSite=Lax cookie — Secure except on plain-http localhost", async () => {
    const { app } = await start();
    const sc = String((await setup(app)).headers["set-cookie"]);
    expect(sc).toMatch(/^al_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const edgeLogin = await login(app, ADMIN, PW, await edgeWrite());
    expect(edgeLogin.statusCode).toBe(200);
    expect(String(edgeLogin.headers["set-cookie"])).toMatch(/; Secure$/);
  });

  it("logs in, reaches private routes, logs out", async () => {
    const { app } = await start();
    await setup(app);
    expect((await app.inject({ url: "/api/test/user", headers: local })).statusCode).toBe(401);
    const bad = await login(app, ADMIN, "wrong password!");
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: "invalid_credentials" });
    const ok = await login(app, " INGKI3@gmail.com ", PW);
    expect(ok.statusCode).toBe(200);
    const cookie = cookieOf(ok.headers["set-cookie"]);
    expect((await app.inject({ url: "/api/test/user", headers: { ...local, cookie } })).statusCode).toBe(200);
    const out = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { ...localWrite, cookie },
    });
    expect(out.json<AuthState>().user).toBeNull();
    expect(String(out.headers["set-cookie"])).toMatch(/^al_session=; .*Max-Age=0/);
    expect((await app.inject({ url: "/api/test/user", headers: { ...local, cookie } })).statusCode).toBe(401);
    // Logout is POST-only: a GET (e.g. an <img> on another site) changes nothing.
    expect((await app.inject({ url: "/api/auth/logout", headers: local })).statusCode).not.toBe(200);
  });

  it("refuses login when the Access email and the account email differ, and existing sessions too", async () => {
    const { app } = await start();
    const users = app.users!;
    await setup(app);
    users.create({
      email: "son@example.com",
      name: "아들",
      role: "member",
      passwordHash: await hashPassword(PW),
    });
    // Son passed Access, tries the admin account.
    const r = await login(app, ADMIN, PW, await edgeWrite("son@example.com"));
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "access_email_mismatch" });
    // An admin session cookie replayed under the son's Access login is refused.
    const cookie = cookieOf((await login(app, ADMIN, PW, await edgeWrite())).headers["set-cookie"]);
    expect(
      (await app.inject({ url: "/api/test/user", headers: { ...(await edge()), cookie } })).statusCode,
    ).toBe(200);
    const mixed = await app.inject({
      url: "/api/test/user",
      headers: { ...(await edge("son@example.com")), cookie },
    });
    expect(mixed.statusCode).toBe(403);
    expect(mixed.json()).toEqual({ error: "access_email_mismatch" });
    // At home (no Access) the same cookie works.
    expect((await app.inject({ url: "/api/test/user", headers: { ...local, cookie } })).statusCode).toBe(200);
  });

  it("enforces roles", async () => {
    const { app } = await start();
    const admin = cookieOf((await setup(app)).headers["set-cookie"]);
    app.users!.create({
      email: "son@example.com",
      name: "아들",
      role: "member",
      passwordHash: await hashPassword(PW),
    });
    const member = cookieOf((await login(app, "son@example.com", PW)).headers["set-cookie"]);
    expect(
      (await app.inject({ url: "/api/test/admin-only", headers: { ...local, cookie: admin } })).statusCode,
    ).toBe(200);
    const r = await app.inject({ url: "/api/test/admin-only", headers: { ...local, cookie: member } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "forbidden" });
  });

  it("forces a temporary-password user to change it first and revokes other sessions on change", async () => {
    const { app } = await start();
    await setup(app);
    app.users!.create({
      email: "mom@example.com",
      name: "엄마",
      role: "member",
      passwordHash: await hashPassword("temporary-pass-1"),
      mustChangePassword: true,
    });
    const first = await login(app, "mom@example.com", "temporary-pass-1");
    expect(first.json<AuthState>().user?.mustChangePassword).toBe(true);
    const cookie = cookieOf(first.headers["set-cookie"]);
    const other = cookieOf((await login(app, "mom@example.com", "temporary-pass-1")).headers["set-cookie"]);
    const blocked = await app.inject({ url: "/api/test/user", headers: { ...local, cookie } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toEqual({ error: "password_change_required" });
    const change = (currentPassword: string, newPassword: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/password",
        headers: { ...localWrite, cookie },
        payload: { currentPassword, newPassword },
      });
    expect((await change("wrong-password", "new-password-123")).statusCode).toBe(401);
    expect((await change("temporary-pass-1", "temporary-pass-1")).statusCode).toBe(400);
    const ok = await change("temporary-pass-1", "new-password-123");
    expect(ok.statusCode).toBe(200);
    expect(ok.json<AuthState>().user?.mustChangePassword).toBe(false);
    expect((await app.inject({ url: "/api/test/user", headers: { ...local, cookie } })).statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/api/test/user", headers: { ...local, cookie: other } })).statusCode,
    ).toBe(401);
    expect((await login(app, "mom@example.com", "temporary-pass-1")).statusCode).toBe(401);
  });

  it("deactivation ends sessions at once and emits an access-change event", async () => {
    const { app } = await start();
    await setup(app);
    const son = app.users!.create({
      email: "son@example.com",
      name: "아들",
      role: "member",
      passwordHash: await hashPassword(PW),
    });
    const cookie = cookieOf((await login(app, "son@example.com", PW)).headers["set-cookie"]);
    const seen: UserAccessChanged[] = [];
    app.appEvents.on("user-access-changed", (e) => seen.push(e));
    app.users!.deactivate(son.id);
    expect((await app.inject({ url: "/api/test/user", headers: { ...local, cookie } })).statusCode).toBe(401);
    expect(seen).toEqual([{ userId: son.id, reason: "deactivated" }]);
    expect((await login(app, "son@example.com", PW)).statusCode).toBe(401);
    app.users!.setRole(son.id, "admin");
    expect(seen.at(-1)).toEqual({ userId: son.id, reason: "role_changed" });
  });

  it("refuses a session of an inactive user even if the session row survived", async () => {
    const { app, db } = await start();
    const cookie = cookieOf((await setup(app)).headers["set-cookie"]);
    db.$client.prepare("update users set active = 0").run();
    expect((await app.inject({ url: "/api/test/user", headers: { ...local, cookie } })).statusCode).toBe(401);
  });

  it("ignores malformed and unknown session cookies", async () => {
    const { app } = await start();
    await setup(app);
    for (const cookie of [
      "al_session=",
      "al_session=abc",
      `al_session=${"A".repeat(43)}`,
      "al_session=../../x",
    ])
      expect(
        (await app.inject({ url: "/api/test/user", headers: { ...local, cookie } })).statusCode,
        cookie,
      ).toBe(401);
  });
});

describe("login rate limits", () => {
  it("limits per account and per client IP (CF-Connecting-IP only through the tunnel)", async () => {
    let t = 0;
    const { app } = await start({}, { perAccount: 3, perIp: 5, windowMs: 60_000, now: () => t });
    await setup(app);
    for (let i = 0; i < 3; i++) expect((await login(app, ADMIN, "wrong password!")).statusCode).toBe(401);
    // Locked even with the right password.
    expect((await login(app, ADMIN, PW)).statusCode).toBe(429);
    t += 60_001;
    expect((await login(app, ADMIN, PW)).statusCode).toBe(200);

    // Per IP through the tunnel: different accounts from one IP.
    const fromIp = async (ip: string, email: string) => {
      const h = { ...(await edgeWrite(email)), "cf-connecting-ip": ip };
      return login(app, email, "wrong password!", h);
    };
    for (let i = 0; i < 5; i++)
      expect((await fromIp("198.51.100.9", `x${i}@example.com`)).statusCode).toBe(401);
    expect((await fromIp("198.51.100.9", "y@example.com")).statusCode).toBe(429);
    expect((await fromIp("198.51.100.10", "y@example.com")).statusCode).toBe(401);
  });
});

describe("races", () => {
  it("refuses a login whose password check was overtaken by a password change or deactivation", async () => {
    const gates: (() => void)[] = [];
    const verify = async (hash: string, pw: string) => {
      const real = await (await import("../src/auth/passwords.js")).verifyPassword(hash, pw);
      await new Promise<void>((r) => gates.push(r));
      return real;
    };
    const { app } = await start({}, { verify });
    const users = app.users!;
    const son = users.create({
      email: "son@example.com",
      name: "아들",
      role: "member",
      passwordHash: await hashPassword(PW),
    });
    const waitGate = async () => {
      while (!gates.length) await new Promise((r) => setTimeout(r, 5));
      return gates.shift()!;
    };

    const pending = login(app, "son@example.com", PW);
    const release = await waitGate();
    users.setPassword(son.id, await hashPassword("a-brand-new-password"));
    release();
    expect((await pending).statusCode).toBe(401);

    users.setPassword(son.id, await hashPassword(PW));
    const pending2 = login(app, "son@example.com", PW);
    const release2 = await waitGate();
    users.deactivate(son.id);
    release2();
    expect((await pending2).statusCode).toBe(401);
  });

  it("counts parallel guesses against the limit before the slow password check", async () => {
    const { app } = await start({}, { perAccount: 1, perIp: 100 });
    await setup(app);
    const rs = await Promise.all(Array.from({ length: 6 }, () => login(app, ADMIN, "wrong password!")));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([401, 429, 429, 429, 429, 429]);
  });

  it("does not count a successful login against the IP budget", async () => {
    const { app } = await start({}, { perIp: 2 });
    await setup(app);
    for (let i = 0; i < 4; i++) expect((await login(app, ADMIN, PW)).statusCode).toBe(200);
  });
});

describe("encoded paths", () => {
  it("applies CSRF and the private-by-default rule to percent-encoded API paths", async () => {
    const { app } = await start();
    const r = await app.inject({
      method: "POST",
      url: "/%61pi/auth/setup",
      headers: local,
      payload: { name: "x", password: PW },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "csrf" });
    for (const url of ["/%61pi/test/user", "/%61%70%69/test/user", "/api/test/%75ser"])
      expect((await app.inject({ url, headers: local })).statusCode, url).toBe(401);
  });

  it("does the same behind the temporary gate (Access not configured)", async () => {
    const { app } = await start({ CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: "", TEMP_GATE_CODE: "12345678" });
    const edgeHost = { host: HOST };
    const g = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { ...edgeHost, "content-type": "application/x-www-form-urlencoded" },
      payload: "code=12345678",
    });
    const cookie = cookieOf(g.headers["set-cookie"]);
    const r = await app.inject({
      method: "POST",
      url: "/%61pi/auth/setup",
      headers: { ...edgeHost, cookie },
      payload: { name: "x", password: PW },
    });
    expect(r.statusCode).toBe(403);
    expect((await app.inject({ url: "/%61pi/test/user", headers: { ...edgeHost, cookie } })).statusCode).toBe(
      401,
    );
  });
});

describe("CSRF", () => {
  it("refuses state-changing API calls without the right Origin or the custom header", async () => {
    const { app } = await start();
    const tries: Record<string, string>[] = [
      { ...local, [CSRF_HEADER]: "1" },
      { ...local, origin: "https://evil.example", [CSRF_HEADER]: "1" },
      { ...local, origin: "http://127.0.0.1:3000", [CSRF_HEADER]: "1" },
      { ...local, origin: "http://localhost:3000" },
      { ...local, origin: "null", [CSRF_HEADER]: "1" },
      { ...(await edge()), origin: "http://chat.2prostream.com", [CSRF_HEADER]: "1" },
      { ...(await edge()), origin: "http://localhost:3000", [CSRF_HEADER]: "1" },
    ];
    for (const headers of tries) {
      const r = await setup(app, headers);
      expect(r.statusCode, JSON.stringify(headers.origin)).toBe(403);
      expect(r.json()).toEqual({ error: "csrf" });
    }
    expect((await setup(app, await edgeWrite())).statusCode).toBe(200);
  });
});
