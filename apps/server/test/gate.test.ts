import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { GATE_COOKIE } from "../src/gate.js";

const CODE = "12345678";
const apps: { close: () => Promise<unknown> }[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function webDist(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-gate-"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    "<!doctype html><title>Agent Lee</title><div id=root></div>",
  );
  fs.writeFileSync(path.join(dir, "app.js"), "console.log(1)");
  return dir;
}

async function start(env: Record<string, string> = { TEMP_GATE_CODE: CODE }, gate = {}) {
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  const config = loadConfig({ NODE_ENV: "production", ...env });
  const app = await buildApp(config, { webDist: webDist(), logger: false, gate: { now: () => t, ...gate } });
  apps.push(app);
  return { app: throughTunnel(app), clock };
}

/** The gate covers tunnel requests only: make every injected request arrive with the public Host. */
const EDGE = { host: "chat.2prostream.com" };
function throughTunnel<T extends Awaited<ReturnType<typeof buildApp>>>(app: T): T {
  const inject = app.inject.bind(app) as (o: object) => ReturnType<T["inject"]>;
  app.inject = ((o: string | { headers?: object }) =>
    inject(
      typeof o === "string" ? { url: o, headers: EDGE } : { ...o, headers: { ...EDGE, ...o.headers } },
    )) as never;
  return app;
}

const post = (
  app: Awaited<ReturnType<typeof start>>["app"],
  code: string,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: "POST",
    url: "/gate",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: new URLSearchParams({ code }).toString(),
  });
const cookieOf = (setCookie: string | string[] | undefined) => String(setCookie).split(";")[0]!;

describe("temporary access-code gate", () => {
  it("is off without TEMP_GATE_CODE", async () => {
    const { app } = await start({});
    // Without the gate (and without Access) the public host fails closed; locally /gate is just a SPA route.
    expect((await app.inject("/")).json()).toEqual({ error: "access_not_configured" });
    const page = await app.inject({ url: "/gate", headers: { host: "localhost:3000" } });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toMatch(/접속 코드/);
  });

  it("does not gate local requests (they already passed the Host check)", async () => {
    const { app } = await start();
    const r = await app.inject({ url: "/api/health", headers: { host: "localhost:3000" } });
    expect(r.statusCode).toBe(200);
  });

  it("sends you back to the page you asked for, and only to a page of this site", async () => {
    const { app } = await start();
    const r = await app.inject("/c/123?x=1");
    expect(r.headers.location).toBe(`/gate?next=${encodeURIComponent("/c/123?x=1")}`);
    const page = await app.inject(r.headers.location as string);
    expect(page.body).toContain('name="next" value="/c/123?x=1"');
    const ok = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ code: CODE, next: "/c/123?x=1" }).toString(),
    });
    expect(ok.headers.location).toBe("/c/123?x=1");
    for (const evil of [
      "//evil.example/x",
      "/\\evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "/a b",
    ]) {
      const r2 = await app.inject({
        method: "POST",
        url: "/gate",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ code: CODE, next: evil }).toString(),
      });
      expect(r2.headers.location, evil).toBe("/");
    }
    // A wrong code keeps the destination for the next try, HTML-escaped.
    const bad = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ code: "00000000", next: '/x"><script>' }).toString(),
    });
    expect(bad.body).not.toContain("<script>");
  });

  it("rejects malformed codes in config", () => {
    expect(() => loadConfig({ TEMP_GATE_CODE: "123" })).toThrow(/TEMP_GATE_CODE/);
    expect(() => loadConfig({ TEMP_GATE_CODE: "1234 5678" })).toThrow(/TEMP_GATE_CODE/);
  });

  it("blocks pages, static files and the API until the code is entered", async () => {
    const { app } = await start();
    for (const url of ["/", "/c/1", "/app.js", "/index.html", "/gate/../"]) {
      const r = await app.inject(url);
      expect(r.statusCode, url).toBe(302);
      expect(r.headers.location).toMatch(/^\/gate(\?next=|$)/);
    }
    for (const url of ["/api/health", "/api/nope", "/api"]) {
      const r = await app.inject(url);
      expect(r.statusCode, url).toBe(401);
      expect(r.json()).toEqual({ error: "gate_required" });
    }
    expect((await app.inject({ method: "POST", url: "/api/x" })).statusCode).toBe(401);
    // An encoded /gate is the gate page itself (same path for the router), not a way around it.
    expect((await app.inject("/%67ate")).body).toMatch(/접속 코드/);
    const page = await app.inject("/gate");
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["content-security-policy"]).toMatch(/form-action 'self'/);
    expect(page.body).toMatch(/<form method="post" action="\/gate">/);
    expect(page.body).not.toContain(CODE);
  });

  it("issues an HttpOnly cookie for the right code and then lets requests through", async () => {
    const { app } = await start();
    const bad = await post(app, "87654321");
    expect(bad.statusCode).toBe(401);
    expect(bad.headers["set-cookie"]).toBeUndefined();
    expect(bad.body).not.toContain(CODE);

    const ok = await post(app, ` ${CODE} `);
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe("/");
    const sc = String(ok.headers["set-cookie"]);
    expect(sc).toMatch(
      new RegExp(
        `^${GATE_COOKIE}=\\d+\\.[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$`,
      ),
    );
    expect(sc).not.toContain(CODE);

    const cookie = cookieOf(ok.headers["set-cookie"]);
    expect((await app.inject({ url: "/api/health", headers: { cookie } })).json()).toMatchObject({
      status: "ok",
    });
    expect((await app.inject({ url: "/c/1", headers: { cookie: `x=1; ${cookie}` } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/app.js", headers: { cookie } })).statusCode).toBe(200);
    // Already signed in: the gate page sends you home.
    expect((await app.inject({ url: "/gate", headers: { cookie } })).statusCode).toBe(303);
  });

  it("rejects forged, tampered and expired cookies", async () => {
    const { app, clock } = await start();
    const cookie = cookieOf((await post(app, CODE)).headers["set-cookie"]);
    const [name, value] = cookie.split("=") as [string, string];
    const [exp, sig] = value.split(".") as [string, string];
    for (const c of [
      `${name}=${Number(exp) + 1}.${sig}`,
      `${name}=${exp}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`,
      `${name}=${exp}.${"A".repeat(43)}`,
      `${name}=${exp}`,
      `other=${value}`,
    ])
      expect((await app.inject({ url: "/api/health", headers: { cookie: c } })).statusCode, c).toBe(401);
    // A second server (another signing key) does not accept the first one's cookie.
    const { app: other } = await start();
    expect((await other.inject({ url: "/api/health", headers: { cookie } })).statusCode).toBe(401);
    clock.advance(7 * 24 * 3600_000);
    expect((await app.inject({ url: "/api/health", headers: { cookie } })).statusCode).toBe(401);
  });

  it("rate-limits wrong codes per client and globally, even for the right code", async () => {
    const { app, clock } = await start(undefined, {
      perClientFailures: 3,
      globalFailures: 5,
      windowMs: 60_000,
    });
    const a = { "cf-connecting-ip": "203.0.113.1" };
    for (let i = 0; i < 3; i++) expect((await post(app, "00000000", a)).statusCode).toBe(401);
    const locked = await post(app, CODE, a);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["set-cookie"]).toBeUndefined();
    // Another client is still allowed until the global budget runs out.
    const b = { "cf-connecting-ip": "203.0.113.2" };
    for (let i = 0; i < 2; i++) expect((await post(app, "00000000", b)).statusCode).toBe(401);
    expect((await post(app, CODE, { "cf-connecting-ip": "203.0.113.3" })).statusCode).toBe(429);
    clock.advance(60_001);
    expect((await post(app, CODE, a)).statusCode).toBe(303);
  });

  it("ignores bodies that are not a form and caps the body size", async () => {
    const { app } = await start();
    const json = await app.inject({ method: "POST", url: "/gate", payload: { code: CODE } });
    expect(json.statusCode).toBe(401);
    const big = await app.inject({
      method: "POST",
      url: "/gate",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "code=" + "1".repeat(5000),
    });
    expect(big.statusCode).toBe(413);
  });

  it("works in dev mode (Vite) and refuses Vite's WebSocket upgrade, which bypasses Fastify hooks", async () => {
    const config = { ...loadConfig({ NODE_ENV: "test", TEMP_GATE_CODE: CODE }), port: 0 };
    const app = throughTunnel(await buildApp(config, { vite: true, logger: false }));
    apps.push(app);
    expect((await app.inject("/")).statusCode).toBe(302);
    for (const url of ["/gate", "/gate?x=1"]) {
      const page = await app.inject(url);
      expect(page.statusCode, url).toBe(200);
      expect(page.body, url).toMatch(/접속 코드/);
    }
    const ok = await post(app, CODE);
    expect(ok.statusCode).toBe(303);
    const cookie = cookieOf(ok.headers["set-cookie"]);
    expect((await app.inject({ url: "/", headers: { cookie } })).body).toContain("/@vite/client");

    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const status = await new Promise<number | string>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Protocol": "vite-hmr",
        },
      });
      req.on("upgrade", (res, socket) => (socket.destroy(), resolve(res.statusCode ?? 0)));
      req.on("response", (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      req.on("error", () => resolve("closed"));
      req.setTimeout(2000, () => (req.destroy(), resolve("closed")));
      req.end();
    });
    expect(status).not.toBe(101);
  });

  it("never lets Vite take WebSocket upgrades on the app port, gate or no gate", async () => {
    const free = await new Promise<number>((r) => {
      const srv = http.createServer().listen(0, "127.0.0.1", () => {
        const p = (srv.address() as AddressInfo).port;
        srv.close(() => r(p));
      });
    });
    const config = { ...loadConfig({ NODE_ENV: "test" }), port: 0 };
    const app = await buildApp(config, { vite: true, logger: false, hmrPort: free });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    expect(app.server.listenerCount("upgrade")).toBe(0);
  });
});
