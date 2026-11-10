import { afterEach, describe, expect, it } from "vitest";
import {
  AdminUser,
  CreateUserResponse,
  CSRF_HEADER,
  DEFAULT_PERMISSIONS,
  type AuthState,
} from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb, runMigrations, openDb } from "../src/db/client.js";
import { temporaryPassword } from "../src/auth/users.js";
import type { UserAccessChanged } from "../src/events.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const local = { host: "localhost:3000" };
const write = { ...local, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
const ADMIN_PW = "admin-password-1";
const cookieOf = (sc: unknown) => String(Array.isArray(sc) ? sc[0] : sc).split(";")[0]!;

async function start() {
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), { db: createTestDb(), logger: false });
  apps.push(app);
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    headers: write,
    payload: { name: "아빠", password: ADMIN_PW },
  });
  const admin = cookieOf(r.headers["set-cookie"]);
  const as = (cookie: string) => ({
    get: (url: string) => app.inject({ url, headers: { ...local, cookie } }),
    post: (url: string, payload: object = {}) =>
      app.inject({ method: "POST", url, headers: { ...write, cookie }, payload }),
  });
  const login = (email: string, password: string) =>
    app.inject({ method: "POST", url: "/api/auth/login", headers: write, payload: { email, password } });
  return { app, admin: as(admin), as, login };
}

describe("user management (admin)", () => {
  it("adds family members with a one-time temporary password they must change", async () => {
    const { admin, as, login } = await start();
    const r = await admin.post("/api/admin/users", { name: "엄마", email: " Mom@Example.com " });
    expect(r.statusCode).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
    const { user, temporaryPassword: temp } = CreateUserResponse.parse(r.json());
    expect(user).toMatchObject({
      email: "mom@example.com",
      role: "member",
      active: true,
      mustChangePassword: true,
    });
    expect(user.permissions).toEqual(DEFAULT_PERMISSIONS);
    expect(temp).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);

    // The list never contains passwords or hashes.
    const list = await admin.get("/api/admin/users");
    expect(list.body).not.toContain(temp);
    expect(list.body).not.toMatch(/argon2|passwordHash/);
    expect(
      AdminUser.array()
        .parse(list.json().users)
        .map((u) => u.email),
    ).toEqual(["ingki3@gmail.com", "mom@example.com"]);

    const first = await login("mom@example.com", temp);
    expect(first.json<AuthState>().user?.mustChangePassword).toBe(true);
    const mom = as(cookieOf(first.headers["set-cookie"]));
    expect((await mom.get("/api/admin/users")).statusCode).toBe(403);
    expect(
      (await mom.post("/api/auth/password", { currentPassword: temp, newPassword: "moms-own-password" }))
        .statusCode,
    ).toBe(200);
    expect((await login("mom@example.com", "moms-own-password")).statusCode).toBe(200);
  });

  it("stores the initial default runtime and refuses duplicate emails and bad input", async () => {
    const { admin } = await start();
    const r = await admin.post("/api/admin/users", {
      name: "아들",
      email: "son@example.com",
      defaultRuntime: "codex",
    });
    expect(CreateUserResponse.parse(r.json()).user.defaultRuntime).toBe("codex");
    expect((await admin.post("/api/admin/users", { name: "x", email: "SON@example.com" })).statusCode).toBe(
      409,
    );
    for (const bad of [
      { name: "", email: "a@b.co" },
      { name: "x", email: "nope" },
      { name: "x", email: "a@b.co", role: "root" },
    ])
      expect((await admin.post("/api/admin/users", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    expect(
      (await admin.post("/api/admin/users", { name: "x", email: "a@b.co", defaultRuntime: "gpt" }))
        .statusCode,
    ).toBe(400);
  });

  it("member accounts cannot use any user API", async () => {
    const { app, admin, as, login } = await start();
    const { user, temporaryPassword: temp } = CreateUserResponse.parse(
      (await admin.post("/api/admin/users", { name: "아들", email: "son@example.com" })).json(),
    );
    const sonCookie = cookieOf((await login("son@example.com", temp)).headers["set-cookie"]);
    await as(sonCookie).post("/api/auth/password", {
      currentPassword: temp,
      newPassword: "sons-new-password",
    });
    const son = as(sonCookie);
    expect((await son.get("/api/admin/users")).statusCode).toBe(403);
    expect((await son.post("/api/admin/users", { name: "x", email: "x@example.com" })).statusCode).toBe(403);
    expect((await son.post(`/api/admin/users/${user.id}/reset-password`)).statusCode).toBe(403);
    const adminId = app.users!.byEmail("ingki3@gmail.com")!.id;
    expect((await son.post(`/api/admin/users/${adminId}/deactivate`)).statusCode).toBe(403);
    expect((await as("").get("/api/admin/users")).statusCode).toBe(401);
  });

  it("deactivation ends the member's sessions at once and emits the access event; self-deactivation refused", async () => {
    const { app, admin, as, login } = await start();
    const { user, temporaryPassword: temp } = CreateUserResponse.parse(
      (await admin.post("/api/admin/users", { name: "아들", email: "son@example.com" })).json(),
    );
    const son = as(cookieOf((await login("son@example.com", temp)).headers["set-cookie"]));
    expect((await son.get("/api/auth/state")).json<AuthState>().user).not.toBeNull();
    const seen: UserAccessChanged[] = [];
    app.appEvents.on("user-access-changed", (e) => seen.push(e));
    const r = await admin.post(`/api/admin/users/${user.id}/deactivate`);
    expect(r.json().user.active).toBe(false);
    expect(seen).toEqual([{ userId: user.id, reason: "deactivated" }]);
    expect((await son.get("/api/auth/state")).json<AuthState>().user).toBeNull();
    expect((await login("son@example.com", temp)).statusCode).toBe(401);
    const adminId = app.users!.byEmail("ingki3@gmail.com")!.id;
    expect((await admin.post(`/api/admin/users/${adminId}/deactivate`)).statusCode).toBe(400);
    expect((await admin.post(`/api/admin/users/nope/deactivate`)).statusCode).toBe(404);
  });

  it("resets a password: old sessions end, a new temporary password must be changed", async () => {
    const { app, admin, as, login } = await start();
    const { user, temporaryPassword: temp } = CreateUserResponse.parse(
      (await admin.post("/api/admin/users", { name: "엄마", email: "mom@example.com" })).json(),
    );
    const momCookie = cookieOf((await login("mom@example.com", temp)).headers["set-cookie"]);
    await as(momCookie).post("/api/auth/password", {
      currentPassword: temp,
      newPassword: "moms-own-password",
    });
    const r = await admin.post(`/api/admin/users/${user.id}/reset-password`);
    const fresh = r.json<{ temporaryPassword: string }>().temporaryPassword;
    expect(fresh).not.toBe(temp);
    expect((await as(momCookie).get("/api/auth/state")).json<AuthState>().user).toBeNull();
    expect((await login("mom@example.com", "moms-own-password")).statusCode).toBe(401);
    const again = await login("mom@example.com", fresh);
    expect(again.json<AuthState>().user?.mustChangePassword).toBe(true);
    const adminId = app.users!.byEmail("ingki3@gmail.com")!.id;
    expect((await admin.post(`/api/admin/users/${adminId}/reset-password`)).statusCode).toBe(400);
    expect((await admin.post(`/api/admin/users/nope/reset-password`)).statusCode).toBe(404);
  });

  it("temporary passwords are random and long enough to pass the password rule", () => {
    const seen = new Set(Array.from({ length: 200 }, temporaryPassword));
    expect(seen.size).toBe(200);
    for (const p of seen) expect(p.length).toBeGreaterThanOrEqual(10);
  });

  it("migration gives existing users the default permissions", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.$client
      .prepare("insert into users (id, email, name, role) values ('u1', 'old@example.com', 'old', 'member')")
      .run();
    const row = db.$client.prepare("select permissions, default_runtime from users").get() as {
      permissions: string;
      default_runtime: string | null;
    };
    expect(JSON.parse(row.permissions)).toEqual(DEFAULT_PERMISSIONS);
    expect(row.default_runtime).toBeNull();
  });
});
