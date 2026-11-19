import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { CSRF_HEADER, PUBLIC_LINK_MAX_ACTIVE, type CreatePublicLinkResponse } from "@agentlee/shared";
import { buildApp, type BuildOptions } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { publicLinks } from "../src/db/schema.js";
import { isPublicLinkPath } from "../src/paths.js";
import { checkVersion } from "../src/public-links/check.js";
import { tokenHash } from "../src/public-links/store.js";
import { knownSecrets } from "../src/secrets/known.js";
import { fastifyRoutes } from "./helpers/permission-matrix.js";

/**
 * Public artifact links (#204): `/artifact/<token>` opens one artifact version to anyone with the link — outside
 * Cloudflare Access and the app login, and only those three routes. Synthetic accounts, keys and JWTs (a local
 * JWKS); never the real Cloudflare.
 */

const TEAM = "family.cloudflareaccess.com";
const AUD = "d".repeat(64);
const HOST = "chat.2prostream.com";
const DAY = 86_400_000;

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
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
  // A fresh `jti` each time: two tokens signed in the same second are otherwise the same string.
  new SignJWT({ email, jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(`https://${TEAM}`)
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

const renders: string[] = [];
async function start(env: Record<string, string> = {}, opts: Partial<BuildOptions> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-publink-"));
  dirs.push(dataDir);
  let clock = Date.now();
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    CF_ACCESS_AUD: AUD,
    PUBLIC_LINKS_ENABLED: "1",
    ...env,
  });
  const { publicLinks: linkOpts, ...rest } = opts;
  const app = await buildApp(config, {
    ...rest,
    db: createTestDb(),
    accessKeys: jwks,
    logger: false,
    // A secret registered in a test stays in the stored rows until the check has seen it (no background rescrub).
    rescrub: { delayMs: 3_600_000 },
    renderer: {
      render: async (job) => {
        renders.push(job.format);
        return { ok: true, body: Buffer.from(`fake-${job.format}`), type: `application/${job.format}` };
      },
    },
    publicLinks: { ...linkOpts, now: () => clock },
  });
  apps.push(app);
  const users = app.users!;
  const mk = (email: string, name: string, role: "admin" | "member", youth = false) => {
    const u = users.create({ email, name, role, passwordHash: "x" });
    if (youth) users.setYouth(u.id, true);
    return { ...u, cookie: `al_session=${users.createSession(u.id)}` };
  };
  const admin = mk("ingki3@gmail.com", "아빠", "admin");
  const mom = mk("mom@example.com", "엄마", "member");
  const son = mk("son@example.com", "아들", "member", true);
  const artifact = (
    owner: { id: string },
    body: { kind?: "html" | "svg" | "markdown" | "chart"; title?: string; content?: string } = {},
  ) => {
    const c = app.conversations!.create(owner.id);
    const scope = { userId: owner.id, conversationId: c.id, runId: crypto.randomUUID() };
    const { artifact: a } = app.artifacts!.create(scope, {
      kind: body.kind ?? "html",
      title: body.title ?? "공개할 페이지",
      content: body.content ?? '<h1 id="t">첫 버전</h1>',
    });
    return { id: a.id, conversationId: c.id, scope };
  };
  const local = (who?: { cookie: string }, write = false) => ({
    host: "localhost:3000",
    ...(who ? { cookie: who.cookie } : {}),
    ...(write ? { origin: "http://localhost:3000", [CSRF_HEADER]: "1" } : {}),
  });
  const create = (who: { cookie: string }, id: string, body: object = { version: 1 }) =>
    app.inject({
      method: "POST",
      url: `/api/artifacts/${id}/public-links`,
      headers: local(who, true),
      payload: body,
    });
  const link = async (who: { cookie: string }, id: string, body?: object) => {
    const r = await create(who, id, body);
    expect(r.statusCode, r.body).toBe(201);
    return r.json<CreatePublicLinkResponse>();
  };
  /** A visitor through the tunnel: the public host, a client IP — and no Access JWT (Cloudflare's Bypass). */
  const visit = (url: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: "GET",
      url,
      headers: { host: HOST, "cf-connecting-ip": "203.0.113.9", ...headers },
    });
  return {
    app,
    admin,
    mom,
    son,
    artifact,
    local,
    create,
    link,
    visit,
    tick: (ms: number) => (clock += ms),
  };
}

const TOKEN_PATH = /^\/artifact\/[A-Za-z0-9_-]{43}$/;

describe("the Access exemption is exactly the public link routes", () => {
  it("every other route of the app still needs a valid Access JWT on the public host", async () => {
    const { app, mom, artifact, link, visit } = await start();
    await app.ready();
    const { path: p } = await link(mom, artifact(mom).id);
    const token = p.split("/").pop()!;
    const routes = fastifyRoutes(app);
    const PUBLIC = new Set(
      ["/artifact/:token", "/artifact/:token/raw", "/artifact/:token/download"].flatMap((u) => [
        `GET ${u}`,
        `HEAD ${u}`,
      ]),
    );
    // The three are there (GET and Fastify's HEAD mirror) …
    expect(routes.filter((r) => PUBLIC.has(r)).sort()).toEqual([...PUBLIC].sort());
    // … and every other route — whatever its method — is refused without a JWT, before any handler runs.
    const failures: string[] = [];
    for (const route of routes) {
      if (PUBLIC.has(route)) continue;
      const [method, pattern] = route.split(" ") as [string, string];
      const url = pattern.replace(/:[A-Za-z]+/g, token).replace("*", "x");
      const r = await app.inject({
        method: method as "GET",
        url,
        headers: { host: HOST, "cf-connecting-ip": "203.0.113.9" },
        ...(method === "GET" || method === "HEAD" ? {} : { payload: {} }),
      });
      if (
        r.statusCode !== 403 ||
        (method !== "HEAD" && r.json<{ error: string }>().error !== "access_denied")
      )
        failures.push(`${route}: ${r.statusCode}`);
    }
    expect(failures).toEqual([]);
    expect(routes.length).toBeGreaterThan(100);
    // The public ones answer without it.
    for (const suffix of ["", "/raw", "/download"])
      expect((await visit(`${p}${suffix}`)).statusCode).toBe(200);
  });

  it("paths that only look like it stay behind Access: /artifacts, /artifact, other suffixes, bad tokens", async () => {
    const { app, mom, artifact, link, visit } = await start();
    const { path: p } = await link(mom, artifact(mom).id);
    const token = p.split("/").pop()!;
    for (const url of [
      "/artifacts",
      "/artifacts/",
      `/artifacts/${token}`,
      "/artifact",
      "/artifact/",
      `/artifact/${token}/`,
      `/artifact/${token}/raw/`,
      `/artifact/${token}/png`,
      `/artifact/${token}x`,
      `/artifact/${token.slice(1)}`,
      `/artifact/${token}/raw/..`,
      `//artifact/${token}`,
      `/a/${token}`,
      `/api/artifacts`,
      `/api/public-links`,
      "/",
    ])
      expect((await visit(url)).statusCode, url).toBe(403);
    // Not a GET: refused too (the routes are GET only, and nothing else is exempt).
    for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const)
      expect((await app.inject({ method, url: p, headers: { host: HOST } })).statusCode).toBe(403);
    expect(isPublicLinkPath(p)).toBe(true);
    expect(isPublicLinkPath(`${p}?x=1`)).toBe(true);
    expect(isPublicLinkPath("/artifacts")).toBe(false);
  });

  it("with PUBLIC_LINKS_ENABLED off nothing is exempt: the link needs Access like the rest, and opens nothing", async () => {
    const on = await start();
    const { path: p } = await on.link(on.mom, on.artifact(on.mom).id);
    const off = await start({ PUBLIC_LINKS_ENABLED: "0" });
    expect((await off.visit(p)).statusCode).toBe(403);
    // Through Access (a family member): still nothing — the server serves no public link.
    const r = await off.visit(p, { "cf-access-jwt-assertion": await jwt("mom@example.com") });
    expect(r.statusCode).toBe(404);
    expect((await off.create(off.mom, off.artifact(off.mom).id)).json()).toEqual({
      error: "public_links_disabled",
    });
  });

  it("cookies and Access JWTs that come along are not read; nothing signs in, no Set-Cookie", async () => {
    const { app, mom, artifact, link, visit } = await start();
    const { path: p } = await link(mom, artifact(mom).id);
    const sessionUser = vi.spyOn(app.users!, "sessionUser");
    const token = await jwt("mom@example.com");
    for (const suffix of ["", "/raw", "/download", "/download?format=png"]) {
      const r = await visit(`${p}${suffix}`, {
        cookie: `${mom.cookie}; al_gate=1.x`,
        "cf-access-jwt-assertion": token,
      });
      expect(r.statusCode, suffix).toBe(200);
      expect(r.headers["set-cookie"]).toBeUndefined();
      // A forged JWT is not even verified: same answer.
      const forged = await visit(`${p}${suffix}`, {
        "cf-access-jwt-assertion": "not.a.jwt",
        cookie: "al_session=x",
      });
      expect(forged.statusCode).toBe(200);
      expect(forged.headers["set-cookie"]).toBeUndefined();
    }
    expect(sessionUser).not.toHaveBeenCalled();
    // The JWT was never seen as a credential (a verified one is registered as a known secret).
    expect(knownSecrets.list()).not.toContain(token);
    // The app itself: the same cookie and JWT do sign in there.
    const me = await app.inject({
      method: "GET",
      url: "/api/public-links",
      headers: { host: HOST, cookie: mom.cookie, "cf-access-jwt-assertion": token },
    });
    expect(me.statusCode).toBe(200);
    expect(sessionUser).toHaveBeenCalled();
    knownSecrets.remove(token);
  });

  it("the temporary code gate does not stand in front of a public link either", async () => {
    const { mom, artifact, link, visit } = await start({
      CF_ACCESS_TEAM_DOMAIN: "",
      CF_ACCESS_AUD: "",
      TEMP_GATE_CODE: "gate-code-123",
    });
    const { path: p } = await link(mom, artifact(mom).id);
    expect((await visit(p)).statusCode).toBe(200);
    expect((await visit("/artifacts")).statusCode).toBe(302);
  });
});

describe("serving", () => {
  it("headers: no-referrer, noindex, private no-store; the original sandboxed like /a/:id/v/:ver/raw; the page has no script", async () => {
    const { mom, artifact, link, visit } = await start();
    const a = artifact(mom, { content: '<h1 id="t">안녕</h1><script>document.title="x"</script>' });
    const { path: p } = await link(mom, a.id);
    const page = await visit(p);
    const raw = await visit(`${p}/raw`);
    const dl = await visit(`${p}/download`);
    for (const r of [page, raw, dl]) {
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(r.headers["cache-control"]).toBe("private, no-store");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
    }
    const pageCsp = String(page.headers["content-security-policy"]);
    expect(pageCsp).toContain("script-src 'none'");
    expect(pageCsp).toContain("frame-ancestors 'none'");
    expect(page.body).not.toMatch(/<script/i);
    // No app bundle, no app shell.
    expect(page.body).not.toMatch(/assets\/|id="root"/);
    expect(page.body).toContain(`<iframe src="${p}/raw" sandbox="allow-scripts"`);
    expect(page.body).not.toContain("allow-same-origin");
    expect(page.body).toContain("Agent Lee에서 공유됨");
    expect(page.body).toContain("공개할 페이지");
    const rawCsp = ([] as string[]).concat(raw.headers["content-security-policy"] as string | string[]);
    expect(rawCsp[0]).toMatch(/^sandbox allow-scripts; /);
    expect(rawCsp[0]).toContain("connect-src 'none'");
    expect(rawCsp[0]).toContain("'sha256-");
    expect(rawCsp[1]).toMatch(/^script-src 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net\//);
    expect(raw.body).toContain('<h1 id="t">안녕</h1>');
    expect(dl.headers["content-disposition"]).toMatch(/^attachment; /);
    expect(String(dl.headers["content-security-policy"])).toMatch(/^sandbox allow-scripts/);
  });

  it("downloads: the original, HTML, PNG and PDF where the kind has them; unknown formats are 404", async () => {
    const { mom, artifact, link, visit } = await start();
    const md = await link(
      mom,
      artifact(mom, { kind: "markdown", title: "메모", content: "# 제목\n\n본문" }).id,
    );
    const orig = await visit(`${md.path}/download`);
    expect(orig.headers["content-type"]).toMatch(/text\/markdown/);
    expect(orig.body).toBe("# 제목\n\n본문");
    const html = await visit(`${md.path}/download?format=html`);
    expect(html.headers["content-type"]).toMatch(/text\/html/);
    expect(html.body).toContain("<h1>제목</h1>");
    renders.length = 0;
    expect((await visit(`${md.path}/download?format=pdf`)).body).toBe("fake-pdf");
    expect(renders).toEqual(["pdf"]);
    // Markdown has no PNG; nothing else is a format.
    expect((await visit(`${md.path}/download?format=png`)).statusCode).toBe(404);
    expect((await visit(`${md.path}/download?format=docx`)).statusCode).toBe(404);
    const svg = await link(
      mom,
      artifact(mom, { kind: "svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" }).id,
    );
    expect((await visit(`${svg.path}/download?format=png`)).body).toBe("fake-png");
    expect((await visit(`${svg.path}/download?format=pdf`)).statusCode).toBe(404);
    expect((await visit(`${svg.path}/download?format=html`)).statusCode).toBe(404);
    expect((await visit(svg.path)).body).not.toContain("format=html");
  });

  it("the version is fixed: a later edit never shows, and no other version or artifact is reachable", async () => {
    const { app, mom, artifact, link, visit } = await start();
    const a = artifact(mom);
    const { path: p } = await link(mom, a.id);
    app.artifacts!.update(a.scope, a.id, { content: '<h1 id="t">둘째 버전</h1>' });
    const raw = await visit(`${p}/raw`);
    expect(raw.body).toContain("첫 버전");
    expect(raw.body).not.toContain("둘째 버전");
    expect((await visit(`${p}/raw?version=2&v=2`)).body).toContain("첫 버전");
    // A link of v2 is a new link with a new token.
    const v2 = await link(mom, a.id, { version: 2 });
    expect(v2.path).not.toBe(p);
    expect((await visit(`${v2.path}/raw`)).body).toContain("둘째 버전");
    // The app's own artifact routes stay behind Access (the id is not a key).
    expect((await visit(`/a/${a.id}/v/1/raw`)).statusCode).toBe(403);
  });
});

describe("tokens", () => {
  it("shown once, stored only as a hash, never listed; a guessed or altered token opens nothing", async () => {
    const { app, mom, artifact, link, local, visit } = await start();
    const created = await link(mom, artifact(mom).id);
    expect(created.path).toMatch(TOKEN_PATH);
    const token = created.path.split("/").pop()!;
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const row = app.publicLinks!.get(created.link.id)!;
    expect(row.tokenHash).toBe(tokenHash(token));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // Nowhere in the table.
    const dump = JSON.stringify(app.publicLinks!.listAll());
    expect(dump).not.toContain(token);
    const mine = await app.inject({ method: "GET", url: "/api/public-links", headers: local(mom) });
    expect(mine.body).not.toContain(token);
    expect(mine.json<{ items: unknown[] }>().items).toHaveLength(1);
    // Guesses: random tokens, one character changed, the hash itself.
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    for (const t of [crypto.randomBytes(32).toString("base64url"), flipped, row.tokenHash.slice(0, 43)])
      expect((await visit(`/artifact/${t}`)).statusCode).toBe(404);
    // Two links never share a token.
    const again = await link(mom, artifact(mom).id);
    expect(again.path).not.toBe(created.path);
  });
});

describe("a link dies at once", () => {
  it("expired (days 1–365, default 7; no 'never')", async () => {
    const s = await start();
    const def = await s.link(s.mom, s.artifact(s.mom).id);
    expect(def.link.expiresAt - def.link.createdAt).toBe(7 * DAY);
    const one = await s.link(s.mom, s.artifact(s.mom).id, { version: 1, expiresInDays: 1 });
    for (const bad of [0, 366, 1.5, null, "7"])
      expect(
        (await s.create(s.mom, s.artifact(s.mom).id, { version: 1, expiresInDays: bad })).statusCode,
      ).toBe(400);
    expect((await s.visit(one.path)).statusCode).toBe(200);
    s.tick(DAY);
    expect((await s.visit(one.path)).statusCode).toBe(404);
    expect((await s.visit(`${one.path}/raw`)).statusCode).toBe(404);
    expect((await s.visit(def.path)).statusCode).toBe(200);
    const max = await s.link(s.mom, s.artifact(s.mom).id, { version: 1, expiresInDays: 365 });
    expect(max.link.expiresAt - max.link.createdAt).toBe(365 * DAY);
  });

  it("turned off by its owner or the admin", async () => {
    const s = await start();
    const a = await s.link(s.mom, s.artifact(s.mom).id);
    const b = await s.link(s.mom, s.artifact(s.mom).id);
    const del = await s.app.inject({
      method: "DELETE",
      url: `/api/public-links/${a.link.id}`,
      headers: s.local(s.mom, true),
    });
    expect(del.json()).toMatchObject({ status: "disabled" });
    expect((await s.visit(a.path)).statusCode).toBe(404);
    expect((await s.visit(`${a.path}/download`)).statusCode).toBe(404);
    // Someone else's: 403 (the son), the admin through their own screen.
    expect(
      (
        await s.app.inject({
          method: "DELETE",
          url: `/api/public-links/${b.link.id}`,
          headers: s.local(s.son, true),
        })
      ).statusCode,
    ).toBe(403);
    const off = await s.app.inject({
      method: "POST",
      url: `/api/admin/public-links/${b.link.id}/disable`,
      headers: s.local(s.admin, true),
    });
    expect(off.statusCode).toBe(200);
    expect((await s.visit(b.path)).statusCode).toBe(404);
  });

  it("its conversation (and so its artifact) deleted", async () => {
    const s = await start();
    const a = s.artifact(s.mom);
    const { path: p } = await s.link(s.mom, a.id);
    const r = await s.app.inject({
      method: "DELETE",
      url: `/api/conversations/${a.conversationId}`,
      headers: s.local(s.mom, true),
    });
    expect(r.statusCode).toBeLessThan(300);
    expect((await s.visit(p)).statusCode).toBe(404);
    // The row went with the artifact (foreign key).
    expect(s.app.publicLinks!.listAll()).toHaveLength(0);
  });

  it("its owner deactivated — and the links stay off", async () => {
    const s = await start();
    const { path: p, link: l } = await s.link(s.mom, s.artifact(s.mom).id);
    s.app.users!.deactivate(s.mom.id);
    expect((await s.visit(p)).statusCode).toBe(404);
    expect(s.app.publicLinks!.get(l.id)!.disabledAt).not.toBeNull();
  });

  it("an inactive owner opens nothing even before the event (checked on every request)", async () => {
    const s = await start();
    const { path: p } = await s.link(s.mom, s.artifact(s.mom).id);
    // Straight in the table (no event): the live check itself refuses.
    const db = (s.app.publicLinks as unknown as { db: ReturnType<typeof createTestDb> }).db;
    db.$client.prepare("UPDATE users SET active = 0 WHERE id = ?").run(s.mom.id);
    expect((await s.visit(p)).statusCode).toBe(404);
    db.$client.prepare("UPDATE users SET active = 1 WHERE id = ?").run(s.mom.id);
    expect((await s.visit(p)).statusCode).toBe(200);
    // And a link whose row names another owner than the artifact's is dead too.
    db.update(publicLinks).set({ ownerId: s.son.id }).where(eq(publicLinks.ownerId, s.mom.id)).run();
    expect((await s.visit(p)).statusCode).toBe(404);
  });
});

describe("who makes one, and what is checked first", () => {
  it("the owner — a youth account too; not someone it is shared with, not the admin", async () => {
    const s = await start();
    expect((await s.create(s.son, s.artifact(s.son).id)).statusCode).toBe(201);
    const a = s.artifact(s.mom);
    s.app.sharing!.store.create({
      ownerId: s.mom.id,
      itemKind: "artifact",
      itemId: a.id,
      conversationId: a.conversationId,
      target: { audience: "family" },
      mode: "live",
      boundaryMessageId: null,
      snapshot: [],
    });
    // The son can read it (shared) — but not publish it.
    expect(
      (await s.app.inject({ method: "GET", url: `/api/artifacts/${a.id}`, headers: s.local(s.son) }))
        .statusCode,
    ).toBe(200);
    for (const who of [s.son, s.admin]) {
      const r = await s.create(who, a.id);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: "forbidden" });
      const c = await s.app.inject({
        method: "GET",
        url: `/api/artifacts/${a.id}/public-links/check`,
        headers: s.local(who),
      });
      expect(c.statusCode).toBe(403);
    }
    expect((await s.create(s.mom, a.id)).statusCode).toBe(201);
  });

  it("a known secret value in the version blocks it; emails, phone numbers and external hosts are warned about", async () => {
    const s = await start();
    const secret = `sk-publink-${crypto.randomBytes(12).toString("hex")}`;
    const a = s.artifact(s.mom, { content: `<p>키: ${secret}</p>` });
    // Registered after the version was stored (as a key added later): the stored text still has it.
    knownSecrets.add(secret);
    try {
      const check = await s.app.inject({
        method: "GET",
        url: `/api/artifacts/${a.id}/public-links/check?version=1`,
        headers: s.local(s.mom),
      });
      expect(check.json()).toMatchObject({ secret: true });
      expect(check.body).not.toContain(secret);
      const r = await s.create(s.mom, a.id);
      expect(r.statusCode).toBe(422);
      expect(r.json()).toEqual({ error: "public_link_secret" });
      expect(s.app.publicLinks!.listAll()).toHaveLength(0);
    } finally {
      knownSecrets.remove(secret);
    }
    const warn = s.artifact(s.mom, {
      content:
        '<p>mom@example.com, 010-1234-5678</p><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script><img src="https://images.example.org/a.png">',
    });
    const created = await s.link(s.mom, warn.id);
    expect(created.check).toEqual({
      version: 1,
      secret: false,
      emails: 1,
      phones: 1,
      externalHosts: ["cdn.jsdelivr.net", "images.example.org"],
    });
  });

  it("pattern checks", () => {
    const c = (content: string) => checkVersion({ version: 1, title: "t", content });
    expect(c("연락: a.b+c@example.co.kr, x@y.io").emails).toBe(2);
    expect(c("01012345678 / 02-123-4567 / +82 10-1234-5678 / 1234").phones).toBe(3);
    expect(c("2026-11-19 12:30").phones).toBe(0);
    expect(
      c("<link href='//fonts.example.com/x.css'> url(https://a.example/b.woff) ![x](https://m.example/p.png)")
        .externalHosts,
    ).toEqual(["a.example", "fonts.example.com", "m.example"]);
    expect(c("텍스트에 쓴 https://example.com 주소").externalHosts).toEqual([]);
  });

  it(`at most ${PUBLIC_LINK_MAX_ACTIVE} active links per account (turned off or expired ones do not count)`, async () => {
    const s = await start();
    const a = s.artifact(s.mom);
    let first = "";
    for (let i = 0; i < PUBLIC_LINK_MAX_ACTIVE; i++) {
      const l = await s.link(s.mom, a.id);
      first ||= l.link.id;
    }
    const over = await s.create(s.mom, a.id);
    expect(over.statusCode).toBe(409);
    expect(over.json()).toEqual({ error: "public_link_limit" });
    // Someone else's cap is their own.
    expect((await s.create(s.son, s.artifact(s.son).id)).statusCode).toBe(201);
    await s.app.inject({
      method: "DELETE",
      url: `/api/public-links/${first}`,
      headers: s.local(s.mom, true),
    });
    expect((await s.create(s.mom, a.id)).statusCode).toBe(201);
    const settings = await s.app.inject({
      method: "GET",
      url: "/api/public-links/settings",
      headers: s.local(s.mom),
    });
    expect(settings.json()).toEqual({
      enabled: true,
      maxActive: PUBLIC_LINK_MAX_ACTIVE,
      active: PUBLIC_LINK_MAX_ACTIVE,
    });
  });

  it("the admin sees counts, owners and expiry — never a title or content", async () => {
    const s = await start();
    await s.link(s.mom, s.artifact(s.mom, { title: "엄마의 비밀 계획", content: "<p>내용 본문</p>" }).id);
    const r = await s.app.inject({
      method: "GET",
      url: "/api/admin/public-links",
      headers: s.local(s.admin),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json<{ counts: unknown; items: Record<string, unknown>[] }>();
    expect(body.counts).toEqual({ active: 1, expired: 0, disabled: 0 });
    expect(Object.keys(body.items[0]!).sort()).toEqual(
      ["createdAt", "disabledAt", "expiresAt", "id", "ownerName", "status", "viewCount"].sort(),
    );
    expect(r.body).not.toContain("비밀 계획");
    expect(r.body).not.toContain("내용 본문");
    expect(
      (await s.app.inject({ method: "GET", url: "/api/admin/public-links", headers: s.local(s.mom) }))
        .statusCode,
    ).toBe(403);
  });
});

describe("views and rate limits", () => {
  it("views of the page are counted (no IP, no user agent kept); raw and downloads are not", async () => {
    const s = await start();
    const { path: p, link: l } = await s.link(s.mom, s.artifact(s.mom).id);
    await s.visit(p, { "user-agent": "VisitorBrowser/1.0" });
    await s.visit(p);
    await s.visit(`${p}/raw`);
    await s.visit(`${p}/download`);
    const row = s.app.publicLinks!.get(l.id)!;
    expect(row.viewCount).toBe(2);
    expect(row.lastViewedAt).not.toBeNull();
    expect(JSON.stringify(row)).not.toMatch(/203\.0\.113|VisitorBrowser/);
  });

  it("per link and for all links: requests and (far fewer) PNG/PDF renders", async () => {
    const s = await start(
      {},
      { publicLinks: { limits: { perLink: 3, global: 100, renderPerLink: 1, renderGlobal: 2 } } },
    );
    const a = await s.link(s.mom, s.artifact(s.mom).id);
    const b = await s.link(s.mom, s.artifact(s.mom).id);
    for (let i = 0; i < 3; i++) expect((await s.visit(a.path)).statusCode).toBe(200);
    const over = await s.visit(`${a.path}/raw`);
    expect(over.statusCode).toBe(429);
    expect(over.headers["retry-after"]).toBe("60");
    expect(over.headers["cache-control"]).toBe("private, no-store");
    // Another link has its own window.
    expect((await s.visit(`${b.path}/download?format=png`)).statusCode).toBe(200);
    expect((await s.visit(`${b.path}/download?format=png`)).statusCode).toBe(429);
    s.tick(61_000);
    expect((await s.visit(a.path)).statusCode).toBe(200);
    // The renders' global window: one more for a, then none for anyone.
    expect((await s.visit(`${a.path}/download?format=pdf`)).statusCode).toBe(200);
    const c = await s.link(s.mom, s.artifact(s.mom).id);
    expect((await s.visit(`${c.path}/download?format=pdf`)).statusCode).toBe(429);
  });

  it("guessing is bounded by the global window too (unknown tokens count)", async () => {
    const s = await start({}, { publicLinks: { limits: { global: 3 } } });
    const { path: p } = await s.link(s.mom, s.artifact(s.mom).id);
    for (let i = 0; i < 3; i++)
      expect((await s.visit(`/artifact/${crypto.randomBytes(32).toString("base64url")}`)).statusCode).toBe(
        404,
      );
    expect((await s.visit(p)).statusCode).toBe(429);
  });
});
