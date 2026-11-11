import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { CSRF_HEADER } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import type { ResourceRef } from "../src/authz/policy.js";
import { loadConfig } from "../src/config.js";
import { createTestDb, type Db } from "../src/db/client.js";
import { notifications, pushSubscriptions, settings } from "../src/db/schema.js";
import { bundle, compose, safePath, SHARED_BODY, twoLines } from "../src/notifications/compose.js";
import { validPushEndpoint } from "../src/notifications/endpoint.js";
import { inQuietHours } from "../src/notifications/quiet.js";
import type { PushTarget } from "../src/notifications/service.js";
import { VAPID_PRIVATE } from "../src/notifications/vapid.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** 2026-11-11 23:30 in Seoul (UTC+9). */
const NIGHT = Date.UTC(2026, 10, 11, 14, 30);
/** 2026-11-12 07:01 in Seoul. */
const MORNING = Date.UTC(2026, 10, 11, 22, 1);
/** 2026-11-11 12:00 in Seoul. */
const NOON = Date.UTC(2026, 10, 11, 3, 0);

type Sent = {
  endpoint: string;
  payload: { title: string; body: string; url: string; id?: string; tag: string };
};

/** A fake push service: records every push; `fail` maps an endpoint to the status it answers with. */
function pushService() {
  const sent: Sent[] = [];
  const fail = new Map<string, number>();
  const sender = async (t: PushTarget, payload: string) => {
    const status = fail.get(t.endpoint);
    if (status) throw Object.assign(new Error("push refused"), { statusCode: status });
    sent.push({ endpoint: t.endpoint, payload: JSON.parse(payload) as Sent["payload"] });
  };
  return { sent, fail, sender };
}

const KEY = crypto.randomBytes(32);
const dbs = new WeakMap<App, Db>();
const app_db = (app: App) => dbs.get(app)!;
/** Push states of every stored notification, sorted. */
const states = (db: Db) =>
  db
    .select({ s: notifications.pushState })
    .from(notifications)
    .all()
    .map((r) => r.s)
    .sort();
const LOCAL = { host: "localhost:3000", origin: "http://localhost:3000", [CSRF_HEADER]: "1" };

async function setup(o: { db?: Db; now?: number; log?: PassThrough } = {}) {
  const db = o.db ?? createTestDb();
  const clock = { now: o.now ?? NOON };
  const push = pushService();
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    db,
    masterKey: KEY,
    ...(o.log ? { logStream: o.log } : { logger: false }),
    notifications: { sender: push.sender, now: () => clock.now },
  });
  apps.push(app);
  dbs.set(app, db);
  await app.ready();
  const users = app.users!;
  const member = (name: string, role: "admin" | "member" = "member") => {
    const user = users.create({ email: `${name}@n.test`, name, role, passwordHash: "x" });
    const token = users.createSession(user.id);
    return { user, token, cookie: `al_session=${token}` };
  };
  const api = (
    who: { cookie: string },
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { ...LOCAL, cookie: who.cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  let n = 0;
  const subscribe = async (
    who: { cookie: string },
    endpoint = `https://fcm.googleapis.com/fcm/send/d${++n}`,
  ) => {
    const r = await api(who, "POST", "/api/push/devices", {
      endpoint,
      keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
      label: "Android · Chrome",
      sessionTag: await tagOf(who),
    });
    return { r, endpoint };
  };
  /** This session's tag, as the page reads it. */
  const tagOf = async (who: { cookie: string }) =>
    (await api(who, "GET", "/api/push/devices")).json<{ sessionTag: string }>().sessionTag;
  return { app, db, clock, push, member, api, subscribe, tagOf, svc: app.notifications! };
}

describe("text rules (FR-13.5)", () => {
  it("keeps two lines of a summary, drops markdown markers and control characters", () => {
    expect(twoLines("# 제목\n\n- 첫째 줄\n- 둘째 줄\n- 셋째 줄")).toBe("제목\n첫째 줄…");
    expect(twoLines("한 줄")).toBe("한 줄");
    expect(twoLines("a\u0007b\nc")).toBe("ab\nc");
    const long = "가".repeat(200);
    expect(Array.from(twoLines(long)).length).toBeLessThanOrEqual(80);
  });

  it("allows same-origin paths only", () => {
    expect(safePath("/c/123?x=1#m")).toBe("/c/123?x=1#m");
    for (const bad of [
      "https://evil.example/c/1",
      "//evil.example/x",
      "/\\evil.example",
      "javascript:alert(1)",
      "c/1",
      "",
      // Dot segments that normalise into a protocol-relative "//host" (plain and percent-encoded).
      "/a/..//evil.example",
      "/a/../..//evil.example/x",
      "/a/%2e%2e//evil.example",
      "/a/%2E%2E//evil.example",
      "/a/.%2e//evil.example",
      "/./..//evil.example",
    ])
      expect(safePath(bad), bad).toBe("/");
    // Harmless dot segments still resolve to the in-app path.
    expect(safePath("/a/../c/1")).toBe("/c/1");
    expect(safePath("/a/%2e%2e/c/1")).toBe("/c/1");
  });

  it("never puts shared content in a share notification", () => {
    const c = compose({
      kind: "share_received",
      fromName: "아들",
      itemTitle: "물리 실험 그래프",
      url: "/shared/1",
      ref: { kind: "x", id: "1" },
    });
    expect(c.body).toBe("아들님이 「물리 실험 그래프」을(를) 공유했어요");
    expect(bundle(["a", "b", "c"])).toEqual({
      title: "알림 3개가 와 있어요",
      body: "a\nb",
      url: "/notifications",
    });
  });

  it("quiet hours wrap midnight in the user's time zone", () => {
    const p = { quietStart: "23:00", quietEnd: "07:00", timeZone: "Asia/Seoul" };
    expect(inQuietHours(p, NIGHT)).toBe(true);
    expect(inQuietHours(p, MORNING)).toBe(false);
    expect(inQuietHours(p, NOON)).toBe(false);
    expect(inQuietHours({ ...p, quietStart: "09:00", quietEnd: "18:00" }, NOON)).toBe(true);
    expect(inQuietHours({ quietStart: null, quietEnd: null, timeZone: "Asia/Seoul" }, NIGHT)).toBe(false);
  });

  it("accepts push-service endpoints only", () => {
    expect(validPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(validPushEndpoint("https://web.push.apple.com/QGx")).toBe(true);
    expect(validPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(validPushEndpoint("https://wns2-bl2p.notify.windows.com/w/?token=x")).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://192.168.0.10/x",
      "https://localhost/x",
      "https://router.local/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://notify.windows.com/x",
      "not a url",
    ])
      expect(validPushEndpoint(bad), bad).toBe(false);
  });
});

describe("VAPID keys", () => {
  it("are generated once; the private key is stored encrypted and reused after a restart", async () => {
    const a = await setup();
    const mom = a.member("mom");
    const key1 = (await a.api(mom, "GET", "/api/push/key")).json<{ publicKey: string }>().publicKey;
    expect(key1).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    const row = a.db.select().from(settings).where(eq(settings.key, VAPID_PRIVATE)).get()!;
    expect(row.encrypted).toBe(true);
    expect(row.value.startsWith("v1:")).toBe(true);
    expect(a.svc.vapid.privateKey).not.toBe("");
    expect(row.value).not.toContain(a.svc.vapid.privateKey);
    await a.app.close();
    apps.length = 0;
    const b = await setup({ db: a.db });
    expect(b.svc.vapid.publicKey).toBe(key1);
    expect(b.svc.vapid.privateKey).toBe(a.svc.vapid.privateKey);
  });
});

describe("devices", () => {
  it("validates the endpoint and stores it encrypted, bound to the session", async () => {
    const { member, subscribe, api, db } = await setup();
    const mom = member("mom");
    for (const endpoint of ["http://fcm.googleapis.com/x", "https://10.0.0.1/x", "https://evil.example/x"])
      expect((await subscribe(mom, endpoint)).r.statusCode).toBe(400);
    const { r, endpoint } = await subscribe(mom);
    expect(r.statusCode).toBe(201);
    const row = db.select().from(pushSubscriptions).get()!;
    expect(row.secret).not.toContain(endpoint.split("/").pop());
    expect(row.secret).not.toContain("fcm");
    const devices = (await api(mom, "GET", "/api/push/devices")).json<{ devices: { current: boolean }[] }>();
    expect(devices.devices).toEqual([expect.objectContaining({ label: "Android · Chrome", current: true })]);
  });

  it("are removed on logout, on deactivation, and when another account signs in on the browser", async () => {
    const { app, member, subscribe, api, svc, push } = await setup();
    // logout
    const mom = member("mom");
    await subscribe(mom);
    expect((await api(mom, "POST", "/api/auth/logout", {})).statusCode).toBe(200);
    expect(svc.devices(mom.user.id, undefined)).toEqual([]);
    // deactivation (every session of the account)
    const son = member("son");
    await subscribe(son);
    app.users!.deactivate(son.user.id);
    expect(svc.devices(son.user.id, undefined)).toEqual([]);
    // another account on the same browser: login replaces the old session …
    const dad = member("dad");
    await subscribe(dad);
    const wife = app.users!.create({ email: "wife@n.test", name: "wife", role: "member", passwordHash: "x" });
    const { hashPassword } = await import("../src/auth/passwords.js");
    app.users!.setPassword(wife.id, await hashPassword("wife-password-1"));
    const login = await api(dad, "POST", "/api/auth/login", {
      email: "wife@n.test",
      password: "wife-password-1",
    });
    expect(login.statusCode).toBe(200);
    expect(svc.devices(dad.user.id, undefined)).toEqual([]);
    // … and the same endpoint registered by another account replaces the first account's device.
    const a = member("a");
    const b = member("b");
    const { endpoint } = await subscribe(a);
    await subscribe(b, endpoint);
    expect(svc.devices(a.user.id, undefined)).toEqual([]);
    expect(svc.devices(b.user.id, undefined)).toHaveLength(1);
    svc.publish(a.user.id, { kind: "test" });
    await svc.settled();
    expect(push.sent).toEqual([]);
  });

  it("a device whose session expired gets nothing and is removed", async () => {
    const { clock, member, subscribe, svc, push } = await setup();
    const mom = member("mom");
    await subscribe(mom);
    clock.now += 31 * 24 * 3600_000;
    svc.publish(mom.user.id, { kind: "test" });
    await svc.settled();
    expect(push.sent).toEqual([]);
    expect(svc.devices(mom.user.id, undefined)).toEqual([]);
  });

  it("404/410 from the push service deletes the device; other errors keep it", async () => {
    const { member, subscribe, svc, push } = await setup();
    const mom = member("mom");
    const gone = await subscribe(mom);
    const flaky = await subscribe(mom);
    push.fail.set(gone.endpoint, 410);
    push.fail.set(flaky.endpoint, 503);
    svc.publish(mom.user.id, { kind: "test" });
    await svc.settled();
    const left = svc.devices(mom.user.id, undefined);
    expect(left).toHaveLength(1);
    push.fail.clear();
    svc.publish(mom.user.id, { kind: "test" });
    await svc.settled();
    expect(push.sent.map((s) => s.endpoint)).toEqual([flaky.endpoint]);
  });

  it("device lists carry no endpoint identifier; this session's endpoint is compared on the server", async () => {
    const { app, member, subscribe, api } = await setup();
    const mom = member("mom");
    const { r, endpoint } = await subscribe(mom);
    const body = r.json<{ devices: Record<string, unknown>[]; sessionTag: string }>();
    expect(Object.keys(body.devices[0]!).sort()).toEqual([
      "createdAt",
      "current",
      "id",
      "label",
      "lastSentAt",
    ]);
    const hash = (e: string) => crypto.createHash("sha256").update(e).digest("hex");
    const check = (who: { cookie: string }, e: string) =>
      api(who, "POST", "/api/push/devices/check", { endpointHash: hash(e) }).then((x) => x.json());
    expect(await check(mom, endpoint)).toEqual({ match: true });
    expect(await check(mom, `${endpoint}-other`)).toEqual({ match: false });
    // Another session of the same account, and another account, are told nothing about it.
    expect(await check({ cookie: `al_session=${app.users!.createSession(mom.user.id)}` }, endpoint)).toEqual({
      match: false,
    });
    expect(await check(member("son"), endpoint)).toEqual({ match: false });
  });

  it("each session has its own opaque tag; a re-registration for another session is refused (409)", async () => {
    const { app, member, subscribe, api, svc } = await setup();
    const mom = member("mom");
    const first = (await subscribe(mom)).r.json<{ sessionTag: string }>().sessionTag;
    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first).not.toContain(mom.token);
    const again = (await api(mom, "GET", "/api/push/devices")).json<{ sessionTag: string }>().sessionTag;
    expect(again).toBe(first);
    const second = { cookie: `al_session=${app.users!.createSession(mom.user.id)}` };
    const tag2 = (await api(second, "GET", "/api/push/devices")).json<{ sessionTag: string }>().sessionTag;
    expect(tag2).not.toBe(first);
    // Session A's worker re-registers after B signed in on the browser: refused, nothing bound to B.
    const son = member("son");
    const r = await api(son, "POST", "/api/push/devices", {
      endpoint: "https://fcm.googleapis.com/fcm/send/renewed",
      keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
      label: "x",
      sessionTag: first,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "session_changed" });
    expect(svc.devices(son.user.id, undefined)).toEqual([]);
    // With its own tag it is accepted.
    const ownTag = (await api(son, "GET", "/api/push/devices")).json<{ sessionTag: string }>().sessionTag;
    const ok = await api(son, "POST", "/api/push/devices", {
      endpoint: "https://fcm.googleapis.com/fcm/send/renewed",
      keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
      label: "x",
      sessionTag: ownTag,
    });
    expect(ok.statusCode).toBe(201);
    // Without a tag nothing is registered.
    const untagged = await api(son, "POST", "/api/push/devices", {
      endpoint: "https://fcm.googleapis.com/fcm/send/untagged",
      keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
      label: "x",
    });
    expect(untagged.statusCode).toBe(400);
  });

  it("replacing this session's device is one transaction: a failed registration keeps the old one", async () => {
    const { app, member, subscribe, api, svc, tagOf } = await setup();
    const mom = member("mom");
    const old = (await subscribe(mom)).r.json<{ id: string }>().id;
    const keys = { p256dh: "B".repeat(87), auth: "A".repeat(22) };
    const bad = await api(mom, "POST", "/api/push/devices", {
      endpoint: "https://evil.example/x",
      keys,
      label: "x",
      sessionTag: await tagOf(mom),
      replaces: old,
    });
    expect(bad.statusCode).toBe(400);
    expect(svc.devices(mom.user.id, undefined).map((d) => d.id)).toEqual([old]);
    const good = await api(mom, "POST", "/api/push/devices", {
      endpoint: "https://fcm.googleapis.com/fcm/send/renewed",
      keys,
      label: "x",
      sessionTag: await tagOf(mom),
      replaces: old,
    });
    const now = svc.devices(mom.user.id, undefined);
    expect(now.map((d) => d.id)).toEqual([good.json<{ id: string }>().id]);
    // `replaces` never reaches another account's (or another session's) device.
    const son = member("son");
    const sons = (await subscribe(son)).r.json<{ id: string }>().id;
    await api(mom, "POST", "/api/push/devices", {
      endpoint: "https://fcm.googleapis.com/fcm/send/third",
      keys,
      label: "x",
      sessionTag: await tagOf(mom),
      replaces: sons,
    });
    expect(svc.devices(son.user.id, undefined).map((d) => d.id)).toEqual([sons]);
    // … nor mom's own device registered by another of her sessions.
    const laptop = { cookie: `al_session=${app.users!.createSession(mom.user.id)}` };
    const other = (await subscribe(laptop)).r.json<{ id: string }>().id;
    await api(mom, "POST", "/api/push/devices", {
      endpoint: "https://fcm.googleapis.com/fcm/send/fourth",
      keys,
      label: "x",
      sessionTag: await tagOf(mom),
      replaces: other,
    });
    expect(svc.devices(mom.user.id, undefined).map((d) => d.id)).toContain(other);
  });

  it("only the owner can remove a device", async () => {
    const { member, subscribe, api } = await setup();
    const mom = member("mom");
    const son = member("son");
    const { r } = await subscribe(mom);
    const id = r.json<{ id: string }>().id;
    expect((await api(son, "DELETE", `/api/push/devices/${id}`)).statusCode).toBe(403);
    expect((await api(mom, "DELETE", `/api/push/devices/${id}`)).json()).toMatchObject({ devices: [] });
  });
});

describe("publish and push", () => {
  it("stores the entry, pushes title/two-line body/same-origin url to every device", async () => {
    const { member, subscribe, svc, push, api } = await setup();
    const mom = member("mom");
    const one = await subscribe(mom);
    const two = await subscribe(mom);
    const id = svc.publish(mom.user.id, {
      kind: "schedule_succeeded",
      scheduleName: "아침 시장 브리핑",
      summary: "관심 종목 5개 중 3개 상승.\n삼성전자 강세예요.\n셋째 줄은 잘려요.",
      url: "https://evil.example/c/1",
    })!;
    await svc.settled();
    expect(push.sent.map((s) => s.endpoint).sort()).toEqual([one.endpoint, two.endpoint].sort());
    expect(push.sent[0]!.payload).toEqual({
      title: "아침 시장 브리핑",
      body: "관심 종목 5개 중 3개 상승.\n삼성전자 강세예요.…",
      url: "/",
      id,
      tag: id,
    });
    const inbox = (await api(mom, "GET", "/api/notifications")).json<{
      items: { id: string }[];
      unread: number;
    }>();
    expect(inbox.items.map((i) => i.id)).toEqual([id]);
    expect(inbox.unread).toBe(1);
  });

  it("admin kinds go to admins only", async () => {
    const { member, svc } = await setup();
    const mom = member("mom");
    const dad = member("dad", "admin");
    expect(svc.publish(mom.user.id, { kind: "daily_cost", amountUsd: 12, thresholdUsd: 10 })).toBeUndefined();
    expect(svc.publish(dad.user.id, { kind: "daily_cost", amountUsd: 12, thresholdUsd: 10 })).toBeDefined();
    expect(
      svc.publish(dad.user.id, { kind: "system_warning", message: "디스크 공간이 부족해요" }),
    ).toBeDefined();
  });

  it("a result seen only through a share never carries its content", async () => {
    const { app, member, subscribe, svc, push } = await setup();
    const owner = member("owner");
    const mom = member("mom");
    await subscribe(mom);
    app.resources.register("shared-thing", (id) => ({
      kind: "shared-thing",
      id,
      ownerId: owner.user.id,
      sharedWith: [mom.user.id],
    }));
    svc.publish(mom.user.id, {
      kind: "schedule_succeeded",
      scheduleName: "아빠의 브리핑",
      summary: "비밀스러운 결과 내용",
      url: "/c/1",
      ref: { kind: "shared-thing", id: "1" },
    });
    await svc.settled();
    expect(push.sent[0]!.payload.body).toBe(SHARED_BODY);
    expect(JSON.stringify(svc.list(mom.user.id))).not.toContain("비밀스러운");
  });
});

describe("permission re-check right before sending", () => {
  /** A resource whose sharing can be revoked. */
  function shares(app: App, ownerId: string) {
    const refs = new Map<string, ResourceRef>();
    app.resources.register("share", (id) => refs.get(id));
    return {
      share(id: string, withUser: string) {
        refs.set(id, { kind: "share", id, ownerId, sharedWith: [withUser] });
      },
      revoke(id: string) {
        refs.set(id, { kind: "share", id, ownerId, sharedWith: [] });
      },
    };
  }

  it("cancels a held share notification whose share was revoked (and hides it from the inbox)", async () => {
    const { app, clock, member, subscribe, svc, push, api } = await setup({ now: NIGHT });
    const son = member("son");
    const mom = member("mom");
    await subscribe(mom);
    await api(mom, "PUT", "/api/notifications/prefs", {
      quietStart: "23:00",
      quietEnd: "07:00",
      timeZone: "Asia/Seoul",
    });
    const s = shares(app, son.user.id);
    s.share("a", mom.user.id);
    s.share("b", mom.user.id);
    const input = (id: string) =>
      ({
        kind: "share_received",
        fromName: "아들",
        itemTitle: `그래프 ${id}`,
        url: `/shared/${id}`,
        ref: { kind: "share", id },
      }) as const;
    svc.publish(mom.user.id, input("a"));
    svc.publish(mom.user.id, input("b"));
    await svc.settled();
    expect(push.sent).toEqual([]);
    s.revoke("a");
    expect(svc.list(mom.user.id).items.map((i) => i.url)).toEqual(["/shared/b"]);
    expect(svc.unread(mom.user.id)).toBe(1);
    clock.now = MORNING;
    await svc.flushDue();
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.payload.url).toBe("/shared/b");
    expect(states(app_db(app))).toEqual(["cancelled", "sent"]);
  });

  it("refuses at publish time when the share is already gone, and cancels everything for a deactivated user", async () => {
    const { app, clock, member, subscribe, svc, push, api } = await setup({ now: NIGHT });
    const son = member("son");
    const mom = member("mom");
    const s = shares(app, son.user.id);
    s.share("x", son.user.id); // not shared with mom
    expect(
      svc.publish(mom.user.id, {
        kind: "share_received",
        fromName: "아들",
        itemTitle: "t",
        url: "/s",
        ref: { kind: "share", id: "x" },
      }),
    ).toBeUndefined();
    await subscribe(mom);
    await api(mom, "PUT", "/api/notifications/prefs", {
      quietStart: "23:00",
      quietEnd: "07:00",
      timeZone: "Asia/Seoul",
    });
    svc.publish(mom.user.id, { kind: "connection_lost", runtimeLabel: "Codex" });
    // Deactivation also ends the sessions (and with them the devices); the held entry must not go anywhere.
    app.users!.deactivate(mom.user.id);
    clock.now = MORNING;
    await svc.flushDue();
    expect(push.sent).toEqual([]);
    expect(states(app_db(app))).toEqual(["cancelled"]);
  });
});

describe("quiet hours (FR-13.4)", () => {
  it("holds pushes during quiet hours, then sends them as one bundle", async () => {
    const { clock, member, subscribe, svc, push, api } = await setup({ now: NIGHT });
    const mom = member("mom");
    await subscribe(mom);
    const put = await api(mom, "PUT", "/api/notifications/prefs", {
      quietStart: "23:00",
      quietEnd: "07:00",
      timeZone: "Asia/Seoul",
    });
    expect(put.statusCode).toBe(200);
    for (const name of ["아침 브리핑", "DART 공시", "환율"])
      svc.publish(mom.user.id, {
        kind: "schedule_succeeded",
        scheduleName: name,
        summary: "결과",
        url: "/c/1",
      });
    await svc.settled();
    expect(push.sent).toEqual([]);
    expect(svc.list(mom.user.id).items).toHaveLength(3);
    await svc.flushDue(); // still night: nothing
    expect(push.sent).toEqual([]);
    clock.now = MORNING;
    await svc.flushDue();
    await svc.flushDue(); // a second tick sends nothing more
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.payload).toMatchObject({
      title: "알림 3개가 와 있어요",
      body: "아침 브리핑\nDART 공시",
      url: "/notifications",
    });
  });

  it("keeps held pushes across a restart and sends them at start once quiet hours are over", async () => {
    const first = await setup({ now: NIGHT });
    const mom = first.member("mom");
    await first.subscribe(mom);
    await first.api(mom, "PUT", "/api/notifications/prefs", {
      quietStart: "23:00",
      quietEnd: "07:00",
      timeZone: "Asia/Seoul",
    });
    first.svc.publish(mom.user.id, {
      kind: "schedule_failed",
      scheduleName: "아침 브리핑",
      reason: "네이버 증권 응답 없음",
      url: "/c/1",
    });
    first.svc.publish(mom.user.id, { kind: "connection_lost", runtimeLabel: "Codex" });
    // A push cut off mid-way by the shutdown is sent again too.
    first.db
      .update(notifications)
      .set({ pushState: "sending" })
      .where(eq(notifications.kind, "connection_lost"))
      .run();
    await first.app.close();
    apps.length = 0;
    expect(first.push.sent).toEqual([]);

    const second = await setup({ db: first.db, now: MORNING });
    await second.svc.settled();
    expect(second.push.sent).toHaveLength(1);
    expect(second.push.sent[0]!.payload.title).toBe("알림 2개가 와 있어요");
  });

  it("turning quiet hours off sends what was held", async () => {
    const { member, subscribe, svc, push, api } = await setup({ now: NIGHT });
    const mom = member("mom");
    await subscribe(mom);
    await api(mom, "PUT", "/api/notifications/prefs", {
      quietStart: "23:00",
      quietEnd: "07:00",
      timeZone: "Asia/Seoul",
    });
    svc.publish(mom.user.id, { kind: "connection_lost", runtimeLabel: "Codex" });
    await svc.settled();
    expect(push.sent).toEqual([]);
    await api(mom, "PUT", "/api/notifications/prefs", {
      quietStart: null,
      quietEnd: null,
      timeZone: "Asia/Seoul",
    });
    await svc.settled();
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.payload.title).toBe("Codex 연결이 끊겼어요");
  });

  it("validates the settings", async () => {
    const { member, api } = await setup();
    const mom = member("mom");
    for (const bad of [
      { quietStart: "23:00", quietEnd: null, timeZone: "Asia/Seoul" },
      { quietStart: "25:00", quietEnd: "07:00", timeZone: "Asia/Seoul" },
      { quietStart: "07:00", quietEnd: "07:00", timeZone: "Asia/Seoul" },
    ])
      expect((await api(mom, "PUT", "/api/notifications/prefs", bad)).statusCode).toBe(400);
    const ok = await api(mom, "PUT", "/api/notifications/prefs", {
      quietStart: "22:30",
      quietEnd: "06:00",
      timeZone: "Nowhere/City",
    });
    expect(ok.json()).toEqual({ quietStart: "22:30", quietEnd: "06:00", timeZone: "Asia/Seoul" });
    expect((await api(mom, "GET", "/api/notifications/prefs")).json()).toEqual(ok.json());
  });
});

describe("inbox API", () => {
  it("reading an entry hidden by a revoked share or a lost admin role is not found and returns nothing", async () => {
    const { app, member, svc, api } = await setup();
    const son = member("son");
    const mom = member("mom");
    const refs = new Map<string, ResourceRef>([
      ["a", { kind: "share", id: "a", ownerId: son.user.id, sharedWith: [mom.user.id] }],
    ]);
    app.resources.register("share", (id) => refs.get(id));
    const shared = svc.publish(mom.user.id, {
      kind: "share_received",
      fromName: "아들",
      itemTitle: "비밀 그래프",
      url: "/shared/a",
      ref: { kind: "share", id: "a" },
    })!;
    refs.set("a", { kind: "share", id: "a", ownerId: son.user.id, sharedWith: [] });
    const r1 = await api(mom, "POST", `/api/notifications/${shared}/read`, {});
    expect(r1.statusCode).toBe(404);
    expect(r1.body).not.toContain("비밀");
    expect(svc.get(shared)!.readAt).toBeNull();

    const dad = member("dad", "admin");
    const cost = svc.publish(dad.user.id, { kind: "daily_cost", amountUsd: 12.5, thresholdUsd: 10 })!;
    app.users!.setRole(dad.user.id, "member");
    const r2 = await api(dad, "POST", `/api/notifications/${cost}/read`, {});
    expect(r2.statusCode).toBe(404);
    expect(r2.body).not.toContain("12.50");
    expect(svc.get(cost)!.readAt).toBeNull();
    // Re-shared / admin again: visible and readable again.
    app.users!.setRole(dad.user.id, "admin");
    expect((await api(dad, "POST", `/api/notifications/${cost}/read`, {})).statusCode).toBe(200);
  });

  it("each user sees only their own entries; read and read-all", async () => {
    const { member, svc, api } = await setup();
    const mom = member("mom");
    const son = member("son");
    const a = svc.publish(mom.user.id, { kind: "test" })!;
    svc.publish(mom.user.id, { kind: "connection_lost", runtimeLabel: "Codex" });
    svc.publish(son.user.id, { kind: "test" });
    const list = (who: typeof mom) =>
      api(who, "GET", "/api/notifications").then((r) =>
        r.json<{ items: { id: string; readAt: number | null }[]; unread: number }>(),
      );
    expect((await list(mom)).items).toHaveLength(2);
    expect((await list(son)).items).toHaveLength(1);
    expect((await api(son, "POST", `/api/notifications/${a}/read`, {})).statusCode).toBe(403);
    expect(
      (await api(mom, "POST", `/api/notifications/${a}/read`, {})).json<{ readAt: number }>().readAt,
    ).toBeTypeOf("number");
    expect((await api(mom, "GET", "/api/notifications/unread")).json()).toEqual({ unread: 1 });
    expect((await api(mom, "POST", "/api/notifications/read-all", {})).json()).toEqual({ unread: 0 });
    expect((await api(son, "GET", "/api/notifications/unread")).json()).toEqual({ unread: 1 });
    expect((await app_anon(api)).statusCode).toBe(401);
  });
});

/** An unauthenticated call. */
const app_anon = (api: (w: { cookie: string }, m: "GET", u: string) => Promise<{ statusCode: number }>) =>
  api({ cookie: "" }, "GET", "/api/notifications");

describe("logs", () => {
  it("never contain endpoints, titles or bodies", async () => {
    const log = new PassThrough();
    let out = "";
    log.on("data", (c: Buffer) => (out += c.toString()));
    const { member, subscribe, svc, push } = await setup({ log });
    const mom = member("mom");
    const { endpoint } = await subscribe(mom);
    const gone = await subscribe(mom);
    push.fail.set(gone.endpoint, 410);
    svc.publish(mom.user.id, {
      kind: "schedule_succeeded",
      scheduleName: "비밀 예약",
      summary: "비밀 본문",
      url: "/c/1",
    });
    await svc.settled();
    await new Promise((r) => setImmediate(r));
    expect(out).toContain('"msg":"push.sent"');
    expect(out).toContain('"msg":"push.subscription_gone"');
    expect(out).toContain('"httpStatus":410');
    for (const secret of [endpoint, gone.endpoint, "fcm.googleapis.com", "비밀", mom.token])
      expect(out).not.toContain(secret);
  });
});
