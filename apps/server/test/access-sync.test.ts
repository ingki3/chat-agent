import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AccessOverview,
  AccessPreview,
  AccessSync,
  AdminEmailChange,
  AdminEmailConfirmState,
  AuthState,
  CSRF_HEADER,
} from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb, type Db } from "../src/db/client.js";
import { hashPassword } from "../src/auth/passwords.js";
import { CloudflareAccessClient, policyRevision, retryAfter, ruleEmail } from "../src/access/cloudflare.js";
import { CloudflareMock } from "./helpers/cloudflare-mock.js";

/**
 * Cloudflare Access sync (#36, PRD FR-15.2–15.7, acceptance 13 automated part) against a loopback mock of the
 * Cloudflare API — never the real one. Synthetic token, ids and emails only.
 */
const TEAM = "family.cloudflareaccess.com";
const AUD = "a".repeat(64);
const HOST = "chat.2prostream.com";
const ADMIN = "ingki3@gmail.com";
const NEW_ADMIN = "dad.new@example.com";
const MOM = "mom@example.com";
const SON = "son@example.com";
const PW = "correct horse battery";
const TOKEN = `cfat_SYNTHETICaccessTOKEN${"x".repeat(16)}Z9k3`;

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

let privateKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256" };
  jwks = createLocalJWKSet({ keys: [jwk] });
});
const jwt = (email: string) =>
  new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

const cookieOf = (sc: unknown) => String(Array.isArray(sc) ? sc[0] : sc).split(";")[0]!;

async function mock(emails: string[] = [ADMIN]) {
  const m = await new CloudflareMock(TOKEN, emails).start();
  closers.push(() => m.close());
  return m;
}

/** Every body the app answered, to check the token never leaves the server. */
const bodies: string[] = [];

/** The real app on `db` (a second call on the same db = a restart), with the mock as the Cloudflare API. */
async function boot(db: Db, m: CloudflareMock | undefined, retryMs = 30) {
  const app = await buildApp(
    loadConfig({ NODE_ENV: "test", CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD }),
    {
      db,
      logger: false,
      accessKeys: jwks,
      accessSync: { ...(m ? { apiBase: m.url } : {}), retryDelay: () => retryMs },
    },
  );
  let open = true;
  closers.push(async () => {
    if (open) await app.close();
  });
  const restart = async () => {
    open = false;
    await app.close();
    return boot(db, m, retryMs);
  };
  const inject = async (o: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    cookie?: string;
    body?: object;
    edgeEmail?: string;
  }) => {
    const write = o.method !== "GET";
    const headers: Record<string, string> = o.edgeEmail
      ? {
          host: HOST,
          "cf-connecting-ip": "198.51.100.7",
          "cf-access-jwt-assertion": await jwt(o.edgeEmail),
          ...(write ? { origin: `https://${HOST}`, [CSRF_HEADER]: "1" } : {}),
        }
      : { host: "localhost:3000", ...(write ? { origin: "http://localhost:3000", [CSRF_HEADER]: "1" } : {}) };
    if (o.cookie) headers.cookie = o.cookie;
    const r = await app.inject({
      method: o.method,
      url: o.url,
      headers,
      ...(write ? { payload: o.body ?? {} } : {}),
    });
    bodies.push(r.body);
    return r;
  };
  const login = async (email: string, edgeEmail?: string) => {
    const r = await inject({
      method: "POST",
      url: "/api/auth/login",
      body: { email, password: PW },
      edgeEmail,
    });
    expect(r.statusCode).toBe(200);
    return cookieOf(r.headers["set-cookie"]);
  };
  return { app, db, inject, login, restart };
}

type Booted = Awaited<ReturnType<typeof boot>>;

async function family(o: { emails?: string[]; register?: boolean; retryMs?: number } = {}) {
  const m = await mock(o.emails);
  const db = createTestDb();
  const b = await boot(db, m, o.retryMs);
  const hash = await hashPassword(PW);
  b.app.users!.create({ email: ADMIN, name: "아빠", role: "admin", passwordHash: hash });
  const admin = await b.login(ADMIN);
  if (o.register !== false) {
    const r = await b.inject({
      method: "PUT",
      url: "/api/admin/access/registration",
      cookie: admin,
      body: { token: TOKEN, accountId: m.accountId, appId: m.appId, policyId: m.policyId },
    });
    expect(r.statusCode).toBe(200);
  }
  return { m, b, admin, hash };
}

const as = (b: Booted, cookie: string) => ({
  get: (url: string) => b.inject({ method: "GET", url, cookie }),
  post: (url: string, body?: object) => b.inject({ method: "POST", url, cookie, body: body ?? {} }),
  overview: async () =>
    AccessOverview.parse((await b.inject({ method: "GET", url: "/api/admin/access", cookie })).json()),
  preview: async (change?: object) => {
    const r = await b.inject({
      method: "POST",
      url: "/api/admin/access/preview",
      cookie,
      body: change ? { change } : {},
    });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  },
  apply: async (p: { revision: string | null; final: string[] }) => {
    const r = await b.inject({
      method: "POST",
      url: "/api/admin/access/apply",
      cookie,
      body: { revision: p.revision, final: p.final },
    });
    return { status: r.statusCode, body: r.json() as { sync?: unknown; error?: string } };
  },
});

const sync = (body: { sync?: unknown }) => AccessSync.parse(body.sync);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Cloudflare client", () => {
  it("reads email rules only, hashes the whole policy and bounds Retry-After", () => {
    expect(ruleEmail({ email: { email: " Mom@Example.com " } })).toBe("mom@example.com");
    expect(ruleEmail({ email_domain: { domain: "example.com" } })).toBeUndefined();
    expect(ruleEmail({ email: { email: "x@y" }, group: {} })).toBeUndefined();
    const a = policyRevision({ name: "p", include: [], decision: "allow" });
    expect(policyRevision({ decision: "allow", include: [], name: "p" })).toBe(a);
    expect(policyRevision({ decision: "allow", include: [], name: "p", exclude: [{}] })).not.toBe(a);
    expect(retryAfter("2")).toBe(2000);
    expect(retryAfter(null)).toBe(30_000);
    expect(retryAfter("99999")).toBe(300_000);
  });

  it("sends the token only as a bearer header, and maps refusals to fixed codes", async () => {
    const m = await mock();
    const c = new CloudflareAccessClient(TOKEN, { base: m.url });
    const t = { accountId: m.accountId, appId: m.appId, policyId: m.policyId, scope: "reusable" as const };
    expect((await c.policy(t)).emails).toEqual([ADMIN]);
    expect(m.calls.every((x) => x.authorized && !x.path.includes(TOKEN))).toBe(true);
    await expect(
      new CloudflareAccessClient(`${TOKEN}wrong`, { base: m.url }).policy(t),
    ).rejects.toMatchObject({
      code: "cf_unauthorized",
    });
    m.failures.push({ status: 429, retryAfter: "3" });
    await expect(c.policy(t)).rejects.toMatchObject({ code: "cf_rate_limited", retryAfterMs: 3000 });
    m.failures.push({ status: 502 });
    await expect(c.policy(t)).rejects.toMatchObject({ code: "cf_unavailable" });
    expect(await c.revokeUser(t, MOM)).toBe("unavailable");
  });
});

describe("registration (FR-15.2, 15.6)", () => {
  it("checks the token, the application and the policy, stores the token encrypted and shows its last 4 only", async () => {
    const { m, b, admin } = await family({ register: false });
    const a = as(b, admin);
    expect((await a.overview()).mode).toBe("manual");
    const reg = (body: object) =>
      b.inject({ method: "PUT", url: "/api/admin/access/registration", cookie: admin, body });
    const ids = { accountId: m.accountId, appId: m.appId, policyId: m.policyId };
    expect((await reg(ids)).json()).toEqual({ error: "access_token_required" });
    const wrong = await reg({ ...ids, token: `${TOKEN.slice(0, -4)}abcd` });
    expect([wrong.statusCode, wrong.json()]).toEqual([502, { error: "cf_unauthorized" }]);
    expect((await reg({ ...ids, token: TOKEN, policyId: "pol-other" })).json()).toEqual({
      error: "access_policy_not_in_app",
    });
    m.aud = "b".repeat(64);
    expect((await reg({ ...ids, token: TOKEN })).json()).toEqual({ error: "access_app_mismatch" });
    m.aud = AUD;
    const ok = await reg({ ...ids, token: TOKEN });
    expect(ok.statusCode).toBe(200);
    const o = await a.overview();
    expect(o.mode).toBe("auto");
    expect(o.registration).toMatchObject({
      ...ids,
      scope: "reusable",
      tokenMasked: "••••Z9k3",
      policyName: "가족만",
    });
    // Stored as ciphertext only; never in an answer.
    const rows = b.db.$client.prepare("SELECT value FROM settings").all() as { value: string }[];
    expect(rows.some((r) => r.value.includes(TOKEN))).toBe(false);
    expect(bodies.some((x) => x.includes(TOKEN))).toBe(false);
    // An app-scoped (legacy) policy is written on the application's path.
    m.reusable = false;
    await reg(ids);
    expect((await a.overview()).registration?.scope).toBe("app");
    // Back to manual mode.
    await b.inject({ method: "DELETE", url: "/api/admin/access/registration", cookie: admin });
    expect((await a.overview()).mode).toBe("manual");
  });
});

describe("preview and apply (FR-15.2, 15.3, acceptance 13)", () => {
  it("previews the final list with this change and the drift, then writes exactly that list", async () => {
    const { m, b, admin } = await family({ emails: [ADMIN, "stray@example.com"] });
    const a = as(b, admin);
    const p = AccessPreview.parse((await a.preview({ kind: "create", email: MOM })).body);
    expect(p).toMatchObject({
      mode: "auto",
      accessEmails: [ADMIN, "stray@example.com"],
      final: [ADMIN, MOM].sort(),
      add: [MOM],
      remove: ["stray@example.com"],
      change: { add: [MOM], remove: [] },
      drift: { add: [], remove: ["stray@example.com"] },
      otherRules: 1,
    });
    // Saving the change opens a pending sync ("Access에 아직 반영 안 됨").
    expect((await a.post("/api/admin/users", { name: "엄마", email: MOM })).statusCode).toBe(201);
    const before = await a.overview();
    expect(before.open?.status).toBe("pending");
    expect(before.dirty).toBe(true);
    const r = await a.apply({ revision: p.revision, final: p.final });
    expect(r.status).toBe(200);
    expect(sync(r.body)).toMatchObject({ status: "applied", added: [MOM], removed: ["stray@example.com"] });
    // The live policy is the previewed final list; the other include rule and the other fields are untouched.
    expect(m.emails().sort()).toEqual(p.final);
    expect(m.policy.include[0]).toEqual({ group: { id: "grp-1" } });
    expect(m.policy.session_duration).toBe("24h");
    const after = await a.overview();
    expect([after.open, after.dirty, after.lastApplied?.status]).toEqual([null, false, "applied"]);
    // Comparison (FR-15.3): in line now.
    const cmp = AccessPreview.parse((await a.preview()).body);
    expect([cmp.add, cmp.remove]).toEqual([[], []]);
  });

  it("revision conflict: a dashboard edit after the preview → 409, nothing written; preview again → applied", async () => {
    const { m, b, admin } = await family();
    const a = as(b, admin);
    const p = AccessPreview.parse((await a.preview({ kind: "create", email: MOM })).body);
    await a.post("/api/admin/users", { name: "엄마", email: MOM });
    m.dashboardEdit([ADMIN, "uncle@example.com"]);
    const r = await a.apply({ revision: p.revision, final: p.final });
    expect([r.status, r.body.error]).toEqual([409, "access_revision_changed"]);
    expect(m.count("PUT", /policies/)).toBe(0);
    expect(m.emails()).toEqual([ADMIN, "uncle@example.com"]);
    expect((await a.overview()).open?.status).toBe("pending");
    // Even a dashboard change that leaves the emails alone moves the revision.
    const p2 = AccessPreview.parse((await a.preview()).body);
    expect(p2.drift).toEqual({ add: [MOM], remove: ["uncle@example.com"] });
    m.policy = { ...m.policy, session_duration: "12h" };
    expect((await a.apply({ revision: p2.revision, final: p2.final })).body.error).toBe(
      "access_revision_changed",
    );
    const p3 = AccessPreview.parse((await a.preview()).body);
    expect(sync((await a.apply({ revision: p3.revision, final: p3.final })).body).status).toBe("applied");
    expect(m.emails().sort()).toEqual([ADMIN, MOM].sort());
    expect(m.policy.session_duration).toBe("12h");
  });

  it("refuses a stale preview when the app's list changed after it", async () => {
    const { b, admin } = await family();
    const a = as(b, admin);
    const p = AccessPreview.parse((await a.preview({ kind: "create", email: MOM })).body);
    await a.post("/api/admin/users", { name: "엄마", email: MOM });
    await a.post("/api/admin/users", { name: "아들", email: SON });
    expect((await a.apply({ revision: p.revision, final: p.final })).body.error).toBe("access_preview_stale");
  });

  it("a failed write keeps the app's change and is retried idempotently (a landed write is not repeated)", async () => {
    const { m, b, admin } = await family();
    const a = as(b, admin);
    const p = AccessPreview.parse((await a.preview({ kind: "create", email: MOM })).body);
    await a.post("/api/admin/users", { name: "엄마", email: MOM });
    m.failures.push({ method: "PUT", status: 500 });
    const r = await a.apply({ revision: p.revision, final: p.final });
    expect(sync(r.body)).toMatchObject({ status: "failed", errorCode: "cf_unavailable", attempts: 1 });
    expect(b.app.users!.byEmail(MOM)?.active).toBe(true);
    expect((await a.overview()).open?.status).toBe("failed");
    // This time the write lands but its answer is lost: still "failed".
    m.failures.push({ method: "PUT", status: 502, applyFirst: true });
    expect(sync((await a.post("/api/admin/access/retry")).json())).toMatchObject({ status: "failed" });
    expect(m.count("PUT", /policies/)).toBe(2);
    // The retry reads the live list first: already the final list → applied without a third write.
    const done = sync((await a.post("/api/admin/access/retry")).json());
    expect(done).toMatchObject({ status: "applied", added: [MOM], removed: [] });
    expect(m.count("PUT", /policies/)).toBe(2);
    expect((await a.post("/api/admin/access/retry")).json()).toEqual({ error: "access_nothing_to_retry" });
  });

  it("429: the server retries by itself after Retry-After", async () => {
    const { m, b, admin } = await family();
    const a = as(b, admin);
    const p = AccessPreview.parse((await a.preview({ kind: "create", email: MOM })).body);
    await a.post("/api/admin/users", { name: "엄마", email: MOM });
    m.failures.push({ method: "PUT", status: 429, retryAfter: "1" });
    const s = sync((await a.apply({ revision: p.revision, final: p.final })).body);
    expect(s).toMatchObject({ status: "failed", errorCode: "cf_rate_limited" });
    expect(s.retryAt).not.toBeNull();
    for (let i = 0; i < 50 && (await a.overview()).open; i++) await wait(20);
    expect((await a.overview()).lastApplied?.added).toEqual([MOM]);
    expect(m.emails()).toContain(MOM);
  });

  it("a restart in the middle of a write: interrupted, and the retry checks the live list first", async () => {
    const { m, b, admin } = await family();
    const a = as(b, admin);
    const p = AccessPreview.parse((await a.preview({ kind: "create", email: MOM })).body);
    await a.post("/api/admin/users", { name: "엄마", email: MOM });
    // The process stopped right after Cloudflare took the write, before the row said so.
    m.failures.push({ method: "PUT", status: 500, applyFirst: true });
    await a.apply({ revision: p.revision, final: p.final });
    b.db.$client.prepare("UPDATE access_syncs SET status = 'applying', error_code = NULL").run();
    const b2 = await b.restart();
    const admin2 = await b2.login(ADMIN);
    const a2 = as(b2, admin2);
    expect((await a2.overview()).open).toMatchObject({ status: "failed", errorCode: "interrupted" });
    expect(sync((await a2.post("/api/admin/access/retry")).json()).status).toBe("applied");
    expect(m.count("PUT", /policies/)).toBe(1);
  });

  it("deactivation (FR-15.5): app blocked at once, the email leaves Access, Access sessions revoked where allowed", async () => {
    const { m, b, admin } = await family({ emails: [ADMIN, MOM, SON] });
    const a = as(b, admin);
    for (const [name, email] of [
      ["엄마", MOM],
      ["아들", SON],
    ])
      await a.post("/api/admin/users", { name, email });
    const sonId = b.app.users!.byEmail(SON)!.id;
    const momId = b.app.users!.byEmail(MOM)!.id;
    let p = AccessPreview.parse((await a.preview({ kind: "deactivate", userId: sonId })).body);
    expect(p).toMatchObject({ change: { add: [], remove: [SON] }, remove: [SON] });
    await a.post(`/api/admin/users/${sonId}/deactivate`);
    expect(b.app.users!.sessionCount(sonId)).toBe(0);
    // The minimal token may not revoke sessions: "unavailable" (the screen shows the delay).
    let s = sync((await a.apply({ revision: p.revision, final: p.final })).body);
    expect(s).toMatchObject({
      status: "applied",
      removed: [SON],
      revokes: [{ email: SON, result: "unavailable" }],
    });
    expect(m.emails()).not.toContain(SON);
    // With the Organizations permission the sessions are revoked.
    m.allowRevoke = true;
    p = AccessPreview.parse((await a.preview({ kind: "deactivate", userId: momId })).body);
    await a.post(`/api/admin/users/${momId}/deactivate`);
    s = sync((await a.apply({ revision: p.revision, final: p.final })).body);
    expect(s.revokes).toEqual([{ email: MOM, result: "revoked" }]);
    expect(m.revoked).toEqual([MOM]);
  });
});

describe("the current admin email is protected (FR-15.2)", () => {
  it("refuses a change that drops it, and puts it back when the dashboard lost it", async () => {
    const { m, b, admin } = await family();
    const a = as(b, admin);
    const adminId = b.app.users!.byEmail(ADMIN)!.id;
    const p = await a.preview({ kind: "update", userId: adminId, email: "other@example.com" });
    expect([p.status, p.body.error]).toEqual([409, "admin_email_protected"]);
    expect(
      (
        await b.inject({
          method: "PATCH",
          url: `/api/admin/users/${adminId}`,
          cookie: admin,
          body: { email: "other@example.com" },
        })
      ).json(),
    ).toEqual({
      error: "admin_email_change",
    });
    expect((await a.preview({ kind: "deactivate", userId: adminId })).body.error).toBe(
      "admin_email_protected",
    );
    // Someone removed it in the dashboard: the comparison shows it and the sync adds it back.
    m.dashboardEdit(["someone@example.com"]);
    const cmp = AccessPreview.parse((await a.preview()).body);
    expect(cmp.drift).toEqual({ add: [ADMIN], remove: ["someone@example.com"] });
    await a.apply({ revision: cmp.revision, final: cmp.final });
    expect(m.emails()).toEqual([ADMIN]);
  });
});

describe("admin email change (FR-15.7)", () => {
  const change = (o: { change?: unknown }) => AdminEmailChange.parse(o.change);

  it("each step fails or restarts on the old email; confirmed only from the old session through Access with the new one", async () => {
    const { m, b, admin } = await family({ emails: [ADMIN] });
    let a = as(b, admin);
    const adminId = b.app.users!.byEmail(ADMIN)!.id;
    expect((await a.post("/api/admin/access/admin-email", { email: ADMIN })).json()).toEqual({
      error: "admin_email_same",
    });

    // 1. Pending. A restart keeps it pending; the admin still signs in with the old email.
    expect(change((await a.post("/api/admin/access/admin-email", { email: NEW_ADMIN })).json()).state).toBe(
      "pending",
    );
    expect((await a.post("/api/admin/access/admin-email", { email: "x@example.com" })).json()).toEqual({
      error: "admin_email_change_open",
    });
    // The new email is reserved meanwhile.
    expect((await a.post("/api/admin/users", { name: "x", email: NEW_ADMIN })).json()).toEqual({
      error: "email_taken",
    });
    let b1 = await b.restart();
    let cookie = await b1.login(ADMIN);
    a = as(b1, cookie);
    let o = await a.overview();
    expect(o.adminEmailChange?.state).toBe("pending");
    expect(o.appEmails.map((e) => e.email)).toEqual([NEW_ADMIN, ADMIN].sort());

    // 2. Adding the new email to Access fails → still pending, old email in use; a retry adds it.
    let p = AccessPreview.parse((await a.preview()).body);
    expect(p).toMatchObject({ add: [NEW_ADMIN], remove: [] });
    m.failures.push({ method: "PUT", status: 503 });
    expect(sync((await a.apply({ revision: p.revision, final: p.final })).body).status).toBe("failed");
    expect((await a.overview()).adminEmailChange?.state).toBe("pending");
    b1 = await b1.restart();
    cookie = await b1.login(ADMIN);
    a = as(b1, cookie);
    expect(sync((await a.post("/api/admin/access/retry")).json()).status).toBe("applied");
    expect(m.emails().sort()).toEqual([NEW_ADMIN, ADMIN].sort());
    expect((await a.overview()).adminEmailChange?.state).toBe("added");

    // 3. A restart while waiting for the confirmation keeps "added" and the old email.
    b1 = await b1.restart();
    const oldLocal = await b1.login(ADMIN);
    const oldEdge = await b1.login(ADMIN, ADMIN);
    a = as(b1, oldLocal);
    expect((await a.overview()).adminEmailChange?.state).toBe("added");
    const confirm = (cookie: string | undefined, edgeEmail?: string) =>
      b1.inject({
        method: "POST",
        url: "/api/access/admin-email/confirm",
        ...(cookie ? { cookie } : {}),
        ...(edgeEmail ? { edgeEmail } : {}),
      });
    const ready = async (cookie: string, edgeEmail?: string) =>
      AdminEmailConfirmState.parse(
        (
          await b1.inject({
            method: "GET",
            url: "/api/access/admin-email/confirm",
            cookie,
            ...(edgeEmail ? { edgeEmail } : {}),
          })
        ).json(),
      ).ready;
    // Not from localhost, not with the old Access email, not without the old session.
    expect((await confirm(oldLocal)).json()).toEqual({ error: "admin_email_verify_edge" });
    expect((await confirm(oldEdge, ADMIN)).json()).toEqual({ error: "admin_email_verify_mismatch" });
    expect((await confirm(undefined, NEW_ADMIN)).json()).toEqual({ error: "admin_email_step" });
    expect(await ready(oldEdge, ADMIN)).toBe(false);
    // The old session through Access with the new email: everything else refuses that pairing.
    expect(
      (
        await b1.inject({ method: "GET", url: "/api/admin/access", cookie: oldEdge, edgeEmail: NEW_ADMIN })
      ).json(),
    ).toEqual({
      error: "access_email_mismatch",
    });
    expect(await ready(oldEdge, NEW_ADMIN)).toBe(true);
    // A switch that cannot commit (the new email got taken by an account meanwhile) leaves everything as it was.
    const intruder = b1.app.users!.create({ email: NEW_ADMIN, name: "x", role: "member", passwordHash: "x" });
    expect((await confirm(oldEdge, NEW_ADMIN)).json()).toEqual({ error: "email_taken" });
    expect(b1.app.users!.byId(adminId)?.email).toBe(ADMIN);
    expect((await a.overview()).adminEmailChange?.state).toBe("added");
    b1.db.$client.prepare("DELETE FROM users WHERE id = ?").run(intruder.id);

    // 4. Confirmed: the account and its sessions switch to the new email.
    const ok = await confirm(oldEdge, NEW_ADMIN);
    expect(ok.statusCode).toBe(200);
    expect(AuthState.parse(ok.json()).user?.email).toBe(NEW_ADMIN);
    const fresh = cookieOf(ok.headers["set-cookie"]);
    expect(b1.app.users!.byId(adminId)?.email).toBe(NEW_ADMIN);
    expect((await b1.inject({ method: "GET", url: "/api/admin/access", cookie: oldLocal })).statusCode).toBe(
      401,
    );
    a = as(b1, fresh);
    expect(
      (await b1.inject({ method: "GET", url: "/api/admin/access", cookie: fresh, edgeEmail: NEW_ADMIN }))
        .statusCode,
    ).toBe(200);
    o = await a.overview();
    expect(o.adminEmailChange?.state).toBe("switched");
    expect(o.open?.reasons).toContain("admin_email_switched");

    // 5. Removing the old email fails and the server restarts: the change stays "switched"; the retry finishes it.
    p = AccessPreview.parse((await a.preview()).body);
    expect(p).toMatchObject({ add: [], remove: [ADMIN], final: [NEW_ADMIN] });
    m.failures.push({ method: "PUT", status: 500 });
    expect(sync((await a.apply({ revision: p.revision, final: p.final })).body).status).toBe("failed");
    expect(m.emails()).toContain(ADMIN);
    b1 = await b1.restart();
    a = as(b1, await b1.login(NEW_ADMIN));
    expect((await a.overview()).adminEmailChange?.state).toBe("switched");
    expect(sync((await a.post("/api/admin/access/retry")).json()).status).toBe("applied");
    expect(m.emails()).toEqual([NEW_ADMIN]);
    expect((await a.overview()).adminEmailChange?.state).toBe("done");
  });

  it("the old email is never removed before the switch, and a cancel takes the new one out again", async () => {
    const { m, b, admin } = await family();
    const a = as(b, admin);
    await a.post("/api/admin/access/admin-email", { email: NEW_ADMIN });
    let p = AccessPreview.parse((await a.preview()).body);
    await a.apply({ revision: p.revision, final: p.final });
    expect((await a.overview()).adminEmailChange?.state).toBe("added");
    // Another family change while waiting: the final list keeps both admin emails.
    p = AccessPreview.parse((await a.preview({ kind: "create", email: MOM })).body);
    expect(p.final).toEqual([NEW_ADMIN, ADMIN, MOM].sort());
    await a.post("/api/admin/users", { name: "엄마", email: MOM });
    await a.apply({ revision: p.revision, final: p.final });
    expect(m.emails()).toContain(ADMIN);
    // Cancel: the new email leaves the wanted list; the next sync removes it from Access.
    expect(
      AdminEmailChange.parse((await a.post("/api/admin/access/admin-email/cancel")).json().change).state,
    ).toBe("cancelled");
    p = AccessPreview.parse((await a.preview()).body);
    expect(p.remove).toEqual([NEW_ADMIN]);
    await a.apply({ revision: p.revision, final: p.final });
    expect(m.emails().sort()).toEqual([ADMIN, MOM].sort());
  });
});

describe("manual mode (FR-15.4)", () => {
  it("shows the list to enter by hand and records the admin's confirmation, admin email change included", async () => {
    const { b, admin } = await family({ register: false });
    const a = as(b, admin);
    await a.post("/api/admin/users", { name: "엄마", email: MOM });
    const p = AccessPreview.parse((await a.preview()).body);
    expect(p).toMatchObject({
      mode: "manual",
      revision: null,
      accessEmails: null,
      final: [ADMIN, MOM].sort(),
    });
    expect((await a.apply({ revision: "x", final: p.final })).body.error).toBe("access_not_registered");
    expect((await a.post("/api/admin/access/manual-done", { final: [ADMIN] })).json()).toEqual({
      error: "access_preview_stale",
    });
    const s = sync((await a.post("/api/admin/access/manual-done", { final: p.final })).json());
    expect(s).toMatchObject({ status: "applied", mode: "manual" });
    expect((await a.overview()).dirty).toBe(false);
    // The admin email change in manual mode: "추가했어요" moves it to the confirmation step.
    await a.post("/api/admin/access/admin-email", { email: NEW_ADMIN });
    const p2 = AccessPreview.parse((await a.preview()).body);
    await a.post("/api/admin/access/manual-done", { final: p2.final });
    expect((await a.overview()).adminEmailChange?.state).toBe("added");
  });
});

describe("review round 1 (#167)", () => {
  /** A second active admin with a session. */
  async function secondAdmin(b: Booted, hash: string, email = "admin2@example.com") {
    b.app.users!.create({ email, name: "둘째 관리자", role: "admin", passwordHash: hash });
    return b.login(email);
  }

  it("P1: an account added while the write reads the policy is not removed by the stale list (no PUT, 409)", async () => {
    const STRAY = "stray@example.com";
    const { m, b, admin } = await family({ emails: [ADMIN, STRAY] });
    const a = as(b, admin);
    const p = AccessPreview.parse((await a.preview()).body);
    expect(p.remove).toEqual([STRAY]);
    const gate = m.pause("GET", /policies/);
    const pending = a.apply({ revision: p.revision, final: p.final });
    await gate.started;
    // Meanwhile another tab makes that address an admin account.
    expect((await a.post("/api/admin/users", { name: "엄마", email: STRAY, role: "admin" })).statusCode).toBe(
      201,
    );
    gate.release();
    const r = await pending;
    expect([r.status, r.body.error]).toEqual([409, "access_preview_stale"]);
    expect(m.count("PUT", /policies/)).toBe(0);
    expect(m.emails()).toContain(STRAY);
    const o = await a.overview();
    expect(o.open?.status).toBe("pending");
    expect(o.open?.reasons).toContain("user_created");
  });

  it("P1: a change saved during the PUT stays pending on its own, not marked applied", async () => {
    const { m, b, admin } = await family();
    const a = as(b, admin);
    const p = AccessPreview.parse((await a.preview({ kind: "create", email: MOM })).body);
    await a.post("/api/admin/users", { name: "엄마", email: MOM });
    const gate = m.pause("PUT", /policies/);
    const pending = a.apply({ revision: p.revision, final: p.final });
    await gate.started;
    await a.post("/api/admin/users", { name: "아들", email: SON });
    gate.release();
    expect(sync((await pending).body)).toMatchObject({ status: "applied", added: [MOM] });
    const o = await a.overview();
    expect(o.open).toMatchObject({ status: "pending", reasons: ["user_created"] });
    expect(o.dirty).toBe(true);
    expect(m.emails()).not.toContain(SON);
  });

  it("P1: registration saves nothing when the caller's session ends while Cloudflare is checked", async () => {
    const { m, b, admin } = await family({ register: false });
    const gate = m.pause("GET", /\/apps\/[^/]+$/);
    const pending = b.inject({
      method: "PUT",
      url: "/api/admin/access/registration",
      cookie: admin,
      body: { token: TOKEN, accountId: m.accountId, appId: m.appId, policyId: m.policyId },
    });
    await gate.started;
    await b.inject({ method: "POST", url: "/api/auth/logout", cookie: admin });
    gate.release();
    expect((await pending).statusCode).toBe(403);
    expect(b.app.accessSync!.registration()).toBeNull();
    const keys = b.db.$client.prepare("SELECT key FROM settings WHERE key LIKE 'access.%'").all();
    expect(keys).toEqual([]);
  });

  it("P1: apply writes nothing when the caller stops being admin during the read; the automatic retry needs its confirmer", async () => {
    const { m, b, admin, hash } = await family();
    const a = as(b, admin);
    const admin2 = await secondAdmin(b, hash);
    let p = AccessPreview.parse((await a.preview({ kind: "create", email: MOM })).body);
    await a.post("/api/admin/users", { name: "엄마", email: MOM });
    // Demoted by the other admin while the policy is read.
    const adminId = b.app.users!.byEmail(ADMIN)!.id;
    const gate = m.pause("GET", /policies/);
    const pending = a.apply({ revision: p.revision, final: p.final });
    await gate.started;
    await b.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminId}`,
      cookie: admin2,
      body: { role: "member" },
    });
    gate.release();
    expect((await pending).status).toBe(403);
    expect(m.count("PUT", /policies/)).toBe(0);
    // The other admin confirms; a 429 schedules the automatic retry; they are deactivated before it runs.
    const a2 = as(b, admin2);
    p = AccessPreview.parse((await a2.preview()).body);
    m.failures.push({ method: "PUT", status: 429, retryAfter: "1" });
    expect(sync((await a2.apply({ revision: p.revision, final: p.final })).body).errorCode).toBe(
      "cf_rate_limited",
    );
    await b.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminId}`,
      cookie: admin2,
      body: { role: "admin" },
    });
    const admin1again = await b.login(ADMIN);
    const admin2Id = b.app.users!.byEmail("admin2@example.com")!.id;
    await b.inject({ method: "POST", url: `/api/admin/users/${admin2Id}/deactivate`, cookie: admin1again });
    for (let i = 0; i < 50 && (await as(b, admin1again).overview()).open?.errorCode !== "forbidden"; i++)
      await wait(20);
    expect((await as(b, admin1again).overview()).open?.errorCode).toBe("forbidden");
    expect(m.count("PUT", /policies/)).toBe(1);
    expect(m.emails()).not.toContain(MOM);
  });

  it("P2: a confirm always checks the revision, even when the email list is unchanged", async () => {
    const { m, b, admin } = await family();
    const a = as(b, admin);
    const p = AccessPreview.parse((await a.preview()).body);
    m.policy = { ...m.policy, session_duration: "12h" };
    const r = await a.apply({ revision: p.revision, final: p.final });
    expect([r.status, r.body.error]).toEqual([409, "access_revision_changed"]);
    // A retry accepts "already landed" only for its own sent write: a failed read (nothing sent) does not count.
    const p2 = AccessPreview.parse((await a.preview({ kind: "create", email: MOM })).body);
    await a.post("/api/admin/users", { name: "엄마", email: MOM });
    m.failures.push({ method: "GET", status: 503 });
    expect(sync((await a.apply({ revision: p2.revision, final: p2.final })).body).errorCode).toBe(
      "cf_unavailable",
    );
    m.dashboardEdit([ADMIN, MOM]);
    expect(sync((await a.post("/api/admin/access/retry")).json())).toMatchObject({
      status: "failed",
      errorCode: "access_revision_changed",
    });
  });

  it("P2: deactivating or demoting an admin ends their unswitched email change; the other admin can go on", async () => {
    const { b, admin, hash } = await family({ register: false });
    const admin2 = await secondAdmin(b, hash);
    const a = as(b, admin);
    const a2 = as(b, admin2);
    const adminId = b.app.users!.byEmail(ADMIN)!.id;
    await a.post("/api/admin/access/admin-email", { email: NEW_ADMIN });
    await a.post("/api/admin/access/manual-done", {
      final: AccessPreview.parse((await a.preview()).body).final,
    });
    expect((await a2.overview()).adminEmailChange?.state).toBe("added");
    await a2.post(`/api/admin/users/${adminId}/deactivate`);
    let o = await a2.overview();
    expect(o.adminEmailChange?.state).toBe("cancelled");
    expect(o.appEmails.map((e) => e.email)).not.toContain(NEW_ADMIN);
    expect(
      AdminEmailChange.parse(
        (await a2.post("/api/admin/access/admin-email", { email: "a2.new@example.com" })).json().change,
      ).state,
    ).toBe("pending");
    await a2.post("/api/admin/access/admin-email/cancel");
    // Demotion does the same.
    const admin3 = await secondAdmin(b, hash, "admin3@example.com");
    const admin3Id = b.app.users!.byEmail("admin3@example.com")!.id;
    await as(b, admin3).post("/api/admin/access/admin-email", { email: "a3.new@example.com" });
    await b.inject({
      method: "PATCH",
      url: `/api/admin/users/${admin3Id}`,
      cookie: admin2,
      body: { role: "member" },
    });
    o = await a2.overview();
    expect(o.adminEmailChange?.state).toBe("cancelled");
    // A change left behind by an account that is no longer admin (changed outside the app) can be cancelled or replaced.
    const admin4 = await secondAdmin(b, hash, "admin4@example.com");
    await as(b, admin4).post("/api/admin/access/admin-email", { email: "a4.new@example.com" });
    b.db.$client.prepare("UPDATE users SET active = 0 WHERE email = 'admin4@example.com'").run();
    expect(
      AdminEmailChange.parse((await a2.post("/api/admin/access/admin-email/cancel")).json().change).state,
    ).toBe("cancelled");
    await as(b, await secondAdmin(b, hash, "admin5@example.com")).post("/api/admin/access/admin-email", {
      email: "a5.new@example.com",
    });
    b.db.$client.prepare("UPDATE users SET role = 'member' WHERE email = 'admin5@example.com'").run();
    expect(
      AdminEmailChange.parse(
        (await a2.post("/api/admin/access/admin-email", { email: "a2.new@example.com" })).json().change,
      ).state,
    ).toBe("pending");
  });

  it("P2: an oversized answer is cut off while it streams, not read to its end", async () => {
    let delivered = 0;
    const big = (headers: Record<string, string> = {}) =>
      new CloudflareAccessClient(TOKEN, {
        base: "http://127.0.0.1:9",
        fetch: async () =>
          new Response(
            new ReadableStream({
              pull(c) {
                if (delivered < 8) {
                  c.enqueue(new Uint8Array(300_000).fill(32));
                  delivered++;
                } else c.close();
              },
            }),
            { headers },
          ),
      });
    const t = { accountId: "acc1", appId: "app1", policyId: "pol1", scope: "app" as const };
    await expect(big().policy(t)).rejects.toMatchObject({ code: "cf_bad_response" });
    expect(delivered).toBeLessThanOrEqual(5);
    delivered = 0;
    await expect(big({ "content-length": "2400000" }).policy(t)).rejects.toMatchObject({
      code: "cf_bad_response",
    });
    expect(delivered).toBeLessThanOrEqual(1);
  });

  it("round 2 P1: a confirm refused with 403 never becomes the pending automatic retry's input", async () => {
    const { m, b, admin } = await family({ retryMs: 400 });
    const a = as(b, admin);
    const p = AccessPreview.parse((await a.preview({ kind: "create", email: MOM })).body);
    await a.post("/api/admin/users", { name: "엄마", email: MOM });
    m.failures.push({ method: "PUT", status: 429, retryAfter: "1" });
    expect(sync((await a.apply({ revision: p.revision, final: p.final })).body).errorCode).toBe(
      "cf_rate_limited",
    );
    // Another change, confirmed again — the caller's session ends while the policy is read.
    await a.post("/api/admin/users", { name: "아들", email: SON });
    const p2 = AccessPreview.parse((await a.preview()).body);
    const gate = m.pause("GET", /policies/);
    const pending = a.apply({ revision: p2.revision, final: p2.final });
    await gate.started;
    await b.inject({ method: "POST", url: "/api/auth/logout", cookie: admin });
    gate.release();
    expect((await pending).status).toBe(403);
    const row = () =>
      b.db.$client.prepare("SELECT final_emails, error_code, base_revision FROM access_syncs").get() as {
        final_emails: string;
        error_code: string;
        base_revision: string;
      };
    expect(JSON.parse(row().final_emails)).toEqual([ADMIN, MOM].sort());
    expect(row().base_revision).toBe(p.revision);
    // The automatic retry runs on what was there before (the old list — now stale), so it writes nothing new.
    for (let i = 0; i < 60 && row().error_code === "cf_rate_limited"; i++) await wait(25);
    expect(row().error_code).toBe("access_preview_stale");
    expect(m.count("PUT", /policies/)).toBe(1);
    expect(m.emails()).not.toContain(SON);
  });

  it("round 2 P2: a manual retry by another admin becomes the automatic retry's authority", async () => {
    const { m, b, admin, hash } = await family();
    const a = as(b, admin);
    const admin2 = await secondAdmin(b, hash);
    const p = AccessPreview.parse((await a.preview({ kind: "create", email: MOM })).body);
    await a.post("/api/admin/users", { name: "엄마", email: MOM });
    m.failures.push({ method: "PUT", status: 500 });
    expect(sync((await a.apply({ revision: p.revision, final: p.final })).body).status).toBe("failed");
    const adminId = b.app.users!.byEmail(ADMIN)!.id;
    await b.inject({
      method: "PATCH",
      url: `/api/admin/users/${adminId}`,
      cookie: admin2,
      body: { role: "member" },
    });
    const a2 = as(b, admin2);
    m.failures.push({ method: "PUT", status: 429, retryAfter: "1" });
    expect(sync((await a2.post("/api/admin/access/retry")).json()).errorCode).toBe("cf_rate_limited");
    for (let i = 0; i < 60 && (await a2.overview()).open; i++) await wait(20);
    expect((await a2.overview()).lastApplied?.added).toContain(MOM);
    expect(m.emails()).toContain(MOM);
  });
});
