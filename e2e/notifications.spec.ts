import crypto from "node:crypto";
import { devices, expect, test, type Browser, type Page, type Worker } from "@playwright/test";
import { ADMIN, MOM, SON, csrf, useAccount } from "./helpers.js";

/**
 * Notifications (#34). A real push service cannot be reached from the test browser, so the browser's push
 * subscription is stubbed (a fake push-service endpoint); everything else — permission handling, the device
 * registration on the server, the inbox and the badge — is the real thing.
 */

/**
 * Stubs the Notification permission and PushManager; `answer` is what the permission prompt returns. Both are
 * kept in localStorage, so they survive reloads like the real browser state does (the endpoint lives under
 * `e2e-push-endpoint`; tests change it to play a renewal by the browser).
 */
async function stubPush(page: Page, answer: "granted" | "denied") {
  await page.addInitScript((answer) => {
    const w = window as unknown as { __asks: number };
    w.__asks = 0;
    const PERM = "e2e-push-permission";
    const SUB = "e2e-push-endpoint";
    const permission = () => (localStorage.getItem(PERM) ?? "default") as NotificationPermission;
    Object.defineProperty(Notification, "permission", { get: permission, configurable: true });
    Notification.requestPermission = async () => {
      w.__asks++;
      localStorage.setItem(PERM, answer);
      return answer;
    };
    const make = (endpoint: string) =>
      ({
        endpoint,
        options: { applicationServerKey: null, userVisibleOnly: true },
        toJSON: () => ({
          endpoint,
          expirationTime: null,
          keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
        }),
        unsubscribe: async () => {
          // Tests set this to play a browser that fails to drop the subscription.
          if (localStorage.getItem("e2e-push-unsubscribe-fails"))
            throw new DOMException("failed", "AbortError");
          localStorage.removeItem(SUB);
          return true;
        },
      }) as unknown as PushSubscription;
    PushManager.prototype.subscribe = async function () {
      const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(SUB, endpoint);
      return make(endpoint);
    };
    PushManager.prototype.getSubscription = async () => {
      const endpoint = localStorage.getItem(SUB);
      return endpoint ? make(endpoint) : null;
    };
  }, answer);
}

/** The app's service worker once it controls `page` (Chromium exposes workers to the test). */
async function controllingWorker(page: Page) {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const ctx = page.context();
  return ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
}

/** A separate browser (no saved session) that looks like this project's device. */
function freshContext(browser: Browser, baseURL: string, project: string) {
  const d = devices[project === "mobile" ? "Pixel 7" : "Desktop Chrome"];
  return browser.newContext({
    baseURL,
    userAgent: d.userAgent,
    viewport: d.viewport,
    deviceScaleFactor: d.deviceScaleFactor,
    isMobile: d.isMobile,
    hasTouch: d.hasTouch,
  });
}

async function login(page: Page, who: { email: string; password: string }) {
  await page.getByLabel("이메일", { exact: true }).fill(who.email);
  await page.getByLabel("비밀번호", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
}

const asks = (page: Page) => page.evaluate(() => (window as unknown as { __asks: number }).__asks);

async function openSidebar(page: Page, mobile: boolean) {
  if (mobile) await page.getByRole("button", { name: "메뉴 열기" }).click();
}

test("inbox: badge, list, open → its address, read state", async ({ page, baseURL }, info) => {
  const mobile = info.project.name === "mobile";
  // One account per project: the two projects run at the same time.
  const who = mobile ? SON : MOM;
  await useAccount(page, who);
  await page.request.post("/api/notifications/read-all", { headers: csrf(baseURL!) });
  for (let i = 0; i < 2; i++)
    expect((await page.request.post("/api/notifications/test", { headers: csrf(baseURL!) })).status()).toBe(
      201,
    );

  await page.goto("/");
  await openSidebar(page, mobile);
  await expect(page.getByTestId("unread-badge")).toHaveText("2");
  await page.getByRole("link", { name: "알림함, 안 읽은 알림 2개" }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  const items = page.getByTestId("notification");
  await expect(items.first()).toContainText("테스트 알림");
  await expect(items.first()).toContainText("안 읽음");
  await items.first().click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.goto("/notifications");
  await expect(page.getByTestId("notification").filter({ hasText: "안 읽음" })).toHaveCount(1);
  await page.getByRole("button", { name: "모두 읽음" }).click();
  await expect(page.getByTestId("notification").filter({ hasText: "안 읽음" })).toHaveCount(0);
  await openSidebar(page, mobile);
  await expect(page.getByTestId("unread-badge")).toHaveCount(0);
});

test("the permission prompt opens only from the button; a refusal shows the blocked state", async ({
  page,
}) => {
  await stubPush(page, "denied");
  await useAccount(page, ADMIN);
  await page.goto("/settings");
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  expect(await asks(page)).toBe(0);
  await page.getByRole("button", { name: "이 기기에서 알림 켜기" }).click();
  await expect(page.getByTestId("device-state")).toHaveText("브라우저가 차단");
  await expect(page.getByRole("note")).toContainText("차단");
  expect(await asks(page)).toBe(1);
});

test("turning on registers this device for the session; logging out removes it", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await freshContext(browser, baseURL!, info.project.name);
  const page = await ctx.newPage();
  await stubPush(page, "granted");
  // A fresh login (its own session), so logging out does not end the saved sessions other tests use.
  await page.goto("/settings");
  await login(page, ADMIN);
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");

  await page.getByRole("button", { name: "이 기기에서 알림 켜기" }).click();
  await expect(page.getByTestId("device-state")).toHaveText("켜짐");
  await expect(page.getByTestId("this-device")).toContainText(
    info.project.name === "mobile" ? "Android" : "Chrome",
  );
  const devices = await page.request.get("/api/push/devices");
  expect(
    ((await devices.json()) as { devices: { current: boolean }[] }).devices.filter((d) => d.current),
  ).toHaveLength(1);

  await page.getByTestId("this-device").getByRole("button", { name: "끄기", exact: true }).click();
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  await page.getByRole("button", { name: "이 기기에서 알림 켜기" }).click();
  await expect(page.getByTestId("device-state")).toHaveText("켜짐");

  if (info.project.name === "mobile") await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.getByRole("button", { name: "로그아웃" }).click();
  await login(page, ADMIN);
  // The device belonged to the ended session: this login starts without it.
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  const after = await page.request.get("/api/push/devices");
  expect(
    ((await after.json()) as { devices: { current: boolean }[] }).devices.filter((d) => d.current),
  ).toHaveLength(0);
  await ctx.close();
});

test("quiet hours are saved", async ({ page }) => {
  await useAccount(page, ADMIN);
  // Held: until the saved value is here, the form cannot be edited (#103). Otherwise a tick made on the defaults
  // could land just as the stored "on" (the other project's run, or a previous one) arrives, and undo itself.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/notifications/prefs", async (route) => {
    if (route.request().method() === "GET") await held;
    await route.fallback();
  });
  await page.goto("/settings");
  const on = page.getByLabel("사용", { exact: true });
  await expect(on).toBeDisabled();
  await expect(page.getByLabel("방해 금지 시작")).toBeDisabled();
  release();
  await expect(on).toBeEnabled();
  await on.check();
  await page.getByLabel("방해 금지 시작").fill("22:30");
  await page.getByLabel("방해 금지 끝").fill("06:45");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("저장했어요.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("방해 금지 시작")).toHaveValue("22:30");
  await expect(page.getByLabel("방해 금지 끝")).toHaveValue("06:45");
  await expect(page.getByLabel("사용", { exact: true })).toBeChecked();
});

test("a tapped notification opens its in-app address only; an expired session lands there after login", async ({
  browser,
  page,
  baseURL,
}, info) => {
  await useAccount(page, MOM);
  await page.goto("/");
  await expect(page.locator(".topbar")).toBeVisible();
  // What the service worker posts to an open window when a notification is tapped.
  const tap = (url: string) =>
    page.evaluate(
      (url) =>
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent("message", { data: { type: "agentlee:open", url } }),
        ),
      url,
    );
  await tap("/settings");
  await expect(page).toHaveURL(/\/settings$/);
  await tap("https://evil.example/phish");
  await expect(page).toHaveURL(new RegExp(`^${baseURL}/$`));

  // No session (expired or logged out): the address opened from the notification shows the login screen, and
  // signing in shows that same page.
  const ctx = await freshContext(browser, baseURL!, info.project.name);
  const fresh = await ctx.newPage();
  await fresh.goto("/notifications");
  await login(fresh, MOM);
  await expect(fresh).toHaveURL(/\/notifications$/);
  await expect(fresh.locator(".topbar .title")).toHaveText("🔔 알림함");
  await ctx.close();
});

test("tapping a notification while the open window shows the login screen lands there after login", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await freshContext(browser, baseURL!, info.project.name);
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  const sw = await controllingWorker(page);
  // What the worker's notificationclick handler runs, in the real worker against the real window.
  await sw.evaluate(() =>
    (globalThis as unknown as { openFromNotification: (u: string) => Promise<void> }).openFromNotification(
      "/notifications",
    ),
  );
  await expect(page).toHaveURL(/\/notifications$/);
  await login(page, MOM);
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.locator(".topbar .title")).toHaveText("🔔 알림함");
  await ctx.close();
});

type Ctx = Awaited<ReturnType<typeof freshContext>>;
const hashOf = (e: string) => crypto.createHash("sha256").update(e).digest("hex");
const bindingOf = (page: Page) =>
  page.evaluate(async () => {
    const r = await caches.match("/push-binding", { cacheName: "agentlee-push" });
    return r ? ((await r.json()) as { sessionTag: string | null }) : null;
  });
const markerOf = (page: Page) =>
  page.evaluate(async () => {
    const r = await caches.match("/push-reregister", { cacheName: "agentlee-push" });
    return r ? ((await r.json()) as { sessionTag: string | null }) : null;
  });

/** A fresh login of `who` with push turned on for this session (stubbed push service). */
async function turnedOn(ctx: Ctx, who: { email: string; password: string }) {
  const page = await ctx.newPage();
  await stubPush(page, "granted");
  await page.goto("/settings");
  await login(page, who);
  await page.getByRole("button", { name: "이 기기에서 알림 켜기" }).click();
  await expect(page.getByTestId("device-state")).toHaveText("켜짐");
  const sw = await controllingWorker(page);
  const current = async () =>
    (
      (await (await page.request.get("/api/push/devices")).json()) as {
        devices: { id: string; current: boolean }[];
      }
    ).devices.filter((d) => d.current);
  /** Server-side comparison for this session (`POST /api/push/devices/check`). */
  const registered = async (endpoint: string) =>
    (
      (await (
        await page.request.post("/api/push/devices/check", {
          data: { endpointHash: hashOf(endpoint) },
          headers: csrf(new URL(page.url()).origin),
        })
      ).json()) as { match: boolean }
    ).match;
  return { page, sw, current, registered };
}

/** The browser renews its subscription and the worker's registration is answered with `status`. */
async function renewalFails(ctx: Ctx, page: Page, sw: Worker, status: number) {
  const renewed = `https://fcm.googleapis.com/fcm/send/e2e-renewed-${Math.random().toString(36).slice(2)}`;
  await page.evaluate((e) => localStorage.setItem("e2e-push-endpoint", e), renewed);
  await ctx.route("**/api/push/devices", (route) =>
    route.request().method() === "POST" ? route.fulfill({ status, json: { error: "x" } }) : route.continue(),
  );
  await sw.evaluate(
    (endpoint) =>
      (globalThis as unknown as { reRegister: (o: unknown, n: unknown) => Promise<void> }).reRegister(null, {
        toJSON: () => ({ endpoint, keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } }),
      }),
    renewed,
  );
  await ctx.unroute("**/api/push/devices");
  return renewed;
}

test("a renewed subscription the worker could not register (403) is registered on the same session's next start", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await freshContext(browser, baseURL!, info.project.name);
  const { page, sw, current, registered } = await turnedOn(ctx, SON);
  const [first] = await current();
  const renewed = await renewalFails(ctx, page, sw, 403);
  expect((await markerOf(page))?.sessionTag).toEqual(expect.any(String));
  // The server still has the old registration; the next start of this session swaps it for the renewed one.
  // (The "row already gone after a 410" branch — `register` by the marker — is covered by
  // apps/web/test/push-reconcile.test.ts: a user's DELETE is an explicit off and ends recovery on purpose.)

  await page.reload();
  await expect(page.getByTestId("device-state")).toHaveText("켜짐");
  // The page can show the state before its sync's server calls have finished: wait for the server (#87).
  await expect.poll(async () => (await current()).map((d) => d.id)).not.toContain(first!.id);
  await expect.poll(() => registered(renewed)).toBe(true);
  await expect.poll(() => markerOf(page)).toBeNull();

  // The real browser state wins: no subscription any more → shown off, and the server forgets the device.
  await page.evaluate(() => localStorage.removeItem("e2e-push-endpoint"));
  await page.reload();
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  await expect.poll(() => current()).toEqual([]);
  await ctx.close();
});

test("session expired, the worker's re-registration failed, then another account signs in: nothing is turned on for it", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await freshContext(browser, baseURL!, info.project.name);
  const { page, sw } = await turnedOn(ctx, SON);
  await renewalFails(ctx, page, sw, 401);
  expect(await markerOf(page)).not.toBeNull();
  // The session ends without a logout (expiry), and mom signs in on this browser.
  await ctx.clearCookies();
  await page.reload();
  await login(page, MOM);
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  const mine = (await (await page.request.get("/api/push/devices")).json()) as {
    devices: { current: boolean }[];
  };
  expect(mine.devices.filter((d) => d.current)).toEqual([]);
  await expect.poll(() => markerOf(page)).toBeNull();
  await ctx.close();
});

test("replacing the registration is safe: a failed registration (503) keeps it, and the next start replaces it", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await freshContext(browser, baseURL!, info.project.name);
  const { page, current, registered } = await turnedOn(ctx, SON);
  const [first] = await current();
  // The browser has renewed its subscription (the worker never ran, e.g. renewal noticed at start).
  const renewed = `https://fcm.googleapis.com/fcm/send/e2e-renewed-${Math.random().toString(36).slice(2)}`;
  await page.evaluate((e) => localStorage.setItem("e2e-push-endpoint", e), renewed);
  await ctx.route("**/api/push/devices", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 503, json: { error: "x" } })
      : route.continue(),
  );
  await page.reload();
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  // Nothing was deleted: the old registration is still there.
  expect((await current()).map((d) => d.id)).toEqual([first!.id]);
  await ctx.unroute("**/api/push/devices");

  await page.reload();
  await expect(page.getByTestId("device-state")).toHaveText("켜짐");
  expect((await current()).map((d) => d.id)).not.toContain(first!.id);
  await expect.poll(() => registered(renewed)).toBe(true);
  await ctx.close();
});

test("the browser signs in to another account between a sync's check and its registration: refused, nothing bound", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await freshContext(browser, baseURL!, info.project.name);
  const { page, sw } = await turnedOn(ctx, SON);
  await renewalFails(ctx, page, sw, 403);
  // Next start of son's session: the sync reads son's tag, then — before its registration goes out — mom signs
  // in on this browser (another tab), so the registration arrives with mom's cookie.
  let switched = false;
  // Settles once the intercepted registration has been answered (sign-in done, request sent with mom's cookie).
  let answered!: () => void;
  const registrationAnswered = new Promise<void>((r) => (answered = r));
  await ctx.route("**/api/push/devices", async (route) => {
    if (route.request().method() !== "POST" || switched) return route.continue();
    switched = true;
    const r = await ctx.request.post("/api/auth/login", {
      data: { email: MOM.email, password: MOM.password },
      headers: csrf(baseURL!),
    });
    expect(r.ok()).toBe(true);
    const cookie = (await ctx.cookies()).find((c) => c.name === "al_session")!;
    const response = await route.fetch({
      headers: { ...route.request().headers(), cookie: `al_session=${cookie.value}` },
    });
    await route.fulfill({ response });
    answered();
  });
  await page.reload();
  await expect.poll(() => switched).toBe(true);
  // Wait for the intercepted request and the sign-in to finish before checking and removing the route.
  await registrationAnswered;
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  await ctx.unroute("**/api/push/devices");
  const moms = (await (await ctx.request.get("/api/push/devices")).json()) as { devices: unknown[] };
  expect(moms.devices).toEqual([]);
  await expect.poll(() => markerOf(page)).toBeNull();
  expect(await bindingOf(page)).toBeNull();
  await ctx.close();
});

test("turning off discards recovery even when the browser fails to unsubscribe: the next start stays off", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await freshContext(browser, baseURL!, info.project.name);
  const { page, sw, current } = await turnedOn(ctx, SON);
  await renewalFails(ctx, page, sw, 403);
  // The recovery marker is pending (no sync since) while the screen still shows "켜짐".
  expect(await markerOf(page)).not.toBeNull();
  await expect(page.getByTestId("device-state")).toHaveText("켜짐");
  await page.evaluate(() => localStorage.setItem("e2e-push-unsubscribe-fails", "1"));
  await page.getByTestId("this-device").getByRole("button", { name: "끄기", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("구독을 끊지 못했어요");
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  await expect.poll(() => markerOf(page)).toBeNull();
  expect(await bindingOf(page)).toBeNull();
  // The browser still holds a subscription; reconnecting must not turn it back on by itself.
  await page.reload();
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  await expect.poll(() => current()).toEqual([]);
  await ctx.close();
});

test("after a successful renewal by the worker, 끄기 with a failing unsubscribe still leaves nothing on", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await freshContext(browser, baseURL!, info.project.name);
  const { page, sw, current, registered } = await turnedOn(ctx, SON);
  // The browser renews its subscription and the worker registers the new one (succeeds this time).
  const renewed = `https://fcm.googleapis.com/fcm/send/e2e-renewed-${Math.random().toString(36).slice(2)}`;
  await page.evaluate((e) => localStorage.setItem("e2e-push-endpoint", e), renewed);
  await sw.evaluate(
    (endpoint) =>
      (globalThis as unknown as { reRegister: (o: unknown, n: unknown) => Promise<void> }).reRegister(null, {
        toJSON: () => ({ endpoint, keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } }),
      }),
    renewed,
  );
  await expect.poll(() => markerOf(page)).toBeNull();
  // The renewal replaced this session's device: one row, for the renewed endpoint.
  await expect.poll(async () => (await current()).length).toBe(1);
  await expect.poll(() => registered(renewed)).toBe(true);

  await page.evaluate(() => localStorage.setItem("e2e-push-unsubscribe-fails", "1"));
  await page.getByTestId("this-device").getByRole("button", { name: "끄기", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("구독을 끊지 못했어요");
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  await expect.poll(() => current()).toEqual([]);
  // Reconnect: still off, and the server has nothing of this session to push to.
  await page.reload();
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  await expect.poll(() => current()).toEqual([]);
  expect(await registered(renewed)).toBe(false);
  await ctx.close();
});

test("a worker re-registration still in flight when 끄기 is clicked is refused; turning on again works", async ({
  browser,
  baseURL,
}, info) => {
  const ctx = await freshContext(browser, baseURL!, info.project.name);
  const { page, sw, current, registered } = await turnedOn(ctx, SON);
  // The browser renews its subscription; the worker's registration POST is held on the way to the server.
  const renewed = `https://fcm.googleapis.com/fcm/send/e2e-renewed-${Math.random().toString(36).slice(2)}`;
  await page.evaluate((e) => localStorage.setItem("e2e-push-endpoint", e), renewed);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let intercepted = false;
  await ctx.route("**/api/push/devices", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    intercepted = true;
    await held;
    return route.continue();
  });
  const inFlight = sw.evaluate(
    (endpoint) =>
      (globalThis as unknown as { reRegister: (o: unknown, n: unknown) => Promise<void> }).reRegister(null, {
        toJSON: () => ({ endpoint, keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) } }),
      }),
    renewed,
  );
  await expect.poll(() => intercepted).toBe(true);

  // Meanwhile the user turns it off (and the browser even fails to drop its subscription).
  await page.evaluate(() => localStorage.setItem("e2e-push-unsubscribe-fails", "1"));
  await page.getByTestId("this-device").getByRole("button", { name: "끄기", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("구독을 끊지 못했어요");
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");

  // The held POST now arrives: refused, nothing registered.
  release();
  await inFlight;
  await ctx.unroute("**/api/push/devices");
  await expect.poll(() => current()).toEqual([]);
  expect(await registered(renewed)).toBe(false);
  await page.reload();
  await expect(page.getByTestId("device-state")).toHaveText("꺼짐");
  await expect.poll(() => current()).toEqual([]);

  // Turning on again by hand works.
  await page.evaluate(() => localStorage.removeItem("e2e-push-unsubscribe-fails"));
  await page.getByRole("button", { name: "이 기기에서 알림 켜기" }).click();
  await expect(page.getByTestId("device-state")).toHaveText("켜짐");
  await expect.poll(async () => (await current()).length).toBe(1);
  await ctx.close();
});
