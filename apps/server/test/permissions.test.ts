import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { can, type ResourceRef } from "../src/authz/policy.js";
import { watchAccess } from "../src/authz/resources.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { openSse } from "../src/sse.js";
import {
  ADMIN_MATRIX,
  ADMIN_MATRIX_PREFIXES,
  ADMIN_USER_MATRIX,
  APP_MATRIX,
  OWNER_ONLY,
  READ,
  USAGE,
  createFamily,
  fastifyRoutes,
  runAdminMatrix,
  runAdminUserMatrix,
  runMatrix,
  sendAs,
  type MatrixRow,
} from "./helpers/permission-matrix.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

let lastDb: ReturnType<typeof createTestDb>;
const newApp = async () => {
  lastDb = createTestDb();
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    db: lastDb,
    logger: false,
    // Export routes (#51) answer 200 for whoever passes the check; the browser itself is tested elsewhere.
    renderer: { render: async () => ({ ok: true, body: Buffer.from("x"), type: "image/png" }) },
  });
  apps.push(app);
  return app;
};

/** A test resource kind "note" with real write/delete behaviour, owned by `owner` and shared with `shared`. */
async function withNotes() {
  const app = await newApp();
  const notes = new Map<string, ResourceRef & { title: string }>();
  let seq = 0;
  app.resources.register("note", (id) => notes.get(id));
  const note = { kind: "note" } as const;
  app.get("/api/test/notes/:id", { config: { resource: { ...note, action: "read" } } }, async (req) => ({
    title: notes.get(req.resource!.id)!.title,
  }));
  app.patch("/api/test/notes/:id", { config: { resource: { ...note, action: "write" } } }, async (req) => {
    notes.get(req.resource!.id)!.title = "changed";
    return { ok: true };
  });
  app.delete("/api/test/notes/:id", { config: { resource: { ...note, action: "delete" } } }, async (req) => {
    notes.delete(req.resource!.id);
    return { ok: true };
  });
  app.get("/api/test/notes/:id/usage", { config: { resource: { ...note, action: "usage" } } }, async () => ({
    n: 1,
  }));
  app.get(
    "/download",
    { config: { resource: { ...note, action: "read", from: "query" } } },
    async () => "file",
  );
  app.get(
    "/api/test/admin-stream",
    { config: { auth: "admin", noResource: "admin-only feed" } },
    async (req, reply) => {
      const stream = openSse(reply, { heartbeatMs: 1000 });
      stream.onClose(watchAccess(app, req, () => (stream.send("revoked", {}), stream.close())));
      stream.send("ready", {});
    },
  );
  app.get(
    "/api/test/note-by-query",
    { config: { resource: { ...note, action: "read", from: "query" } } },
    async () => ({}),
  );
  app.post(
    "/api/test/note-by-body",
    { config: { resource: { ...note, action: "read", from: "body" } } },
    async () => ({}),
  );
  app.get(
    "/api/test/notes/:id/stream",
    { config: { resource: { ...note, action: "read" } } },
    async (req, reply) => {
      // ?race=1: the share is revoked after the request was authorised but before the stream subscribes.
      if ((req.query as { race?: string }).race) notes.get(req.resource!.id)!.sharedWith = [];
      const stream = openSse(reply, { heartbeatMs: 1000 });
      const stop = watchAccess(app, req, () => (stream.send("revoked", {}), stream.close()));
      stream.onClose(stop);
      if (!stream.closed) stream.send("ready", {});
    },
  );
  // A stream that is not about one resource (e.g. the user's notification feed): only the user is re-checked.
  app.get("/api/test/feed", { config: { noResource: "test feed" } }, async (req, reply) => {
    const stream = openSse(reply, { heartbeatMs: 1000 });
    stream.onClose(watchAccess(app, req, () => (stream.send("revoked", {}), stream.close())));
    stream.send("ready", {});
  });
  // A non-API page that addresses a resource (like /a/:id for artifacts).
  app.get("/n/:id", { config: { resource: { ...note, action: "read" } } }, async () => "page");
  app.post("/n/:id", { config: { resource: { ...note, action: "write" } } }, async () => "saved");
  const f = await createFamily(app);
  const create = (opts: { shared?: boolean } = {}) => {
    const id = `n${++seq}`;
    notes.set(id, {
      kind: "note",
      id,
      ownerId: f.users.owner.id,
      sharedWith: opts.shared === false ? [] : [f.users.shared.id],
      title: "t",
    });
    return id;
  };
  return { app, f, notes, create };
}

describe("policy", () => {
  const note: ResourceRef = { kind: "note", id: "n", ownerId: "mom", sharedWith: ["son"] };
  const u = (id: string, role: "admin" | "member" = "member", active = true) => ({ id, role, active });
  it("owner: everything; shared: read; admin: usage only; inactive: nothing", () => {
    for (const a of ["read", "write", "delete", "share", "usage"] as const)
      expect(can(u("mom"), a, note)).toBe(true);
    expect(can(u("son"), "read", note)).toBe(true);
    for (const a of ["write", "delete", "share", "usage"] as const)
      expect(can(u("son"), a, note)).toBe(false);
    expect(can(u("dad", "admin"), "usage", note)).toBe(true);
    for (const a of ["read", "write", "delete", "share"] as const)
      expect(can(u("dad", "admin"), a, note)).toBe(false);
    expect(can(u("mom", "member", false), "read", note)).toBe(false);
    expect(can(u("x"), "read", note)).toBe(false);
  });
});

describe("resource routes", () => {
  it("son asking for mom's private note gets 403, the admin too, a missing id 404 (matrix)", async () => {
    const { f, create } = await withNotes();
    const rows: MatrixRow[] = [
      { route: "GET /api/test/notes/:id", expect: READ, fixture: () => create() },
      { route: "PATCH /api/test/notes/:id", expect: OWNER_ONLY, fixture: () => create() },
      // Real delete: without a fresh fixture per caller, everyone after the owner would get 404.
      { route: "DELETE /api/test/notes/:id", expect: OWNER_ONLY, fixture: () => create() },
      { route: "GET /api/test/notes/:id/usage", expect: USAGE, fixture: () => create() },
      // Ids from the query string and the body, and a fixed non-API path.
      { route: "GET /api/test/note-by-query", expect: READ, fixture: () => create() },
      { route: "POST /api/test/note-by-body", expect: READ, fixture: () => create() },
      { route: "GET /download", expect: READ, fixture: () => create() },
      // Not shared: the shared user is a stranger to it.
      {
        route: "GET /api/test/notes/:id",
        expect: { ...READ, shared: 403 },
        fixture: () => create({ shared: false }),
      },
    ];
    expect(await runMatrix(f, rows)).toEqual([]);
  });

  it("checks ids taken from the query string or the body the same way", async () => {
    const { app, f, create } = await withNotes();
    const id = create({ shared: false });
    const get = (cookie: string, q: string) =>
      app.inject({ url: `/api/test/note-by-query?${q}`, headers: { host: "localhost:3000", cookie } });
    expect((await get(f.cookies.owner, `id=${id}`)).statusCode).toBe(200);
    expect((await get(f.cookies.shared, `id=${id}`)).statusCode).toBe(403);
    expect((await get(f.cookies.owner, "id=nope")).statusCode).toBe(404);
    expect((await get(f.cookies.owner, "")).statusCode).toBe(404);
    const post = (cookie: string, id: string) =>
      app.inject({
        method: "POST",
        url: "/api/test/note-by-body",
        headers: { host: "localhost:3000", cookie, origin: "http://localhost:3000", "x-agent-lee": "1" },
        payload: { id },
      });
    expect((await post(f.cookies.owner, id)).statusCode).toBe(200);
    expect((await post(f.cookies.admin, id)).statusCode).toBe(403);
  });

  it("refuses to register a route that could address a resource without a declaration", async () => {
    const app = await newApp();
    const h = async () => ({});
    for (const url of ["/api/things/:id", "/api/things", "/api/things/*", "/a/:id", "/files/*"])
      expect(() => app.get(url, h), url).toThrow(/must declare config.resource or config.noResource/);
    expect(() => app.get("/api/x", { config: { noResource: " " } }, h)).toThrow(/must declare/);
    expect(() =>
      app.get(
        "/api/things/:id",
        { config: { resource: { kind: "x", action: "read", param: "thingId" } } },
        h,
      ),
    ).toThrow(/not in path/);
    expect(() =>
      app.get("/api/things/:id", { config: { auth: "public", resource: { kind: "x", action: "read" } } }, h),
    ).toThrow(/cannot be public/);
    expect(() =>
      app.get("/api/things/:id", { config: { noResource: "x", resource: { kind: "x", action: "read" } } }, h),
    ).toThrow(/not both/);
    // Explicit, reasoned opt-out; wildcard and query/body ids are declarable.
    expect(() =>
      app.get("/api/runtimes/:name/models", { config: { noResource: "static catalogue" } }, h),
    ).not.toThrow();
    expect(() =>
      app.get("/files2/*", { config: { resource: { kind: "x", action: "read", param: "*" } } }, h),
    ).not.toThrow();
    // Routes without an id in the path outside /api (pages, static files) need nothing.
    expect(() => app.get("/about", h)).not.toThrow();
  });

  it("guards non-API resource routes (e.g. /a/:id) with the login check too", async () => {
    const { app, f, create } = await withNotes();
    const id = create();
    expect((await app.inject({ url: `/n/${id}`, headers: { host: "localhost:3000" } })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: `/n/${id}`, headers: { host: "localhost:3000", cookie: f.cookies.stranger } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: `/n/${id}`, headers: { host: "localhost:3000", cookie: f.cookies.shared } }))
        .statusCode,
    ).toBe(200);
  });

  it("applies CSRF to state-changing non-API resource routes", async () => {
    const { app, f, create } = await withNotes();
    const id = create();
    const post = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: `/n/${id}`,
        headers: {
          host: "localhost:3000",
          cookie: f.cookies.owner,
          "content-type": "text/plain",
          ...headers,
        },
        payload: "x",
      });
    expect((await post({ origin: "http://localhost:4000" })).statusCode).toBe(403);
    expect((await post({})).statusCode).toBe(403);
    expect((await post({ origin: "http://localhost:3000", "x-agent-lee": "1" })).statusCode).toBe(200);
  });

  it("every resource route of the real app has a matrix row, and every row holds", async () => {
    const app = await newApp();
    await app.ready();
    const declared = app.resources.routes.map((r) => `${r.method} ${r.url}`).sort();
    expect(declared).toEqual(APP_MATRIX.map((r) => r.route).sort());
    expect(await runMatrix(await createFamily(app), APP_MATRIX)).toEqual([]);
  });
});

describe("admin-only routes", () => {
  it("every admin route of the real app refuses members (the son too) with 403 and anonymous callers with 401", async () => {
    const app = await newApp();
    await app.ready();
    const f = await createFamily(app);
    // What Fastify actually serves under /api/admin — not what our config says is admin. HEAD is swept too: the
    // automatic mirror of each GET and any explicitly registered HEAD route.
    const isAdminPath = (r: string) => /^[A-Z]+ \/api\/admin(\/|$)/.test(r);
    const routes = fastifyRoutes(app).filter(isAdminPath).sort();
    expect(routes.length).toBeGreaterThan(10);
    // Our registry saw the same routes, and every one of them is declared admin-only.
    const registered = app.resources.allRoutes.map((r) => `${r.method} ${r.url}`);
    expect(registered.filter(isAdminPath).sort()).toEqual(routes);
    const declaredAdmin = new Set(app.resources.adminRoutes.map((r) => `${r.method} ${r.url}`));
    expect(routes.filter((r) => !declaredAdmin.has(r))).toEqual([]);
    const failures: string[] = [];
    for (const route of routes)
      for (const [who, want] of [
        ["owner", 403],
        ["shared", 403],
        ["stranger", 403],
        ["anon", 401],
      ] as const) {
        const got = (await sendAs(f, who, route)).statusCode;
        if (got !== want) failures.push(`${route} as ${who}: expected ${want}, got ${got}`);
      }
    expect(failures).toEqual([]);
  });

  it("tells Fastify's automatic HEAD mirror of a GET from an explicitly registered HEAD route", async () => {
    const app = await newApp();
    const handler = async () => ({ ok: true });
    app.get("/api/test/both", { config: { noResource: "test" } }, handler);
    app.head("/api/test/head-only", { config: { noResource: "test" } }, async () => "");
    // An explicit HEAD on a path whose GET Fastify did not mirror (exposeHeadRoute off), same handler even.
    app.get("/api/test/own-head", { exposeHeadRoute: false, config: { noResource: "test" } }, handler);
    app.head("/api/test/own-head", { config: { noResource: "other" } }, handler);
    await app.ready();
    const entry = (method: string, url: string) =>
      app.resources.allRoutes.filter((r) => r.method === method && r.url === url);
    expect(entry("HEAD", "/api/test/both")).toEqual([
      { method: "HEAD", url: "/api/test/both", mirror: true },
    ]);
    expect(entry("HEAD", "/api/test/head-only")).toEqual([
      { method: "HEAD", url: "/api/test/head-only", mirror: false },
    ]);
    expect(entry("HEAD", "/api/test/own-head")).toEqual([
      { method: "HEAD", url: "/api/test/own-head", mirror: false },
    ]);
    // In the real app the only explicit HEAD routes under /api are the JSON 404 catch-alls (`app.all`); static
    // files register their own HEAD too. Every other HEAD it serves is a GET's mirror.
    const real = await newApp();
    await real.ready();
    expect(
      real.resources.allRoutes
        .filter((r) => r.method === "HEAD" && !r.mirror && r.url.startsWith("/api"))
        .map((r) => r.url)
        .sort(),
    ).toEqual(["/api", "/api/*"]);
    expect(real.resources.allRoutes.some((r) => r.method === "HEAD" && r.mirror)).toBe(true);
  });

  it("every usage admin route has a row, and the admin gets its data (#32)", async () => {
    const app = await newApp();
    await app.ready();
    const declared = app.resources.adminRoutes
      .filter((r) => !r.mirror)
      .filter((r) => ADMIN_MATRIX_PREFIXES.some((p) => r.url === p || r.url.startsWith(`${p}/`)))
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(declared).toEqual(ADMIN_MATRIX.map((r) => r.route).sort());
    expect(await runAdminMatrix(await createFamily(app), ADMIN_MATRIX)).toEqual([]);
  });

  it("every admin route of the admin screen has a row and succeeds for the admin (#35)", async () => {
    const app = await newApp();
    await app.ready();
    const routes = app.resources.adminRoutes.filter((r) => !r.mirror).map((r) => `${r.method} ${r.url}`);
    const covered = new Set([...ADMIN_MATRIX, ...ADMIN_USER_MATRIX].map((r) => r.route));
    // No admin route anywhere without its row: the screen's whole API is run as every caller.
    expect(routes.filter((r) => !covered.has(r)).sort()).toEqual([]);
    expect([...covered].filter((r) => !routes.includes(r)).sort()).toEqual([]);
    expect(ADMIN_MATRIX_PREFIXES.length).toBeGreaterThan(1);
    expect(await runAdminUserMatrix(await createFamily(app), ADMIN_USER_MATRIX)).toEqual([]);
  });
});

describe("open streams re-check access", () => {
  async function openStream(app: App, cookie: string, path: string) {
    if (!app.server.listening) await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { cookie, host: "localhost:3000" },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (re: RegExp) => {
      while (!re.test(text)) {
        const { value, done } = await reader.read();
        if (done) return { text, ended: true };
        text += decoder.decode(value);
      }
      return { text, ended: false };
    };
    const rest = async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return { text, ended: true };
        text += decoder.decode(value);
      }
    };
    return { until, rest };
  }

  it("closes a shared user's stream when the share is revoked", async () => {
    const { app, f, notes, create } = await withNotes();
    const id = create();
    const s = await openStream(app, f.cookies.shared, `/api/test/notes/${id}/stream`);
    await s.until(/event: ready/);
    notes.get(id)!.sharedWith = [];
    app.appEvents.emit("resource-access-changed", { kind: "note", id });
    const end = await s.rest();
    expect(end.text).toMatch(/event: revoked/);
    expect(end.ended).toBe(true);
  });

  it("catches a revoke that happens between the request check and the subscription", async () => {
    const { app, f, create } = await withNotes();
    const s = await openStream(app, f.cookies.shared, `/api/test/notes/${create()}/stream?race=1`);
    const end = await s.rest();
    expect(end.text).toMatch(/event: revoked/);
    expect(end.text).not.toMatch(/event: ready/);
    expect(end.ended).toBe(true);
  });

  it("closes the stream when the user is deactivated, but not for unrelated changes", async () => {
    const { app, f, create } = await withNotes();
    const id = create();
    const s = await openStream(app, f.cookies.shared, `/api/test/notes/${id}/stream`);
    await s.until(/event: ready/);
    const users = app.users!;
    users.setRole(f.users.admin.id, "member"); // someone else: no effect
    app.appEvents.emit("resource-access-changed", { kind: "note", id: "other" }); // other note: no effect
    users.setRole(f.users.shared.id, "member"); // re-checked, still allowed
    users.deactivate(f.users.shared.id);
    const end = await s.rest();
    expect(end.text.match(/event: revoked/g)).toHaveLength(1);
    expect(end.ended).toBe(true);
  });

  it("closes the stream when its session ends (password change elsewhere) or the admin is demoted", async () => {
    const { app, f, create } = await withNotes();
    const id = create();
    const s1 = await openStream(app, f.cookies.shared, `/api/test/notes/${id}/stream`);
    await s1.until(/event: ready/);
    // A password change revokes the user's sessions (the one holding the stream included).
    app.users!.setPassword(f.users.shared.id, f.users.shared.passwordHash!);
    expect((await s1.rest()).text).toMatch(/event: revoked/);

    const s2 = await openStream(app, f.cookies.admin, "/api/test/admin-stream");
    await s2.until(/event: ready/);
    app.users!.setRole(f.users.admin.id, "member");
    expect((await s2.rest()).text).toMatch(/event: revoked/);
  });

  it("closes the stream on logout and when the session expires", async () => {
    const { app, f } = await withNotes();
    const s1 = await openStream(app, f.cookies.shared, "/api/test/feed");
    await s1.until(/event: ready/);
    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        host: "localhost:3000",
        cookie: f.cookies.shared,
        origin: "http://localhost:3000",
        "x-agent-lee": "1",
      },
    });
    expect((await s1.rest()).text).toMatch(/event: revoked/);

    // The owner's session runs out 300 ms from now; the open stream must end with it.
    lastDb.$client
      .prepare("update sessions set expires_at = ? where user_id = ?")
      .run(Date.now() + 300, f.users.owner.id);
    const s2 = await openStream(app, f.cookies.owner, "/api/test/feed");
    await s2.until(/event: ready/);
    const t0 = Date.now();
    expect((await s2.rest()).text).toMatch(/event: revoked/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("closes a non-resource stream when its user is deactivated", async () => {
    const { app, f } = await withNotes();
    const s = await openStream(app, f.cookies.shared, "/api/test/feed");
    await s.until(/event: ready/);
    app.users!.deactivate(f.users.shared.id);
    const end = await s.rest();
    expect(end.text).toMatch(/event: revoked/);
    expect(end.ended).toBe(true);
  });
});
