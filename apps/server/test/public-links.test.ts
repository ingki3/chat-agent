import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { domainToASCII } from "node:url";
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
import { HOSTS_CORPUS } from "./fixtures/public-links/hosts-corpus.js";
import HOSTS_PRIOR from "./fixtures/public-links/hosts-prior.json" with { type: "json" };

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
    // The address to share: built by the server from PUBLIC_HOST over https — made here on localhost all the same.
    expect(created.url).toBe(`https://${HOST}${created.path}`);
    const token = created.path.split("/").pop()!;
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const row = app.publicLinks!.get(created.link.id)!;
    expect(row.tokenHash).toBe(tokenHash(token));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // Nowhere in the table.
    const dump = JSON.stringify([app.publicLinks!.activeAll(), app.publicLinks!.historyAll({ limit: 100 })]);
    expect(dump).not.toContain(token);
    const mine = await app.inject({ method: "GET", url: "/api/public-links", headers: local(mom) });
    expect(mine.body).not.toContain(token);
    expect(mine.json<{ active: unknown[] }>().active).toHaveLength(1);
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
    expect(s.app.publicLinks!.counts()).toEqual({ active: 0, expired: 0, disabled: 0 });
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
      expect(s.app.publicLinks!.counts()).toEqual({ active: 0, expired: 0, disabled: 0 });
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
      externalHostsMore: 0,
    });
  });

  it("pattern checks", () => {
    const c = (content: string) => checkVersion({ version: 1, title: "t", content });
    expect(c("연락: a.b+c@example.co.kr, x@y.io").emails).toBe(2);
    expect(c("01012345678 / 02-123-4567 / +82 10-1234-5678 / 1234").phones).toBe(3);
    expect(c("2026-11-19 12:30").phones).toBe(0);
    expect(
      c(
        "<link href='//fonts.example.com/x.css'><style>@font-face{src:url(https://a.example/b.woff)}</style> ![x](https://m.example/p.png)",
      ).externalHosts,
    ).toEqual(["a.example", "fonts.example.com", "m.example"]);
    // Mentioned is listed (over-inclusive by design, review #209 round 5).
    expect(c("텍스트에 쓴 https://example.com 주소").externalHosts).toEqual(["example.com"]);
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
    const body = r.json<{ counts: unknown; active: Record<string, unknown>[] }>();
    expect(body.counts).toEqual({ active: 1, expired: 0, disabled: 0 });
    expect(Object.keys(body.active[0]!).sort()).toEqual(
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

describe("review #209", () => {
  it("names, emails and phone numbers in the title alone are warned about too", async () => {
    const s = await start();
    const created = await s.link(
      s.mom,
      s.artifact(s.mom, { title: "엄마 mom@example.com 010-1234-5678", content: "<p>내용</p>" }).id,
    );
    expect(created.check).toMatchObject({ emails: 1, phones: 1 });
    expect(checkVersion({ version: 1, title: "x@y.io", content: "a@b.co" }).emails).toBe(2);
  });

  it("the checks stay linear on the largest version (512 KiB), adversarial input too", () => {
    const N = 512 * 1024;
    const inputs = {
      letters: "a".repeat(N),
      ats: "a@".repeat(N / 2),
      dottedDomain: `a@${"b.".repeat(N / 2 - 2)}`,
      localThenAt: `${"a.".repeat(N / 2 - 1)}@`,
      images: "![".repeat(N / 2),
      srcSpaces: `src${" ".repeat(N - 3)}`,
      urls: "url(".repeat(N / 4),
      digits: "0-".repeat(N / 2),
      html: `<div class="x"><a href="https://example.com/p">링크 mom@example.com</a><img src="data:x"></div>\n`.repeat(
        Math.floor(N / 90),
      ),
      code: `const x = { a: 1, email: "a@b.co", phone: "010-1234-5678" }; // ${"y".repeat(40)}\n`.repeat(
        Math.floor(N / 100),
      ),
    };
    for (const [name, content] of Object.entries(inputs)) {
      const t = performance.now();
      checkVersion({ version: 1, title: "t", content });
      const ms = performance.now() - t;
      // A linear pass over 512 KiB takes a few ms; a quadratic one takes minutes. Generous for a loaded CI machine.
      expect(ms, name).toBeLessThan(1500);
    }
    expect(checkVersion({ version: 1, title: "t", content: inputs.ats }).emails).toBe(0);
  });

  it("downloads: the global limit counts a bad format too; the render limit is checked before the document is made", async () => {
    const s = await start({}, { publicLinks: { limits: { global: 3, renderPerLink: 1 } } });
    const { path: p } = await s.link(s.mom, s.artifact(s.mom).id);
    expect((await s.visit(`${p}/download?format=docx`)).statusCode).toBe(404);
    expect((await s.visit(`${p}/download?format=png`)).statusCode).toBe(200);
    const exportSpy = vi.spyOn(await import("../src/artifacts/export.js"), "exportDocument");
    expect((await s.visit(`${p}/download?format=pdf`)).statusCode).toBe(429);
    expect(exportSpy).not.toHaveBeenCalled();
    exportSpy.mockRestore();
    // Three requests counted, the bad format among them: the next one is over the global window.
    expect((await s.visit(p)).statusCode).toBe(429);
  });

  it("every open link is listed however much history there is; the history is paged", async () => {
    const s = await start();
    const a = s.artifact(s.mom);
    const open = await s.link(s.mom, a.id);
    // 120 later links, all turned off: the old open link must still be in the list (and in the admin's).
    for (let i = 0; i < 120; i++) {
      const l = await s.link(s.mom, a.id);
      s.app.publicLinks!.disable(l.link.id);
    }
    type Page = { active: { id: string }[]; history: { id: string }[]; nextCursor: string | null };
    const get = async (url: string, who = s.mom) =>
      (await s.app.inject({ method: "GET", url, headers: s.local(who) })).json<Page>();
    const first = await get("/api/public-links");
    expect(first.active.map((l) => l.id)).toEqual([open.link.id]);
    expect(first.history).toHaveLength(50);
    const seen = new Set(first.history.map((l) => l.id));
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await get(`/api/public-links?cursor=${encodeURIComponent(cursor)}`);
      expect(next.active).toEqual([]);
      for (const l of next.history) seen.add(l.id);
      cursor = next.nextCursor;
    }
    expect(seen.size).toBe(120);
    const admin = await get("/api/admin/public-links", s.admin);
    expect(admin.active.map((l) => l.id)).toEqual([open.link.id]);
    expect(admin.nextCursor).not.toBeNull();
    expect(
      (await s.app.inject({ method: "GET", url: "/api/public-links?cursor=bad", headers: s.local(s.mom) }))
        .statusCode,
    ).toBe(400);
    // Only a cursor the server could have issued: a number and a UUID (review #209: 36 hyphens were let through).
    for (const bad of [`1:${"-".repeat(36)}`, "1:not-a-uuid", `x:${crypto.randomUUID()}`])
      for (const [url, who] of [
        ["/api/public-links", s.mom],
        ["/api/admin/public-links", s.admin],
      ] as const)
        expect(
          (
            await s.app.inject({
              method: "GET",
              url: `${url}?cursor=${encodeURIComponent(bad)}`,
              headers: s.local(who),
            })
          ).statusCode,
          `${url} ${bad}`,
        ).toBe(400);
    expect(
      (
        await s.app.inject({
          method: "GET",
          url: `/api/public-links?cursor=${encodeURIComponent(`1:${crypto.randomUUID()}`)}`,
          headers: s.local(s.mom),
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("review #209 round 2", () => {
  it("IDN emails in their ASCII form (xn-- top-level domain) are counted", () => {
    const c = (content: string) => checkVersion({ version: 1, title: "t", content }).emails;
    expect(c("reader@xn--vv4b11d.xn--3e0b707e")).toBe(1);
    expect(c("a@b.xn--p1ai, c@d.com")).toBe(2);
    expect(c("a@b.c")).toBe(0);
    expect(c("a@b.c0m")).toBe(0);
  });

  it("external hosts after any whitespace around `=` — scripts found exactly as prepareHtml finds them", async () => {
    const { prepareHtml } = await import("../src/artifacts/serve.js");
    const html = `<script src=\n${" ".repeat(20)}"https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<img\n  src\n  =\n  'https://images.example.org/a.png'><link href =  "//fonts.example.com/x.css">`;
    expect(checkVersion({ version: 1, title: "t", content: html }).externalHosts).toEqual([
      "cdn.jsdelivr.net",
      "fonts.example.com",
      "images.example.org",
    ]);
    // prepareHtml sees the same script (it adds the SRI): the two agree.
    expect(prepareHtml(html).body).toContain('integrity="sha384-');
    // Long runs stay linear.
    const t = performance.now();
    checkVersion({ version: 1, title: "t", content: `src${" ".repeat(512 * 1024)}` });
    checkVersion({ version: 1, title: "t", content: `src=${" ".repeat(512 * 1024)}x` });
    checkVersion({ version: 1, title: "t", content: "src ".repeat(128 * 1024) });
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe("review #209 rounds 3–5: external addresses are those the version mentions", () => {
  const hosts = (content: string, title = "t") => checkVersion({ version: 1, title, content }).externalHosts;
  const CDN = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";

  it("the xn-- prefix of an IDN top-level domain in any case (emails and hosts)", () => {
    const c = (content: string) => checkVersion({ version: 1, title: "t", content }).emails;
    expect(c("reader@xn--vv4b11d.XN--3E0B707E")).toBe(1);
    expect(c("reader@Xn--vv4b11d.Xn--3e0b707e")).toBe(1);
    expect(c("READER@EXAMPLE.COM")).toBe(1);
    expect(hosts("<img src='https://XN--VV4B11D.xn--3e0b707e/a.png'>")).toEqual(["xn--vv4b11d.xn--3e0b707e"]);
  });

  it("every input an earlier HTML/CSS scanner missed now reports its host — nothing is parsed, so nothing is missed", () => {
    const cases: [string, string, string][] = [
      ["style= in body", '<p><code>style="</code></p><img src="https://img.example/p.png">', "img.example"],
      [
        "SVG fill url()",
        '<svg><rect fill="url(https://paint.example/colors.svg#blue)"/></svg>',
        "paint.example",
      ],
      [
        "long <style> attribute",
        `<style data-note="${"n".repeat(1000)}">p{background:url(https://long-style.example/p.png)}</style>`,
        "long-style.example",
      ],
      [
        "64 KiB style",
        `<div style="${"color:red;".repeat(7000)}background:url(//big-style.example/b.png)">`,
        "big-style.example",
      ],
      ["srcset bad((", '<img srcset="a.png bad((x), https://img.example/real.png 2x">', "img.example"],
      ["2048 spaces", `<script src="${" ".repeat(2048)}${CDN}"></script>`, "cdn.jsdelivr.net"],
      ["vertical tab prefix", `<script src="\u000b${CDN}"></script>`, "cdn.jsdelivr.net"],
      [
        "=https:// relative",
        '<script src="=https://images.example.org/file.js"></script>',
        "images.example.org",
      ],
      [
        "<code>url(</code>",
        '<p><code>url(</code> <a href="https://docs.example.org/css">문서</a></p>',
        "docs.example.org",
      ],
      ["srcset comma in URL", '<img srcset="/p.png?urls=/a,//thumb.example.org/b 2x">', "thumb.example.org"],
      ["@import", "<style>@import url( 'https://fonts.example.com/x.css' );</style>", "fonts.example.com"],
      ["markdown image", "![그림](https://m.example/p.png)", "m.example"],
      ["chart JSON", '{"title":"출처 https://data.example.org/x","series":[]}', "data.example.org"],
    ];
    for (const [name, content, host] of cases) expect(hosts(content), name).toContain(host);
    // The title counts too.
    expect(hosts("<p>본문</p>", "출처 //title.example.net/a")).toEqual(["title.example.net"]);
  });

  it("what is not a host: comments, relative paths, the page's own base, other schemes", () => {
    expect(hosts("// 주석입니다\n//todo: 고치기\nconst x = 1; // end")).toEqual([]);
    expect(hosts('<img src="/x.png"><a href="#top"></a><img src="data:image/png;base64,AAAA">')).toEqual([]);
    expect(
      hosts('<a href="mailto:a@b.co">메일</a> <a href="https://artifact.invalid/x">자기 자신</a>'),
    ).toEqual([]);
    expect(hosts("https://Example.COM./path and http://a-b.example.")).toEqual([
      "a-b.example",
      "example.com",
    ]);
    // Never cut short (round 8): every host is found; the answer lists 100 and counts the rest.
    expect(hosts(Array.from({ length: 30 }, (_, i) => `https://h${i}.example/`).join(" "))).toHaveLength(30);
    const many = checkVersion({
      version: 1,
      title: "t",
      content: Array.from({ length: 150 }, (_, i) => `https://h${i}.example/`).join(" "),
    });
    expect(many.externalHosts).toHaveLength(100);
    expect(many.externalHostsMore).toBe(50);
  });

  it("hosts as the URL parser reads them: Unicode, userinfo, extra slashes, tab/newline, port (review #209 round 6)", () => {
    // A Unicode host and its punycode form are one host.
    const LIBRARY = domainToASCII("도서관.example.org");
    expect(LIBRARY).toMatch(/^xn--[a-z0-9]+\.example\.org$/);
    expect(hosts("<a href='https://도서관.example.org/a'>")).toEqual([LIBRARY]);
    expect(hosts(`https://도서관.example.org/a //${LIBRARY.toUpperCase()}/b`)).toEqual([LIBRARY]);
    expect(hosts("<img src='https://예시.한국/p.png'>")).toEqual(["xn--vv4b11d.xn--3e0b707e"]);
    // Userinfo up to the last @ is not the host.
    expect(hosts("https://reader@docs.example.org/x")).toEqual(["docs.example.org"]);
    expect(hosts("https://a:b@c@evil-is-not.example@docs.example.org/x")).toEqual(["docs.example.org"]);
    // Extra slashes, a tab or newline inside, a port.
    expect(hosts("https:///docs.example.org/x")).toEqual(["docs.example.org"]);
    // Split by a newline: the joined reading is among the candidates (the cut-off one may be too — over-inclusive).
    expect(hosts('<img src="https://docs.exa\nmple.org/p.png">')).toContain("docs.example.org");
    expect(hosts("https://docs.example.org:8443/x and //plain.example:80")).toEqual([
      "docs.example.org",
      "plain.example",
    ]);
    // Ends where the URL ends: quotes, brackets, query, prose punctuation.
    expect(
      hosts("url(https://a.example) 'https://b.example' (see //c.example), https://d.example?x"),
    ).toEqual(["a.example", "b.example", "c.example", "d.example"]);
    // Not names: an IP address, the page itself.
    expect(hosts("http://127.0.0.1:3000/x //artifact.invalid/y")).toEqual([]);
  });

  it("one linear pass over the largest version (512 KiB), adversarial input too", () => {
    const N = 512 * 1024;
    for (const [name, content] of Object.entries({
      slashes: "/".repeat(N),
      pairs: "//".repeat(N / 2),
      longHost: `//${"a".repeat(N - 2)}`,
      unicodeHost: `//${"도".repeat(N - 2)}`,
      ats: `//${"@".repeat(N - 2)}`,
      slashesThenHost: `//${"/".repeat(N - 20)}a.example`,
      manyAuthorities: "//a.b@c.d:1 ".repeat(N / 12),
      dots: `//${".".repeat(N - 2)}`,
      many: "//a.b ".repeat(N / 6),
      html: `<img src="https://img.example/p.png"><a href="//x.example/y">링크</a>\n`.repeat(
        Math.floor(N / 64),
      ),
    })) {
      const t = performance.now();
      checkVersion({ version: 1, title: "t", content });
      expect(performance.now() - t, name).toBeLessThan(1500);
    }
  });
});

describe("review #209 round 7: the union of readings never reports less than before", () => {
  it("differential: on every review reproduction and ordinary documents, ⊇ every earlier implementation and the target", () => {
    const prior = HOSTS_PRIOR as Record<string, Record<string, string[]>>;
    const failures: string[] = [];
    for (const c of HOSTS_CORPUS) {
      const got = new Set(
        checkVersion({ version: 1, title: c.title ?? "t", content: c.content }).externalHosts,
      );
      const before = prior[c.name];
      if (!before) failures.push(`${c.name}: no prior results (regenerate hosts-prior.json)`);
      for (const [sha, hosts] of Object.entries(before ?? {}))
        // Not host names at all (an earlier URL-based reading kept `docs.example.org&` from `&#47;`): not owed.
        for (const h of hosts.filter((x) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x)))
          if (!got.has(h)) failures.push(`${c.name}: ${h} (reported by ${sha}) missing`);
      for (const h of c.target) if (!got.has(h)) failures.push(`${c.name}: target ${h} missing`);
    }
    expect(failures).toEqual([]);
    // Every earlier implementation is in the record.
    expect(Object.keys(Object.values(prior)[0]!).sort()).toEqual(
      ["c536cf1", "2b025c9", "7e03a2f", "22f926c", "dbc308e", "7db8e29", "43208e1", "89db51e"].sort(),
    );
  });

  it("the round-7 inputs, one by one", () => {
    const hosts = (content: string) => checkVersion({ version: 1, title: "t", content }).externalHosts;
    expect(hosts("<img src=https://cdn.example.org\nalt=logo>")).toContain("cdn.example.org");
    expect(hosts("참고 https://docs.example.org!")).toEqual(["docs.example.org"]);
    expect(hosts('<a href="https://docs.example.org&#47;help">')).toEqual(["docs.example.org"]);
    expect(hosts("https://last,first@docs.example.org/help")).toContain("docs.example.org");
  });
});

describe("review #209 round 8", () => {
  const hosts = (content: string) => checkVersion({ version: 1, title: "t", content }).externalHosts;
  it("no cap while scanning: the last real host after many noisy readings is found", () => {
    const noisy = [0, 1, 2, 3, 4].map((i) => `<img src=https://cdn${i}.example.org\nalt=logo>`).join("\n");
    expect(hosts(`${noisy}\n<img src="https://icons.example.org/a">`)).toContain("icons.example.org");
  });
  it("code points outside the BMP and ideographic / fullwidth dots", () => {
    expect(hosts("https://𠮷田.example.org/a")).toEqual([domainToASCII("𠮷田.example.org")]);
    expect(hosts("https://文書。example.org/a")).toEqual([domainToASCII("文書.example.org")]);
    expect(hosts("https://文書．example．org/a")).toEqual([domainToASCII("文書.example.org")]);
  });
  it("after-@ readings on the newline-joined span too, and an @ in a later CSS value", () => {
    expect(hosts('<a href="https://reader@docs.exa\nmple.org/help">')).toContain("docs.example.org");
    expect(hosts("background-image:url(https://reader@cdn.example.org),url(icon@2x.png)")).toContain(
      "cdn.example.org",
    );
  });
});
